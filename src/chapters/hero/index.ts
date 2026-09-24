import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { clamp, ease, lerp, segment, smoothstep } from '../../core/math'
import { Chamber } from './chamber'
import { Mark } from './mark'
import { HeroUI } from './ui'
import {
  ECHO_LIFE,
  ECHO_SPEED,
  FIXTURES_Z,
  IDLE_RATE,
  MARK_POS,
  MARK_SCALE,
  PULSES_PER_LOCAL,
  T,
  envAt,
  makeWaveUniforms,
  outAt,
  pressure,
  wavelet,
  type WaveState,
} from './shared'
import './hero.css'

/*
 * HERO — "Listen". An anechoic chamber, the quietest room there is.
 *   0.00–0.12  SILENCE  still room; the chrome mark turns; banks of studio
 *                       light clunk on in sequence after the loader hands over
 *   0.12–0.60  SOUND    the LED pulses and pressure fronts roll out through
 *                       the foam: wedges compress, tilt and spring back
 *   0.60–0.92  PAYOFF   the room settles; the camera squares up on the mark,
 *                       centre-high, like a record sleeve; one last echo
 *                       front leaves the LED and carries the liner credit
 *                       "Make the internet listen." in beneath it
 *   0.92–1.00  OUT      one big front rushes at the camera → ripple cut
 */

interface Key {
  t: number
  /** orbit around the (offset) target, radians */
  az: number
  el: number
  dist: number
  /** landscape framing offsets (camera right / world up) */
  tx: number
  ty: number
  /** portrait framing offsets */
  px: number
  py: number
  /** portrait distance factor (phones hold the mark a little closer) */
  pz: number
  fov: number
}
type Prop = Exclude<keyof Key, 't'>

// prettier-ignore
const KEYS: Key[] = [
  { t: 0.0,  az: 0.0,   el: -0.035, dist: 10.6, tx: 0, ty: -0.05, px: 0, py: -0.55, pz: 1,    fov: 38 },
  { t: 0.12, az: 0.0,   el: -0.02,  dist: 9.2,  tx: 0, ty: -0.05, px: 0, py: -0.5,  pz: 1,    fov: 38 },
  { t: 0.3,  az: 0.3,   el: 0.52,   dist: 8.6,  tx: 0, ty: -1.6,  px: 0, py: -1.7,  pz: 1,    fov: 44 },
  { t: 0.46, az: 0.6,   el: 0.3,    dist: 8.0,  tx: 0, ty: -0.8,  px: 0, py: -0.9,  pz: 1,    fov: 42 },
  // payoff: square up on the mark and hold it centre-high, the caption beneath (an album cover)
  { t: 0.62, az: 0.14,  el: 0.18,   dist: 9.2,  tx: 0, ty: -0.66, px: 0, py: -1.1,  pz: 0.95, fov: 40 },
  { t: 0.76, az: 0.0,   el: 0.15,   dist: 9.4,  tx: 0, ty: -0.84, px: 0, py: -1.3,  pz: 0.86, fov: 38 },
  { t: 0.92, az: -0.03, el: 0.15,   dist: 9.15, tx: 0, ty: -0.84, px: 0, py: -1.3,  pz: 0.86, fov: 38 },
]

/** Smooth monotone cubic through the keys (no stops at each key). */
function sample(t: number, prop: Prop): number {
  const n = KEYS.length
  if (t <= KEYS[0].t) return KEYS[0][prop]
  if (t >= KEYS[n - 1].t) return KEYS[n - 1][prop]
  let i = 0
  while (i < n - 2 && t > KEYS[i + 1].t) i++
  const k0 = KEYS[i]
  const k1 = KEYS[i + 1]
  const h = k1.t - k0.t
  const s = (t - k0.t) / h
  const slope = (j: number) => {
    if (j <= 0 || j >= n - 1) return 0
    const a = KEYS[j - 1],
      b = KEYS[j],
      c = KEYS[j + 1]
    const d0 = (b[prop] - a[prop]) / (b.t - a.t)
    const d1 = (c[prop] - b[prop]) / (c.t - b.t)
    if (d0 * d1 <= 0) return 0
    return (2 * d0 * d1) / (d0 + d1)
  }
  const m0 = slope(i) * h
  const m1 = slope(i + 1) * h
  const s2 = s * s
  const s3 = s2 * s
  return (2 * s3 - 3 * s2 + 1) * k0[prop] + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * k1[prop] + (s3 - s2) * m1
}

/** 0 landscape .. 1 tall portrait: blends the portrait framing in */
const portraitQ = (aspect: number) => clamp((1.3 - aspect) / 0.75)

/**
 * Where the settled payoff frame puts the mark's lower edge, as a fraction of
 * screen height from the top — the caption hangs beneath it at any aspect.
 */
function markFoot(aspect: number, markHalf: number) {
  const q = portraitQ(aspect)
  const s = 0.84
  const halfFov = ((sample(s, 'fov') + 16 * q) * Math.PI) / 360
  const dist = sample(s, 'dist') * lerp(1, sample(s, 'pz'), q) * (1 - 0.04 * q)
  const oy = lerp(sample(s, 'ty'), sample(s, 'py'), q)
  const ndc = (-oy - markHalf) / (dist * Math.tan(halfFov))
  return 0.5 - ndc * 0.5
}

/** Light bank i, `t` seconds after the reveal: off, then a hard clunk on with a small settle. */
function bank(t: number, i: number, reduced: boolean) {
  const at = 0.28 + i * 0.2
  if (t < at) return 0
  const x = t - at
  if (reduced) return clamp(x / 0.5)
  // the far bank's tube catches on the second strike
  if (i === 1 && x < 0.16) return x < 0.05 ? 1.1 : x < 0.1 ? 0.12 : 1.25
  return 1 + 0.35 * Math.exp(-x * 9) * Math.cos(x * 30)
}

/** A macrotask yield (rAF never fires in a background tab). */
const yieldToBrowser = () => new Promise<void>(r => setTimeout(r, 0))

export default function create(): Chapter {
  const group = new THREE.Group()
  const u = makeWaveUniforms()
  const markRoot = new THREE.Group()
  markRoot.position.copy(MARK_POS)
  markRoot.scale.setScalar(MARK_SCALE)
  group.add(markRoot)

  let chamber: Chamber
  let mark: Mark
  let ui: HeroUI
  let reduced = false
  let revealAt = -1
  let initAt = 0
  let warm = 0
  let toneOn = false
  let camAz = 0
  /** when the payoff's echo front left the LED (performance clock), and whether the caption was called last frame */
  let echoAt = -1
  let captionWas = false
  /** the mark's half-height in world units (its yaw never changes it) */
  let markHalf = 1.1
  let footAspect = 0

  const wave: WaveState = { phase: 0, local: 0, amp: 0.9, out: 0, echo: 0, echoAmp: 0 }
  const anchorWorld: THREE.Vector3[] = []
  const anchorPress: number[] = []
  const tmpD = new THREE.Vector3()
  const tmpA = new THREE.Vector3()
  const tmpB = new THREE.Vector3()
  const right = new THREE.Vector3()
  const ledWorld = new THREE.Vector3()
  const now = () => performance.now() / 1000

  return {
    id: 'hero',
    group,

    async init(ctx: ChapterContext) {
      reduced = ctx.reducedMotion
      initAt = now()
      // two chunks with a yield between, so the loader keeps painting
      chamber = new Chamber(ctx.mobile, u)
      group.add(chamber.group)
      await yieldToBrowser()

      mark = new Mark(ctx.mobile)
      // centre the LED on the pivot so the mark turns around its heart
      mark.root.position.set(-mark.center.x, -mark.center.y, 0)
      markRoot.add(mark.root)
      mark.chrome.geometry.computeBoundingBox()
      const bb = mark.chrome.geometry.boundingBox!
      markHalf = ((bb.max.y - bb.min.y) * MARK_SCALE) / 2
      await yieldToBrowser()
      mark.attachEnv(ctx.renderer, ctx.mobile)

      ui = new HeroUI(ctx.stage, ctx.mobile)
      ui.addCallouts(chamber.anchors.length, [-44, -39, -51])
      for (let i = 0; i <= chamber.anchors.length; i++) {
        anchorWorld.push(new THREE.Vector3())
        anchorPress.push(0)
      }

      const onReveal = () => {
        if (revealAt < 0) revealAt = now()
      }
      if (document.documentElement.dataset.ready === '1') onReveal()
      else window.addEventListener('hark:reveal', onReveal, { once: true })
    },

    update(local: number, frame: Frame, ctx: ChapterContext) {
      const t = frame.time
      const clock = now()
      const motion = reduced ? 0.25 : 1
      if (revealAt < 0 && (document.documentElement.dataset.ready === '1' || clock - initAt > 20)) revealAt = clock
      // first update is the engine's prewarm: light everything so it all compiles/uploads
      const warming = warm++ < 1
      const since = warming ? 99 : revealAt < 0 ? -1 : clock - revealAt

      // ---- lights ----
      let lit = 0
      for (let i = 0; i < FIXTURES_Z.length; i++) {
        const v = since < 0 ? 0 : bank(since, i, reduced)
        u.uLights.value[i] = v
        lit += Math.min(v, 1)
      }
      lit /= FIXTURES_Z.length
      u.uAmbient.value = lerp(0.1, 1, lit)
      u.uTime.value = t

      // ---- the pressure field ----
      const phase = local * PULSES_PER_LOCAL + t * IDLE_RATE * motion
      const out = outAt(local)
      wave.phase = phase
      wave.local = local
      wave.amp = reduced ? 0.55 : 0.92
      wave.out = reduced ? out * 0.5 : out
      u.uPhase.value = phase
      u.uLocal.value = local
      u.uAmp.value = wave.amp
      u.uOut.value = wave.out

      // ---- the echo: one last front, sent out as the caption is called in ----
      const caption = local > T.captionA && local < T.captionB
      if (caption && !captionWas && !warming && (echoAt < 0 || clock - echoAt > ECHO_LIFE * 0.6)) echoAt = clock
      captionWas = caption
      const age = echoAt < 0 ? 99 : clock - echoAt
      const echoLive = age < ECHO_LIFE
      wave.echo = age * ECHO_SPEED
      wave.echoAmp = echoLive ? (reduced ? 0.35 : 0.7) * (1 - smoothstep(ECHO_LIFE - 0.5, ECHO_LIFE, age)) : 0
      u.uEcho.value = wave.echo
      u.uEchoAmp.value = wave.echoAmp
      const echoK = echoLive ? Math.exp(-age * 4.5) : 0

      const env = envAt(local)
      const f = phase - Math.floor(phase)
      const kick = env * Math.exp(-f * 5) + echoK * 0.8

      // ---- the mark ----
      const bob = Math.sin(t * 0.55) * 0.045 * motion
      markRoot.position.set(MARK_POS.x, MARK_POS.y + bob, MARK_POS.z)
      const yaw = camAz * 0.55 - 0.16 + Math.sin(t * 0.19) * 0.12 * motion + (1 - smoothstep(0, 0.2, local)) * 0.1 * Math.sin(t * 0.13)
      const outK = wavelet(out * 3.2)
      markRoot.rotation.set(Math.sin(t * 0.27) * 0.03 * motion - out * 0.2, yaw, Math.sin(t * 0.23) * 0.015 * motion)
      markRoot.scale.setScalar(MARK_SCALE * (1 + kick * 0.025 + outK * 0.05))
      mark.uniforms.uMPhase.value = phase
      mark.uniforms.uMAmp.value = (env * 0.0095 + outK * 0.012 + echoK * 0.008) * (reduced ? 0.5 : 1)
      mark.uniforms.uMIdle.value = 0.0065 * (reduced ? 0.4 : 1)
      mark.uniforms.uMTime.value = t
      // at rest the diamond sits just under the bloom threshold, so its halo breathes in and out
      const breathe = 1.45 + 0.42 * (0.5 + 0.5 * Math.sin(t * 1.5)) * motion
      const led = breathe + kick * 2.2 + out * 2.5
      mark.set(led, warming ? 1 : lit, 0.05 * wavelet(f) * env + 0.04 * outK)

      // contact shadow follows the mark's yaw
      u.uShadowC.value.set(markRoot.position.x, markRoot.position.z)
      u.uShadowAxis.value.set(Math.cos(yaw), -Math.sin(yaw))
      u.uShadow.value = 0.62 * lit

      // ---- post + studio ----
      const pp = ctx.post.params
      pp.bloomStrength = 0.6 + kick * 0.2 + out * 0.15
      pp.bloomRadius = 0.22
      pp.aberration = 0.0012 + out * 0.0012
      pp.vignette = 0.26
      pp.flash = Math.pow(segment(local, 0.97, 1), 2) * 0.18
      const sp = ctx.studio.params
      sp.tone = 0
      sp.spot = 0
      sp.envIntensity = 0.7

      // ---- sound hook: a low sine that swells with each pulse ----
      const sounding = env > 0.01 || out > 0 || echoK > 0.01
      if (sounding || toneOn) {
        const level = sounding ? clamp(0.12 * env * (0.4 + 0.6 * Math.exp(-f * 3)) + out * 0.2 + echoK * 0.1) : 0
        window.dispatchEvent(new CustomEvent('hark:tone', { detail: { hz: 110, level } }))
        toneOn = sounding
      }

      // ---- DOM ----
      const aspect = frame.width / Math.max(1, frame.height)
      if (aspect !== footAspect) {
        footAspect = aspect
        ui.setCaptionTop(markFoot(aspect, markHalf))
      }
      const soundOn = local > 0.17 && local < 0.56
      // the meter reads the pressure arriving a few metres out
      const level = clamp(Math.abs(pressure(wave, 2.5)) * 0.95 + kick * 0.2)
      ui.update({
        local,
        introT: warming ? 0 : since,
        level: soundOn ? level : 0,
        pulse: Math.floor(phase - T.soundA * PULSES_PER_LOCAL),
        sound: soundOn,
        reduced,
      })

      // callout anchors ride on their (deformed) wedge tips
      chamber.anchors.forEach((a, i) => {
        const d = tmpD.copy(a.base).sub(MARK_POS)
        const dist = d.length()
        const s = pressure(wave, dist)
        d.addScaledVector(a.normal, -d.dot(a.normal)).normalize()
        anchorWorld[i]
          .copy(a.base)
          .addScaledVector(a.normal, a.height * (1 - 0.42 * s))
          .addScaledVector(d, 0.5 * s * 0.6)
        anchorPress[i] = s
      })
      group.updateMatrixWorld(true)
      mark.led.getWorldPosition(ledWorld)
      anchorWorld[chamber.anchors.length].copy(ledWorld)
      ui.updateCallouts(local > 0.2 && local < 0.55, anchorWorld, anchorPress, ctx.camera, frame.width, frame.height, frame.dt)
    },

    camera(local: number, frame: Frame, out: CameraPose) {
      const aspect = frame.width / Math.max(1, frame.height)
      const q = portraitQ(aspect)
      const tl = Math.min(local, T.payoffB)
      const idle = reduced ? 0 : 1
      const az = sample(tl, 'az') + Math.sin(frame.time * 0.11) * 0.01 * idle
      const el = sample(tl, 'el') + Math.sin(frame.time * 0.09) * 0.006 * idle
      const dist = sample(tl, 'dist') * lerp(1, sample(tl, 'pz'), q) * (1 - 0.04 * q)
      const fov = sample(tl, 'fov') + 16 * q
      // landscape offsets are authored at 16:10; narrower screens pull the subject in
      const ox = lerp(sample(tl, 'tx') * Math.min(1, aspect / 1.6), sample(tl, 'px'), q)
      const oy = lerp(sample(tl, 'ty'), sample(tl, 'py'), q)
      camAz = az

      right.set(Math.cos(az), 0, -Math.sin(az))
      const target = tmpA.copy(MARK_POS).addScaledVector(right, ox)
      target.y += oy
      const dir = tmpB.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
      out.position.copy(target).addScaledVector(dir, dist)
      out.target.copy(target)
      out.fov = fov
      out.roll = 0
      out.parallax = 0.35

      // OUT: a slow push toward the mark as the front arrives, a little shudder when it passes
      const o = segment(local, T.payoffB, 1)
      if (o > 0) {
        const push = ease.inCubic(o)
        out.position.lerp(tmpA.copy(MARK_POS).addScaledVector(dir, dist * 0.55), push * 0.6)
        out.target.lerp(MARK_POS, push * 0.5)
        out.fov = lerp(fov, fov + 10, push)
        out.roll = -0.03 * push
        const hit = outAt(local)
        const shake = smoothstep(0.55, 0.75, hit) * (1 - smoothstep(0.8, 1, hit)) * 0.05 * idle
        out.position.y += Math.sin(frame.time * 37) * shake
        out.position.x += Math.sin(frame.time * 29 + 1.3) * shake * 0.6
      }
    },

    onLeave() {
      if (toneOn) {
        window.dispatchEvent(new CustomEvent('hark:tone', { detail: { hz: 110, level: 0 } }))
        toneOn = false
      }
    },
  }
}
