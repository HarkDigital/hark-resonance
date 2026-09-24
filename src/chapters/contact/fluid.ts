import * as THREE from 'three'
import { logoShapes } from '../../logo/logo'
import { HASH } from '../../core/glsl'

/*
 * FERROFLUID MARK — the Hark mark as a puddle of glossy black magnetic
 * liquid in a machined aluminium dish with a bone ceramic well.
 *
 * Everything below lives in "logo space": the mark is 1 unit tall, lying on
 * the XZ plane (logo +y → world −z, so the mark reads upright from the front).
 * The chapter scales the whole dish group into world units.
 *
 *  - buildLogoSdf(): rasterize the mark once to a canvas, exact Euclidean
 *    distance transform (Felzenszwalb) → half-float signed-distance texture.
 *  - the fluid is a triangular-lattice grid (culled to the mark) displaced in
 *    the vertex shader: rounded meniscus from the SDF + a hexagonal Rosensweig
 *    spike field that rises where the magnet is. Spike tips sit exactly on
 *    lattice vertices, normals are per-pixel and analytic, so the spikes stay
 *    needle-sharp at modest vertex counts.
 *  - arrival: the SDF morphs from a round puddle into the mark (uMorph).
 */

/** half extent of the SDF domain (logo units) */
export const HALF = 0.68
/** radius of the arrival puddle (logo units) */
export const PUDDLE_R = 0.27

export interface Sdf {
  tex: THREE.DataTexture
  data: Float32Array
  size: number
  /** max radius of the mark from its centre (logo units) */
  maxR: number
  /** longest along-the-stroke distance from the arrival puddle */
  geoMax: number
  /** deep-interior points (mesh xz) — the idle magnet wanders along these */
  ridge: Float32Array
}

/** Exact 1-D squared distance transform (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0
  v[0] = 0
  z[0] = -1e20
  z[1] = 1e20
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = 1e20
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const dq = q - v[k]
    d[q] = dq * dq + f[v[k]]
  }
}

/** 2-D squared EDT: distance from every pixel to the nearest pixel where `seed` is true. */
function edt2d(seed: Uint8Array, size: number, want: 0 | 1): Float64Array {
  const INF = 1e20
  const grid = new Float64Array(size * size)
  for (let i = 0; i < grid.length; i++) grid[i] = seed[i] === want ? 0 : INF
  const f = new Float64Array(size)
  const d = new Float64Array(size)
  const v = new Int32Array(size)
  const z = new Float64Array(size + 1)
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) f[y] = grid[y * size + x]
    edt1d(f, size, d, v, z)
    for (let y = 0; y < size; y++) grid[y * size + x] = d[y]
  }
  for (let y = 0; y < size; y++) {
    const row = y * size
    for (let x = 0; x < size; x++) f[x] = grid[row + x]
    edt1d(f, size, d, v, z)
    for (let x = 0; x < size; x++) grid[row + x] = d[x]
  }
  return grid
}

/** Yield to the event loop (a macrotask, so it also works in hidden tabs). */
export const yieldTask = () =>
  new Promise<void>(resolve => {
    const ch = new MessageChannel()
    ch.port1.onmessage = () => resolve()
    ch.port2.postMessage(0)
  })

/**
 * Rasterize the mark (even-odd scanline fill at pixel centres, no canvas
 * readback), exact EDT both ways, light blur → half-float SDF. Async: yields
 * between the heavy steps so init never blocks a frame for long.
 */
export async function buildLogoSdf(size: number): Promise<Sdf> {
  const k = size / (2 * HALF)
  // edges of every contour (outer + holes), logo space
  const edges: number[] = []
  let maxR = 0
  const addContour = (pts: THREE.Vector2[]) => {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % pts.length]
      if (a.y !== b.y) edges.push(a.x, a.y, b.x, b.y)
      maxR = Math.max(maxR, Math.hypot(a.x, a.y))
    }
  }
  for (const s of logoShapes()) {
    addContour(s.getPoints(32))
    for (const h of s.holes) addContour(h.getPoints(32))
  }
  const n = size * size
  // row 0 = top = logo +HALF (flipped into texture order below)
  const inside = new Uint8Array(n)
  const xs: number[] = []
  for (let row = 0; row < size; row++) {
    const Y = HALF - (row + 0.5) / k
    xs.length = 0
    for (let e = 0; e < edges.length; e += 4) {
      const y0 = edges[e + 1]
      const y1 = edges[e + 3]
      if ((y0 <= Y && Y < y1) || (y1 <= Y && Y < y0)) {
        const x0 = edges[e]
        xs.push(x0 + ((Y - y0) * (edges[e + 2] - x0)) / (y1 - y0))
      }
    }
    xs.sort((a, b) => a - b)
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const a = Math.max(0, Math.ceil((xs[i] + HALF) * k - 0.5))
      const b = Math.min(size - 1, Math.ceil((xs[i + 1] + HALF) * k - 0.5) - 1)
      for (let x = a; x <= b; x++) inside[row * size + x] = 1
    }
  }
  await yieldTask()
  const dToIn = edt2d(inside, size, 1)
  await yieldTask()
  const dToOut = edt2d(inside, size, 0)
  await yieldTask()

  // signed distance in logo units, rows flipped so texture v runs with logo +y
  const sdf = new Float32Array(n)
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size
    const dst = y * size
    for (let x = 0; x < size; x++) {
      const i = src + x
      const dpx = inside[i] ? -(Math.sqrt(dToOut[i]) - 0.5) : Math.sqrt(dToIn[i]) - 0.5
      sdf[dst + x] = dpx / k
    }
  }
  // two light separable box passes melt the pixel stair-steps out of the
  // distance field (the meniscus normals come straight from its gradient)
  const tmp = new Float32Array(n)
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < size; y++) {
      const r = y * size
      for (let x = 0; x < size; x++) {
        const a = sdf[r + Math.max(0, x - 1)]
        const b = sdf[r + x]
        const c = sdf[r + Math.min(size - 1, x + 1)]
        tmp[r + x] = (a + b + c) / 3
      }
    }
    for (let y = 0; y < size; y++) {
      const a = Math.max(0, y - 1) * size
      const b = y * size
      const c = Math.min(size - 1, y + 1) * size
      for (let x = 0; x < size; x++) sdf[b + x] = (tmp[a + x] + tmp[b + x] + tmp[c + x]) / 3
    }
  }

  // geodesic distance from the arrival puddle, measured along the strokes
  // (chamfer relaxation inside the mark + a thin band around it), so the pool
  // visibly flows out along the mark instead of popping up in the hook curls
  const FAR = 3
  const geo = new Float32Array(n).fill(FAR)
  const pass = new Uint8Array(n)
  const band = 0.012
  const cx = size / 2
  // seed only the heart of the pool: the hook tails that dip inside the puddle
  // are reached the long way round, so nothing fills in disconnected islands
  const seedR = 0.12 * k
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x
      if (sdf[i] < band) {
        pass[i] = 1
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cx) < seedR) geo[i] = 0
      }
    }
  }
  const d1 = 1 / k
  const d2 = Math.SQRT2 / k
  for (let it = 0; it < 14; it++) {
    let changed = false
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const i = y * size + x
        if (!pass[i]) continue
        const v = Math.min(geo[i], geo[i - 1] + d1, geo[i - size] + d1, geo[i - size - 1] + d2, geo[i - size + 1] + d2)
        if (v < geo[i]) {
          geo[i] = v
          changed = true
        }
      }
    }
    for (let y = size - 2; y >= 1; y--) {
      for (let x = size - 2; x >= 1; x--) {
        const i = y * size + x
        if (!pass[i]) continue
        const v = Math.min(geo[i], geo[i + 1] + d1, geo[i + size] + d1, geo[i + size + 1] + d2, geo[i + size - 1] + d2)
        if (v < geo[i]) {
          geo[i] = v
          changed = true
        }
      }
    }
    if (!changed) break
  }
  let geoMax = 0
  for (let i = 0; i < n; i++) if (sdf[i] < 0 && geo[i] < FAR) geoMax = Math.max(geoMax, geo[i])

  const half = new Uint16Array(n * 2)
  for (let i = 0; i < n; i++) {
    half[i * 2] = THREE.DataUtils.toHalfFloat(sdf[i])
    half[i * 2 + 1] = THREE.DataUtils.toHalfFloat(geo[i])
  }
  const tex = new THREE.DataTexture(half, size, size, THREE.RGFormat, THREE.HalfFloatType)
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  tex.generateMipmaps = false
  tex.needsUpdate = true
  const ridgePts: number[] = []
  const step = Math.max(2, Math.round(size / 96))
  for (let y = 0; y < size; y += step) {
    for (let x = 0; x < size; x += step) {
      if (sdf[y * size + x] < -0.042) ridgePts.push((x + 0.5) / k - HALF, -((y + 0.5) / k - HALF))
    }
  }
  return { tex, data: sdf, size, maxR, geoMax, ridge: new Float32Array(ridgePts) }
}

/** Nearest-texel SDF lookup in logo space (x, logoY). */
function sdfLookup(sdf: Sdf, x: number, y: number) {
  const s = sdf.size
  const u = Math.round(((x + HALF) / (2 * HALF)) * s - 0.5)
  const v = Math.round(((y + HALF) / (2 * HALF)) * s - 0.5)
  if (u < 0 || v < 0 || u >= s || v >= s) return 1
  return sdf.data[v * s + u]
}

export interface FluidUniforms {
  uSdf: { value: THREE.Texture | null }
  uHalf: { value: number }
  uOrigin: { value: THREE.Vector2 }
  uSpacing: { value: number }
  uMorph: { value: number }
  uPuddleR: { value: number }
  uGeoMax: { value: number }
  uPuddleH: { value: number }
  uHeight: { value: number }
  uMenR: { value: number }
  uTime: { value: number }
  /** xy = magnet (mesh xz), z = strength */
  uMag: { value: THREE.Vector3 }
  uMagLag: { value: THREE.Vector3 }
  uSigma: { value: number }
  uSpikeAmp: { value: number }
  /** global field kick (arrival flicker) */
  uFlick: { value: number }
  uLean: { value: number }
  /** drop-landing rings: x = amplitude, y = phase */
  uRipple: { value: THREE.Vector2 }
  uWobble: { value: number }
}

export function fluidUniforms(): FluidUniforms {
  return {
    uSdf: { value: null },
    uHalf: { value: HALF },
    uOrigin: { value: new THREE.Vector2() },
    uSpacing: { value: 0.034 },
    uMorph: { value: 1 },
    uPuddleR: { value: PUDDLE_R },
    uGeoMax: { value: 0.6 },
    uPuddleH: { value: 0.05 },
    uHeight: { value: 0.03 },
    uMenR: { value: 0.034 },
    uTime: { value: 0 },
    uMag: { value: new THREE.Vector3(0, 0, 0) },
    uMagLag: { value: new THREE.Vector3(0, 0, 0) },
    uSigma: { value: 0.215 },
    uSpikeAmp: { value: 0.125 },
    uFlick: { value: 0 },
    uLean: { value: 0.3 },
    uRipple: { value: new THREE.Vector2() },
    uWobble: { value: 1 },
  }
}

/**
 * The studio PMREM is a grey photo room; this set sits on a bone table in
 * front of a bone cyc. Reflections that look down or out toward the horizon
 * pick up that bone (max(), so the strip lights and softbox still win).
 */
const BOUNCE = /* glsl */ `
{
  // uBounceFlag: a black flag behind the camera (product-shot trick) so glossy
  // black reads black face-on and gets bright bone rims at the sides and back
  vec2 bFh = normalize(inverseTransformDirection(vec3(0.0, 0.0, -1.0), viewMatrix).xz + 1e-5);
  vec3 bRv = inverseTransformDirection(reflect(-geometryViewDir, geometryNormal), viewMatrix);
  float bFl = mix(1.0, smoothstep(-0.3, 0.5, dot(normalize(bRv.xz + 1e-5), bFh)), uBounceFlag);
  radiance = max(radiance, uBounce * smoothstep(uBounceY.x, uBounceY.y, bRv.y) * bFl);
  #ifdef USE_CLEARCOAT
  vec3 bRc = inverseTransformDirection(reflect(-geometryViewDir, geometryClearcoatNormal), viewMatrix);
  float bFc = mix(1.0, smoothstep(-0.3, 0.5, dot(normalize(bRc.xz + 1e-5), bFh)), uBounceFlag);
  clearcoatRadiance = max(clearcoatRadiance, uBounce * smoothstep(uBounceY.x, uBounceY.y, bRc.y) * bFc);
  #endif
}
`

/** Patch a Standard/Physical shader with the bone bounce. */
export function addBounce(
  shader: { fragmentShader: string; uniforms: Record<string, THREE.IUniform> },
  color: THREE.Color,
  y0 = 0.45,
  y1 = 0.02,
  flag = 0,
) {
  shader.uniforms.uBounce = { value: color }
  shader.uniforms.uBounceY = { value: new THREE.Vector2(y0, y1) }
  shader.uniforms.uBounceFlag = { value: flag }
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\nuniform vec3 uBounce;\nuniform vec2 uBounceY;\nuniform float uBounceFlag;`)
    .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>\n${BOUNCE}`)
}

export const BONE = new THREE.Color('#e9e5dc')

/** Shared GLSL: SDF morph, meniscus, field, hex spike lattice. */
const COMMON = /* glsl */ `
uniform sampler2D uSdf;
uniform float uHalf, uSpacing, uMorph, uPuddleR, uPuddleH, uHeight, uMenR, uTime, uGeoMax;
uniform float uSigma, uSpikeAmp, uFlick, uLean, uWobble;
uniform vec2 uOrigin, uRipple;
uniform vec3 uMag, uMagLag;
${HASH}

vec2 logoSG(vec2 p) {
  vec2 uv = vec2(p.x, -p.y) / (2.0 * uHalf) + 0.5;
  return texture2D(uSdf, uv).rg;
}
float puddleSdf(vec2 p) {
  float a = atan(p.y, p.x);
  float r = uPuddleR * (1.0 + 0.05 * sin(3.0 * a + uTime * 0.6) + 0.035 * sin(5.0 * a - uTime * 0.8));
  return length(p) - r;
}
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
float sdfAt(vec2 p) {
  vec2 sg = logoSG(p);
  if (uMorph >= 0.999) return sg.x;
  // the pool drains outward ALONG the strokes (geodesic front, rounded tip)
  // while the central puddle shrinks into them
  float t = uMorph;
  float ang = atan(p.y, p.x);
  float front = t * (uGeoMax + 0.08) - 0.02 + 0.012 * sin(ang * 7.0 + uTime * 1.3) * (1.0 - t);
  float fill = -smin(-sg.x, -(sg.y - front), 0.03);
  float pud = puddleSdf(p) + uPuddleR * (1.0 - pow(max(1.0 - t, 0.0), 0.8)) + t * t * 0.2;
  return smin(fill, pud, 0.06);
}
float fieldAt(vec2 p) {
  vec2 a = p - uMag.xy;
  vec2 b = p - uMagLag.xy;
  float s2 = uSigma * uSigma;
  float f1 = uMag.z * exp(-dot(a, a) / s2);
  float f2 = uMagLag.z * exp(-dot(b, b) / (s2 * 1.6));
  return max(f1, f2) + uFlick;
}
float meniscus(float d, float H) {
  // rounded bead with a steep but finite contact slope; outside the mark the
  // sheet dives under the well floor so the contact line is a real
  // (multisampled) depth intersection, not an aliased discard
  if (d > 0.0) return -min(d * 3.0, 0.02);
  float x = clamp(-d / uMenR, 0.0, 1.0);
  return H * (1.0 - pow(max(1.0 - x, 0.0), 2.6));
}
// offset from the nearest hex-lattice spike (xy) and that spike's lattice coords (zw)
vec4 hexCell(vec2 p) {
  vec2 r = vec2(1.0, 1.7320508) * uSpacing;
  vec2 h = 0.5 * r;
  vec2 q = p - uOrigin;
  vec2 a = mod(q + h, r) - h;
  vec2 b = mod(q, r) - h;
  vec2 d = dot(a, a) < dot(b, b) ? a : b;
  return vec4(d, q - d);
}
// concave-flanked cone, needle tip; grad = d(shape)/d(xz)
float spikeShape(vec2 d, float an, out vec2 grad) {
  float R = uSpacing * 0.5 * mix(0.42, 1.0, sqrt(clamp(an, 0.0, 1.0)));
  float r = length(d);
  float t = clamp(r / R, 0.0, 1.0);
  float k = max(1.0 - t, 0.0);
  grad = (r > 1e-6 && t < 1.0) ? d / r * (-1.55 * pow(k, 0.55) / R) : vec2(0.0);
  return pow(k, 1.55);
}
float spikeRand(vec2 id) { return hash12(floor(id / uSpacing * 2.0 + 0.5) + 17.0); }
float spikeGain(float rnd) {
  return (0.72 + 0.56 * rnd) * (1.0 + 0.09 * uWobble * sin(uTime * 6.3 + rnd * 40.0));
}
float ringH(vec2 p, out vec2 grad) {
  float r = length(p);
  float env = exp(-r * 4.5);
  float w = 64.0;
  float s = sin(r * w - uRipple.y);
  grad = r > 1e-5 ? p / r * (uRipple.x * env * (cos(r * w - uRipple.y) * w - 4.5 * s)) : vec2(0.0);
  return uRipple.x * env * s;
}
`

export function createFluidMaterial(u: FluidUniforms) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#050506'),
    roughness: 0.07,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    ior: 1.85,
    specularIntensity: 1,
    envMapIntensity: 1.1,
  })
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, u)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
${COMMON}
varying vec2 vP;
varying float vD;
varying float vAmpS;
varying vec2 vGB;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `vec2 fp = position.xz;
float fd = sdfAt(fp);
float fF = fieldAt(fp);
float fH = mix(uPuddleH, uHeight, uMorph) * (1.0 + 0.4 * clamp(fF, 0.0, 1.4));
float fe = 0.006;
float fB = meniscus(fd, fH);
vec2 fGB = vec2(
  meniscus(sdfAt(fp + vec2(fe, 0.0)), fH) - meniscus(sdfAt(fp - vec2(fe, 0.0)), fH),
  meniscus(sdfAt(fp + vec2(0.0, fe)), fH) - meniscus(sdfAt(fp - vec2(0.0, fe)), fH)
) / (2.0 * fe);
vec2 fRG;
float fR = ringH(fp, fRG) * smoothstep(0.0, 0.03, -fd);
fGB += fRG * smoothstep(0.0, 0.03, -fd);
vec4 fc = hexCell(fp);
// Rosensweig: spikes appear past a critical field, then grow with it
float fAmpS = uSpikeAmp * smoothstep(0.34, 0.5, fF) * (0.25 + 0.75 * clamp(fF, 0.0, 1.3)) * smoothstep(0.004, 0.04, -fd);
vec2 fSG;
float fAmp = fAmpS * spikeGain(spikeRand(fc.zw));
float fS = spikeShape(fc.xy, fAmp / uSpikeAmp, fSG) * fAmp;
vec2 fToM = uMag.xy - (fc.zw + uOrigin);
vec2 fLean = normalize(fToM + vec2(1e-5)) * fS * uLean * smoothstep(0.0, 0.25, length(fToM));
vP = fp;
vD = fd;
vAmpS = fAmpS;
vGB = fGB;
vec3 objectNormal = normalize(vec3(-fGB.x, 1.0, -fGB.y));
#ifdef USE_TANGENT
  vec3 objectTangent = vec3( tangent.xyz );
#endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = vec3(fp.x + fLean.x, 0.0006 + fB + fR + fS, fp.y + fLean.y);`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
${COMMON}
varying vec2 vP;
varying float vD;
varying float vAmpS;
varying vec2 vGB;`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
if (vD > 0.03) discard;`,
      )
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
vec4 fc = hexCell(vP);
vec2 fSG;
float fAmp = vAmpS * spikeGain(spikeRand(fc.zw));
float fSp = spikeShape(fc.xy, fAmp / uSpikeAmp, fSG);
vec2 fG = vGB + fSG * fAmp;
vec3 fN = normalize(vec3(-fG.x, 1.0, -fG.y));
normal = normalize((viewMatrix * vec4(fN, 0.0)).xyz);
nonPerturbedNormal = normal;
// valleys between tall spikes see less of the room
float fOcc = 1.0 - 0.55 * (1.0 - fSp) * clamp(fAmp / (uSpikeAmp * 0.6), 0.0, 1.0);`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
reflectedLight.indirectSpecular *= fOcc;
#ifdef USE_CLEARCOAT
clearcoatSpecularIndirect *= mix(1.0, fOcc, 0.7);
#endif`,
      )
  }
  const fo = mat.onBeforeCompile
  mat.onBeforeCompile = (shader, r) => {
    fo.call(mat, shader, r)
    addBounce(shader, BONE.clone().multiplyScalar(1.05), 0.5, 0.0, 1)
  }
  mat.customProgramCacheKey = () => 'hark-ferrofluid'
  return mat
}

/**
 * Triangular-lattice grid over the SDF domain, culled to the union of the
 * mark and the arrival puddle. Spike lattice (spacing = n·a, n even) lands
 * exactly on vertices.
 */
export function buildFluidGeometry(sdf: Sdf, spacing: number, n: number, puddleR: number, origin: THREE.Vector2) {
  const a = spacing / n
  const rowH = (a * Math.sqrt(3)) / 2
  const x0 = -HALF
  const z0 = -HALF
  origin.set(x0, z0)
  const cols = Math.ceil((2 * HALF) / a) + 1
  const rows = Math.ceil((2 * HALF) / rowH) + 1
  const idx = (i: number, j: number) => j * cols + i
  const keep = new Uint8Array(cols * rows)
  const px = new Float32Array(cols * rows)
  const pz = new Float32Array(cols * rows)
  const margin = 0.02
  const pr = puddleR * 1.1 + margin
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = x0 + (i + (j & 1) * 0.5) * a
      const z = z0 + j * rowH
      const k = idx(i, j)
      px[k] = x
      pz[k] = z
      const d = sdfLookup(sdf, x, -z)
      keep[k] = d < margin || Math.hypot(x, z) < pr ? 1 : 0
    }
  }
  const remap = new Int32Array(cols * rows).fill(-1)
  const pos: number[] = []
  const index: number[] = []
  const vert = (k: number) => {
    if (remap[k] < 0) {
      remap[k] = pos.length / 3
      pos.push(px[k], 0, pz[k])
    }
    return remap[k]
  }
  const tri = (p: number, q: number, r: number) => {
    if (!keep[p] && !keep[q] && !keep[r]) return
    // front faces point up (+y): (q−p)×(r−p) must have a positive y
    const cy = (pz[q] - pz[p]) * (px[r] - px[p]) - (px[q] - px[p]) * (pz[r] - pz[p])
    if (cy > 0) index.push(vert(p), vert(q), vert(r))
    else index.push(vert(p), vert(r), vert(q))
  }
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      if ((j & 1) === 0) {
        tri(idx(i, j), idx(i, j + 1), idx(i + 1, j))
        tri(idx(i + 1, j), idx(i, j + 1), idx(i + 1, j + 1))
      } else {
        tri(idx(i, j), idx(i, j + 1), idx(i + 1, j + 1))
        tri(idx(i, j), idx(i + 1, j + 1), idx(i + 1, j))
      }
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1))
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), HALF * 1.5)
  return geo
}

/** Bone-ceramic well floor: printed tick ring + soft contact shade under the fluid. */
export function createFloorMaterial(u: FluidUniforms, tickR0: number, tickR1: number) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#ece8e0'),
    roughness: 0.5,
    metalness: 0,
    clearcoat: 0.55,
    clearcoatRoughness: 0.16,
    envMapIntensity: 1,
  })
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, u)
    shader.uniforms.uTick = { value: new THREE.Vector2(tickR0, tickR1) }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vLP;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvLP = position.xz;`)
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
${COMMON}
uniform vec2 uTick;
varying vec2 vLP;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float r = length(vLP);
  float ang = atan(vLP.y, vLP.x) / 6.2831853 + 0.5;
  float f = fract(ang * 120.0);
  float fr = fwidth(r) + 1e-5;
  // tick AA from the radial footprint (fwidth(ang) spikes at the atan seam)
  float aa = 120.0 * fr / (6.2831853 * max(r, 1e-3)) + 1e-4;
  float line = 1.0 - smoothstep(0.1 - aa, 0.1 + aa, min(f, 1.0 - f));
  float major = 1.0 - step(0.5, mod(floor(ang * 120.0 + 0.5), 10.0));
  float r0 = mix(uTick.x + (uTick.y - uTick.x) * 0.45, uTick.x, major);
  float band = smoothstep(r0 - fr, r0 + fr, r) * (1.0 - smoothstep(uTick.y - fr, uTick.y + fr, r));
  float edge = 1.0 - smoothstep(0.0, fr * 1.5, abs(r - uTick.y - 0.004));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.06), clamp(line * band * 0.8 + edge * 0.35, 0.0, 1.0));
}`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
{
  float dd = max(sdfAt(vLP), 0.0);
  float ao = 1.0 - 0.62 * exp(-dd / 0.012) - 0.2 * exp(-dd / 0.05);
  reflectedLight.indirectDiffuse *= ao;
  reflectedLight.indirectSpecular *= mix(1.0, ao, 0.8);
  #ifdef USE_CLEARCOAT
  clearcoatSpecularIndirect *= mix(1.0, ao, 0.8);
  #endif
}`,
      )
  }
  mat.customProgramCacheKey = () => 'hark-ferro-floor'
  return mat
}

/** Machined dish wall + rim (lathe). */
export function dishWallGeometry(rIn: number, rOut: number, top: number, bottom: number) {
  const pts: THREE.Vector2[] = []
  const f = 0.008 // inner fillet
  // inner wall from the floor up, with a small fillet into the floor
  for (let i = 0; i <= 5; i++) {
    const a = (i / 5) * (Math.PI / 2)
    pts.push(new THREE.Vector2(rIn - f + Math.sin(a) * f, f - Math.cos(a) * f))
  }
  pts.push(new THREE.Vector2(rIn, top - 0.006))
  // chamfer
  pts.push(new THREE.Vector2(rIn + 0.004, top - 0.0015))
  pts.push(new THREE.Vector2(rIn + 0.008, top))
  // flat top
  pts.push(new THREE.Vector2(rOut - 0.01, top))
  // rounded outer edge
  for (let i = 1; i <= 5; i++) {
    const a = (i / 5) * (Math.PI / 2)
    pts.push(new THREE.Vector2(rOut - 0.01 + Math.sin(a) * 0.01, top - 0.01 + Math.cos(a) * 0.01))
  }
  pts.push(new THREE.Vector2(rOut, bottom + 0.006))
  pts.push(new THREE.Vector2(rOut - 0.004, bottom))
  pts.push(new THREE.Vector2(rOut - 0.02, bottom))
  const geo = new THREE.LatheGeometry(pts, 160)
  return geo
}

/** Table under the dish: bone sweep with a light pool and a soft contact shadow. */
export function createTable(radius: number, dishR: number) {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uCenter: { value: new THREE.Color('#f6f4ef') },
      uEdge: { value: new THREE.Color('#e3dfd6') },
      uDishR: { value: dishR },
      uRadius: { value: radius },
      uShadow: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vXZ;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vXZ = wp.xz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uCenter, uEdge;
      uniform float uDishR, uRadius, uShadow;
      varying vec2 vXZ;
      void main() {
        float r = length(vXZ);
        vec3 c = mix(uCenter, uEdge, smoothstep(0.0, uRadius * 0.55, r));
        float o = max(r - uDishR, 0.0);
        // tight contact line + wide soft shade from the overhead softbox
        float sh = 0.55 * exp(-o / 0.035) + 0.22 * exp(-o / 0.32) + 0.08 * exp(-o / 1.2);
        c *= 1.0 - sh * uShadow;
        float a = 1.0 - smoothstep(uRadius * 0.45, uRadius, r);
        gl_FragColor = vec4(c, a);
      }
    `,
  })
  const geo = new THREE.CircleGeometry(radius, 96)
  geo.rotateX(-Math.PI / 2)
  const mesh = new THREE.Mesh(geo, mat)
  mesh.renderOrder = -5
  return { mesh, mat }
}
