import * as THREE from 'three';
import { NW, NE, vert, frag, postFrag, brightFrag, blurFrag } from './shaders.js';

// ---- settings ----
const params = new URLSearchParams(location.search);
const RENDER = params.has('render');               // for frame export (time is passed in from outside)
const PHONE = matchMedia('(pointer: coarse)').matches;
const PREVIEW = params.has('preview');                // preview render: coarse and fast
// render resolution: export renders at 2x and downsamples. The page caps the pixel count (the shader is heavy)
const BUDGET = PHONE ? 0.8e6 : 0.95e6;
let SS = RENDER ? (PREVIEW ? 1 : 2) : 1;
const SUB = RENDER && !PREVIEW ? 3 : 1;                         // how many sub-renders to average per frame (motion blur)
const SHUTTER = 1 / 90;
const LOOP = 21.2;
const ZS = 4.5, SLOPE = 0.06;                       // same as shaders.js (shoreline, beach slope)

// wave list: break time, wave height, run-up distance, random seed (same order as reality-js; slightly taller waves to show off the sea sparkle)
const WAVES = [
  [-3.61, 0.40, 2.3, 0.11],
  [0.18, 0.46, 3.3, 0.37],
  [3.43, 0.36, 2.6, 0.59],
  [5.96, 0.44, 3.1, 0.83],
  [7.66, 0.46, 3.1, 0.23],
  [11.18, 0.52, 3.2, 0.71],
  [15.68, 0.46, 3.2, 0.47],
  [19.45, 0.44, 2.9, 0.91],
  [22.89, 0.40, 2.3, 0.15],
];
if (WAVES.length !== NW) throw new Error('wave count mismatch');

// ---- render setup ----
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: RENDER, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.autoClear = false;
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

const camera = new THREE.PerspectiveCamera(48, 1, 0.03, 20000);
camera.rotation.order = 'YXZ';

const evA = Array.from({ length: NE }, () => new THREE.Vector4());
const evT = Array.from({ length: NE }, () => new THREE.Vector4(-99, 0, 0, 0));
const uniforms = {
  uT: { value: 0 },
  uWave: { value: WAVES.map((w) => new THREE.Vector4(...w)) },
  uCam: { value: camera.position },
  uOrigin: { value: new THREE.Vector2() },
  uMirror: { value: 0 },
  uRefl: { value: null },
  uRes: { value: new THREE.Vector2(1, 1) },
  uGlow: { value: 1 },
  uEv: { value: evA },
  uEvT: { value: evT },
  uNE: { value: 0 },
  uFeet: { value: 0 },
  uDbg: { value: Number(params.get('dbg') || 0) },   // debug: show wave quantities one at a time as colors
};

// grid shared by water and sand: a fan from the camera's feet, finer near, out to 9 km (camera-relative coordinates)
function fanGrid(rows, cols, dMin, dMax) {
  const pos = new Float32Array(rows * cols * 3);
  const r = Math.pow(dMax / dMin, 1 / (rows - 1));
  let k = 0;
  for (let j = 0; j < rows; j++) {
    const d = dMin * Math.pow(r, j);
    const half = d * 0.9 + 1.4;
    for (let i = 0; i < cols; i++) { pos[k++] = (i / (cols - 1) * 2 - 1) * half; pos[k++] = 0; pos[k++] = d; }
  }
  return indexed(pos, rows, cols);
}
// for the top-down view: an evenly spaced patch of beach (beach coordinates)
function rectGrid(rows, cols, x0, x1, d0, d1) {
  const pos = new Float32Array(rows * cols * 3);
  let k = 0;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    pos[k++] = x0 + (x1 - x0) * i / (cols - 1); pos[k++] = 0; pos[k++] = d0 + (d1 - d0) * j / (rows - 1);
  }
  return indexed(pos, rows, cols);
}
function indexed(pos, rows, cols) {
  const idx = new Uint32Array((rows - 1) * (cols - 1) * 6);
  let k = 0;
  for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
    const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
    idx[k++] = a; idx[k++] = b; idx[k++] = c; idx[k++] = b; idx[k++] = d; idx[k++] = c;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}
const grids = {
  fan: RENDER ? fanGrid(1100, 700, 0.25, 9000) : fanGrid(PHONE ? 420 : 640, PHONE ? 240 : 360, 0.25, 9000),
  top: RENDER ? rectGrid(1300, 1300, -26, 26, -14, 38) : rectGrid(PHONE ? 420 : 640, PHONE ? 420 : 640, -26, 26, -14, 38),
};

const scene = new THREE.Scene();
const mk = (isSand) => new THREE.ShaderMaterial({
  vertexShader: vert, fragmentShader: frag,
  defines: { NRIP: RENDER ? 60 : 36 },   // number of ripples (fewer on the page)
  uniforms: { ...uniforms, uIsSand: { value: isSand ? 1 : 0 } },
  side: THREE.DoubleSide,
  polygonOffset: !isSand, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
});
const sandMat = mk(true), waterMat = mk(false);
const sand = new THREE.Mesh(grids.fan, sandMat);
const water = new THREE.Mesh(grids.fan, waterMat);
sand.frustumCulled = water.frustumCulled = false;
water.renderOrder = 1;
scene.add(sand, water);
function useGrid(name) { sand.geometry = water.geometry = grids[name]; }

// ---- render targets ----
const quadVert = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }';
const quadScene = new THREE.Scene();
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
quad.frustumCulled = false;
quadScene.add(quad);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const accMat = new THREE.ShaderMaterial({
  vertexShader: quadVert,
  fragmentShader: 'uniform sampler2D uTex; uniform float uW; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(uTex, vUv).rgb * uW, 1.); }',
  uniforms: { uTex: { value: null }, uW: { value: 1 / SUB } },
  blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
});
const brightMat = new THREE.ShaderMaterial({ vertexShader: quadVert, fragmentShader: brightFrag, uniforms: { uTex: { value: null }, uTexel: { value: new THREE.Vector2() }, uExposure: { value: 1 } }, depthTest: false, depthWrite: false });
const blurMat = new THREE.ShaderMaterial({ vertexShader: quadVert, fragmentShader: blurFrag, uniforms: { uTex: { value: null }, uDir: { value: new THREE.Vector2() } }, depthTest: false, depthWrite: false });
const postMat = new THREE.ShaderMaterial({
  vertexShader: quadVert, fragmentShader: postFrag,
  uniforms: { uTex: { value: null }, uBloom: { value: null }, uBloom2: { value: null }, uTexel: { value: new THREE.Vector2() }, uExposure: { value: 2.2 }, uT: uniforms.uT },
  depthTest: false, depthWrite: false,
});

const blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
blackTex.needsUpdate = true;
let W = 0, H = 0, rt = null;
function resize() {
  const w = Math.round(canvas.clientWidth * devicePixelRatio), h = Math.round(canvas.clientHeight * devicePixelRatio);
  if (w === W && h === H) return;
  W = w; H = h;
  renderer.setSize(W, H, false);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  if (rt) Object.values(rt).forEach((r) => r.dispose());
  if (!RENDER) SS = Math.min(1, Math.sqrt(BUDGET / (W * H)));
  const iw = Math.round(W * SS), ih = Math.round(H * SS);
  const rd = RENDER ? 2 : 3;   // reflection downsample factor
  const hf = { type: THREE.HalfFloatType, depthBuffer: true };
  const lin = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
  rt = {
    refl: new THREE.WebGLRenderTarget(Math.round(iw / rd), Math.round(ih / rd), { ...hf, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }),
    scene: new THREE.WebGLRenderTarget(iw, ih, hf),
    acc: new THREE.WebGLRenderTarget(iw, ih, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }),
    b1: new THREE.WebGLRenderTarget(Math.round(iw / 4), Math.round(ih / 4), lin),
    b2: new THREE.WebGLRenderTarget(Math.round(iw / 4), Math.round(ih / 4), lin),
    c1: new THREE.WebGLRenderTarget(Math.round(iw / 16), Math.round(ih / 16), lin),
    c2: new THREE.WebGLRenderTarget(Math.round(iw / 16), Math.round(ih / 16), lin),
  };
  uniforms.uRefl.value = rt.refl.texture;
  postMat.uniforms.uTexel.value.set(1 / iw, 1 / ih);
}

// ---- camera ----
// view: { ox, od: position on the beach, h: height above sand (or water surface if any), yaw, pitch, roll (deg), fov, grid }
function groundY(d) { return Math.max(SLOPE * (ZS - d), 0); }
function setView(v) {
  useGrid(v.grid || 'fan');
  camera.fov = v.fov;
  camera.updateProjectionMatrix();
  if ((v.grid || 'fan') === 'fan') {
    uniforms.uOrigin.value.set(v.ox, v.od);
    camera.position.set(v.ox, groundY(v.od) + v.h, -v.od);
  } else {
    uniforms.uOrigin.value.set(0, 0);
    camera.position.set(v.ox, v.h, -v.od);
  }
  const D = THREE.MathUtils.degToRad;
  camera.rotation.set(D(v.pitch), D(v.yaw), D(v.roll || 0));
  camera.updateMatrixWorld();
}

// ---- touch trails (finger, footprints) ----
let events = [];   // { a:[x,d], b:[x,d], t, amp, kind, ang }
function pushEvents(list) {
  const n = Math.min(list.length, NE);
  const start = list.length - n;
  for (let i = 0; i < n; i++) {
    const e = list[start + i];
    evA[i].set(e.a[0], e.a[1], e.b[0], e.b[1]);
    evT[i].set(e.t, e.amp, e.kind, e.ang || 0);
  }
  uniforms.uNE.value = n;
  uniforms.uFeet.value = list.some((e) => e.kind > 0) ? 1 : 0;
}

// ---- render one frame ----
function drawScene(target) {
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  renderer.render(scene, camera);
}
function pass(mat, target) {
  quad.material = mat;
  renderer.setRenderTarget(target);
  renderer.render(quadScene, ortho);
}
function frame(t, viewAt) {
  resize();
  renderer.setRenderTarget(rt.acc);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  for (let s = 0; s < SUB; s++) {
    const ts = t + (SUB > 1 ? (s / (SUB - 1) - 0.5) * SHUTTER : 0);
    uniforms.uT.value = viewAt.scene(ts);
    setView(viewAt.view(ts));
    // 1) light mirrored at the water surface (reflected in wet sand and water)
    uniforms.uMirror.value = 1;
    uniforms.uRefl.value = blackTex;
    uniforms.uRes.value.set(rt.refl.width, rt.refl.height);
    drawScene(rt.refl);
    // 2) main pass
    uniforms.uMirror.value = 0;
    uniforms.uRefl.value = rt.refl.texture;
    uniforms.uRes.value.set(rt.scene.width, rt.scene.height);
    drawScene(rt.scene);
    accMat.uniforms.uTex.value = rt.scene.texture;
    quad.material = accMat;
    renderer.setRenderTarget(rt.acc);
    renderer.render(quadScene, ortho);
  }
  // bloom: two levels, 1/4 and 1/16
  const exp = postMat.uniforms.uExposure.value;
  brightMat.uniforms.uExposure.value = exp;
  brightMat.uniforms.uTex.value = rt.acc.texture;
  brightMat.uniforms.uTexel.value.set(1 / rt.acc.width, 1 / rt.acc.height);
  pass(brightMat, rt.b1);
  blur(rt.b1, rt.b2, 1.0);
  brightMat.uniforms.uTex.value = rt.b1.texture;
  brightMat.uniforms.uTexel.value.set(1 / rt.b1.width, 1 / rt.b1.height);
  brightMat.uniforms.uExposure.value = 1;
  pass(brightMat, rt.c1);
  blur(rt.c1, rt.c2, 1.0);
  postMat.uniforms.uTex.value = rt.acc.texture;
  postMat.uniforms.uBloom.value = rt.b1.texture;
  postMat.uniforms.uBloom2.value = rt.c1.texture;
  pass(postMat, null);
}
function blur(a, b, k) {
  blurMat.uniforms.uTex.value = a.texture;
  blurMat.uniforms.uDir.value.set(k / a.width, 0);
  pass(blurMat, b);
  blurMat.uniforms.uTex.value = b.texture;
  blurMat.uniforms.uDir.value.set(0, k / a.height);
  pass(blurMat, a);
}

// ---- film (15 s, 5 shots) ----
const lerp = (a, b, u) => a + (b - a) * u;
const ease = (u) => u * u * (3 - 2 * u);
// low eye line just above the waterline (used at 0 s and in the last shot). u is 0-1 within the shot
// locked-off camera on a tripod (shot like a long exposure; moving it smears the afterglow)
const lowView = () => ({ ox: 0.2, od: 0.6, h: 1.0, yaw: -2, pitch: -13.6, roll: 0.4, fov: 25 });

// finger trail (a loose S over the backwash, in 2 s)
function fingerTrail(t0, t1, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    pts.push({ t: lerp(t0, t1, ease(u) * 0.8 + u * 0.2), x: lerp(-0.55, 0.5, u) + 0.12 * Math.sin(u * 6.2), d: 3.6 + 0.3 * Math.sin(u * 3.6 + 0.4) });
  }
  const out = [];
  for (let i = 1; i < pts.length; i++) out.push({ a: [pts[i - 1].x, pts[i - 1].d], b: [pts[i].x, pts[i].d], t: pts[i].t, amp: 1.1, kind: 0 });
  return out;
}
// footprints walking across wet sand toward the sea
function footsteps(t0, step, n, x0, d0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const left = i % 2 === 0;
    const x = x0 + (left ? -0.09 : 0.09) + 0.015 * Math.sin(i * 1.7);
    const d = d0 + i * 0.36;
    out.push({ a: [x, d], b: [x, d], t: t0 + i * step, amp: 1.5, kind: left ? 1 : 2, ang: Math.PI / 2 + (left ? 0.08 : -0.08) });
  }
  return out;
}

const SHOTS = [
  // 0 s: open on the brightest moment, a glowing bore breaking from one end
  { name: 'break', t0: 0, t1: 3.0, s0: 7.4, view: () => lowView(), ev: [] },
  { name: 'finger', t0: 3.0, t1: 5.5, s0: 18.88, view: () => ({ ox: 0, od: 2.4, h: 0.78, yaw: 0, pitch: -40, roll: 0.3, fov: 50 }), ev: fingerTrail(18.9, 20.6, 46) },
  { name: 'steps', t0: 5.5, t1: 8.5, s0: 4.9, view: () => ({ ox: 0.08, od: 1.3, h: 1.05, yaw: 0, pitch: -47, roll: 0.3, fov: 44 }), ev: footsteps(5.0, 0.36, 7, 0.05, 1.9) },
  { name: 'above', t0: 8.5, t1: 11.5, s0: 7.0, view: () => ({ grid: 'top', ox: 2.0, od: 5.8, h: 25, yaw: 0, pitch: -90, roll: 34, fov: 48 }), ev: [] },
  // the last shot uses the same beach eye line and joins the 0 s frame (scene time 7.4) at exactly 15 s
  { name: 'return', t0: 11.5, t1: 15.0, s0: 3.9, view: () => lowView(), ev: [] },
];
const FILM_LEN = 15;
function shotAt(ft) { return SHOTS.find((s) => ft >= s.t0 && ft < s.t1) || SHOTS[SHOTS.length - 1]; }
function filmFrame(ft) {
  const sh = shotAt(ft);
  pushEvents(sh.ev);
  frame(ft, { scene: (t) => sh.s0 + (t - sh.t0), view: () => sh.view() });
  return sh.name;
}

// ---- page ----
const views = {
  // widen the field of view on portrait screens (the horizon always sits just above the top of the frame)
  shore: () => { const fov = camera.aspect < 1 ? 36 : 25; return { ...lowView(), fov, pitch: -(fov / 2 + 1.1) }; },
  above: (t) => ({ grid: 'top', ox: 1.8 + 0.3 * Math.sin(t * 0.05), od: 5.6, h: camera.aspect < 1 ? 30 : 22, yaw: 0, pitch: -90, roll: camera.aspect < 1 ? 62 : 34, fov: 50 }),
};
let viewName = 'shore';
let t0 = performance.now();
const now = () => (performance.now() - t0) / 1000;

if (RENDER) {
  document.body.classList.add('film');
  window.__filmLen = FILM_LEN;
  window.__renderAt = (f, fps) => {
    const name = filmFrame(f / fps);
    renderer.getContext().finish();
    return { scene: name };
  };
  window.__ready = true;
} else {
  setupUI();
  const loop = () => {
    const t = now();
    const st = t % LOOP;
    events = events.filter((e) => st - e.t < 6 && st >= e.t - 0.01);
    pushEvents(events);
    frame(t, { scene: () => st, view: (tt) => views[viewName](tt) });
    requestAnimationFrame(loop);
  };
  loop();
}

function setupUI() {
  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.05);
  const hit = new THREE.Vector3();
  let last = null;
  const toBeach = (ev) => {
    const r = canvas.getBoundingClientRect();
    const v = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    setView(views[viewName](now()));
    ray.setFromCamera(v, camera);
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return [hit.x, -hit.z];
  };
  const add = (p) => {
    const st = now() % LOOP;
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < (viewName === 'above' ? 0.12 : 0.025)) return;
    const a = last || p;
    events.push({ a, b: p, t: st, amp: viewName === 'above' ? 2.2 : 1.6, kind: 0 });
    if (events.length > NE) events.shift();
    last = p;
  };
  let down = false;
  canvas.addEventListener('pointerdown', (e) => { down = true; last = null; canvas.setPointerCapture(e.pointerId); const p = toBeach(e); if (p) add(p); document.getElementById('hint').style.opacity = 0; });
  canvas.addEventListener('pointermove', (e) => { if (!down) return; const p = toBeach(e); if (p) add(p); });
  const up = () => { down = false; last = null; };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  const bs = { shore: document.getElementById('b-shore'), above: document.getElementById('b-above') };
  const set = (n) => { viewName = n; events = []; Object.entries(bs).forEach(([k, b]) => b.classList.toggle('on', k === n)); };
  bs.shore.onclick = () => set('shore');
  bs.above.onclick = () => set('above');
  set('shore');
}
