import { logoPoints, logoShapes } from '../../logo/logo'
import { rng } from '../../core/math'

/*
 * Chladni modes of a square plate driven at its centre, and the per-grain
 * sand targets for every one of them.
 *
 *   f(x, y) = cos(nπx)·cos(mπy) ± cos(mπx)·cos(nπy),   x, y ∈ [-1, 1]
 *
 * Sand collects where the plate stands still (f ≈ 0). For each mode we
 * sample grain positions from a Gaussian band around the nodal lines
 * (distance estimate |f| / |∇f|), with low-frequency density variation and a
 * few stray grains, like real footage. Consecutive modes are matched grain to
 * grain along a Hilbert curve, so each grain only migrates locally when the
 * frequency changes instead of teleporting across the plate.
 *
 * Output: one RG float texture, TEX_W wide. Row block 0 = scattered sand at
 * rest, 1..11 = the service modes, 12 = the Hark mark. The plate spans
 * -1..1 on world x/z; texture (x, y) = world (x, z).
 */

export interface Mode {
  n: number
  m: number
  /** +1 / -1: which superposition */
  s: 1 | -1
  /** decorative drive frequency (∝ n² + m², like a real plate) */
  hz: number
}

const mode = (n: number, m: number, s: 1 | -1): Mode => ({ n, m, s, hz: Math.round(42.9 * (n * n + m * m)) })

/** One mode per service, rising in frequency and complexity. */
export const MODES: Mode[] = [
  mode(1, 2, 1), // 01 diamond + ring            214 Hz
  mode(1, 3, 1), // 02 cross + ring              429 Hz
  mode(2, 3, 1), // 03 diamond + quatrefoil      558 Hz
  mode(1, 4, -1), // 04 saltire + ring + waves   729 Hz
  mode(2, 4, -1), // 05 saltire + four rings     858 Hz
  mode(1, 5, 1), // 06 grid of bow-ties         1115 Hz
  mode(2, 5, 1), // 07 flower                   1244 Hz
  mode(3, 5, 1), // 08 crossed rings            1459 Hz
  mode(2, 6, 1), // 09 grid of rings            1716 Hz
  mode(4, 5, -1), // 10 chevrons                1759 Hz
  mode(2, 7, 1), // 11 lace                     2274 Hz
]

/** the finale "mode": the Hark mark (Hark, est. 2016) */
export const LOGO_HZ = 2016
export const ROW_LOGO = MODES.length + 1
export const MODE_ROWS = MODES.length + 2
export const TEX_W = 256

/** the Hark mark on the plate: world units per logo unit */
export const LOGO_SCALE = 1.28
/** keep-out zones: the centre bolt and the accelerometer puck */
export const BOLT_R = 0.05
export const PUCK = { x: 0.8, z: -0.8, r: 0.1 }

const EDGE = 0.975

const blocked = (x: number, y: number) =>
  x * x + y * y < BOLT_R * BOLT_R || (x - PUCK.x) ** 2 + (y - PUCK.z) ** 2 < PUCK.r * PUCK.r

/* ---------- small value noise for natural density variation ---------- */
function valueNoise(seed: number) {
  const R = 16
  const r = rng(seed)
  const g = new Float32Array(R * R)
  for (let i = 0; i < g.length; i++) g[i] = r()
  const at = (i: number, j: number) => g[(((j % R) + R) % R) * R + (((i % R) + R) % R)]
  return (x: number, y: number) => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    let fx = x - xi
    let fy = y - yi
    fx = fx * fx * (3 - 2 * fx)
    fy = fy * fy * (3 - 2 * fy)
    const a = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * fx
    const b = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * fx
    return a + (b - a) * fy
  }
}

/* ---------- Hilbert ordering + radix sort ---------- */
const H_N = 256
let hLut: Uint16Array | null = null
/** Hilbert index of every cell of a 256² grid (built once, ~65k entries). */
function hilbertLut() {
  if (hLut) return hLut
  hLut = new Uint16Array(H_N * H_N)
  for (let j = 0; j < H_N; j++)
    for (let i = 0; i < H_N; i++) {
      let x = i,
        y = j,
        d = 0
      for (let s = H_N >> 1; s > 0; s >>= 1) {
        const rx = (x & s) > 0 ? 1 : 0
        const ry = (y & s) > 0 ? 1 : 0
        d += s * s * ((3 * rx) ^ ry)
        if (ry === 0) {
          if (rx === 1) {
            x = H_N - 1 - x
            y = H_N - 1 - y
          }
          const t = x
          x = y
          y = t
        }
      }
      hLut[j * H_N + i] = d
    }
  return hLut
}

/**
 * Indices of `pts` (xy pairs in [-1,1]) sorted along a Hilbert curve. Uses
 * `a` and `b` as scratch; the result is always `a` (two radix passes).
 */
function hilbertOrder(pts: Float32Array, count: number, keys: Uint16Array, a: Uint32Array, b: Uint32Array) {
  const lut = hilbertLut()
  for (let i = 0; i < count; i++) {
    let x = ((pts[i * 2] * 0.5 + 0.5) * H_N) | 0
    let y = ((pts[i * 2 + 1] * 0.5 + 0.5) * H_N) | 0
    x = x < 0 ? 0 : x > H_N - 1 ? H_N - 1 : x
    y = y < 0 ? 0 : y > H_N - 1 ? H_N - 1 : y
    keys[i] = lut[y * H_N + x]
    a[i] = i
  }
  // LSD radix sort, two 8-bit passes (keys are 16 bits)
  const cnt = new Uint32Array(256)
  let src = a
  let dst = b
  for (let shift = 0; shift < 16; shift += 8) {
    cnt.fill(0)
    for (let i = 0; i < count; i++) cnt[(keys[src[i]] >>> shift) & 255]++
    let sum = 0
    for (let k = 0; k < 256; k++) {
      const c = cnt[k]
      cnt[k] = sum
      sum += c
    }
    for (let i = 0; i < count; i++) {
      const id = src[i]
      dst[cnt[(keys[id] >>> shift) & 255]++] = id
    }
    const t = src
    src = dst
    dst = t
  }
  return src
}

/* ---------- samplers ---------- */
const G = 256

function sampleScatter(out: Float32Array, count: number, rand: () => number) {
  const vn = valueNoise(3)
  let i = 0
  while (i < count) {
    const x = (rand() * 2 - 1) * EDGE
    const y = (rand() * 2 - 1) * EDGE
    if (blocked(x, y)) continue
    // gentle clumping, as if poured from a shaker
    if (rand() > 0.45 + 0.55 * vn(x * 2.6 + 11, y * 2.6 + 4)) continue
    out[i * 2] = x
    out[i * 2 + 1] = y
    i++
  }
}

function sampleMode(md: Mode, out: Float32Array, count: number, rand: () => number, cdf: Float64Array, seed: number) {
  const { n, m, s } = md
  const PI = Math.PI
  const cn = new Float32Array(G),
    sn = new Float32Array(G),
    cm = new Float32Array(G),
    sm = new Float32Array(G)
  for (let i = 0; i < G; i++) {
    const x = ((i + 0.5) / G) * 2 - 1
    cn[i] = Math.cos(n * PI * x)
    sn[i] = Math.sin(n * PI * x)
    cm[i] = Math.cos(m * PI * x)
    sm[i] = Math.sin(m * PI * x)
  }
  const vn = valueNoise(seed)
  const c2 = (0.35 * PI * Math.max(n, m)) ** 2
  // lines get a touch finer as the pattern gets busier
  const sig = 0.0115 - 0.0002 * (n + m)
  const inv = 1 / (sig * sig)
  let total = 0
  for (let j = 0; j < G; j++) {
    const y = ((j + 0.5) / G) * 2 - 1
    for (let i = 0; i < G; i++) {
      const x = ((i + 0.5) / G) * 2 - 1
      let w = 0
      if (Math.abs(x) < EDGE && Math.abs(y) < EDGE) {
        const f = cn[i] * cm[j] + s * cm[i] * cn[j]
        const fx = -n * PI * sn[i] * cm[j] - s * m * PI * sm[i] * cn[j]
        const fy = -m * PI * cn[i] * sm[j] - s * n * PI * cm[i] * sn[j]
        const e = ((f * f) / (fx * fx + fy * fy + c2)) * inv
        // most of the plate is far from any line: skip the noise + exp there
        if (e < 9 && !blocked(x, y)) w = Math.exp(-e) * (0.5 + 0.5 * vn(x * 3.1 + 7, y * 3.1 + 2))
      }
      total += w
      cdf[j * G + i] = total
    }
  }
  const strays = Math.floor(count * 0.009)
  const lines = count - strays
  // stratified draw: one sorted pass over the CDF (even lines, no binary search)
  const step = total / lines
  let cell = 0
  for (let k = 0; k < lines; k++) {
    const r = (k + rand()) * step
    while (cell < G * G - 1 && cdf[cell] < r) cell++
    const i = cell % G
    const j = (cell / G) | 0
    out[k * 2] = ((i + rand()) / G) * 2 - 1
    out[k * 2 + 1] = ((j + rand()) / G) * 2 - 1
  }
  let k = lines
  while (k < count) {
    const x = (rand() * 2 - 1) * EDGE
    const y = (rand() * 2 - 1) * EDGE
    if (blocked(x, y)) continue
    out[k * 2] = x
    out[k * 2 + 1] = y
    k++
  }
}

/** Random points along every contour of the mark (outer edges + holes), by arc length. */
function outlineSamples(count: number, rand: () => number) {
  const segs: number[] = []
  let total = 0
  const addPoly = (pts: { x: number; y: number }[]) => {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % pts.length]
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      if (len < 1e-7) continue
      total += len
      segs.push(a.x, a.y, b.x, b.y, total)
    }
  }
  // the normalized shapes are polylines, so getPoints() is just their vertices
  for (const sh of logoShapes()) {
    addPoly(sh.getPoints())
    for (const h of sh.holes) addPoly(h.getPoints())
  }
  const nSeg = segs.length / 5
  const out = new Float32Array(count * 2)
  // stratified along the total length, one forward pass
  let si = 0
  for (let k = 0; k < count; k++) {
    const r = ((k + rand()) / count) * total
    while (si < nSeg - 1 && segs[si * 5 + 4] < r) si++
    const o = si * 5
    const start = segs[o + 4] - Math.hypot(segs[o + 2] - segs[o], segs[o + 3] - segs[o + 1])
    const t = Math.min(1, Math.max(0, (r - start) / (segs[o + 4] - start)))
    out[k * 2] = segs[o] + (segs[o + 2] - segs[o]) * t
    out[k * 2 + 1] = segs[o + 1] + (segs[o + 3] - segs[o + 1]) * t
  }
  return out
}

function sampleLogo(out: Float32Array, count: number, rand: () => number) {
  const fillN = Math.floor(count * 0.72)
  const edgeN = Math.floor(count * 0.268)
  const fill = logoPoints(Math.ceil(fillN * 1.04), { seed: 19 })
  const edge = outlineSamples(edgeN, rand)
  let k = 0
  const push = (x: number, y: number) => {
    if (k >= count || blocked(x, y) || Math.abs(x) > EDGE || Math.abs(y) > EDGE) return
    out[k * 2] = x
    out[k * 2 + 1] = y
    k++
  }
  // the finale camera looks down from the -z side (index.ts MARK_*): logo x runs
  // along world -x and logo y (up) toward the far edge, +z
  for (let i = 0; i < fill.length / 3 && k < fillN; i++) push(-fill[i * 3] * LOGO_SCALE, fill[i * 3 + 1] * LOGO_SCALE)
  // sand banks up against the edges of the figure
  const gauss = () => (rand() + rand() + rand() - 1.5) * 0.9
  for (let i = 0; i < edgeN; i++)
    push(-edge[i * 2] * LOGO_SCALE + gauss() * 0.006, edge[i * 2 + 1] * LOGO_SCALE + gauss() * 0.006)
  while (k < count) push((rand() * 2 - 1) * EDGE, (rand() * 2 - 1) * EDGE)
}

/** Yield to the browser between heavy steps (a macrotask; works in hidden tabs too). */
const yieldTask = () =>
  new Promise<void>(resolve => {
    const ch = new MessageChannel()
    ch.port1.onmessage = () => resolve()
    ch.port2.postMessage(0)
  })

/**
 * Build all targets. `rowsPer` rows of TEX_W grains per mode.
 * Returns RG float data, TEX_W × (rowsPer · MODE_ROWS). Runs in short
 * chunks (one mode per task) so the loader never stalls.
 */
export async function buildTargets(rowsPer: number, data = new Float32Array(TEX_W * rowsPer * 2 * MODE_ROWS)) {
  const count = TEX_W * rowsPer
  const rand = rng(1234)
  const cdf = new Float64Array(G * G)
  const cur = new Float32Array(count * 2)
  const next = new Float32Array(count * 2)
  const keys = new Uint16Array(count)
  const a = new Uint32Array(count),
    b = new Uint32Array(count),
    c = new Uint32Array(count),
    d = new Uint32Array(count)

  sampleScatter(cur, count, rand)
  data.set(cur, 0)

  for (let row = 1; row < MODE_ROWS; row++) {
    await yieldTask()
    if (row === ROW_LOGO) sampleLogo(next, count, rand)
    else sampleMode(MODES[row - 1], next, count, rand, cdf, 40 + row * 7)
    // match grains (ordered by where they are now) to the new targets (ordered the same way)
    const from = hilbertOrder(cur, count, keys, a, b)
    const to = hilbertOrder(next, count, keys, c, d)
    const base = row * count * 2
    for (let r = 0; r < count; r++) {
      const g = from[r]
      const t = to[r]
      data[base + g * 2] = next[t * 2]
      data[base + g * 2 + 1] = next[t * 2 + 1]
    }
    cur.set(data.subarray(base, base + count * 2))
  }
  return { data, count, height: rowsPer * MODE_ROWS }
}
