import * as THREE from 'three'
import { smoothstep } from '../../core/math'

/*
 * HERO — "Listen". An anechoic chamber: the quietest room on earth.
 *
 *   0.00–0.12  SILENCE  still room, the chrome mark turns; lights clunk on (time-based intro)
 *   0.12–0.60  SOUND    the LED pulses; pressure fronts roll through the foam
 *   0.60–0.92  PAYOFF   the room settles, camera cranes back + down; headline + CTAs
 *   0.92–1.00  OUT      one big front rushes at the camera; the ripple cut takes over
 *
 * The pressure field is a pure function of (local, time), shared verbatim by
 * the GLSL (foam, net, chrome) and the CPU (callouts, LED, sound).
 */

export const T = {
  soundA: 0.12,
  soundB: 0.6,
  payoffA: 0.62,
  payoffB: 0.92,
  outA: 0.905,
}

/** Where the mark floats (world). The pressure source is its LED diamond. */
export const MARK_POS = new THREE.Vector3(0, 2.15, 0)
export const MARK_SCALE = 2.05

/** Chamber extents (wedge bases). The camera looks down -z. */
export const ROOM = {
  x: 8.2,
  floor: -1.55,
  ceil: 7.6,
  back: -13,
  front: 12.5,
  netY: 0,
}

/** Ceiling light banks, back to front — they clunk on in this order. */
export const FIXTURES_Z = [-9.3, -5.1, -0.9, 3.3, 7.5]
export const FIXTURE_Y = 6.15
export const FIXTURE_HALF = 5.6

/** ring spacing (world units) of the pulse train */
export const LAMBDA = 4.2
/** pulses per unit of local progress (scroll drives the train) */
export const PULSES_PER_LOCAL = 9
/** idle pulses per second so a parked scroll still breathes */
export const IDLE_RATE = 0.45
/** how fast the disturbance's edge spreads, in world units per unit of local */
export const ENV_SPEED = 55
/** out wave: radius reached at local = 1 */
export const OUT_REACH = 13.5

export const wavelet = (x: number) => (x <= 0 ? 0 : Math.exp(-3.2 * x) * Math.sin(10.053 * x) * 1.7)
export const envAt = (l: number) => smoothstep(0.115, 0.2, l) * (1 - smoothstep(0.5, 0.62, l))
export const outAt = (local: number) => Math.max(0, (local - T.outA) / (1 - T.outA))

export interface WaveState {
  phase: number
  local: number
  amp: number
  out: number
}

/** Pressure (−0.4..1.1 × amp) at distance d from the source. Mirrors WAVE_GLSL.pressure. */
export function pressure(w: WaveState, d: number) {
  const x = w.phase - d / LAMBDA
  const f = x - Math.floor(x)
  const a = (envAt(w.local - d / ENV_SPEED) * w.amp) / (1 + d * 0.045)
  let s = wavelet(f) * a
  if (w.out > 0) s += wavelet((w.out * OUT_REACH - d) / 3.0) * 1.35
  return s
}

/** Uniforms shared (by reference) between every material that listens to the field. */
export function makeWaveUniforms() {
  return {
    uPhase: { value: 0 },
    uLocal: { value: 0 },
    uAmp: { value: 0.9 },
    uOut: { value: 0 },
    uSrc: { value: MARK_POS.clone() },
    /** 0 dark (before the lights clunk on) .. 1 */
    uLights: { value: [0, 0, 0, 0, 0] as number[] },
    uAmbient: { value: 0.2 },
    /** mark contact-shadow: xz centre + axis (cos, sin of the mark's yaw) */
    uShadowC: { value: new THREE.Vector2(MARK_POS.x, MARK_POS.z) },
    uShadowAxis: { value: new THREE.Vector2(1, 0) },
    uShadow: { value: 0 },
    uHaze: { value: new THREE.Color('#e7e3db') },
    uTime: { value: 0 },
  }
}
export type WaveUniforms = ReturnType<typeof makeWaveUniforms>

export const WAVE_GLSL = /* glsl */ `
uniform float uPhase;
uniform float uLocal;
uniform float uAmp;
uniform float uOut;
uniform vec3 uSrc;
const float LAMBDA = ${LAMBDA.toFixed(3)};
const float ENV_SPEED = ${ENV_SPEED.toFixed(3)};
const float OUT_REACH = ${OUT_REACH.toFixed(3)};
float wavelet(float x) { return x <= 0.0 ? 0.0 : exp(-3.2 * x) * sin(10.053 * x) * 1.7; }
float envAt(float l) { return smoothstep(0.115, 0.2, l) * (1.0 - smoothstep(0.5, 0.62, l)); }
float pressure(float d) {
  float f = fract(uPhase - d / LAMBDA);
  float a = envAt(uLocal - d / ENV_SPEED) * uAmp / (1.0 + d * 0.045);
  float s = wavelet(f) * a;
  if (uOut > 0.0) s += wavelet((uOut * OUT_REACH - d) / 3.0) * 1.35;
  return s;
}
`

/** Studio light model shared by the foam and the cable net. */
export const LIGHT_GLSL = /* glsl */ `
uniform float uLights[5];
uniform float uAmbient;
uniform vec2 uShadowC;
uniform vec2 uShadowAxis;
uniform float uShadow;
uniform vec3 uHaze;
const float FIX_Z[5] = float[5](${FIXTURES_Z.map(z => z.toFixed(2)).join(', ')});
const float FIX_Y = ${FIXTURE_Y.toFixed(2)};
const float FIX_HALF = ${FIXTURE_HALF.toFixed(2)};
/** diffuse light from the ceiling banks (wrapped Lambert on line lights) */
float bankLight(vec3 P, vec3 N) {
  float l = 0.0;
  for (int i = 0; i < 5; i++) {
    vec3 Lp = vec3(clamp(P.x, -FIX_HALF, FIX_HALF), FIX_Y, FIX_Z[i]);
    vec3 L = Lp - P;
    float r2 = dot(L, L);
    L *= inversesqrt(r2);
    float ndl = max(dot(N, L) * 0.8 + 0.2, 0.0);
    l += uLights[i] * ndl * 13.0 / (r2 + 16.0);
  }
  return l;
}
/** soft elliptical contact shadow of the floating mark */
float markShadow(vec3 P, float soft) {
  vec2 d = P.xz - uShadowC;
  float u = dot(d, uShadowAxis);
  float v = dot(d, vec2(-uShadowAxis.y, uShadowAxis.x));
  float e = u * u / (1.3 * soft) + v * v / (0.32 * soft);
  return 1.0 - uShadow * exp(-e) ;
}
`
