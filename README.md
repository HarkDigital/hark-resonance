# Hark Resonance — concept site

*Sound made visible.* A scroll-driven WebGL concept for Hark Digital Design —
"hark" means listen — set in a bright acoustic lab: bone-white studio, liquid
chrome, matte vinyl and foam, and signal green used only as LED light.

**Live:** https://harkdigital.github.io/hark-resonance/

Sister concepts for comparison:
[Orbit (space)](https://harkdigital.github.io/hark-igloo/) ·
[the 2026 site build](https://harkdigital.github.io/hark-digital-2026/).
Copy, services, portfolio and testimonials come from the 2026 site
(`Clients/Hark Digital 2026 Website/site-v2/src/data`) via `src/content.ts`.

## The story

| # | Chapter | What happens |
|---|---------|--------------|
| 01 | **Listen** (`hero`) | An anechoic chamber of foam wedges; the mark floats in liquid chrome with a green LED. Pressure waves roll through the foam → *Make the internet listen.* set like an album cover |
| 02 | **The Crate** (`work`) | *Built to be heard.* Projects as 12" sleeves in a record crate — sleeves flip forward, the record slides out and spins; then the nine more |
| 03 | **Liner Notes** (`voices`) | *We listen. They talk.* An Unknown-Pleasures ridgeline plot; each testimonial is a cut |
| 04 | **Cymatics** (`services`) | *Eleven ways to be heard.* Sand on a vibrating Chladni plate forms a new pattern per service, finally the Hark mark |
| 05 | **Noise Floor** (`shield`) | A bench oscilloscope: a red intrusion trace is cancelled by a green anti-phase trace → *Hacked? Breathe.* → 24/7 |
| 06 | **The Desk** (`process`) | *We listen first. Then we build.* Mixing-desk faders push up for Listen · Prototype · Build · Support; LED readouts show the real stats |
| 07 | **Say Hello** (`contact`) | The mark as ferrofluid whose spikes chase your cursor; the email set as record credits |

The loader ends with a choice — **Play with sound** or **Enter quietly** — since
sound is the point (add `?gate` to always ask). Chapter cuts are a pressure-wave ripple with a paper wash. Text reveals are a
word-rise. Phones held sideways get a "turn your phone upright" screen.
Screen readers and keyboards get the whole story as linear semantic HTML
(`src/core/srContent.ts`), and the visuals follow keyboard focus. Audio
(generative WebAudio, off by default) plays a real tone in the cymatics chapter.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # typecheck + production build → dist/
```

URL params: `?nointro`, `?c=work&l=0.5` (chapter at local progress), `?p=0.4`,
`?only=hero`, `?debug`.

Screenshots at exact scroll positions (headless Chrome):

```bash
npx vite --config vite.shots.config.ts --port 5290 --strictPort   # no-HMR server
node scripts/shot.mjs --port=5290 --frames=hero:0.3,work:0.2 --out=shots [--mobile]
```

## How it's built

Same engine as the Orbit concept (Vite + TypeScript + Three.js r186 + Lenis):
one fixed canvas, the page scroll only provides length, each chapter gets a
scroll range and local progress 0..1, and only the active chapter renders.

- `src/studio/Studio.ts` — the shared studio: a backdrop dome that blends
  between a bone cyclorama and a graphite room per chapter, plus a procedural
  photo-studio environment map (strip lights, softbox) so chrome and metal get
  product-shot reflections. Tone mapping is Khronos PBR Neutral.
- `src/core/post.ts` — HDR render → NaN guard → bloom (HDR-only) → output →
  ripple/paper final pass.
- `src/chapters/<id>/` — self-contained scenes with their own HUD copy and CSS.
- `src/ui/` — chrome (nav, audio switch, tape-counter track readout), loader,
  sound, rotate gate, no-WebGL fallback.

## Deploy

Pushes to `main` deploy to GitHub Pages via `.github/workflows/deploy.yml`
(built with `--base=/hark-resonance/`, `noindex` so the concept never competes
with hark.digital in search).
