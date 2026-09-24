import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { clamp, ease, lerp, segment, smoothstep } from '../../core/math'
import { Desk, LADDERS, STRIPS, type DeskState } from './desk'
import { DeskHud } from './hud'
import { DB_MARKS, LAYOUT as L, faderDb } from './layout'
import './process.css'

/*
 * THE DESK — "How we work."
 *
 * A close-up product film of a four-channel console on the bone cyc. Each
 * process step is a channel: as you scroll, its fader climbs the dB legend
 * detent by detent (a damped spring chases a scroll-derived staircase, so it
 * clicks and overshoots), its meter jumps, its LED lights and the camera
 * dollies on down the desk. Then the bridge readouts clear and sweep in the
 * stats, and the master fader slams to the stop with every meter pinned as
 * the ripple takes over.
 *
 *   0.00–0.08  ripple lands, desk self-test sweep; "How we work."
 *   0.08–0.80  channels 01–04: Listen · Prototype · Build · Support
 *   0.80–0.95  bridge readouts: 10 YRS · $1M+ · 15 (+ labels)
 *   0.95–1.00  master to +10, all meters peak → cut
 */

const S0 = 0.08
const SW = 0.18
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
const ch = (i: number): [number, number, number] => [L.channels[i] + 0.02, 0.3, 0.62]

const WIDE: Shot[] = [
  { t: 0, p: [-0.35, 0.32, 0.25], az: 30, el: 38, w: 6.2, h: 3.4, sx: 0.3, sy: -0.34, fov: 30 },
  { t: 0.09, p: ch(0), az: 30, el: 56, w: 3.1, h: 1.95, sx: 0.26, sy: 0.26, fov: 30, e: ease.inOutCubic },
  { t: 0.78, p: ch(3), az: 28, el: 58, w: 3.3, h: 2.1, sx: 0.24, sy: 0.3, fov: 30, e: inOutSine },
  { t: 0.865, p: [0, 0.3, 0.02], az: 0, el: 24, w: 7.0, h: 3.3, sx: 0, sy: 0.1, fov: 30, e: ease.inOutCubic },
  { t: END_AT, p: [0.06, 0.3, 0.02], az: 2.5, el: 25, w: 6.7, h: 3.15, sx: 0, sy: 0.1, fov: 30, e: (t: number) => t },
  { t: 1, p: [L.masterX + 0.1, 0.3, 0.55], az: 18, el: 38, w: 1.5, h: 1.1, sx: 0, sy: 0.02, fov: 30, e: ease.inCubic },
]

const TALL: Shot[] = [
  { t: 0, p: [0.1, 0.32, 0.2], az: 24, el: 42, w: 5.0, h: 3.4, sx: 0, sy: 0.02, fov: 38 },
  { t: 0.09, p: ch(0), az: 22, el: 60, w: 2.1, h: 2.2, sx: 0, sy: 0.02, fov: 38, e: ease.inOutCubic },
  { t: 0.78, p: ch(3), az: 28, el: 62, w: 2.1, h: 2.2, sx: 0, sy: 0.02, fov: 38, e: inOutSine },
  { t: 0.865, p: [0, 0.3, -0.05], az: 0, el: 50, w: 4.5, h: 2.1, sx: 0, sy: 0.3, fov: 38, e: ease.inOutCubic },
  { t: END_AT, p: [0.04, 0.3, -0.05], az: 2.5, el: 51, w: 4.3, h: 2.0, sx: 0, sy: 0.3, fov: 38, e: (t: number) => t },
  { t: 1, p: [L.masterX + 0.1, 0.3, 0.55], az: 14, el: 50, w: 1.1, h: 1.4, sx: 0, sy: 0.05, fov: 38, e: ease.inCubic },
]

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
      const gain = [0.55, 0.15, 1.05, 0.4]
      const toneSet = [-0.45, 0.5, 0.25, -0.2]
      for (let i = 0; i < 4; i++) {
        const s = S0 + SW * i
        const a = ease.outBack(segment(local, s + 0.01, s + 0.06))
        st.knob[i * 2] = lerp(-2.36, gain[i], a)
        st.knob[i * 2 + 1] = lerp(0, toneSet[i], a)
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
      const scrimV = smoothstep(0.05, 0.12, local) * (1 - smoothstep(STATS_AT - 0.03, STATS_AT + 0.02, local))
      const so = scrimV.toFixed(3)
      if (hud.scrim.style.opacity !== so) hud.scrim.style.opacity = so
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
      const keys = aspect < 0.8 ? TALL : WIDE
      const band = hud?.band
      if (band && band.statsTop > band.headTop + 60) {
        // stats frame: fit the whole desk into the space between the top chrome and the stats block
        const top = band.headTop
        const bot = band.statsTop - 20
        const mid = (top + bot) / 2
        const sy = clamp(1 - (2 * mid) / Math.max(1, frame.height), -0.2, 0.6)
        const h = (STATS_FIT * frame.height) / Math.max(140, bot - top)
        for (const k of [keys[3], keys[4]]) {
          k.sy = sy
          k.h = h
        }
      }
      if (aspect < 0.8 && band && band.bottom > band.top) {
        // centre the channel close-ups in the free band between headline and list
        const mid = (band.top + band.bottom) / 2
        const sy = clamp(1 - (2 * mid) / Math.max(1, frame.height), -0.4, 0.5)
        TALL[1].sy = sy
        TALL[2].sy = sy
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
