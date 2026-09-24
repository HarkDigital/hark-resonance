import * as THREE from 'three'
import { rng } from '../../core/math'
import { MODE_ROWS, TEX_W, buildTargets } from './modes'

/*
 * The sand: one Points draw of 20–40k grains. Every grain's position is a
 * pure function of (mode A, mode B, transition t) read from a float texture
 * of precomputed targets, plus time-driven buzz while the plate drives it.
 *
 * A second, tiny pass splats the same grains top-down into a 256² density
 * target. The plate samples it for contact shadows / occlusion, and the
 * grains sample it to pile up (height) and darken where buried.
 */

/** density target covers [-EXT, EXT] on x/z */
export const EXT = 1.08

const GRAIN = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D tTargets;
uniform int uRowA;
uniform int uRowB;
uniform float uT;
uniform float uTime;
uniform float uVib;
uniform float uHum;
uniform float uDiffuse;
uniform vec3 uModeB;
uniform vec4 uWave;
uniform vec4 uTap;
attribute vec4 aRnd;

#define TW ${TEX_W}
#define PI 3.14159265

vec2 tgt(int row, int id) { return texelFetch(tTargets, ivec2(id % TW, row + id / TW), 0).rg; }
float h11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
vec2 h21(float p) { vec3 p3 = fract(vec3(p) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float fieldB(vec2 p) {
  float n = uModeB.x, m = uModeB.y;
  return cos(n * PI * p.x) * cos(m * PI * p.y) + uModeB.z * cos(m * PI * p.x) * cos(n * PI * p.y);
}

// xz on the plate in .xy, hop height in .z
vec3 grain(int id, out float travel) {
  vec2 A = tgt(uRowA, id);
  vec2 B = tgt(uRowB, id);
  float fid = float(id);
  // the new figure condenses from the drive bolt outward
  float delay = aRnd.z * 0.14 + 0.18 * min(length(A), 1.3) / 1.3;
  float dur = 0.36 + 0.3 * aRnd.w;
  float s = clamp((uT - delay) / dur, 0.0, 1.0);
  float e = s * s * (3.0 - 2.0 * s);
  vec2 d = B - A;
  float L = length(d);
  vec2 perp = L > 1e-5 ? vec2(-d.y, d.x) / L : vec2(0.0);
  vec2 h = h21(fid * 0.713 + 1.7) - 0.5;
  float bell = sin(PI * s);
  // curved path + diffusion while it travels (scroll-driven)
  vec2 p = mix(A, B, e) + perp * h.x * 0.8 * L * bell;
  p += (h21(fid * 1.37 + 9.1) - 0.5) * 2.0 * uDiffuse * bell;
  // the plate keeps driving until the grain finds a quiet line: it buzzes (time-driven)
  float onset = smoothstep(0.0, 0.05, uT) * (1.0 - s * s);
  float fB = uModeB.z != 0.0 ? abs(fieldB(p)) : 0.0;
  float act = uModeB.z != 0.0 ? clamp(fB * 0.75, 0.15, 1.0) : 0.7;
  // at rest the lines stay still; only strays out on the antinodes keep dancing
  float amp = uVib * (onset * act + uHum * smoothstep(0.35, 0.9, fB) * s);
  float ph = uTime * (41.0 + 23.0 * h.y) + fid * 1.7;
  p += vec2(sin(ph), cos(ph * 1.31)) * amp * 0.0045;
  float hop = abs(sin(ph * 0.53)) * amp * 0.016;
  // pressure-wave front (the plate "rings")
  float r = length(p);
  float wq = (r - uWave.x) / uWave.z;
  float wv = exp(-wq * wq) * uWave.y;
  hop += wv * (0.007 + 0.006 * h.y) * (0.6 + 0.8 * aRnd.x);
  p += (r > 1e-4 ? p / r : vec2(0.0)) * wv * 0.006 * (h.x + 0.5);
  // a knock on the plate: a ring from the tap point
  vec2 tq = p - uTap.xy;
  float tr = length(tq);
  float tq2 = (tr - uTap.z) / 0.08;
  float tw = exp(-tq2 * tq2) * uTap.w;
  hop += tw * (0.014 + 0.012 * h.y) * (0.6 + 0.8 * aRnd.x);
  p += (tr > 1e-4 ? tq / tr : vec2(0.0)) * tw * 0.009 * (h.x + 0.5);
  travel = bell;
  return vec3(clamp(p, vec2(-0.992), vec2(0.992)), hop);
}
`

const VERT = /* glsl */ `
${GRAIN}
uniform sampler2D tDensity;
uniform float uSize;
uniform float uPx;
uniform float uPileK;
uniform float uPileH;
uniform vec3 uLight;
uniform vec3 uSandA;
uniform vec3 uSandB;
uniform float uExt;
varying vec3 vCol;
varying vec3 vL;
varying float vGlint;

void main() {
  int id = gl_VertexID;
  float travel;
  vec3 g = grain(id, travel);
  float dens = textureLod(tDensity, g.xy / uExt * 0.5 + 0.5, 0.0).r;
  float pile = 1.0 - exp(-dens * uPileK);
  float rank = aRnd.y;
  float size = uSize * (0.7 + 0.6 * aRnd.x);
  float y = size * 0.45 + pile * rank * uPileH + g.z;
  vec4 mv = modelViewMatrix * vec4(g.x, y, g.y, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = max(1.35, size * uPx / -mv.z);

  vL = normalize((viewMatrix * vec4(uLight, 0.0)).xyz);
  float fid = float(id);
  vec3 col = mix(uSandA, uSandB, h11(fid * 0.37 + 3.1));
  // buried grains sit in their neighbours' shade
  float ao = mix(1.0, 0.3 + 0.7 * rank, pile);
  vCol = col * ao;
  // quartz glints: a random facet that flashes when it lines up with the key
  vec3 facet = normalize(vec3(h21(fid * 2.31) - 0.5, 0.9).xzy);
  vec3 fv = normalize((viewMatrix * vec4(facet, 0.0)).xyz);
  float spec = max(dot(reflect(-vL, fv), vec3(0.0, 0.0, 1.0)), 0.0);
  vGlint = step(0.975, h11(fid * 1.91 + 0.3)) * pow(spec, 60.0) * ao * (1.0 - travel);
}
`

const FRAG = /* glsl */ `
uniform float uKey;
uniform float uAmb;
varying vec3 vCol;
varying vec3 vL;
varying float vGlint;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  c.y = -c.y;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  vec3 n = vec3(c, sqrt(1.0 - r2));
  float dif = max(dot(n, vL), 0.0);
  // wrap a little so the shadow side isn't dead black (bounce off the plate)
  float wrap = max((dot(n, vL) + 0.35) / 1.35, 0.0);
  float sky = 0.55 + 0.45 * n.y;
  vec3 col = vCol * (uAmb * sky + uKey * mix(wrap, dif, 0.6));
  col += vGlint * 3.5 * (1.0 - r2);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const DENS_VERT = /* glsl */ `
${GRAIN}
uniform float uExt;
uniform float uSplat;
void main() {
  float travel;
  vec3 g = grain(gl_VertexID, travel);
  gl_Position = vec4(g.xy / uExt, 0.0, 1.0);
  gl_PointSize = uSplat;
}
`
const DENS_FRAG = /* glsl */ `
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float w = exp(-dot(c, c) * 3.0);
  gl_FragColor = vec4(w, w, w, 1.0);
}
`

export class Sand {
  points: THREE.Points
  count: number
  targets: THREE.DataTexture
  private data: Float32Array<ArrayBuffer>
  density: THREE.WebGLRenderTarget
  uniforms: {
    tTargets: THREE.IUniform<THREE.Texture>
    tDensity: THREE.IUniform<THREE.Texture>
    uRowA: THREE.IUniform<number>
    uRowB: THREE.IUniform<number>
    uT: THREE.IUniform<number>
    uTime: THREE.IUniform<number>
    uVib: THREE.IUniform<number>
    uHum: THREE.IUniform<number>
    uDiffuse: THREE.IUniform<number>
    uModeB: THREE.IUniform<THREE.Vector3>
    uWave: THREE.IUniform<THREE.Vector4>
    uTap: THREE.IUniform<THREE.Vector4>
    uSize: THREE.IUniform<number>
    uPx: THREE.IUniform<number>
    uPileK: THREE.IUniform<number>
    uPileH: THREE.IUniform<number>
    uLight: THREE.IUniform<THREE.Vector3>
    uSandA: THREE.IUniform<THREE.Color>
    uSandB: THREE.IUniform<THREE.Color>
    uExt: THREE.IUniform<number>
    uKey: THREE.IUniform<number>
    uAmb: THREE.IUniform<number>
    uSplat: THREE.IUniform<number>
  }
  /** grains per mode row block */
  rowsPer: number
  private densScene = new THREE.Scene()
  private densCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private clear = new THREE.Color()

  constructor(mobile: boolean, light: THREE.Vector3) {
    this.rowsPer = mobile ? 80 : 160
    const count = (this.count = TEX_W * this.rowsPer)
    // filled by load(); uploaded once
    this.data = new Float32Array(count * 2 * MODE_ROWS)
    const tex = (this.targets = new THREE.DataTexture(
      this.data,
      TEX_W,
      this.rowsPer * MODE_ROWS,
      THREE.RGFormat,
      THREE.FloatType,
    ))
    tex.minFilter = tex.magFilter = THREE.NearestFilter
    tex.generateMipmaps = false

    const res = mobile ? 192 : 256
    this.density = new THREE.WebGLRenderTarget(res, res, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      depthBuffer: false,
    })

    const r = rng(77)
    const rnd = new Float32Array(count * 4)
    for (let i = 0; i < rnd.length; i++) rnd[i] = r()
    const geo = new THREE.BufferGeometry()
    // three needs a position attribute to size the draw; the shader ignores it
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
    geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 4))
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2)

    this.uniforms = {
      tTargets: { value: tex },
      tDensity: { value: this.density.texture },
      uRowA: { value: 0 },
      uRowB: { value: 0 },
      uT: { value: 1 },
      uTime: { value: 0 },
      uVib: { value: 1 },
      uHum: { value: 0.45 },
      uDiffuse: { value: 0.024 },
      uModeB: { value: new THREE.Vector3() },
      uWave: { value: new THREE.Vector4(0, 0, 0.12, 0) },
      uTap: { value: new THREE.Vector4(0, 0, 0, 0) },
      uSize: { value: mobile ? 0.0078 : 0.0058 },
      uPx: { value: 800 },
      uPileK: { value: 0.09 },
      uPileH: { value: 0.012 },
      uLight: { value: light.clone().normalize() },
      uSandA: { value: new THREE.Color('#ece6d8') },
      uSandB: { value: new THREE.Color('#d8cdb6') },
      uExt: { value: EXT },
      uKey: { value: 0.95 },
      uAmb: { value: 0.3 },
      uSplat: { value: mobile ? 3.2 : 3.6 },
    }
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
    })
    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false
    this.points.renderOrder = 2

    const dmat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: DENS_VERT,
      fragmentShader: DENS_FRAG,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    })
    const dpts = new THREE.Points(geo, dmat)
    dpts.frustumCulled = false
    this.densScene.add(dpts)
  }

  /** Compute every mode's grain targets (chunked across tasks) and upload them. */
  async load() {
    await buildTargets(this.rowsPer, this.data)
    this.targets.needsUpdate = true
  }

  /** Splat the grains into the density target (call once per frame, before the main render). */
  renderDensity(renderer: THREE.WebGLRenderer) {
    const prev = renderer.getRenderTarget()
    const alpha = renderer.getClearAlpha()
    renderer.getClearColor(this.clear)
    renderer.setRenderTarget(this.density)
    renderer.setClearColor(0x000000, 0)
    renderer.clear(true, false, false)
    renderer.render(this.densScene, this.densCam)
    renderer.setClearColor(this.clear, alpha)
    renderer.setRenderTarget(prev)
  }
}
