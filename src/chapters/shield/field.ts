import * as THREE from 'three'
import { HASH } from '../../core/glsl'

/*
 * The waterfall: N parallel waveform rows receding in depth on the bone
 * floor, each a paper fin (opaque, so rows in front hide the ones behind,
 * Unknown-Pleasures style) topped with an ink ribbon of constant screen-space
 * width. Every vertex is evaluated in the shader from uniforms, so the whole
 * field is two draw calls and has no state: the same (local, time) always
 * gives the same picture.
 *
 *   height = base + rise * (noise * spring + calm * calmMix) + pulse
 *
 * noise   a jagged, flickering spectrum; bursts (hack attempts) form ridges
 *         that drift back through the rows like a real waterfall display.
 * spring  behind the anti-phase front the noise rings down like a damped
 *         spring: it flips upside down (anti-noise), overshoots, settles to 0.
 * calm    a slow breathing sine that rolls diagonally across the rows.
 */

const FIELD_GLSL = /* glsl */ `
uniform float uTime;
uniform float uFlicker;
uniform float uNoise;
uniform float uDensity;
uniform float uFront;
uniform float uLag;
uniform float uCalm;
uniform float uGather;
uniform float uRise;
uniform float uLedOn;
uniform vec2 uPulse;
uniform vec2 uCount;
uniform vec3 uSize;
uniform vec4 uHero;
uniform vec4 uPoke;

${HASH}

float vnoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// sample s (0..M-1) of row j (0 = front .. N-1 = back).
// info = (alert 0..1, led 0..1, depth 0 front..1 back)
vec3 fieldPos(float s, float j, out vec3 info) {
  float u = s / (uCount.y - 1.0) * 2.0 - 1.0;
  float zn = 1.0 - 2.0 * j / (uCount.x - 1.0);
  float age = (1.0 - zn) * 0.5;
  float t = uTime;
  float env = exp(-u * u * 2.4);

  // ---- noise: rows further back are older (waterfall), so features drift back
  float T = (t - age * 4.8) * 1.3;
  float hills = vnoise2(vec2(u * 5.5 + 11.0, T * 0.9)) * 0.65 + vnoise2(vec2(u * 15.0 - 4.0, T * 1.9)) * 0.35;
  hills = hills * hills;
  float grass = hash12(vec2(s * 1.37 + j * 57.1, floor(t * uFlicker) + j * 3.0));
  grass *= grass;
  float burst = 0.0;
  float alert = 0.0;
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float ct = T * (1.1 + fk * 0.43) + fk * 17.3;
    float cell = floor(ct);
    float ph = fract(ct);
    if (hash12(vec2(cell, fk * 7.1 + 1.0)) > uDensity) continue;
    float cx = hash12(vec2(cell, fk * 3.7 + 11.0)) * 1.8 - 0.9;
    float amp = 0.3 + 1.15 * pow(hash12(vec2(cell, fk + 23.0)), 2.2);
    float w = 0.006 + 0.018 * hash12(vec2(cell, fk + 5.0));
    float shape = exp(-abs(u - cx) / w);
    float envT = smoothstep(0.0, 0.07, ph) * pow(1.0 - ph, 1.4);
    float spike = amp * shape * envT * (0.5 + 0.5 * hash12(vec2(s, cell + fk)));
    burst += spike;
    float isAlert = step(0.6, hash12(vec2(cell, fk + 31.0)));
    alert = max(alert, isAlert * smoothstep(0.06, 0.32, spike));
  }
  float noise = uNoise * (hills * 0.5 * (0.12 + env) + grass * 0.05 * (0.35 + env) + burst * (0.6 + 0.4 * env));

  // the intrusion: one sustained spike and its echo in the rows behind
  float dj = j - uHero.x;
  if (dj > -0.5 && dj < 4.5) {
    float hs = uHero.z * exp(-dj * 0.7) * exp(-abs(u - uHero.y - dj * 0.006) / 0.014) * (0.82 + 0.18 * hash12(vec2(s, 91.0)));
    noise += hs;
    alert = max(alert, smoothstep(0.05, 0.3, hs));
  }

  // the visitor's pointer is a little anti-noise of its own: it quiets the
  // noise under it and lifts the calm surface like a hand under silk
  vec2 pw = vec2(u * uSize.x, zn * uSize.y) - uPoke.xy;
  float poke = uPoke.w * exp(-dot(pw, pw) / (uPoke.z * uPoke.z));
  noise *= 1.0 - 0.9 * poke;
  alert *= 1.0 - poke;

  // ---- calm: a slow breathing sine rolling diagonally across the rows
  float g = uGather;
  float phase = age * 5.2 * (1.0 - g);
  float breath = 0.8 + 0.2 * sin(t * 0.85 + age * 2.8 * (1.0 - g));
  float envC = smoothstep(1.02, 0.4, abs(u));
  float calm = uCalm * breath * envC * sin(u * 7.85 + phase - t * 0.55);

  // ---- the anti-phase front: d > 0 behind it. The front row leads.
  float d = uFront - u - uLag * age;
  float sw = step(0.0, d);
  float spring = mix(1.0, exp(-d * 6.2) * cos(d * 14.0), sw);
  float calmMix = sw * (1.0 - exp(-d * 3.2));
  float led = exp(-d * d * 7000.0) * uLedOn;
  float ridge = 0.035 * led;

  // ---- in-beat: a pressure wave rolls through the rows, front to back
  float pulse = uPulse.y * exp(-pow((zn - uPulse.x) * 4.0, 2.0)) * (0.35 + 0.65 * env);

  float h = uSize.z + uRise * (noise * spring + calm * calmMix + poke * 0.12 * calmMix) + ridge + pulse;
  h = max(h, 0.035) + g * g * 0.5;

  info = vec3(alert * clamp(spring, 0.0, 1.0) * step(0.0, uRise - 0.01), led, age * (1.0 - g));
  return vec3(u * uSize.x * (1.0 + g * 0.9), h, zn * uSize.y * (1.0 - g));
}
`

const LINE_VERT = /* glsl */ `
${FIELD_GLSL}
uniform vec2 uRes;
uniform float uWidth;
varying float vDist;
varying float vHalf;
varying vec3 vInfo;
varying float vDense;

void main() {
  float s = position.x;
  float j = position.y;
  float side = position.z;
  vec3 info;
  vec3 i0;
  vec3 i2;
  vec3 p1 = fieldPos(s, j, info);
  vec3 p0 = fieldPos(max(s - 1.0, 0.0), j, i0);
  vec3 p2 = fieldPos(min(s + 1.0, uCount.y - 1.0), j, i2);
  mat4 mvp = projectionMatrix * modelViewMatrix;
  vec4 c0 = mvp * vec4(p0, 1.0);
  vec4 c1 = mvp * vec4(p1, 1.0);
  vec4 c2 = mvp * vec4(p2, 1.0);
  vec2 a = c0.xy / max(abs(c0.w), 1e-4) * uRes;
  vec2 b = c2.xy / max(abs(c2.w), 1e-4) * uRes;
  vec2 tng = b - a;
  float len = length(tng);
  tng = len > 1e-5 ? tng / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-tng.y, tng.x);
  // ink thins with distance; the LED band and alert tips run a touch heavier
  float w = uWidth * mix(1.0, 0.45, info.z) * (1.0 + info.y * 0.35 + info.x * 0.5 + uGather * 0.8);
  float halfW = w * 0.5 + 1.0;
  // anti-moire: where rows crowd closer than a few pixels on screen, let the ink recede
  vec4 cz = mvp * vec4(p1 + vec3(0.0, 0.0, -2.0 * uSize.y * (1.0 - uGather) / (uCount.x - 1.0)), 1.0);
  float gap = length((cz.xy / max(abs(cz.w), 1e-4) - c1.xy / max(abs(c1.w), 1e-4)) * 0.5 * uRes);
  vDense = mix(1.0, smoothstep(1.0, 4.5, gap), 0.6 * (1.0 - uGather));
  c1.xy += nrm * side * halfW * 2.0 / uRes * c1.w;
  vDist = side * halfW;
  vHalf = w * 0.5;
  vInfo = info;
  gl_Position = c1;
}
`

const LINE_FRAG = /* glsl */ `
uniform vec3 uInk;
uniform vec3 uFog;
uniform vec3 uAlert;
uniform vec3 uLed;
uniform float uOpacity;
varying float vDist;
varying float vHalf;
varying vec3 vInfo;
varying float vDense;

void main() {
  float cov = clamp(vHalf + 0.5 - abs(vDist), 0.0, 1.0) * mix(0.35, 1.0, vDense);
  vec3 col = mix(uInk, uFog, vInfo.z * 0.72);
  col = mix(col, uAlert, clamp(vInfo.x, 0.0, 1.0));
  col = mix(col, uLed, clamp(vInfo.y, 0.0, 1.0));
  gl_FragColor = vec4(col, cov * uOpacity);
}
`

const FIN_VERT = /* glsl */ `
${FIELD_GLSL}
varying float vY;
varying float vTop;
varying vec3 vInfo;

void main() {
  vec3 info;
  vec3 p = fieldPos(position.x, position.y, info);
  vTop = p.y;
  // out-beat: the fins shrink up into their line so one clean waveform is left
  p.y = mix(mix(0.0, p.y - 0.03, uGather), p.y, position.z);
  vY = p.y;
  vInfo = info;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`

const FIN_FRAG = /* glsl */ `
uniform vec3 uFin;
uniform vec3 uFinLow;
uniform vec3 uFog;
uniform vec3 uAlert;
uniform vec3 uLed;
varying float vY;
varying float vTop;
varying vec3 vInfo;

void main() {
  float below = vTop - vY;
  // paper fin: lit along its top edge, occluded toward the floor
  vec3 col = mix(uFinLow, uFin, smoothstep(0.0, 0.42, vY));
  col *= 1.0 + 0.05 * smoothstep(0.035, 0.0, below);
  col = mix(col, uFog, vInfo.z * 0.5);
  // the passing LED front and the red spikes both light the paper under them
  float nearTop = smoothstep(0.32, 0.0, below);
  col += uLed * 0.012 * vInfo.y * nearTop;
  col = mix(col, uAlert * 0.55, vInfo.x * 0.16 * nearTop);
  gl_FragColor = vec4(col, 1.0);
}
`

export interface FieldOptions {
  rows: number
  samples: number
}

const lin = (hex: string, k = 1) => new THREE.Color(hex).multiplyScalar(k)

export class Field {
  object = new THREE.Group()
  uniforms = {
    uTime: { value: 0 },
    uFlicker: { value: 12 },
    uNoise: { value: 1 },
    uDensity: { value: 0.6 },
    uFront: { value: -3 },
    uLag: { value: 0.55 },
    uCalm: { value: 0.2 },
    uGather: { value: 0 },
    uRise: { value: 1 },
    uLedOn: { value: 0 },
    uPulse: { value: new THREE.Vector2(2, 0) },
    uCount: { value: new THREE.Vector2(1, 1) },
    /** half width (x), half depth (z), base height */
    uSize: { value: new THREE.Vector3(5, 3, 0.14) },
    /** row, u, amplitude of the sustained intrusion spike */
    uHero: { value: new THREE.Vector4(-10, 0, 0, 0) },
    /** pointer on the field: x, z, radius, strength */
    uPoke: { value: new THREE.Vector4(0, 0, 1, 0) },
    uRes: { value: new THREE.Vector2(1, 1) },
    uWidth: { value: 1.6 },
    uOpacity: { value: 1 },
    uInk: { value: lin('#0e0e0f') },
    uFog: { value: lin('#e6e2da') },
    uAlert: { value: lin('#ff4a2e', 1.35) },
    uLed: { value: lin('#00ff85', 2.6) },
    uFin: { value: lin('#f6f4ef') },
    uFinLow: { value: lin('#c9c3b8') },
  }
  rows: number
  samples: number

  constructor({ rows, samples }: FieldOptions) {
    this.rows = rows
    this.samples = samples
    this.uniforms.uCount.value.set(rows, samples)

    const n = rows * samples * 2
    const data = new Float32Array(n * 3)
    let o = 0
    for (let j = 0; j < rows; j++)
      for (let s = 0; s < samples; s++)
        for (let k = 0; k < 2; k++) {
          data[o++] = s
          data[o++] = j
          data[o++] = k
        }
    const idx = n > 65535 ? new Uint32Array(rows * (samples - 1) * 6) : new Uint16Array(rows * (samples - 1) * 6)
    o = 0
    for (let j = 0; j < rows; j++)
      for (let s = 0; s < samples - 1; s++) {
        const a = (j * samples + s) * 2
        idx[o++] = a
        idx[o++] = a + 1
        idx[o++] = a + 2
        idx[o++] = a + 1
        idx[o++] = a + 3
        idx[o++] = a + 2
      }

    // fins: position = (s, j, 0 floor | 1 top)
    const finGeo = new THREE.BufferGeometry()
    finGeo.setAttribute('position', new THREE.BufferAttribute(data, 3))
    finGeo.setIndex(new THREE.BufferAttribute(idx, 1))
    // lines: position = (s, j, -1 | +1 side)
    const lineData = data.slice()
    for (let i = 2; i < lineData.length; i += 3) lineData[i] = lineData[i] * 2 - 1
    const lineGeo = new THREE.BufferGeometry()
    lineGeo.setAttribute('position', new THREE.BufferAttribute(lineData, 3))
    lineGeo.setIndex(new THREE.BufferAttribute(idx, 1))
    const sphere = new THREE.Sphere(new THREE.Vector3(), 20)
    finGeo.boundingSphere = sphere
    lineGeo.boundingSphere = sphere

    const fins = new THREE.Mesh(
      finGeo,
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: FIN_VERT,
        fragmentShader: FIN_FRAG,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 2,
      }),
    )
    fins.frustumCulled = false
    const lines = new THREE.Mesh(
      lineGeo,
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: LINE_VERT,
        fragmentShader: LINE_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    lines.frustumCulled = false
    lines.renderOrder = 2
    this.object.add(fins, lines)
  }
}
