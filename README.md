# Glowing Shore

A beach at night where the breaking waves glow blue, in three.js. Drag across the water and it lights up where you touch it, the way sea sparkle (*Noctiluca*, a dinoflagellate) flashes when the water is stirred.

**Open: https://aiimpl.github.io/glowing-shore/** (Shore / Above switch at the bottom)

Nothing is pre-rendered and there are no image files: the waves, the foam, the sand and the light are all computed in the browser.

## How it is built

| | |
|---|---|
| Waves | Each wave is a function of time (from [reality-js](https://github.com/aiimpl/reality-js)): a swell steepens, breaks from the crest down, runs up the sand as a bore and slides back. Waves come in at an angle, so a break peels along the beach |
| What glows | Only water that is being stirred: the breaking crest and the front of the bore, the leading edge of the run-up, and fresh foam. The light follows the strands of the foam, not its whole area, and fades within a second, so the sea stays dark between flashes |
| Grains | The light is made of single flashes: small cells that each light up for a moment at a random time, denser where the water is more stirred |
| Your finger | Each drag segment is kept with its time. In the water it leaves a trail of flashes that spreads and fades, plus rings of ripples on the surface |
| Footprints | Steps on wet sand press a foot-shaped hollow into the sand, and the water left in it glows, brightest at the rim, then fades over a few seconds |
| Reflection | The glowing water is drawn a second time, mirrored in the water plane, at half size. Wet sand and the thin water of the run-up show it, blurred by the grain of the sand |
| Post | Bloom at 1/4 and 1/16 size, ACES tone mapping, vignette and grain. The film is drawn at 2x and three sub-frames per frame (motion blur) |

- `web/src/shaders.js`: the waves, the glow, footprints, finger trails, foam, bloom and tone mapping
- `web/src/main.js`: grids, the mirrored pass, bloom, the five shots of the film, the page
- `tools/`: frames for the video (`render.py`), the mp4 (`encode.sh`), a row of stills (`sheet.sh`), a page check at desktop and phone size (`check_page.py`)

```sh
make serve          # http://127.0.0.1:8812/
make setup          # Python + Playwright for the video and the check
make preview        # a rough 30 fps version of the film, about a minute
make film video     # build/yakouchu.mp4 (1080x1350, 60 fps)
make check          # pyflakes, then the page at desktop and phone size
```

## License

MIT (`LICENSE`). three.js is MIT, see `web/vendor/three/LICENSE`.
