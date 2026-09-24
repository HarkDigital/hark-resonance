import * as THREE from 'three'
import { rng } from '../../core/math'

/*
 * The stacked ridgeline plot (after the CP 1919 pulsar plot on Unknown
 * Pleasures), built as real geometry:
 *
 *  - every row is a screen-space ribbon (constant pixel width, analytic AA),
 *    its height computed in the vertex shader from a voiceprint texture;
 *  - under every row hangs an invisible, depth-only "curtain" that occludes
 *    the rows behind it, so the graphite backdrop shows through untouched
 *    (the classic look, without having to match the backdrop colour).
 *
 * Voiceprints are baked on the CPU into one R16F texture: layer 0 is silence,
 * layer 1 the chapter's own "house" print, layers 2.. one per testimonial,
 * derived from the words of the quote (phrases → loud bands of rows, words →
 * syllabic jitter, letters → formant peaks). The same data drives a CPU
 * mirror of the height function so HUD elements can ride the lines exactly.
 */

/** Groove radius of the back (innermost) and front (outermost) rows: a 12" record, label and all. */
export const GROOVE_R = [1.05, 3.2] as const

export interface Voice {
  text: string
  seed: number
}

const hashStr = (s: string) => {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}

/** Smooth 1D value noise over a seeded lattice. */
function valueNoise(seed: number) {
  const r = rng(seed)
  const lat = new Float32Array(256)
  for (let i = 0; i < 256; i++) lat[i] = r() * 2 - 1
  return (x: number) => {
    const i = Math.floor(x)
    const f = x - i
    const a = lat[i & 255]
    const b = lat[(i + 1) & 255]
    return a + (b - a) * (f * f * (3 - 2 * f))
  }
}

/**
 * Bake one voiceprint into `out` (rows × samples, row-major, 0 = front row).
 * Heights are normalised so the loudest peak is ~1.
 */
function bakeVoice(out: Float32Array, rows: number, samples: number, v: Voice | null, house: boolean) {
  if (!v) return
  const r = rng(v.seed)
  const n1 = valueNoise(v.seed ^ 0x9e3779b9)
  const n2 = valueNoise(v.seed ^ 0x85ebca6b)
  const n3 = valueNoise(v.seed ^ 0xc2b2ae35)

  // timbre: where the voice sits across the plot and how wide it spreads
  const cx = house ? 0 : (r() - 0.5) * 0.3
  const spread = house ? 0.3 : 0.24 + r() * 0.14
  const sharp = house ? 1 : 0.75 + r() * 0.55

  // --- loudness across rows: phrases become loud bands, words syllables
  const amp = new Float32Array(rows)
  const letters: string[] = new Array(rows).fill('')
  if (house) {
    for (let i = 0; i < rows; i++) {
      amp[i] = 0.55 + 0.45 * (0.5 + 0.5 * n1(i * 0.21 + 3.1))
      letters[i] = ''
    }
  } else {
    const phrases = v.text
      .split(/[,.;:!?]+/)
      .map(p => p.trim().split(/\s+/).filter(Boolean))
      .filter(p => p.length > 0)
    const words = phrases.reduce((a, p) => a + p.length, 0)
    const lead = 2
    const gap = 2
    const usable = rows - lead * 2 - gap * (phrases.length - 1)
    let row = lead
    for (let i = 0; i < rows; i++) amp[i] = 0.2 + 0.12 * r()
    phrases.forEach((p, pi) => {
      const span = Math.max(3, Math.round((p.length / words) * usable))
      const loud = 0.72 + r() * 0.28
      for (let k = 0; k < span && row < rows - 1; k++, row++) {
        const u = (k + 0.5) / span
        const w = p[Math.min(p.length - 1, Math.floor(u * p.length))]
        const wl = Math.min(1, w.replace(/[^a-z]/gi, '').length / 8)
        // attack fast, decay slow — the way a spoken phrase lands
        const env = Math.pow(Math.max(0, Math.sin(Math.PI * Math.min(1, u * 1.25 + 0.04))), 0.6)
        amp[row] = Math.max(amp[row], loud * env * (0.55 + 0.45 * wl) * (0.85 + 0.3 * r()))
        letters[row] = w.toLowerCase()
      }
      if (pi < phrases.length - 1) row += gap
    })
  }

  // --- formant clusters: one spire, twin ridges or a wide fan per voice
  const nc = house ? 1 : 1 + (v.seed % 3)
  const sep = nc === 1 ? 0 : nc === 2 ? 0.26 + r() * 0.12 : 0.2 + r() * 0.06
  const centres: number[] = []
  for (let c = 0; c < nc; c++) centres.push(cx + (c - (nc - 1) / 2) * sep * (1 + (r() - 0.5) * 0.3))
  const cs = house ? spread : spread / Math.sqrt(nc) * (nc > 1 ? 0.85 : 1)
  const weight = centres.map(() => 0.7 + r() * 0.3)

  // the envelope is zero outside [lo, hi]
  const lo = Math.min(...centres) - cs * 1.45
  const hi = Math.max(...centres) + cs * 1.45
  const rowBuf = new Float32Array(samples)

  // --- peaks per row
  let max = 0
  const peaks: { p: number; a: number; w: number }[] = []
  for (let i = 0; i < rows; i++) {
    peaks.length = 0
    const word = letters[i]
    const count = house ? 4 + Math.floor(r() * 4) : Math.min(8, 2 + Math.ceil(word.length * 0.7))
    for (let k = 0; k < count; k++) {
      let pos: number
      let ci = 0
      if (!house && word.length) {
        // letters as formants: each letter has a home cluster and frequency
        const c = word.charCodeAt(k % word.length) - 97
        ci = ((c % nc) + nc) % nc
        const home = (((c * 0.618034) % 1) + 1) % 1
        pos = centres[ci] + (home - 0.5) * 2 * cs * 0.8 + (r() - 0.5) * 0.05
      } else {
        ci = Math.floor(r() * nc)
        const g = (r() + r() + r()) / 3 - 0.5
        pos = centres[ci] + g * 2.4 * cs
      }
      const a = (0.35 + 0.65 * r()) * weight[ci] * (1 - Math.min(1, Math.abs(pos - centres[ci]) / (cs * 1.4)) * 0.6)
      const w = (0.012 + r() * 0.03) / sharp
      peaks.push({ p: pos, a, w })
    }
    const off = i * samples
    const ra = amp[i]
    // peaks first, sparsely: each only touches samples within 3.5 widths
    rowBuf.fill(0)
    for (const pk of peaks) {
      const s0 = Math.max(0, Math.floor(((pk.p - pk.w * 3.5 + 1) / 2) * (samples - 1)))
      const s1 = Math.min(samples - 1, Math.ceil(((pk.p + pk.w * 3.5 + 1) / 2) * (samples - 1)))
      for (let s = s0; s <= s1; s++) {
        const t = ((s / (samples - 1)) * 2 - 1 - pk.p) / pk.w
        rowBuf[s] += pk.a * Math.exp(-t * t)
      }
    }
    for (let s = 0; s < samples; s++) {
      const x = (s / (samples - 1)) * 2 - 1
      // the noise floor: never perfectly flat
      let y = n1(x * 55 + i * 13.7) * 0.012 + n3(x * 140 + i * 5.1) * 0.005
      if (x > lo && x < hi) {
        // flat at the edges, a burst around each formant cluster
        let env = 0
        let hump = 0
        for (let c = 0; c < nc; c++) {
          const d = Math.abs(x - centres[c])
          env = Math.max(env, 1 - smooth(cs * 0.55, cs * 1.45, d))
          const q = d / (cs * 0.75)
          hump += Math.exp(-q * q) * 0.3 * weight[c]
        }
        if (env > 0) {
          const h = rowBuf[s]
          const jag = n2(x * 38 + i * 7.3) * 0.16 + n3(x * 90 + i * 3.1) * 0.06
          y += env * ra * (h * 0.85 + hump + jag * (0.4 + h))
        }
      }
      out[off + s] = y
      if (y > max) max = y
    }
  }
  const k = max > 0 ? 1 / max : 1
  for (let j = 0; j < rows * samples; j++) out[j] *= k
}

function smooth(a: number, b: number, v: number) {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/* ------------------------------------------------------------------ GLSL */

const HEIGHT_GLSL = /* glsl */ `
uniform sampler2D uTex;
uniform float uRows, uSamples, uLayers;
uniform float uA, uB, uMorphT, uMorphSpan, uCalm;
uniform float uTime, uFlow, uIn, uGain;
uniform float uHalfW, uDepth, uDepthScale, uHeight, uWScale;
uniform vec4 uPoke; // x (-1..1), rowN, strength, unused
uniform float uGroove; // 1 = every row bent into a record groove, 0 = straight
uniform vec2 uGrooveR; // groove radius of the back row, the front row

float prof(float layer, float x, float row) {
  float u = ((x * 0.5 + 0.5) * (uSamples - 1.0) + 0.5) / uSamples;
  float v = (layer * uRows + row + 0.5) / (uRows * uLayers);
  return texture2D(uTex, vec2(u, v)).r;
}

// damped spring step: ~27% overshoot, settles in ~1.2 s
float spring(float t) {
  if (t <= 0.0) return 0.0;
  const float z = 0.38;
  const float w = 9.0;
  float wd = w * sqrt(1.0 - z * z);
  return 1.0 - exp(-z * w * t) * (cos(wd * t) + (z * w / wd) * sin(wd * t));
}

float rowGain(float rowN) {
  // in-beat: rows spring up front → back as the chapter arrives
  float t = clamp(uIn * 1.7 - rowN * 0.7, 0.0, 1.0);
  float c1 = 1.70158, c3 = c1 + 1.0;
  // easeOutBack, written out: never pow() a negative base
  float u = t - 1.0;
  float back = 1.0 + c3 * u * u * u + c1 * u * u;
  return back * uGain;
}

float heightAt(float x, float row) {
  float rowN = row / max(uRows - 1.0, 1.0);
  float a = prof(uA, x, row);
  float b = prof(uB, x, row);
  float tr = uMorphT - rowN * uMorphSpan;
  float s = uCalm > 0.5 ? smoothstep(0.0, 0.9, tr) : spring(tr);
  float h = mix(a, b, s);
  // the pressure front passing through the row as it reshapes
  float pq = (tr - 0.1) / 0.11;
  float pf = uCalm > 0.5 ? 0.0 : exp(-pq * pq);
  h += pf * 0.2 * exp(-x * x * 7.0);
  // live: a slow pressure wave rolling front → back + a fine flutter
  h *= 1.0 + uFlow * (0.16 * sin(row * 0.42 - uTime * 1.7) + 0.05 * sin(uTime * 6.3 + row * 2.1));
  h += uFlow * 0.035 * exp(-x * x * 7.0) * sin(x * 29.0 + uTime * 1.9 + row * 1.3) * sin(x * 11.0 - uTime * 1.2 + row * 0.7);
  // the pointer presses into the stack: a swell with rings running outward
  float pdx = (x - uPoke.x) * uHalfW;
  float pdz = (rowN - uPoke.y) * uDepth;
  float pr = sqrt(pdx * pdx + pdz * pdz);
  h += uPoke.z * exp(-pr * pr * 2.2) * (0.16 + 0.1 * cos(pr * 11.0 - uTime * 9.0));
  return h * rowGain(rowN);
}

vec3 plotPos(float x, float row, float h) {
  float rowN = row / max(uRows - 1.0, 1.0);
  float z = uDepth * 0.5 - rowN * uDepth * uDepthScale;
  vec3 p = vec3(x * uHalfW * uWScale, h * uHeight, z);
  if (uGroove > 0.0005) {
    // the in-beat: each row is a groove of the record, a full ring around the
    // plot's centre (front row outermost), that unrolls into its straight
    // line as uGroove -> 0: curvature g/R, arc length pi*R -> the row width,
    // the arc's midpoint gliding from the ring's front to the row's own z
    float g = uGroove;
    float R = mix(uGrooveR.y, uGrooveR.x, rowN);
    float k = g / R;
    float a = x * mix(uHalfW * uWScale, 3.14159265 * R, g) * k;
    float s = sin(a * 0.5);
    p.x = sin(a) / k;
    p.z = mix(z, R, g) - 2.0 * s * s / k;
  }
  return p;
}
`

const LINE_VERT = /* glsl */ `
${HEIGHT_GLSL}
attribute float aX;
attribute float aRow;
attribute float aSide;
uniform vec2 uRes;
uniform float uLineW;
varying float vDist;
varying float vCore;
varying float vRowN;
varying float vX;
varying float vFront;
varying float vGap;

void main() {
  float dx = 2.0 / (uSamples - 1.0);
  float x0 = max(aX - dx, -1.0);
  float x1 = min(aX + dx, 1.0);
  vec3 p = plotPos(aX, aRow, heightAt(aX, aRow));
  vec3 pa = plotPos(x0, aRow, heightAt(x0, aRow));
  vec3 pb = plotPos(x1, aRow, heightAt(x1, aRow));
  mat4 mvp = projectionMatrix * modelViewMatrix;
  vec4 c = mvp * vec4(p, 1.0);
  vec4 ca = mvp * vec4(pa, 1.0);
  vec4 cb = mvp * vec4(pb, 1.0);
  vec2 sa = ca.xy / ca.w * uRes;
  vec2 sb = cb.xy / cb.w * uRes;
  vec2 d = sb - sa;
  float len = length(d);
  vec2 dir = len > 1e-5 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  vRowN = aRow / max(uRows - 1.0, 1.0);
  float trow = uMorphT - vRowN * uMorphSpan;
  float fq = (trow - 0.1) / 0.13;
  vFront = uCalm > 0.5 ? 0.0 : exp(-fq * fq);
  // the record's eight cuts: the first row of every band after the first is
  // a quiet track gap (only drawn while the rows are grooves)
  vGap = aRow > 0.5 && floor(aRow * 8.0 / uRows + 1e-3) != floor((aRow - 1.0) * 8.0 / uRows + 1e-3) ? 1.0 : 0.0;
  float core = uLineW * mix(1.0, 0.62, vRowN) * 0.5;
  float half_ = core + 1.0;
  vCore = core;
  vDist = aSide * half_;
  vX = aX;
  c.xy += n * aSide * half_ * 2.0 / uRes * c.w;
  gl_Position = c;
}
`

const LINE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uBright;
uniform float uFadeBack;
uniform float uSolo;
uniform float uGroove;
varying float vDist;
varying float vCore;
varying float vRowN;
varying float vX;
varying float vFront;
varying float vGap;
void main() {
  // analytic coverage: a box of half-width vCore against a 1px pixel
  float d = abs(vDist);
  float cov = clamp(vCore + 0.5 - d, 0.0, 1.0) * min(1.0, vCore * 2.0);
  // grooves are closed rings; straight rows fade out at their flat ends
  float ends = mix(1.0 - smoothstep(0.8, 1.0, abs(vX)), 1.0, uGroove);
  float depth = mix(mix(1.0, uFadeBack, smoothstep(0.15, 1.0, vRowN)), 0.72 - 0.3 * vRowN, uGroove);
  // the record: a two-lobed vinyl sheen that stays put in the light, and
  // eight cuts separated by quiet track gaps
  float c = abs(cos(vX * 3.14159265 - 0.785398));
  float c2 = c * c;
  float c4 = c2 * c2;
  depth *= mix(1.0, (0.4 + 1.1 * c4 * c4) * (1.0 - 0.8 * vGap), uGroove);
  // the out-beat: rows peel away back → front as the stack folds into one line
  float cut = 1.04 - uSolo * 1.01;
  float solo = 1.0 - smoothstep(cut - 0.03, cut, vRowN);
  // the reshaping wave front reads as a bright band travelling back
  float lift = 1.0 + vFront * 0.75;
  float a = cov * ends * min(1.0, depth + vFront * 0.6) * solo;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor * uBright * lift, a);
}
`

const FILL_VERT = /* glsl */ `
${HEIGHT_GLSL}
attribute float aX;
attribute float aRow;
attribute float aSide;
uniform float uBase;
uniform float uEps;
void main() {
  vec3 p = plotPos(aX, aRow, heightAt(aX, aRow));
  if (aSide > 0.5) p.y = uBase;
  p.z -= uEps;
  // flat grooves seen from above: drop the curtain a hair below its line
  p.y -= uEps * 3.0 * uGroove;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`

/* ------------------------------------------------------- the LED sprite */

/** A tiny HDR signal-green LED (constant pixel size) — bloom makes it glow. */
export class Led {
  mesh: THREE.Mesh
  uniforms = {
    uRes: { value: new THREE.Vector2(1, 1) },
    uPx: { value: 18 },
    uIntensity: { value: 1 },
  }
  constructor() {
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        uniform vec2 uRes;
        uniform float uPx;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec4 c = projectionMatrix * modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          c.xy += position.xy * uPx / uRes * 2.0 * c.w;
          gl_Position = c;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uIntensity;
        varying vec2 vUv;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          // (smoothstep edges kept ascending: reversed edges are undefined in GLSL ES)
          float core = 1.0 - smoothstep(0.2, 0.34, d);
          float halo = exp(-d * d * 9.0) * 0.55;
          vec3 col = vec3(0.0, 1.0, 0.52) * (core * 3.2 + halo) + vec3(0.8, 1.0, 0.9) * (1.0 - smoothstep(0.0, 0.16, d)) * 2.0;
          float a = clamp(core + halo, 0.0, 1.0) * uIntensity;
          if (a < 0.004) discard;
          gl_FragColor = vec4(col * uIntensity, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 5
  }
}

/* -------------------------------------------------------------- the plot */

export class Ridges {
  group = new THREE.Group()
  readonly rows: number
  readonly samples: number
  readonly layers: number
  /** baked voiceprints, [layer][row][sample] */
  readonly data: Float32Array
  /** world size of the plot */
  readonly halfW = 3
  readonly depth = 6.4
  readonly heightScale = 0.8
  uniforms: Record<string, THREE.IUniform>
  private lineMat: THREE.ShaderMaterial
  private fillMat: THREE.ShaderMaterial

  constructor(voices: (Voice | null)[], { rows, samples }: { rows: number; samples: number }) {
    this.rows = rows
    this.samples = samples
    this.layers = voices.length
    const per = rows * samples
    this.data = new Float32Array(per * this.layers)
    voices.forEach((v, i) => bakeVoice(this.data.subarray(i * per, (i + 1) * per), rows, samples, v, i === 1))

    const half = new Uint16Array(this.data.length)
    for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(this.data[i])
    const tex = new THREE.DataTexture(half, samples, rows * this.layers, THREE.RedFormat, THREE.HalfFloatType)
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
    tex.generateMipmaps = false
    tex.needsUpdate = true

    this.uniforms = {
      uTex: { value: tex },
      uRows: { value: rows },
      uSamples: { value: samples },
      uLayers: { value: this.layers },
      uA: { value: 0 },
      uB: { value: 1 },
      uMorphT: { value: 10 },
      uMorphSpan: { value: 0.55 },
      uCalm: { value: 0 },
      uTime: { value: 0 },
      uFlow: { value: 1 },
      uIn: { value: 1 },
      uGain: { value: 1 },
      uHalfW: { value: this.halfW },
      uDepth: { value: this.depth },
      uDepthScale: { value: 1 },
      uHeight: { value: this.heightScale },
      uWScale: { value: 1 },
      uRes: { value: new THREE.Vector2(1, 1) },
      uLineW: { value: 1.4 },
      uColor: { value: new THREE.Color('#eeebe4') },
      uBright: { value: 1 },
      uFadeBack: { value: 0.4 },
      uSolo: { value: 0 },
      uPoke: { value: new THREE.Vector4(0, 0, 0, 0) },
      uGroove: { value: 0 },
      uGrooveR: { value: new THREE.Vector2(GROOVE_R[0], GROOVE_R[1]) },
      uBase: { value: -0.35 },
      uEps: { value: 0.012 },
    }

    // --- shared per-vertex attributes: rows × samples × 2
    const n = rows * samples * 2
    const aX = new Float32Array(n)
    const aRow = new Float32Array(n)
    const aSide = new Float32Array(n)
    const aTop = new Float32Array(n)
    let o = 0
    for (let r = 0; r < rows; r++)
      for (let s = 0; s < samples; s++) {
        const x = (s / (samples - 1)) * 2 - 1
        for (let k = 0; k < 2; k++) {
          aX[o] = x
          aRow[o] = r
          aSide[o] = k === 0 ? -1 : 1
          aTop[o] = k
          o++
        }
      }
    const idx = new Uint32Array(rows * (samples - 1) * 6)
    let j = 0
    for (let r = 0; r < rows; r++)
      for (let s = 0; s < samples - 1; s++) {
        const a = (r * samples + s) * 2
        idx[j++] = a
        idx[j++] = a + 1
        idx[j++] = a + 2
        idx[j++] = a + 1
        idx[j++] = a + 3
        idx[j++] = a + 2
      }
    const index = new THREE.BufferAttribute(idx, 1)
    const xAttr = new THREE.BufferAttribute(aX, 1)
    const rowAttr = new THREE.BufferAttribute(aRow, 1)

    const lineGeo = new THREE.BufferGeometry()
    lineGeo.setIndex(index)
    lineGeo.setAttribute('aX', xAttr)
    lineGeo.setAttribute('aRow', rowAttr)
    lineGeo.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1))
    // three needs a position attribute for bounds; the plot is never culled
    lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3))
    lineGeo.setDrawRange(0, idx.length)

    const fillGeo = new THREE.BufferGeometry()
    fillGeo.setIndex(index)
    fillGeo.setAttribute('aX', xAttr)
    fillGeo.setAttribute('aRow', rowAttr)
    fillGeo.setAttribute('aSide', new THREE.BufferAttribute(aTop, 1))
    fillGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3))
    fillGeo.setDrawRange(0, idx.length)

    this.fillMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: FILL_VERT,
      fragmentShader: /* glsl */ `void main() { gl_FragColor = vec4(0.0); }`,
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
    })
    this.lineMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    })

    const fill = new THREE.Mesh(fillGeo, this.fillMat)
    fill.frustumCulled = false
    fill.renderOrder = 1
    const line = new THREE.Mesh(lineGeo, this.lineMat)
    line.frustumCulled = false
    line.renderOrder = 2
    this.group.add(fill, line)
  }

  /* ---------------------------------------------- CPU mirror of heightAt */

  private prof(layer: number, x: number, row: number) {
    const f = (x * 0.5 + 0.5) * (this.samples - 1)
    const i = Math.max(0, Math.min(this.samples - 2, Math.floor(f)))
    const t = Math.min(1, Math.max(0, f - i))
    const o = (layer * this.rows + row) * this.samples + i
    return this.data[o] + (this.data[o + 1] - this.data[o]) * t
  }

  heightAt(x: number, row: number) {
    const u = this.uniforms
    const rowN = row / Math.max(this.rows - 1, 1)
    const a = this.prof(u.uA.value, x, row)
    const b = this.prof(u.uB.value, x, row)
    const tr = u.uMorphT.value - rowN * u.uMorphSpan.value
    let s: number
    if (u.uCalm.value > 0.5) s = smooth(0, 0.9, tr)
    else if (tr <= 0) s = 0
    else {
      const z = 0.38
      const w = 9
      const wd = w * Math.sqrt(1 - z * z)
      s = 1 - Math.exp(-z * w * tr) * (Math.cos(wd * tr) + ((z * w) / wd) * Math.sin(wd * tr))
    }
    let h = a + (b - a) * s
    const pq = (tr - 0.1) / 0.11
    const pf = u.uCalm.value > 0.5 ? 0 : Math.exp(-pq * pq)
    h += pf * 0.2 * Math.exp(-x * x * 7)
    const t = u.uTime.value
    const fl = u.uFlow.value
    h *= 1 + fl * (0.16 * Math.sin(row * 0.42 - t * 1.7) + 0.05 * Math.sin(t * 6.3 + row * 2.1))
    h += fl * 0.035 * Math.exp(-x * x * 7) * Math.sin(x * 29 + t * 1.9 + row * 1.3) * Math.sin(x * 11 - t * 1.2 + row * 0.7)
    const pk = u.uPoke.value as THREE.Vector4
    if (pk.z > 0) {
      const pdx = (x - pk.x) * this.halfW
      const pdz = (rowN - pk.y) * this.depth
      const pr = Math.sqrt(pdx * pdx + pdz * pdz)
      h += pk.z * Math.exp(-pr * pr * 2.2) * (0.16 + 0.1 * Math.cos(pr * 11 - t * 9))
    }
    const tt = Math.min(1, Math.max(0, u.uIn.value * 1.7 - rowN * 0.7))
    const c1 = 1.70158
    const q = tt - 1
    const back = 1 + (c1 + 1) * q * q * q + c1 * q * q
    return h * back * u.uGain.value
  }

  /**
   * CPU mirror of plotPos: local-space position of plot coordinate x on the
   * row at rowN (0 front .. 1 back) with height h, for a given groove amount,
   * depth scale and width scale (defaults: the current uniforms).
   */
  plotPoint(
    x: number,
    rowN: number,
    h: number,
    out: THREE.Vector3,
    g: number = this.uniforms.uGroove.value,
    ds: number = this.uniforms.uDepthScale.value,
    ws: number = this.uniforms.uWScale.value,
  ) {
    const z = this.depth * 0.5 - rowN * this.depth * ds
    out.set(x * this.halfW * ws, h * this.heightScale, z)
    if (g > 0.0005) {
      const R = GROOVE_R[1] + (GROOVE_R[0] - GROOVE_R[1]) * rowN
      const k = g / R
      const a = x * (this.halfW * ws + (Math.PI * R - this.halfW * ws) * g) * k
      const s = Math.sin(a * 0.5)
      out.x = Math.sin(a) / k
      out.z = z + (R - z) * g - (2 * s * s) / k
    }
    return out
  }

  /** Local-space position of a point on a row (0 = front). */
  pointAt(x: number, row: number, out: THREE.Vector3) {
    return this.plotPoint(x, row / Math.max(this.rows - 1, 1), this.heightAt(x, row), out)
  }

  /** Front→back extent in local z for the current depth scale. */
  zRange() {
    const d = this.depth * this.uniforms.uDepthScale.value
    return [this.depth * 0.5 - d, this.depth * 0.5] as const
  }

  static voiceFrom(text: string, name: string): Voice {
    return { text, seed: hashStr(name + '|' + text.length) }
  }
}
