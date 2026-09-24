import * as THREE from 'three'
import { HASH } from '../../core/glsl'
import { SCREEN } from './layout'

/*
 * The CRT: a slightly domed phosphor face with an illuminated graticule
 * (10 × 8 divisions), and three channel rows of beam traces drawn on it as
 * additive HDR ribbons, so the post bloom gives them their phosphor halo.
 *
 * Every trace vertex is evaluated in the shader from uniforms (no state):
 *
 *   row 0  CH1  the intrusion: jagged noise, burst transients, one sustained
 *               spike (the hack), in red
 *   row 1  CH2  the anti-phase copy, -CH1, written in green by a beam head
 *               that sweeps left → right (uSweep)
 *   row 2  Σ    CH1 + CH2: noise ahead of the head, a flat green line behind
 *               it; later the calm breathing sine, then the out-beat pulse
 *
 * Phosphor persistence: each row is drawn three times, for the current
 * time-base sweep and the two before it. The beam writes u at fraction u of a
 * sweep, and each point decays with its age since it was written, so there's
 * a visible scanning head at slow time-bases and a shimmering afterglow cloud
 * at fast ones. Beam intensity falls with slope (a CRT beam moving fast
 * across the phosphor deposits less light), so spikes read as fine and faint.
 */

const HX = SCREEN.w / 2
const HY = SCREEN.h / 2

const TRACE_COMMON = /* glsl */ `
uniform float uM;
uniform vec2 uHalf;
uniform float uBulge;
uniform vec2 uStep;
uniform float uDecay;
uniform float uNoise;
uniform float uDensity;
uniform vec3 uHero;
uniform vec3 uRowY;
uniform vec3 uRowA;
uniform vec3 uScale;
uniform float uSweep;
uniform vec4 uCalm;
uniform vec4 uPulse;

${HASH}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// the intrusion signal in divisions, for sample s (u = 0..1) of sweep st
float sig(float s, float u, float st) {
  float T = st * 0.23;
  float y = (vnoise(vec2(u * 7.0 + 1.3, T)) - 0.5) * 1.3
          + (vnoise(vec2(u * 26.0 - 4.1, T * 1.7 + 7.0)) - 0.5) * 0.75
          + (hash12(vec2(s * 1.37 + 0.5, st * 3.1 + 0.5)) - 0.5) * 0.45;
  // burst transients: sharp cusps that ring once
  for (int k = 0; k < 4; k++) {
    float fk = float(k);
    vec2 key = vec2(st * 1.13 + 0.5, fk * 7.31 + 1.0);
    if (hash12(key) > uDensity) continue;
    float cx = hash12(key + 11.7);
    float w = 0.003 + 0.009 * hash12(key + 23.1);
    float hA = hash12(key + 5.3);
    float a = (0.7 + 1.9 * hA * hA) * (hash12(key + 2.2) > 0.5 ? 1.0 : -1.0);
    float x = (u - cx) / w;
    y += a * exp(-abs(x)) * cos(x * 1.2);
  }
  // the hack: one sustained spike
  // (a cusp with a rounded crown, so the beam lingers and the tip reads)
  float xh = (u - uHero.x) / 0.009;
  y += uHero.y * (0.55 * exp(-abs(xh)) + 0.45 * exp(-xh * xh)) * cos(xh * 0.6) * (0.93 + 0.07 * hash12(vec2(st, 3.7)));
  return y * uNoise;
}

// y (divisions) of row r at sample s; wr = 1 where the CH2 head has written
float rowY(int r, float s, float st, out float wr) {
  float u = s / (uM - 1.0);
  wr = smoothstep(uSweep + 0.004, uSweep - 0.004, u);
  float y;
  if (r == 0) {
    y = uRowY.x + uScale.x * sig(s, u, st);
  } else if (r == 1) {
    y = uRowY.y - uScale.y * sig(s, u, st) * wr;
  } else {
    float res = uScale.z > 0.0 ? uScale.z * sig(s, u, st) * (1.0 - wr) : 0.0;
    float calm = uCalm.x * sin((u * uCalm.y - uCalm.z) * 6.2831853);
    float px = (u - uPulse.x) / uPulse.z;
    float pulse = uPulse.y * exp(-px * px) * cos(px * 1.9);
    y = uRowY.z + res + calm + pulse;
  }
  return clamp(y, -4.05, 4.05);
}

vec3 surf(float u, float yd) {
  vec2 p = vec2((u * 2.0 - 1.0) * uHalf.x, yd * 0.25 * uHalf.y);
  vec2 q = p / uHalf;
  return vec3(p, uBulge * (1.0 - q.x * q.x) * (1.0 - q.y * q.y) + 0.004);
}
`

const TRACE_VERT = /* glsl */ `
${TRACE_COMMON}
uniform vec2 uRes;
uniform float uPx;
uniform float uBright;
uniform vec3 uRed;
uniform vec3 uGreen;
varying float vDist;
varying vec3 vCol;

void main() {
  float s = position.x;
  float strip = position.y;
  float side = position.z;
  float row = floor(strip / 3.0 + 0.01);
  float layer = strip - row * 3.0;
  int ri = int(row + 0.5);
  float rowA = ri == 0 ? uRowA.x : (ri == 1 ? uRowA.y : uRowA.z);
  if (rowA < 0.002) {
    // whole strip off (uniform per strip, so no stretched triangles)
    vDist = 0.0;
    vCol = vec3(0.0);
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float st = uStep.x - layer;
  float u = s / (uM - 1.0);
  float sa = max(s - 1.0, 0.0);
  float sb = min(s + 1.0, uM - 1.0);
  float wr;
  float wa;
  float wb;
  float y1 = rowY(ri, s, st, wr);
  float y0 = rowY(ri, sa, st, wa);
  float y2 = rowY(ri, sb, st, wb);

  mat4 mvp = projectionMatrix * modelViewMatrix;
  vec4 c0 = mvp * vec4(surf(sa / (uM - 1.0), y0), 1.0);
  vec4 c1 = mvp * vec4(surf(u, y1), 1.0);
  vec4 c2 = mvp * vec4(surf(sb / (uM - 1.0), y2), 1.0);
  vec2 a = c0.xy / max(abs(c0.w), 1e-4) * uRes;
  vec2 b = c2.xy / max(abs(c2.w), 1e-4) * uRes;
  vec2 tng = b - a;
  float len = length(tng);
  tng = len > 1e-5 ? tng / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-tng.y, tng.x);
  float halfW = 7.0 * uPx;
  c1.xy += nrm * side * halfW * 2.0 / uRes * c1.w;
  vDist = side * halfW;

  // phosphor: age (in sweeps) since the beam wrote this point
  float age = layer + uStep.y - u;
  float vis = age < 0.0 ? 0.0 : exp(-age * uDecay);
  // beam speed: fast (steep) strokes deposit less light
  float dxd = 10.0 * (sb - sa) / (uM - 1.0);
  float dyd = y2 - y0;
  float speed = inversesqrt(1.0 + dyd * dyd / max(dxd * dxd, 1e-6));
  float beam = mix(0.1, 1.0, speed);

  vec3 col;
  float head = 0.0;
  if (ri == 0) {
    col = uRed;
  } else if (ri == 1) {
    // fresh phosphor right behind the anti-phase head, and the head itself
    float since = max(uSweep - u, 0.0);
    col = uGreen * (0.62 + 0.38 * exp(-since * 7.0));
    vis *= wr;
    float hd = (u - uSweep) / 0.009;
    head = step(0.0, uSweep) * step(uSweep, 1.0) * exp(-hd * hd) * 2.4;
  } else {
    float red = (1.0 - wr) * clamp(uScale.z * 5.0, 0.0, 1.0);
    col = mix(uGreen, uRed, red);
  }
  vCol = col * (vis * beam * rowA * uBright + head * rowA);
  gl_Position = c1;
}
`

const TRACE_FRAG = /* glsl */ `
uniform float uPx;
varying float vDist;
varying vec3 vCol;
void main() {
  float d = abs(vDist) / uPx;
  float core = exp(-d * d * 0.8);
  float halo = exp(-d * 0.8) * 0.18;
  float lum = dot(vCol, vec3(0.3333));
  vec3 c = vCol * (core + halo) + vec3(0.55) * lum * core * core;
  gl_FragColor = vec4(c, 1.0);
}
`

const FACE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const FACE_FRAG = /* glsl */ `
uniform sampler2D uOverlay;
uniform float uPower;
uniform float uGrat;
uniform float uOverlayA;
uniform vec3 uHaze;
uniform vec3 uRowY;
uniform vec3 uRowA;
uniform vec3 uRed;
uniform vec3 uGreen;
varying vec2 vUv;

void main() {
  // divisions: x -5..5, y -4..4 (derivatives up front, outside any branch)
  vec2 d = (vUv - 0.5) * vec2(10.0, 8.0);
  vec2 fw = max(fwidth(d), vec2(1e-4));
  vec4 ov = texture2D(uOverlay, vUv);

  // dotted graticule, solid centre axes with 0.2-div ticks
  vec2 gd = abs(fract(d + 0.5) - 0.5) / fw;
  vec2 line = clamp(1.2 - gd, 0.0, 1.0);
  vec2 dd = abs(fract(d * 5.0 + 0.5) - 0.5) / (fw * 5.0);
  vec2 dots = clamp(1.7 - dd, 0.0, 1.0);
  float grid = max(line.x * dots.y, line.y * dots.x);
  vec2 axl = clamp(1.2 - abs(d) / fw, 0.0, 1.0);
  vec2 tk = clamp((0.1 - abs(d)) / fw + 0.5, 0.0, 1.0);
  float ticks = max(dots.x * tk.y, dots.y * tk.x);
  float edge = max(clamp(1.2 - (5.0 - abs(d.x)) / fw.x, 0.0, 1.0), clamp(1.2 - (4.0 - abs(d.y)) / fw.y, 0.0, 1.0));
  float grat = max(grid * 0.5, max(max(max(axl.x, axl.y) * 0.62, ticks * 0.8), edge * 0.7));

  vec3 col = vec3(0.006, 0.011, 0.009);
  col += vec3(0.085, 0.2, 0.13) * grat * uGrat;

  // channel ground markers hugging the left edge
  float x = d.x + 5.0;
  float hh = 0.17 * (1.0 - x / 0.32);
  float mx = clamp((0.32 - x) / fw.x, 0.0, 1.0) * step(0.0, x);
  vec3 ym = abs(vec3(d.y) - uRowY);
  vec3 tri = clamp((vec3(hh) - ym) / fw.y, 0.0, 1.0) * mx * uRowA;
  col += (uRed * tri.x + uGreen * (tri.y + tri.z)) * 0.3;

  col += ov.rgb * ov.a * uOverlayA;

  // phosphor haze and CRT falloff toward the rim
  float r = length((vUv - 0.5) * vec2(1.0, 0.8));
  col += uHaze * (1.0 - smoothstep(0.0, 0.62, r));
  col *= 1.0 - 0.6 * smoothstep(0.3, 0.66, r);
  gl_FragColor = vec4(col * uPower, 1.0);
}
`

const lin = (hex: string, k = 1) => new THREE.Color(hex).multiplyScalar(k)

export class Screen {
  /** placed by the scope at the CRT centre: local x right, y up, +z out of the glass */
  object = new THREE.Group()
  uniforms = {
    uM: { value: 2 },
    uHalf: { value: new THREE.Vector2(HX, HY) },
    uBulge: { value: SCREEN.bulge },
    /** (current sweep id, fraction of it drawn) */
    uStep: { value: new THREE.Vector2(0, 0) },
    uDecay: { value: 1.3 },
    uNoise: { value: 1 },
    uDensity: { value: 0.62 },
    /** intrusion spike: u, amplitude (div) */
    uHero: { value: new THREE.Vector3(0.62, 2.4, 0) },
    /** row baselines (div) and visibility: CH1, CH2, Σ */
    uRowY: { value: new THREE.Vector3(0, 0, -2.5) },
    uRowA: { value: new THREE.Vector3(1, 0, 0) },
    /** CH1 gain, CH2 gain, Σ residual gain */
    uScale: { value: new THREE.Vector3(1, 1, 0) },
    uSweep: { value: -1 },
    /** Σ sine: amplitude (div), cycles across the screen, phase, unused */
    uCalm: { value: new THREE.Vector4(0, 2, 0, 0) },
    /** out-beat blip: u, amplitude, width */
    uPulse: { value: new THREE.Vector4(-1, 0, 0.03, 0) },
    uRes: { value: new THREE.Vector2(1, 1) },
    uPx: { value: 1 },
    uBright: { value: 1 },
    uRed: { value: lin('#ff4a2e', 2.4) },
    uGreen: { value: lin('#1fff8f', 2.6) },
    // face
    uOverlay: { value: null as THREE.Texture | null },
    uPower: { value: 1 },
    uGrat: { value: 1 },
    uOverlayA: { value: 0.35 },
    uHaze: { value: new THREE.Color(0, 0, 0) },
  }
  glass: THREE.Mesh

  constructor({ samples, overlay, envMap }: { samples: number; overlay: THREE.Texture; envMap: THREE.Texture }) {
    this.uniforms.uM.value = samples
    this.uniforms.uOverlay.value = overlay

    // phosphor face, domed
    const faceGeo = new THREE.PlaneGeometry(SCREEN.w, SCREEN.h, 40, 32)
    const pos = faceGeo.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) pos.setZ(i, this.bulge(pos.getX(i), pos.getY(i)))
    faceGeo.computeVertexNormals()
    const face = new THREE.Mesh(
      faceGeo,
      new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: FACE_VERT, fragmentShader: FACE_FRAG }),
    )
    this.object.add(face)

    // beam traces: 3 rows × 3 persistence layers, ribbons of (sample, strip, side)
    const strips = 9
    const n = strips * samples * 2
    const data = new Float32Array(n * 3)
    let o = 0
    for (let j = 0; j < strips; j++)
      for (let s = 0; s < samples; s++)
        for (let k = 0; k < 2; k++) {
          data[o++] = s
          data[o++] = j
          data[o++] = k * 2 - 1
        }
    const idx = new Uint32Array(strips * (samples - 1) * 6)
    o = 0
    for (let j = 0; j < strips; j++)
      for (let s = 0; s < samples - 1; s++) {
        const a = (j * samples + s) * 2
        idx[o++] = a
        idx[o++] = a + 1
        idx[o++] = a + 2
        idx[o++] = a + 1
        idx[o++] = a + 3
        idx[o++] = a + 2
      }
    const traceGeo = new THREE.BufferGeometry()
    traceGeo.setAttribute('position', new THREE.BufferAttribute(data, 3))
    traceGeo.setIndex(new THREE.BufferAttribute(idx, 1))
    traceGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3)
    const traces = new THREE.Mesh(
      traceGeo,
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: TRACE_VERT,
        fragmentShader: TRACE_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    )
    traces.frustumCulled = false
    traces.renderOrder = 3
    this.object.add(traces)

    // the glass: studio reflections only, added on top. Unlit on purpose: a
    // light's specular hotspot on the glass would bloom into a blob over the
    // traces as the camera pushes in.
    const glassGeo = faceGeo.clone()
    glassGeo.translate(0, 0, 0.012)
    this.glass = new THREE.Mesh(
      glassGeo,
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        envMap,
        combine: THREE.AddOperation,
        reflectivity: 0.07,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    )
    this.glass.renderOrder = 4
    this.object.add(this.glass)
  }

  /** CRT dome height at local (x, y) */
  bulge(x: number, y: number) {
    const qx = x / HX
    const qy = y / HY
    return SCREEN.bulge * (1 - qx * qx) * (1 - qy * qy)
  }

  /** world position of the point u (0..1 across), y (divisions) on the glass */
  worldAt(u: number, yDiv: number, out: THREE.Vector3) {
    const x = (u * 2 - 1) * HX
    const y = yDiv * 0.25 * HY
    out.set(x, y, this.bulge(x, y) + 0.006)
    return this.object.localToWorld(out)
  }
}
