import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { clamp, ease, lerp, segment, smoothstep } from '../../core/math'
import { Desk, LADDERS, STRIPS, type DeskState } from './desk'
import { DeskHud } from './hud'
import { DB_MARKS, LAYOUT as L, faderDb } from './layout'
import './process.css'

/*
 * THE DESK — "We listen first. Then we build."  (after the Noise Floor bench
 * scope, before the ferrofluid Say Hello)
 *
 * A low-angle product film of a four-channel console on the bone cyc. Each
 * process step is a channel: as you scroll, its fader climbs the dB legend
 * detent by detent (a damped spring chases a scroll-derived staircase, so it
 * clicks and overshoots), its meter jumps, its LED lights and the camera
 * settles on that strip. The walk starts close on Listen and pulls back and
 * round a little with every channel, so the mix builds into the whole desk;
 * the meter bridge and the cyc above it stay in shot, so the chrome's nav band
 * only ever sits on paper. Then the bridge readouts clear and sweep in the
 * stats, and the master fader slams to the stop with every meter pinned while
 * the camera cranes up over it, handing over to the overhead dish.
 *
 *   0.00–0.08  ripple lands, desk self-test sweep; eyebrow + headline
 *   0.08–0.80  channels 01–04: Listen · Prototype · Build · Support
 *              (each settles at ANCHORS[i]: fader up, its text open)
 *   0.80–0.95  bridge readouts: 10 YRS · $1M+ · 15 (+ labels)
 *   0.95–1.00  master to +10, all meters peak, crane up → cut
 */

const S0 = 0.08
const SW = 0.18
/** the camera settles on channel i here (its fader has just clicked up) */
const WALK = [0.1, 0.35, 0.53, 0.71]
/** keyboard / screen-reader stops, one per PROCESS step: fader up, row open, strip framed */
const ANCHORS = [0.17, 0.35, 0.53, 0.71]
const STATS_AT = 0.8
const END_AT = 0.952
const UNITY = 0.75
const DETENTS = DB_MARKS.map(m => m[0]).sort((a, b) => a - b)
/** an A-major voicing, one note per channel (+ master) for the optional tone */
const NOTES = [110, 164.81, 220, 277.18, 440]

const DEG = Math.PI / 180
/** world height of the desk (bridge top to front foot, as framed for the stats) that fills the free band */
const STATS_FIT = 2.3

/** Soft staircase through the legend marks: the cap sticks, then clicks to the next notch. */
function detent(p: number) {
  for (let i = 1; i < DETENTS.length; i++) {
    const a = DETENTS[i - 1]
    const b = DETENTS[i]
    if (p <= b) return a + (b - a) * smoothstep(0.5, 1, (p - a) / (b - a))
  }
  return p
}

function faderTarget(i: number, local: number) {
  if (i < 4) {
    const s = S0 + SW * i
    return detent(ease.inOutQuad(segment(local, s + 0.002, s + 0.062)) * UNITY)
  }
  return detent(lerp(UNITY, 1, ease.inOutCubic(segment(local, END_AT, 0.985))))
}

/** where each channel's GAIN / TONE pair snaps to as it opens */
const KNOB_GAIN = [0.55, 0.15, 1.05, 0.4]
const KNOB_TONE = [-0.45, 0.5, 0.25, -0.2]

// channel "programme material" for the meters: a breathing pad, a pulse, a kick, a steady bed
const ENV = [
  (t: number) => 0.8 + 0.13 * Math.sin(t * 1.9) + 0.06 * Math.sin(t * 5.3 + 1),
  (t: number) => 0.66 + 0.3 * Math.pow(0.5 + 0.5 * Math.sin(t * 4.4), 3),
  (t: number) => 0.52 + 0.46 * Math.exp(-((t * 2.1) % 1) * 5.5),
  (t: number) => 0.82 + 0.08 * Math.sin(t * 3.1 + 2) + 0.06 * Math.sin(t * 7.7),
]

// ---------------------------------------------------------------- camera

interface Shot {
  t: number
  /** subject point */
  p: [number, number, number]
  az: number
  el: number
  /** world width / height that must fit around the subject */
  w: number
  h: number
  /** where the subject sits on screen, NDC */
  sx: number
  sy: number
  fov: number
  /** easing INTO this key */
  e?: (t: number) => number
}

const inOutSine = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t)
const linear = (t: number) => t
const ch = (i: number, dx = 0): [number, number, number] => [L.channels[i] + 0.02 + dx, 0.3, 0.62]

/*
 * Landscape. The channel keys are low (el 26–31) so the meter bridge and the
 * cyc above it stay in shot: the desk's far edge sits below the chrome band
 * (checked at 1024x768 … 1920x1080), the headline and list sit on paper, and
 * the strip stays right of the copy column. Each channel pulls back and swings
 * round a little further than the last, so by Support the whole desk is in view.
 */
const WIDE: Shot[] = [
  { t: 0, p: [-0.35, 0.32, 0.25], az: 30, el: 38, w: 6.2, h: 3.4, sx: 0.3, sy: -0.34, fov: 30 },
  { t: WALK[0], p: ch(0), az: 20, el: 26, w: 2.88, h: 1.8, sx: 0.36, sy: -0.3, fov: 30, e: ease.inOutCubic },
  { t: WALK[1], p: ch(1), az: 25, el: 27, w: 3.04, h: 1.9, sx: 0.36, sy: -0.32, fov: 30, e: inOutSine },
  { t: WALK[2], p: ch(2), az: 33, el: 28, w: 3.52, h: 2.2, sx: 0.34, sy: -0.36, fov: 30, e: inOutSine },
  { t: WALK[3], p: ch(3), az: 40, el: 30, w: 4.32, h: 2.7, sx: 0.4, sy: -0.45, fov: 30, e: inOutSine },
  { t: 0.78, p: ch(3, 0.06), az: 40, el: 31, w: 4.42, h: 2.76, sx: 0.4, sy: -0.45, fov: 30, e: linear },
  { t: 0.865, p: [0, 0.3, 0.02], az: 0, el: 24, w: 7.0, h: 3.3, sx: 0, sy: 0.1, fov: 30, e: ease.inOutCubic },
  { t: END_AT, p: [0.06, 0.3, 0.02], az: 2.5, el: 25, w: 6.7, h: 3.15, sx: 0, sy: 0.1, fov: 30, e: linear },
  // the master slam: push in and crane up over the fader (Say Hello opens overhead)
  { t: 1, p: [L.masterX + 0.05, 0.3, 0.5], az: 8, el: 58, w: 1.5, h: 1.2, sx: 0, sy: 0.02, fov: 30, e: ease.inCubic },
]

/** Portrait: one strip at a time, centred in the free band between headline and list. */
const TALL: Shot[] = [
  { t: 0, p: [0.1, 0.32, 0.2], az: 24, el: 42, w: 5.0, h: 3.4, sx: 0, sy: 0.02, fov: 38 },
  { t: WALK[0], p: ch(0), az: 22, el: 60, w: 2.1, h: 2.2, sx: 0, sy: 0.02, fov: 38, e: ease.inOutCubic },
  { t: WALK[1], p: ch(1), az: 24, el: 60, w: 2.1, h: 2.2, sx: 0, sy: 0.02, fov: 38, e: inOutSine },
  { t: WALK[2], p: ch(2), az: 26, el: 61, w: 2.1, h: 2.2, sx: 0, sy: 0.02, fov: 38, e: inOutSine },
  { t: WALK[3], p: ch(3), az: 28, el: 62, w: 2.1, h: 2.2, sx: 0, sy: 0.02, fov: 38, e: inOutSine },
  { t: 0.78, p: ch(3, 0.05), az: 28, el: 62, w: 2.15, h: 2.25, sx: 0, sy: 0.02, fov: 38, e: linear },
  { t: 0.865, p: [0, 0.3, -0.05], az: 0, el: 50, w: 4.5, h: 2.1, sx: 0, sy: 0.3, fov: 38, e: ease.inOutCubic },
  { t: END_AT, p: [0.04, 0.3, -0.05], az: 2.5, el: 51, w: 4.3, h: 2.0, sx: 0, sy: 0.3, fov: 38, e: linear },
  { t: 1, p: [L.masterX + 0.05, 0.3, 0.5], az: 6, el: 64, w: 1.1, h: 1.4, sx: 0, sy: 0.05, fov: 38, e: ease.inCubic },
]
/** the walk keys (portrait) whose framing follows the free band */
const TALL_WALK = TALL.slice(1, 6)
const STATS_KEYS = { wide: [WIDE[6], WIDE[7]], tall: [TALL[6], TALL[7]] }

const _dir = new THREE.Vector3()
const _right = new THREE.Vector3()
const _up = new THREE.Vector3()

function shotAt(keys: Shot[], local: number, out: Shot) {
  let i = 1
  while (i < keys.length - 1 && local > keys[i].t) i++
  const a = keys[i - 1]
  const b = keys[i]
  const k = (b.e ?? ease.inOutCubic)(segment(local, a.t, b.t))
  out.p[0] = lerp(a.p[0], b.p[0], k)
  out.p[1] = lerp(a.p[1], b.p[1], k)
  out.p[2] = lerp(a.p[2], b.p[2], k)
  out.az = lerp(a.az, b.az, k)
  out.el = lerp(a.el, b.el, k)
  out.w = lerp(a.w, b.w, k)
  out.h = lerp(a.h, b.h, k)
  out.sx = lerp(a.sx, b.sx, k)
  out.sy = lerp(a.sy, b.sy, k)
  out.fov = lerp(a.fov, b.fov, k)
  return out
}

function applyShot(s: Shot, aspect: number, out: CameraPose) {
  const tv = Math.tan((s.fov * DEG) / 2)
  const th = tv * aspect
  const dist = Math.max(s.w / 2 / th, s.h / 2 / tv)
  const az = s.az * DEG
  const el = s.el * DEG
  _dir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
  _right.set(Math.cos(az), 0, -Math.sin(az))
  _up.crossVectors(_dir, _right)
  out.target
    .set(s.p[0], s.p[1], s.p[2])
    .addScaledVector(_right, -s.sx * dist * th)
    .addScaledVector(_up, -s.sy * dist * tv)
  out.position.copy(out.target).addScaledVector(_dir, dist)
  out.fov = s.fov
}

// ---------------------------------------------------------------- chapter

export default function create(): Chapter {
  const group = new THREE.Group()
  let desk: Desk
  let hud: DeskHud
  let primed = false
  let toneOn = false
  const shot: Shot = { t: 0, p: [0, 0, 0], az: 0, el: 0, w: 1, h: 1, sx: 0, sy: 0, fov: 30 }
  const pos = new Array(STRIPS).fill(0)
  const vel = new Array(STRIPS).fill(0)
  const meter = new Array(LADDERS).fill(0)
  const peak = new Array(LADDERS).fill(0)
  const st: DeskState = {
    fader: pos,
    knob: new Array(9).fill(0),
    level: meter,
    peak,
    led: new Array(STRIPS + 1).fill(0),
  }
  const live = [false, false, false, false]
  const db = [0, 0, 0, 0]
  const statsOn = [false, false, false]
  const proj = new THREE.Vector3()

  const tone = (hz: number, level: number) =>
    window.dispatchEvent(new CustomEvent('hark:tone', { detail: { hz, level } }))

  return {
    id: 'process',
    group,
    anchors: ANCHORS,

    init(ctx: ChapterContext) {
      desk = new Desk(ctx.mobile)
      group.add(desk.group)
      hud = new DeskHud(ctx.stage)
    },

    update(local: number, frame: Frame, ctx: ChapterContext) {
      const t = frame.time
      const dt = Math.min(frame.dt, 1 / 20)
      const calm = frame.reducedMotion

      // ---- studio + post: bone cyc, a pool of key light; the end pushes the bloom
      const end = smoothstep(END_AT, 0.985, local)
      ctx.studio.params.tone = 0.05
      ctx.studio.params.spot = 0.6
      ctx.studio.params.warmth = 0.08
      ctx.studio.params.envIntensity = 1
      ctx.post.params.bloomStrength = 0.32 + end * 0.5
      ctx.post.params.bloomRadius = 0.22 + end * 0.2
      ctx.post.params.exposure = 1 + end * 0.06
      ctx.post.params.vignette = 0.26

      // ---- faders: a spring chases the scroll-derived detent staircase
      const k = calm ? 220 : 260
      const zeta = calm ? 1 : 0.42
      const c = 2 * Math.sqrt(k) * zeta
      for (let i = 0; i < STRIPS; i++) {
        const target = faderTarget(i, local)
        if (!primed) {
          pos[i] = target
          vel[i] = 0
          continue
        }
        const n = 4
        const h = dt / n
        for (let s = 0; s < n; s++) {
          vel[i] += (k * (target - pos[i]) - c * vel[i]) * h
          pos[i] += vel[i] * h
          // hard end stops, with a little rebound
          if (pos[i] > 1) {
            pos[i] = 1
            vel[i] = -Math.abs(vel[i]) * 0.25
          } else if (pos[i] < 0) {
            pos[i] = 0
            vel[i] = Math.abs(vel[i]) * 0.25
          }
        }
      }

      // ---- knobs: each channel's pair snaps to its setting as the channel opens
      for (let i = 0; i < 4; i++) {
        const s = S0 + SW * i
        const a = ease.outBack(segment(local, s + 0.01, s + 0.06))
        st.knob[i * 2] = lerp(-2.36, KNOB_GAIN[i], a)
        st.knob[i * 2 + 1] = lerp(0, KNOB_TONE[i], a)
      }
      st.knob[8] = lerp(-0.9, 2.1, ease.outBack(segment(local, END_AT, 0.985)))

      // ---- meters: programme level × fader, a kick when the fader moves, self-test and end peak
      const sweep = local < 0.07 ? Math.sin(Math.PI * clamp(local / 0.07)) : 0
      const amp = calm ? 0.35 : 1
      let sum = 0
      for (let i = 0; i < 4; i++) {
        const env = 1 + (ENV[i](t + i * 0.37) - 1) * amp
        const sig = (pos[i] / UNITY) * 0.64 * env
        sum += sig
        const kick = Math.min(0.4, Math.abs(vel[i]) * 0.12)
        const tgt = clamp(Math.max(sig + kick, sweep, end))
        meter[i] = tgt > meter[i] ? tgt : Math.max(tgt, meter[i] - 1.5 * dt)
      }
      const mix = (sum / 4) * (pos[4] / UNITY) * 1.08
      for (let j = 0; j < 2; j++) {
        const wob = 1 + (calm ? 0 : 0.05 * Math.sin(t * (6.1 + j * 1.3) + j))
        const tgt = clamp(Math.max(mix * wob + Math.min(0.3, Math.abs(vel[4]) * 0.1), sweep, end))
        meter[4 + j] = tgt > meter[4 + j] ? tgt : Math.max(tgt, meter[4 + j] - 1.5 * dt)
      }
      for (let i = 0; i < LADDERS; i++) {
        if (!primed) meter[i] = Math.max(sweep, end, i < 4 ? (pos[i] / UNITY) * 0.6 : mix)
        peak[i] = Math.max(meter[i], peak[i] - 0.3 * dt)
      }

      // ---- LEDs + HUD state
      const step = local >= S0 && local < STATS_AT ? Math.min(3, Math.floor((local - S0) / SW)) : -1
      for (let i = 0; i < 4; i++) {
        live[i] = pos[i] > 0.04
        db[i] = faderDb(pos[i])
        st.led[i] = i === step ? 1 : live[i] ? 0.45 : sweep * 0.8
      }
      st.led[4] = 0.5 + 0.5 * Math.max(end, sweep)
      st.led[5] = 0.85

      // ---- bridge readouts: analyser until the stats, then the numbers sweep in
      const clear = 1 - smoothstep(STATS_AT - 0.012, STATS_AT + 0.008, local)
      desk.displays.forEach((d, i) => {
        const u = d.uniforms
        u.uMode.value = local >= STATS_AT + 0.004 ? 1 : 0
        u.uReveal.value = segment(local, STATS_AT + 0.012 + i * 0.028, STATS_AT + 0.045 + i * 0.028)
        // power-on self-test: a scan bar crosses each readout, staggered
        u.uScan.value = local < 0.075 ? clamp(local / 0.06 - i * 0.12) : 0
        u.uFull.value = end
        u.uLevels.value.set(meter[0] * clear, meter[1] * clear, meter[2] * clear, meter[3] * clear)
        u.uPower.value = 1 + end * 0.4
        statsOn[i] = local >= STATS_AT + 0.02 + i * 0.028 && local < 0.975
      })
      desk.update(st, t)
      primed = true

      // ---- HUD
      const portrait = frame.width / Math.max(1, frame.height) < 0.8
      const scrimOut = 1 - smoothstep(STATS_AT - 0.03, STATS_AT + 0.02, local)
      // the column's paper is fully up before the list rows (0.06) and the first step's text (0.08) rise
      const so = (smoothstep(0.03, 0.07, local) * scrimOut).toFixed(3)
      if (hud.scrim.style.opacity !== so) hud.scrim.style.opacity = so
      // portrait: the headline sits on paper from the first frame, while the dolly-in climbs past it,
      // and the paper holds under the chrome until the pull-back has cleared the desk out of the header
      const sh = (1 - smoothstep(0.835, 0.862, local)).toFixed(3)
      if (hud.scrimHead.style.opacity !== sh) hud.scrimHead.style.opacity = sh
      hud.update({
        head: local < STATS_AT - 0.004,
        list: local >= 0.06 && local < STATS_AT - 0.004,
        step,
        live,
        db,
        stats: statsOn,
        statsOn: local >= STATS_AT + 0.01 && local < 0.975,
      })
      if (local > STATS_AT - 0.05) {
        // line the stats up under the readouts (desktop), from the last applied camera
        const cam = ctx.camera
        cam.updateMatrixWorld()
        const a = desk.anchors.displayEdge
        proj.copy(a[1]).project(cam)
        const left = (proj.x * 0.5 + 0.5) * frame.width
        proj.copy(a[8]).project(cam)
        const right = (proj.x * 0.5 + 0.5) * frame.width
        const gut = Math.max(16, Math.min(48, frame.width * 0.034))
        if (Number.isFinite(left + right))
          hud.placeStats(Math.max(gut, left), Math.min(frame.width - gut, right), NaN, portrait)
      }

      // ---- optional tone: whichever fader is moving sings its note; the master push sings A4
      let hz = 0
      let lvl = 0
      for (let i = 0; i < STRIPS; i++) {
        const l = Math.min(0.16, Math.abs(vel[i]) * 0.06)
        if (l > lvl) {
          lvl = l
          hz = NOTES[i]
        }
      }
      if (end > 0 && end < 1) {
        const l = 0.14 * Math.sin(Math.PI * end)
        if (l > lvl) {
          lvl = l
          hz = NOTES[4]
        }
      }
      if (lvl > 0.004) {
        tone(hz, lvl)
        toneOn = true
      } else if (toneOn) {
        tone(hz || 220, 0)
        toneOn = false
      }
    },

    camera(local: number, frame: Frame, out: CameraPose) {
      const aspect = frame.width / Math.max(1, frame.height)
      const tall = aspect < 0.8
      const keys = tall ? TALL : WIDE
      const band = hud?.band
      const H = Math.max(1, frame.height)
      if (band && band.statsTop > band.headTop + 60) {
        // stats frame: fit the whole desk into the space between the top chrome and the stats block
        const top = band.headTop
        const bot = band.statsTop - 20
        const mid = (top + bot) / 2
        const sy = clamp(1 - (2 * mid) / H, -0.2, 0.6)
        const h = (STATS_FIT * H) / Math.max(140, bot - top)
        for (const k of tall ? STATS_KEYS.tall : STATS_KEYS.wide) {
          k.sy = sy
          k.h = h
        }
      }
      if (tall && band && band.bottom > band.top) {
        // centre the channel close-ups in the free band between headline and list
        const mid = (band.top + band.bottom) / 2
        const sy = clamp(1 - (2 * mid) / H, -0.4, 0.5)
        for (const k of TALL_WALK) k.sy = sy
        // the in-beat wide sits in the band under the headline (the list is not up yet), so
        // on short phones the dolly-in never sweeps the meter bridge up through the title
        const open = (band.top + band.floor) / 2
        TALL[0].sy = clamp(1 - (2 * open) / H, -0.3, 0.1)
      }
      shotAt(keys, local, shot)
      if (!frame.reducedMotion) {
        // a slow hand on the crane
        shot.az += Math.sin(frame.time * 0.17) * 0.6
        shot.el += Math.sin(frame.time * 0.11 + 1) * 0.4
      }
      applyShot(shot, aspect, out)
      out.roll = 0
      out.parallax = 0.12
    },

    onEnter() {
      // derive everything afresh from local on arrival (no history from prewarm or a previous visit)
      primed = false
      peak.fill(0)
    },

    onLeave() {
      if (toneOn) {
        tone(220, 0)
        toneOn = false
      }
    },
  }
}
