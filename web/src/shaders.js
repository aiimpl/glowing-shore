// sea-sparkle shoreline shaders. Water and sand share one grid and get their heights from the same function
// wave shapes are the same as reality-js (shoreline). Made night, and only disturbed water glows blue
export const NW = 9;
export const NE = 96;   // number of touch trails and footprints

export const common = /* glsl */ `
#define NW ${NW}
#define NE ${NE}
#ifndef NRIP
#define NRIP 60
#endif
uniform float uT;
uniform vec4 uWave[NW];   // x: break time  y: wave height (m)  z: run-up (m)  w: random seed
uniform vec3 uCam;
uniform vec2 uOrigin;     // offset from the grid (camera-relative) to beach coordinates

const float ZS = 4.5;     // still-water shoreline (distance from camera, m)
const float SLOPE = 0.06; // beach slope
const float DB = 8.3;     // breaking distance
const float CB = 2.8;     // speed of the bore after breaking, m/s
const float KOB = 0.1;    // oblique arrival: the right side arrives earlier, s/m
const float ACC = 1.6;    // run-up deceleration, m/s^2

float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash32(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float n1(float x){ float i = floor(x), f = fract(x); float u = f * f * (3. - 2. * f); return mix(hash12(vec2(i, 17.3)), hash12(vec2(i + 1., 17.3)), u) * 2. - 1.; }
float fbm(vec2 p){ float s = 0., a = .5; for (int i = 0; i < 4; i++){ s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= .5; } return s; }

#define NE ${NE}
uniform vec4 uEv[NE];    // ax, ad, bx, bd (beach coordinates)
uniform vec4 uEvT[NE];   // time, strength, kind (0 finger trail / 1 left foot / 2 right foot), heading (radians)
uniform int uNE;
uniform int uFeet;   // number of footprints (0 skips the footprint math)

float segDist(vec2 p, vec2 a, vec2 b){
  vec2 ab = b - a; float h = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0., 1.);
  return length(p - a - ab * h);
}
// foot shape (u: heading, v: sideways). Rounded toes, narrow arch, heel
float footShape(vec2 q, float side){
  q.y *= side;
  float sole = length((q - vec2(0.035, 0.008)) / vec2(0.075, 0.042));
  float heel = length((q - vec2(-0.085, 0.0)) / vec2(0.042, 0.036));
  float arch = length((q - vec2(-0.03, -0.012)) / vec2(0.07, 0.022));
  float d = min(min(sole, heel), arch);
  float toes = 9.;
  for (int k = 0; k < 5; k++){
    float fk = float(k);
    vec2 c = vec2(0.118 - fk * fk * 0.0035, 0.03 - fk * 0.0145);
    toes = min(toes, length(q - c) / (0.016 - fk * 0.0018));
  }
  return min(d, toes);
}
// footprint dent (stays from the moment of the step). footprintMask is 0-1
float footprintMask(vec2 p){
  float m = 0.;
  for (int i = 0; i < NE; i++){
    if (i >= uNE) break;
    vec4 tt = uEvT[i];
    if (tt.z < 0.5 || uT < tt.x) continue;
    vec2 q = p - uEv[i].xy;
    if (dot(q, q) > 0.04) continue;
    float ca = cos(tt.w), sa = sin(tt.w);
    q = vec2(ca * q.x + sa * q.y, -sa * q.x + ca * q.y);
    float f = footShape(q, tt.z < 1.5 ? -1. : 1.);
    m = max(m, smoothstep(1.15, 0.8, f) * smoothstep(0., 0.08, uT - tt.x));
  }
  return m;
}
float sandY(vec2 p){ // p = (x, distance D)
  return SLOPE * (ZS - p.y) + 0.018 * sin(p.x * 0.6 + p.y * 0.35) + 0.012 * (fbm(p * 0.9) - 0.5) - (uFeet > 0 ? 0.016 * footprintMask(p) : 0.);
}

// contribution of one wave at point p
// eta: sea surface elevation / film: run-up water thickness / foam: residual foam / crest: closeness to the crest / edge: run-up leading edge
// adv: foam advection / white: whitewater (breaking crest and bore) / swf: foam on the swash
void waveAt(int i, vec2 p, inout float eta, inout float film, inout float foam, inout float crest, inout float edge, inout float adv, inout float white, inout float swf){
  vec4 w = uWave[i];
  if (w.y <= 0.) return;
  float sd = w.w;
  float lat = n1(p.x * 0.16 + sd * 13.1) * 0.55 + n1(p.x * 0.47 + sd * 7.7) * 0.25;
  float H = w.y * (1. + 0.45 * lat);
  float tau = uT - w.x + KOB * p.x + 0.22 * n1(p.x * 0.33 + sd * 3.3);
  float dbL = DB + 1.1 * n1(p.x * 0.21 + sd * 5.9) + 0.4 * n1(p.x * 0.7 + sd);
  float ts = (dbL - ZS) / CB;
  float Dc = dbL - CB * tau;
  float xi = p.y - Dc; // positive = seaward of the front

  // blend smoothly over time between the approaching swell (steep front, gentle back) and the bore after breaking
  float bw = smoothstep(-0.15, 0.35, tau);
  if (tau < 0.6) {
    float k = smoothstep(-3.2, 0., min(tau, 0.));
    float A = H * (0.3 + 0.7 * k);
    float wf = mix(1.5, 0.3, k * k);
    float wb = mix(2.8, 1.9, k);
    float pr = xi < 0. ? exp(-xi * xi / (wf * wf)) : exp(-xi * xi / (wb * wb));
    float pre = A * pr - 0.16 * A * exp(-pow((xi + 1.8) / 1.1, 2.));
    eta += pre * (1. - bw);
    crest = max(crest, k * pr * smoothstep(-1.1, -0.7, xi) * smoothstep(0.65, 0.3, xi) * (1. - bw));   // any step here puts corners in the glow band on obliquely arriving waves
    // start of breaking: the crest whitens from the top (the front face is still translucent)
    float br = smoothstep(-0.7, 0., tau);
    float seg = smoothstep(-0.3, 0.4, n1(p.x * 0.9 + sd * 11.) + br * 0.8);
    white += br * seg * 1.6 * exp(-pow((xi - 0.06 - 0.06 * br) / (0.06 + 0.1 * br), 2.)) * (1. - bw);
  }
  if (tau > -0.15 && tau < ts + 0.25) {
    float dec = exp(-max(tau, 0.) * 0.3);
    float A = H * mix(0.95, 0.62, smoothstep(0., 0.6, tau)) * dec;
    float pr = xi < 0. ? exp(-xi * xi / 0.22) : (0.5 + 0.5 * exp(-xi * xi / 0.3)) * exp(-xi / 3.2);   // the front is a slope of tumbling foam (a steep face looks like a glass wall)
    float fade = smoothstep(ts + 0.25, ts - 0.1, tau);
    eta += A * pr * fade * bw;
    crest = max(crest, 0.5 * dec * exp(-xi * xi / 0.12) * fade * bw);
    float brk = smoothstep(-0.5, 0.5, n1(p.x * 1.4 + sd * 9. + tau * 0.6)) * 0.55 + 0.45;
    white += 1.6 * dec * exp(-pow((xi - 0.08) / (0.42 + 0.25 * smoothstep(0., 1., tau)), 2.)) * fade * bw * (0.75 + 0.25 * lat) * brk;
    foam += 0.6 * dec * exp(-pow((xi - 0.45) / 0.4, 2.)) * fade * bw;
  }

  // foam left behind the passing bore
  if (tau > 0.) {
    float age = tau - (dbL - p.y) / CB;
    if (age > 0.) {
      float keep = smoothstep(dbL + 0.6, dbL - 0.4, p.y) * smoothstep(ZS - 0.3, ZS + 0.4, p.y);
      foam += 0.32 * exp(-age / 1.0) * keep;
    }
  }

  // run-up (climbs the sand from the shoreline, then drains back)
  float tt = tau - ts;
  if (tt > 0.) {
    float R = max(0.05, w.z * (1. + 0.35 * lat));
    float v0 = sqrt(2. * ACC * R);
    float Tt = v0 / ACC;
    // ramp in over 0.25 s at the start (a sudden onset makes the edge race along the beach on oblique waves and leaves a stepped band)
    float life = smoothstep(2. * Tt + 0.6, 2. * Tt - 0.2, tt) * smoothstep(0., 0.25, tt);
    if (life > 0.) {
      float run = v0 * tt - 0.5 * ACC * tt * tt;
      float Ee = ZS - max(run, -0.4) + 0.13 * n1(p.x * 1.05 + sd * 2.1) + 0.05 * n1(p.x * 3.7 + sd * 4.4) + 0.015 * n1(p.x * 11. + sd);
      float up = 1. - smoothstep(0., Tt, tt);          // 1 while running up
      float thick = clamp((p.y - Ee) * mix(0.028, 0.06, up), 0., 0.12);
      thick += 0.035 * up * exp(-pow((p.y - Ee - 0.18) / 0.22, 2.)); // bulge at the leading edge
      thick *= step(Ee, p.y) * life;
      float fw = smoothstep(ZS + 1.6, ZS - 0.2, p.y);
      film = max(film, thick * fw + (p.y > ZS ? thick * (1. - fw) : 0.));
      float cov = (1.25 * exp(-tt / 1.1) + 0.22 * exp(-tt / 5.)) * (0.9 - 0.3 * smoothstep(Tt, 2. * Tt, tt));   // per the reference: right after run-up the swash is covered in foam (over half the foreground), it thins to threads in about 1 s, and a sparse lace lingers
      float inside = smoothstep(Ee - 0.01, Ee + 0.06, p.y) * smoothstep(ZS + 0.9, ZS - 0.1, p.y) * life;
      swf = max(swf, cov * inside);
      white += 1.3 * up * smoothstep(0.9 * Tt, 0.1, tt) * exp(-pow((p.y - Ee - 0.28) / 0.3, 2.)) * life;
      edge = max(edge, exp(-pow((p.y - Ee - 0.03) / 0.045, 2.)) * life * (0.55 + 0.45 * up));
      // foam pattern offset. Switching it abruptly at the edge stretches the pattern into vertical drips, so fade it out over 2.5 m seaward
      adv += (ZS - Ee) * 0.4 * life * smoothstep(Ee - 0.01, Ee + 0.06, p.y) * smoothstep(ZS + 2.5, ZS - 0.3, p.y);
    }
  }
}

struct Surf { float y; float sand; float film; float foam; float crest; float edge; float adv; float white; };

Surf surf(vec2 p){
  float eta = 0., film = 0., foam = 0., crest = 0., edge = 0., adv = 0., white = 0., swf = 0.;
  for (int i = 0; i < NW; i++) waveAt(i, p, eta, film, foam, crest, edge, adv, white, swf);
  foam = max(foam, swf) + 0.3 * min(foam, swf);
  // offshore swell: long waves travelling shoreward beyond the surf zone
  float off = smoothstep(DB - 1., DB + 4., p.y);
  // shallow water, so speed is set by depth (1.3-1.6 m/s; deep-water speed looks more than twice too fast)
  eta += off * (0.07 * sin(0.72 * (p.y + 0.12 * p.x) + 0.72 * 1.4 * uT) + 0.05 * sin(1.05 * (p.y - 0.2 * p.x) + 1.05 * 1.3 * uT + 1.3) + 0.035 * sin(0.55 * (p.y + 0.35 * p.x) + 0.55 * 1.6 * uT + 4.1));
  float rollerN = fbm(p * vec2(2.2, 3.4) + vec2(0., uT * 0.8)) * 0.7 + fbm(p * vec2(7., 10.) - uT * 0.5) * 0.3;
  float lumps = fbm(p * vec2(7., 9.) + vec2(0., uT * 1.1)) + 0.5 * fbm(p * vec2(16., 20.) - uT * 0.7);
  // whitewater foam is raised only over the sea (raising it on sand puts a white wall at the run-up tip)
  eta += smoothstep(0.15, 1.1, white) * (0.04 + 0.07 * rollerN + 0.03 * lumps) * (0.6 + 0.4 * n1(p.x * 1.3 + 4.)) * smoothstep(ZS + 0.2, ZS + 1.4, p.y);
  float sy = sandY(p);
  Surf s;
  s.sand = sy;
  float sea = eta;
  float sheet = sy + film;
  s.y = max(sea, sheet);
  s.film = s.y - sy;
  s.foam = foam;
  s.crest = crest;
  s.edge = edge;
  s.adv = adv;
  s.white = white;
  return s;
}
`;

// fine ripples (normals only). Finer ripples are included closer to the camera
export const ripples = /* glsl */ `
// returns xy = slope, z = slope variance of unresolved sub-pixel ripples (widens the glints)
vec3 rippleSlope(vec2 p, float fw){
  vec2 g = vec2(0.);
  float unres = 0.;
  for (int i = 0; i < NRIP; i++){
    float fi = float(i);
    float lam = 6.0 * pow(0.9, fi) * (0.8 + 0.4 * hash12(vec2(fi, 9.1)));   // 6 m down to about 0.01 m
    float spread = mix(0.9, 2.8, smoothstep(3., 0.2, lam));
    float ang = (hash12(vec2(fi, 3.1)) - 0.5) * spread + 0.15;
    vec2 d = vec2(sin(ang), -cos(ang));
    float k = 6.2831853 / lam;
    float hd = clamp(SLOPE * (p.y - ZS), 0.08, 4.);   // water depth: in shallow water longer waves slow down
    float om = sqrt((9.81 * k + 0.074 / 1000. * k * k * k) * tanh(k * hd));
    float stp = mix(0.14, 0.05, smoothstep(1.5, 0.08, lam)) * (0.45 + 1.1 * hash12(vec2(fi, 7.7)));
    float amp = stp / k;
    float filt = smoothstep(fw * 4., fw * 9., lam);
    float ph = k * dot(d, p) - om * uT + hash12(vec2(fi, 1.3)) * 6.2831;
    float c = cos(ph), sn = sin(ph);
    // sharpen the crests (asymmetric front and back slopes)
    float slope = amp * k * c * (1. + 0.8 * sn);
    g += d * slope * filt;
    unres += (amp * k) * (amp * k) * 0.5 * (1. - filt);
  }
  float rough = 0.6 + 0.8 * vnoise(p * 0.09 + vec2(uT * 0.03, 0.));
  return vec3(g * rough, unres * rough * rough);
}

`
export const lace = /* glsl */ `
// foam lace. The smaller cov is, the wider the holes, until only threads remain
// backwash foam in the reference: a lace of thin threads, stretched into streaks by the draining (seaward) flow,
// changing shape as it is churned, threads breaking until it fades away
float laceLayer(vec2 q, float cov, float t, float seed){
  // pattern 3.5x longer along the flow (depth): on screen it reads as vertical streaks
  vec2 qs = vec2(q.x * 5.5, q.y * 6.5) + seed;   // a fine lace: on screen it reads as thin, wavy horizontal threads
  vec2 qq = qs + 0.6 * vec2(fbm(qs * 0.5 + vec2(1.3, t * 0.35)), fbm(qs * 0.5 + vec2(8.1 - t * 0.3, 0.))) - 0.3;
  qq += 0.15 * vec2(fbm(qq * 3. + vec2(0., t * 0.8)), fbm(qq * 3. + vec2(4.3 + t * 0.7, 0.))) - 0.07;
  // threads: noise contours (1-|2n-1|). Thickness follows the amount of foam
  float n1v = fbm(qq * 1.6 + 5.) * 0.65 + fbm(qq * 3.7 + 11.) * 0.35;
  float r = 1. - abs(2. * n1v - 1.);
  float n2v = fbm(qq * 3.1 + 17.);
  float r2 = 1. - abs(2. * n2v - 1.);
  float fz = vnoise(qq * vec2(18., 18.)) * 0.6 + vnoise(qq * vec2(45., 45.)) * 0.4 - 0.5;
  float w1 = 0.05 + 0.16 * cov, w2 = 0.04 + 0.12 * cov;
  float thread = max(smoothstep(1. - w1, 1. - w1 * 0.7, r + fz * 0.06), smoothstep(1. - w2, 1. - w2 * 0.7, r2 + fz * 0.06) * 0.85);
  // where there is a lot of foam it becomes a sheet (holes of uneven size)
  float b = fbm(qq * 1.2 + 2.) * 0.6 + fbm(qq * 2.9 + 7.) * 0.4 + fz * 0.05;
  float th = 0.6 + (0.55 - cov) * 0.5;   // only very dense foam becomes a sheet; the rest is threads
  float sheet = smoothstep(th - 0.01, th + 0.02, b);
  // threads break more as the foam thins
  float brk = smoothstep(0.62 - 0.45 * cov, 0.8 - 0.45 * cov, vnoise(qq * vec2(2.2, 2.2) + 7. + t * 0.2));
  return max(sheet, thread * mix(0.15, 1., brk)) * smoothstep(0.02, 0.12, cov);
}
float lace(vec2 q, float cov){
  // two layers offset in time: each one fades out and returns with a new pattern, so the lace never stops re-forming
  float f = 0.;
  for (int k = 0; k < 2; k++){
    float ph = uT / 2.2 + float(k) * 0.5;
    float fr = fract(ph);
    float wk = 1. - abs(2. * fr - 1.);
    vec2 off = hash22(vec2(floor(ph), float(k) * 7.3)) * 40.;
    // the fading layer's threads thin and break while the next layer's threads thicken in (no cross-blur, so threads stay crisp)
    f = max(f, laceLayer(q + off, cov * smoothstep(0., 0.5, wk), uT, 0.));
  }
  // fine grain inside the foam, and pinholes where it is thin
  f *= 0.88 + 0.16 * vnoise(q * vec2(40., 55.) + uT * 0.5);
  f *= mix(1., smoothstep(0.15, 0.4, vnoise(q * vec2(60., 80.) + uT * 0.7)), 0.5 * (1. - cov));
  return clamp(f * smoothstep(0.03, 0.3, cov), 0., 1.);
}`;

// touch trails and footprints: a segment (start, end) plus time, strength, kind and heading
export const events = /* glsl */ `
// water ripple from a finger trail (backwash): rings spreading out from the trail
float evWave(vec2 p){
  float h = 0.;
  for (int i = 0; i < NE; i++){
    if (i >= uNE) break;
    vec4 tt = uEvT[i];
    float age = uT - tt.x;
    if (tt.z > 0.5 || age < 0. || age > 2.5) continue;
    float d = segDist(p, uEv[i].xy, uEv[i].zw);
    float front = 0.03 + 0.35 * age;
    float x = d - front;
    h += 0.0035 * sin(x * 140.) * exp(-x * x / 0.002) * exp(-age / 0.8) + 0.004 * exp(-d * d / 0.0006) * exp(-age / 0.3);
  }
  return h;
}
// x: water glow (finger trails), y: sand glow (footprints)
vec2 evGlow(vec2 p){
  vec2 g = vec2(0.);
  for (int i = 0; i < NE; i++){
    if (i >= uNE) break;
    vec4 tt = uEvT[i];
    float age = uT - tt.x;
    if (age < 0. || age > 6.) continue;
    vec4 e = uEv[i];
    if (tt.z < 0.5) {
      // finger trail: flashes bright the moment it is drawn and fades in about 1 s. The trail spreads a little and drifts
      float d = segDist(p, e.xy, e.zw);
      float on = smoothstep(0., 0.04, age);
      float core = exp(-d * d / (0.005 * 0.005)) * exp(-age / 0.25);
      float r = 0.007 + 0.022 * sqrt(age);
      float wake = exp(-d * d / (r * r)) * (exp(-age / 0.4) * 0.75 + exp(-age / 1.4) * 0.25);
      g.x += tt.y * on * (core * 0.9 + wake * 0.6);
    } else {
      // footprint: glows in the shape of the foot the moment it lands, then fades slowly
      float ca = cos(tt.w), sa = sin(tt.w);
      vec2 q = p - e.xy;
      q = vec2(ca * q.x + sa * q.y, -sa * q.x + ca * q.y);
      // water pooled in the dent glows in patches, with a slightly brighter rim
      vec2 wq2 = q * 40. + float(i) * 3.1;
      float f = footShape(q + (vec2(vnoise(wq2), vnoise(wq2 + 7.)) - 0.5) * 0.006, tt.z < 1.5 ? -1. : 1.);
      float on = smoothstep(0., 0.05, age) * (exp(-age / 0.7) * 0.6 + exp(-age / 2.6) * 0.4);
      float rim = exp(-pow((f - 0.9) / 0.12, 2.));
      float inside = smoothstep(1.0, 0.75, f) * (0.35 + 0.65 * smoothstep(0.35, 0.75, vnoise(q * 70. + float(i))));
      g.y += tt.y * on * (rim * 0.45 + inside * 0.8);
      // the sand around the foot glows a little at the moment of the step
      g.y += tt.y * 0.35 * exp(-age / 0.25) * smoothstep(0., 0.04, age) * smoothstep(2.2, 1., f);
    }
  }
  return g;
}
`;

export const vert = /* glsl */ `
${common}
uniform float uIsSand;
uniform float uMirror;
varying vec2 vP;
varying vec3 vW;
void main(){
  vec2 p = vec2(position.x, position.z) + uOrigin;
  float y;
  float far = length(vec2(position.x, position.z));
  if (far < 70.) {
    Surf s = surf(p);
    y = uIsSand > 0.5 ? s.sand : (s.film > 0.002 ? s.y : s.sand - 0.03);
  } else {
    y = uIsSand > 0.5 ? -5. : 0.;
  }
  vP = p;
  vec3 w = vec3(p.x, y, -p.y);
  vW = w;
  if (uMirror > 0.5) w.y = -w.y;   // image mirrored at the water surface (height 0): reflected in wet sand and water
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.);
}
`;

export const frag = /* glsl */ `
${common}
${ripples}
${events}
uniform float uIsSand;
uniform float uMirror;
uniform sampler2D uRefl;
uniform vec2 uRes;
uniform float uGlow;
uniform int uDbg;
varying vec2 vP;
varying vec3 vW;

${lace}

// starlight-only sky (not shown on screen; only what reflects in water and sand)
vec3 nightSky(vec3 d){
  float e = clamp(d.y, 0., 1.);
  return mix(vec3(0.016, 0.022, 0.036), vec3(0.003, 0.004, 0.008), smoothstep(0., 0.35, e));
}
const vec3 AMB = vec3(0.0065, 0.0085, 0.013);
// sea-sparkle glow (Noctiluca blue; the real thing is 470-490 nm)
const vec3 GLOW = vec3(0.03, 0.42, 1.0);

// individual sparks: small cells, each lighting a point for an instant
float sparks(vec2 p, float fw, float cellM, float rate){
  float cs = max(cellM, fw * 1.6);
  vec2 q = p / cs;
  vec2 id = floor(q); vec2 f = fract(q);
  vec3 h0 = hash32(id + 31.7);
  float tt = uT * rate + h0.z * 9.;
  vec3 h = hash32(id + floor(tt) * 1.618);
  vec2 c = h.xy * 0.8 + 0.1;
  float sz = 0.004 + 0.01 * h0.x;
  float r2 = max(sz, pow(0.5 * fw / cs, 2.));
  float pt = exp(-dot(f - c, f - c) / r2) * sz / r2;
  float live = step(0.6, hash12(id + floor(tt) * 3.7));
  return pt * live * pow(sin(3.14159 * fract(tt)), 3.) * 5.2 * (0.2 + 2.4 * h.z * h.z);
}

void main(){
  vec2 p = vP;
  float dist = length(vW - uCam);
  float fw = max(length(fwidth(p)), 1e-4);
  bool near = length(p - uOrigin) < 70.;
  Surf s = surf(p);
  vec3 V = normalize(uCam - vW);
  vec2 suv = gl_FragCoord.xy / uRes;
  vec2 ev = evGlow(p);

  float e = max(0.02, fw * 0.8);
  float hx, hz;
  vec3 col;

  // wet sand: up to where the run-up reaches (3 m from the shoreline). The edge wavers like a wave mark
  float wetEdge = ZS - 3.1 + 0.35 * fbm(vec2(p.x * 0.35, 1.7)) + 0.12 * n1(p.x * 1.7);
  float wet = smoothstep(wetEdge - 0.25, wetEdge + 0.3, p.y);

  if (uIsSand > 0.5) {
    if (!near) discard;
    if (uMirror > 0.5) discard;   // no sand in the mirrored pass (reflect only the water glow)
    hx = sandY(p + vec2(e, 0.)) - s.sand;
    hz = sandY(p + vec2(0., e)) - s.sand;
    vec3 N = normalize(vec3(-hx / e, 1., hz / e));
    float grain = fbm(p * 11.) * 0.5 + fbm(p * 45.) * 0.5;
    vec3 alb = mix(vec3(0.42, 0.40, 0.37), vec3(0.20, 0.19, 0.18), wet) * (0.9 + 0.16 * grain);
    col = alb * AMB * (0.6 + 0.4 * N.y) * 1.4;
    // wet sand is a mirror: reflects the wave glow, blurred by sand grains and the wavering water film
    float F = 0.02 + 0.98 * pow(1. - max(dot(N, V), 0.), 5.);
    vec2 jit = (vec2(fbm(p * 6.), fbm(p * 6. + 9.)) - 0.5) * 0.012 + (N.xz) * 0.02;
    vec3 rf = vec3(0.);
    for (int k = 0; k < 4; k++){
      vec2 o = vec2(float(k) - 1.5, 0.) * 0.0035 + vec2(0., float(k) * 0.006);
      rf += texture2D(uRefl, suv + jit + o).rgb;
    }
    rf *= 0.25;
    col += (rf * 1.7 + nightSky(reflect(-V, N))) * wet * mix(0.45, 1., F);
    // footprints: glow more on wetter sand. Made of clustered grains
    float sp = sparks(p, fw, 0.004, 3.) * 1.4 + sparks(p * 1.4 + 2., fw, 0.007, 2.) + 0.15;
    col += GLOW * (ev.y * (0.2 + 0.8 * wet) + ev.x * 0.7 * wet * wet) * sp * 2.4 * uGlow;
    gl_FragColor = vec4(col, 1.);
    return;
  }

  // water
  if (s.film < 0.0015 && near) discard;
  float h0 = s.y;
  vec3 N;
  if (near) {
    Surf sx = surf(p + vec2(e, 0.));
    Surf sz = surf(p + vec2(0., e));
    hx = sx.y - h0; hz = sz.y - h0;
  } else { hx = 0.; hz = 0.; }
  vec3 rp = rippleSlope(p, fw);
  float calm = mix(0.55, 1., smoothstep(0.0, 0.08, s.film));
  vec2 grad = vec2(hx / e, hz / e) + rp.xy * mix(0.35, 1., calm);
  if (uNE > 0) {
    float ew = 0.004;
    float w0 = evWave(p);
    grad += vec2(evWave(p + vec2(ew, 0.)) - w0, evWave(p + vec2(0., ew)) - w0) / ew;
  }
  N = normalize(vec3(-grad.x, 1., grad.y));

  // ---- glow amount ----
  // strongest on the breaking crest and bore (whitewater), then the run-up leading edge, the foam lace (fresher foam is brighter), and touch trails
  float wn = fbm(p * vec2(5., 7.) + vec2(0., uT * 1.3)) + 0.5 * vnoise(p * vec2(30., 40.) + uT);
  float wh = smoothstep(0.25, 0.9, s.white * (0.55 + 0.7 * wn));
  vec2 wq = p * vec2(6., 9.) + vec2(0., uT * 0.9);
  float lump = fbm(wq) * 0.6 + fbm(wq * 2.3 + 3.) * 0.4;
  float crev = smoothstep(0.3, 0.55, lump);
  vec2 fq = vec2(p.x, p.y + s.adv);
  float patchy = 0.55 + 0.9 * fbm(p * vec2(0.9, 1.6) + 7.);
  float cov = clamp(s.foam * patchy * 1.25, 0., 1.);
  float fl = lace(fq, cov);
  float ed = s.edge * (0.7 + 0.3 * vnoise(p * vec2(9., 30.)));
  float edg = smoothstep(0.35, 0.8, ed);
  float filmMask = smoothstep(0.0015, 0.006, s.film + (p.y > ZS ? 1. : 0.));
  float fm = max(max(fl, wh), edg) * filmMask;

  // whitewater glow follows the foam streaks: lump edges (noise contours) glow thin and bright, gaps stay dark
  float fil2 = 1. - abs(2. * (fbm(wq * 1.7 + 5.) * 0.7 + fbm(wq * 4.1 + 2.) * 0.3) - 1.);
  float strand = smoothstep(0.72, 0.95, fil2);
  // only the most churned part of the front glows. Lighting all the whitewater left behind makes it look like smoke
  float whG = smoothstep(0.5, 1.15, s.white * (0.55 + 0.7 * wn));
  float glow = whG * (0.25 + 0.9 * crev * crev + 2.6 * strand * (0.4 + 0.6 * crev)) * 1.7;
  // the steep face of the bore and breaking wave is the most churned, full of entrained foam. Glow strongly in streaks
  float steep = smoothstep(0.7, 2.2, length(vec2(hx, hz) / e)) * smoothstep(0.05, 0.4, s.white + s.crest);
  glow += steep * (0.4 + 2.2 * strand + 0.8 * crev) * 1.2;
  glow *= mix(0.4, 1., smoothstep(ZS - 0.6, ZS + 0.6, p.y));   // water on the sand is thin, so its glow is subdued too
  glow += edg * 1.3;
  glow += fl * smoothstep(0.35, 1.0, cov) * (1. - smoothstep(0.75, 1.0, fl) * 0.5) * 0.5;
  float churn = fbm(p * 22. + vec2(uT * 0.7, -uT * 0.4));
  float fil = 1. - abs(2. * fbm(p * 38. + vec2(-uT * 0.5, uT * 0.3)) - 1.);
  glow *= filmMask;
  // the glow is a cluster of fine sparks: brighter areas look denser
  float sp = sparks(p, fw, 0.012, 2.4) + sparks(p * 1.31 + 7.7, fw, 0.02, 1.7) * 0.7;
  float g = glow * (0.55 + 0.6 * sp);
  // finger trails are clusters of individual sparks (not a smooth band)
  float spf = sparks(p, fw, 0.005, 3.5) + sparks(p * 1.37 + 4.4, fw, 0.008, 2.6) * 0.8;
  g += ev.x * filmMask * (0.03 + 0.3 * smoothstep(0.7, 0.95, fil) + 1.3 * spf * (0.3 + 0.7 * smoothstep(0.45, 0.8, churn)));
  g *= uGlow;

  float vol = smoothstep(0.05, 1.2, s.white) * (0.6 + 0.4 * wn) + 0.5 * s.crest * smoothstep(0.2, 0.9, s.white);
  if (uMirror > 0.5) {
    // mirrored pass: glow only (used for reflections in wet sand and water)
    float rise = smoothstep(0.05, 0.28, s.y - max(s.sand, 0.));
    gl_FragColor = vec4(GLOW * glow * 1.6 * uGlow * rise, 1.);
    return;
  }

  float NV = max(dot(N, V), 0.);
  float F = 0.02 + 0.98 * pow(1. - max(NV, 0.2), 5.);
  vec3 R = reflect(-V, N);
  if (R.y < 0.) R.y = -R.y * 0.5;
  // reflection: the starlit sky and the mirrored wave glow (distorted by ripples)
  // mirrored glow only on the thin water up the beach (on the open sea it puts ghosts behind the waves)
  vec3 refl = nightSky(normalize(R)) + texture2D(uRefl, suv + grad * vec2(-0.01, 0.015)).rgb * smoothstep(ZS + 0.8, ZS - 0.2, p.y);

  // under the surface: sand shows faintly where shallow; inside the waves light scatters into a blue haze
  float depth = s.film;
  float path = depth / max(0.12, NV);
  vec3 trans = exp(-vec3(3.2, 1.9, 1.8) * path * 3.2);
  vec3 sandC = vec3(0.20, 0.19, 0.18) * AMB * 1.4;
  vec3 body = vec3(0.0012, 0.0026, 0.0034);
  vec3 under = sandC * trans + body * (1. - trans);
  under += GLOW * vol * crev * 0.25 * uGlow;

  F *= mix(0.45, 0.9, calm * smoothstep(1.2, 0.2, s.film));
  col = under * (1. - F) + refl * F;

  // foam: a barely visible grey under starlight, blue only where it glows
  vec3 foamC = vec3(0.55) * AMB * 1.8 * mix(0.6, 1.1, crev);
  col = mix(col, foamC, fm * 0.85);
  col += GLOW * g * 2.4;
  // the bright cores turn whitish
  col += vec3(0.5, 0.8, 1.0) * max(g - 2.2, 0.) * 0.3;

  if (uDbg == 1) col = vec3(s.film * 4.);
  if (uDbg == 2) col = vec3(s.white);
  if (uDbg == 3) col = vec3(s.crest);
  if (uDbg == 4) col = vec3(s.edge);
  if (uDbg == 5) col = vec3(s.foam);
  if (uDbg == 6) col = vec3(glow * 0.3);
  if (uDbg == 7) col = vec3(steep);
  gl_FragColor = vec4(col, 1.);
}
`;

// extract the brightest areas and downsample
export const brightFrag = /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uExposure;
varying vec2 vUv;
void main(){
  vec3 c = vec3(0.);
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++)
    c += texture2D(uTex, vUv + uTexel * (vec2(x, y) - 1.5)).rgb;
  c *= uExposure / 16.;
  gl_FragColor = vec4(max(c - 0.9, 0.), 1.);
}
`;

// blur (separable, vertical and horizontal)
export const blurFrag = /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uDir;
varying vec2 vUv;
void main(){
  vec3 c = vec3(0.); float ws = 0.;
  for (int i = -12; i <= 12; i++){
    float w = exp(-float(i * i) / 50.);
    c += texture2D(uTex, vUv + uDir * float(i)).rgb * w; ws += w;
  }
  gl_FragColor = vec4(c / ws, 1.);
}
`;

// downsample, exposure, bloom, tone, sRGB
export const postFrag = /* glsl */ `
uniform sampler2D uTex;
uniform sampler2D uBloom;
uniform sampler2D uBloom2;
uniform vec2 uTexel;
uniform float uExposure;
uniform float uT;
varying vec2 vUv;
float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main(){
  vec3 c = vec3(0.);
  c += texture2D(uTex, vUv + uTexel * vec2(-0.5, -0.5)).rgb;
  c += texture2D(uTex, vUv + uTexel * vec2( 0.5, -0.5)).rgb;
  c += texture2D(uTex, vUv + uTexel * vec2(-0.5,  0.5)).rgb;
  c += texture2D(uTex, vUv + uTexel * vec2( 0.5,  0.5)).rgb;
  c *= 0.25 * uExposure;
  // sea-sparkle light scatters in the water and softly lights the surrounding water and air blue
  c += texture2D(uBloom, vUv).rgb * 0.3 + texture2D(uBloom2, vUv).rgb * 0.3;
  // vignette
  vec2 q = vUv - 0.5;
  c *= 1. - 0.35 * dot(q, q) * 2.;
  // roll bright values off smoothly toward white (ACES approximation)
  c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
  c = pow(clamp(c, 0., 1.), vec3(1. / 2.2));
  c += (h12(gl_FragCoord.xy + fract(uT) * 91.) - 0.5) / 255. * 2.;
  gl_FragColor = vec4(c, 1.);
}
`;
