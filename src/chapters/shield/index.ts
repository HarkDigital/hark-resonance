import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { Callout, el, reveal, rise, setRise } from '../../core/dom'
import { ease, lerp, segment, smoothstep, window01 } from '../../core/math'
import { SECURITY, STATS } from '../../content'
import { Field } from './field'
import { Bench } from './bench'
import './shield.css'

/*
 * NOISE FLOOR — "Hacked? Breathe."  A hack is noise; Hark is the anti-noise.
 *
 * A waterfall analyser on a bone floor: rows of paper fins with ink waveforms
 * receding in depth, a frequency ruler printed on the floor, and one
 * aluminium fader on a black rail along the front edge.
 *
 *   0.00–0.10  in-beat: a pressure wave rolls through the flat rows and the
 *              noise erupts (spring overshoot); camera settles in low + close
 *   0.06–0.36  NOISE: jagged flickering spectrum, burst ridges drifting back,
 *              red-orange intrusion spikes; callout INTRUSION DETECTED ·
 *              NOISE FLOOR +18 dB; fader parked left, LED blinking red;
 *              tape wow
 *   0.35–0.40  the fader clicks (press + LED → green); camera cranes up/back
 *   0.38–0.70  ANTI-PHASE: the fader slides right, a green LED front fans out
 *              behind it and the noise rings down like a damped spring
 *              (inverts, overshoots, settles) into calm sine rows.
 *              Eyebrow + 'Hacked? Breathe.' + body rise in.
 *   0.72–0.94  CALM: breathing sine surface; 24/7 + label + CTA;
 *              callout NOISE FLOOR −96 dB
 *   0.94–1.00  out-beat: the rows gather into one long waveform line as the
 *              camera drops to face it (next: stacked ridgeline liner notes)
 */

const HUM_HZ = 116.54
const STAT = STATS.find(s => s.value === '24/7') ?? STATS[STATS.length - 1]

type Pose = { p: [number, number, number]; t: [number, number, number]; fov: number }

// key poses: landscape and portrait framings, blended by aspect
const POSES_WIDE: Pose[] = [
  { p: [-5.6, 1.3, 7.6], t: [-1.5, 0.5, 0.5], fov: 30 }, // 0 in-beat (pushed in, front-left)
  { p: [-6.3, 1.6, 8.8], t: [-1.4, 0.52, 0.4], fov: 30 }, // 1 noise
  { p: [-5.2, 2.0, 9.7], t: [-1.0, 0.6, 0.2], fov: 30 }, // 2 noise, craning
  { p: [0.6, 6.3, 14.0], t: [0.0, 0.9, 0.0], fov: 30 }, // 3 editorial wide
  { p: [-0.5, 5.7, 13.8], t: [0.1, 0.85, 0.0], fov: 30 }, // 4 calm drift
  { p: [0.0, 1.0, 9.4], t: [0.0, 0.95, 0.0], fov: 28 }, // 5 out-beat, face the line
]
const POSES_TALL: Pose[] = [
  { p: [-3.4, 1.4, 7.4], t: [-0.3, 0.55, 0.3], fov: 40 },
  { p: [-3.9, 1.7, 8.6], t: [-0.3, 0.6, 0.2], fov: 40 },
  { p: [-3.0, 2.2, 9.4], t: [-0.2, 0.7, 0.0], fov: 40 },
  { p: [0.3, 7.4, 13.0], t: [0.0, 2.6, 0.0], fov: 42 },
  { p: [-0.6, 7.0, 12.7], t: [0.0, 2.5, 0.0], fov: 42 },
  { p: [0.0, 1.05, 9.8], t: [0.0, 1.0, 0.0], fov: 38 },
]

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _v = new THREE.Vector3()
const _p = new THREE.Vector3()
const _ray = new THREE.Raycaster()
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.25)

/** 0..1: how comfortably a world point sits inside the frame (fades near the edges, 0 off-screen) */
function onScreen(world: THREE.Vector3, camera: THREE.Camera, w: number, h: number) {
  _p.copy(world).project(camera)
  if (!Number.isFinite(_p.x) || !Number.isFinite(_p.y) || _p.z > 1) return 0
  const x = (_p.x * 0.5 + 0.5) * w
  const y = (-_p.y * 0.5 + 0.5) * h
  const m = 24
  return Math.min(smoothstep(0, m, x), smoothstep(0, m, w - x), smoothstep(0, m, y), smoothstep(0, m, h - y))
}

function blendPose(i: number, j: number, k: number, pf: number, outP: THREE.Vector3, outT: THREE.Vector3) {
  const W = POSES_WIDE
  const T = POSES_TALL
  for (let c = 0; c < 3; c++) {
    const pw = lerp(W[i].p[c], W[j].p[c], k)
    const pt = lerp(T[i].p[c], T[j].p[c], k)
    const tw = lerp(W[i].t[c], W[j].t[c], k)
    const tt = lerp(T[i].t[c], T[j].t[c], k)
    outP.setComponent(c, lerp(pw, pt, pf))
    outT.setComponent(c, lerp(tw, tt, pf))
  }
  return lerp(lerp(W[i].fov, W[j].fov, k), lerp(T[i].fov, T[j].fov, k), pf)
}

/** portrait factor: 0 landscape .. 1 phone portrait */
const portrait = (f: Frame) => smoothstep(1.25, 0.62, f.width / Math.max(1, f.height))

/** anti-phase front position (field units, see field.ts) for this local */
function frontAt(local: number, lag: number) {
  const start = -1.12
  const end = 1 + lag + 0.08
  if (local < 0.38) return start - 0.4
  if (local < 0.7) return lerp(start, end, ease.inOutQuad(segment(local, 0.38, 0.7)))
  return lerp(end, 4, segment(local, 0.7, 0.8))
}

export default function create(): Chapter {
  const group = new THREE.Group()
  let field: Field
  let bench: Bench
  let intrusion: Callout
  let status: Callout
  let statusText: HTMLElement
  let statusMode = ''
  const dom: Record<string, HTMLElement> = {}
  let heroRow = 0
  const HERO_U = -0.12
  const res = new THREE.Vector2()
  /** the pointer has actually been used (not just the (0,0) default) */
  let pointed = false
  let pokeLevel = 0

  function size(frame: Frame) {
    const pf = portrait(frame)
    return { pf, halfW: lerp(4.6, 2.9, pf), halfD: lerp(2.8, 2.2, pf) }
  }

  return {
    id: 'shield',
    group,

    init(ctx: ChapterContext) {
      const mobile = ctx.mobile
      field = new Field({ rows: mobile ? 58 : 100, samples: mobile ? 180 : 320 })
      heroRow = Math.round(field.rows * 0.16)
      bench = new Bench(ctx.renderer)
      group.add(bench.object, field.object)

      // ---------------- DOM ----------------
      const stage = ctx.stage
      const top = el('div', 'sh-top', undefined, stage)
      const head = el('div', 'sh-head', undefined, top)
      const eyebrow = el('p', 'hud-eyebrow sh-eyebrow', undefined, head)
      dom.eyebrow = eyebrow
      dom.eyebrowText = rise(el('span', 'sh-eyebrow-text', undefined, eyebrow), SECURITY.eyebrow)
      dom.title = rise(el('h2', 'hud-title sh-title', undefined, head), SECURITY.title.replace(/(\S+)$/, '<em>$1</em>'))
      const side = el('div', 'sh-side', undefined, top)
      dom.body = rise(el('p', 'hud-body sh-body', undefined, side), SECURITY.body)
      const calm = el('div', 'sh-calm', undefined, side)
      dom.stat = rise(el('p', 'sh-stat', undefined, calm), STAT.value)
      dom.statLabel = rise(el('p', 'hud-body sh-stat-label', undefined, calm), STAT.label)
      const cta = el('a', 'hud-btn sh-cta', SECURITY.cta, calm)
      cta.href = SECURITY.href
      dom.cta = cta

      intrusion = new Callout(stage, { side: 'right', offset: { x: 84, y: -58 } })
      intrusion.root.classList.add('sh-callout', 'sh-callout--alert')
      intrusion.label.innerHTML = '<span class="sh-co-k">Intrusion detected</span><span class="sh-co-v">Noise floor +18 dB</span>'
      status = new Callout(stage, { side: 'right', offset: { x: 70, y: -64 } })
      status.root.classList.add('sh-callout')
      statusText = el('span', 'sh-co-k', '', status.label)
      reveal(intrusion.root, 0, 0)
      reveal(status.root, 0, 0)
    },

    update(local: number, frame: Frame, ctx: ChapterContext) {
      const { halfW, halfD } = size(frame)
      const t = frame.time
      const rm = frame.reducedMotion
      const u = field.uniforms

      // ---- field
      u.uTime.value = rm ? t * 0.25 : t
      u.uFlicker.value = rm ? 0 : 12
      u.uSize.value.set(halfW, halfD, 0.14)
      const riseK = segment(local, 0.012, 0.1)
      u.uRise.value = riseK >= 1 ? 1 : Math.max(0, ease.outBack(riseK))
      const esc = smoothstep(0.06, 0.3, local)
      u.uNoise.value = lerp(0.72, 1, esc)
      u.uDensity.value = lerp(0.42, 0.74, esc)
      const lag = u.uLag.value
      const front = frontAt(local, lag)
      u.uFront.value = front
      const ledOn = smoothstep(0.372, 0.4, local) * (1 - smoothstep(0.68, 0.74, local))
      u.uLedOn.value = ledOn
      const gather = ease.inOutCubic(segment(local, 0.93, 0.985))
      u.uGather.value = gather
      u.uCalm.value = lerp(0.2, 0.17, frame.mobile ? 1 : 0) * (1 + gather * 0.25)
      u.uPulse.value.set(lerp(1.25, -1.35, segment(local, 0, 0.14)), 0.34 * (1 - smoothstep(0.07, 0.14, local)))
      // the intrusion spike hits with the eruption and holds through the noise
      u.uHero.value.set(heroRow, HERO_U, 1.25 * smoothstep(0.03, 0.1, local), 0)
      // pointer → field (a gentle anti-noise brush); off until the visitor moves it
      if (!pointed && frame.pointerRaw.lengthSq() > 1e-6) pointed = true
      let pokeTarget = 0
      if (pointed && !frame.mobile) {
        _ray.setFromCamera(frame.pointer, ctx.camera)
        if (_ray.ray.intersectPlane(_plane, _p) && Math.abs(_p.x) < 30 && Math.abs(_p.z) < 30) {
          u.uPoke.value.x = _p.x
          u.uPoke.value.y = _p.z
          pokeTarget = window01(local, 0.06, 0.94, 0.04)
        }
      }
      pokeLevel += (pokeTarget - pokeLevel) * (1 - Math.exp(-6 * frame.dt))
      u.uPoke.value.z = 0.85
      u.uPoke.value.w = pokeLevel
      ctx.renderer.getDrawingBufferSize(res)
      u.uRes.value.copy(res)
      const dpr = ctx.renderer.getPixelRatio()
      u.uWidth.value = Math.max(1.3, 1.15 * dpr)

      // ---- bench: the fader leads the front, parks at either end
      let faderU = -0.98
      if (local >= 0.38) faderU = Math.min(0.92, Math.max(-0.98, front + 0.03))
      const press = Math.sin(Math.PI * segment(local, 0.342, 0.39)) * (1 - segment(local, 0.342, 0.39) * 0.5)
      const engaged = local >= 0.358
      let ledLevel = 1
      if (!engaged) ledLevel = rm ? 0.9 : 0.35 + 0.65 * (Math.sin(t * 9.5) > -0.2 ? 1 : 0)
      else if (local > 0.72) ledLevel = 0.75 + 0.25 * Math.sin(t * 1.4)
      bench.layout(halfW, halfD, faderU, press, engaged ? 2 : local > 0.02 ? 1 : 0, ledLevel)
      bench.floorUniforms.uOpacity.value = 1 - gather
      bench.fade(1 - smoothstep(0.0, 0.6, gather))

      // ---- DOM beats
      const headOn = local > 0.4 && local < 0.94
      setRise(dom.eyebrowText, headOn)
      dom.eyebrow.classList.toggle('is-on', headOn)
      setRise(dom.title, headOn)
      setRise(dom.body, local > 0.43 && local < 0.71)
      const calmOn = local > 0.72 && local < 0.94
      setRise(dom.stat, calmOn)
      setRise(dom.statLabel, calmOn)
      dom.cta.classList.toggle('is-in', calmOn)

      // callouts (anchored in 3D)
      const w = frame.width
      const h = frame.height
      const zn = 1 - (2 * heroRow) / (field.rows - 1)
      _v.set(HERO_U * halfW, 0.14 + 1.25 * 0.92 * u.uRise.value, zn * halfD)
      intrusion.update(_v, ctx.camera, w, h, window01(local, 0.085, 0.355, 0.03) * onScreen(_v, ctx.camera, w, h))
      const mode = local < 0.72 ? 'anti' : 'calm'
      if (mode !== statusMode) {
        statusMode = mode
        statusText.textContent = mode === 'anti' ? 'Anti-phase · 180°' : 'Noise floor −96 dB'
      }
      bench.ledWorld(_v)
      status.side = faderU > 0.35 ? 'left' : 'right'
      const sv = mode === 'anti' ? window01(local, 0.39, 0.7, 0.025) : window01(local, 0.745, 0.93, 0.025)
      status.update(_v, ctx.camera, w, h, sv * onScreen(_v, ctx.camera, w, h))

      // ---- post + studio
      const noisy = window01(local, 0.04, 0.4, 0.05)
      ctx.post.params.glitch = rm ? 0 : noisy * (0.07 + 0.1 * Math.max(0, Math.sin(t * 2.3) * Math.sin(t * 3.7)))
      ctx.post.params.bloomStrength = 0.55 + ledOn * 0.2
      ctx.post.params.bloomRadius = 0.4
      ctx.studio.params.tone = 0
      ctx.studio.params.spot = 0.5
      ctx.studio.params.warmth = 0.08
      ctx.studio.params.envIntensity = 1

      // ---- sound: a Bb2 hum a semitone against the room's A chord, cancelled by the front
      const hum = 0.55 * noisy * (1 - segment(local, 0.38, 0.62))
      window.dispatchEvent(new CustomEvent('hark:tone', { detail: { hz: HUM_HZ, level: hum } }))
    },

    camera(local: number, frame: Frame, out: CameraPose) {
      const pf = portrait(frame)
      let fov: number
      if (local < 0.1) fov = blendPose(0, 1, ease.outCubic(segment(local, 0, 0.1)), pf, _a, _b)
      else if (local < 0.34) fov = blendPose(1, 2, ease.inOutQuad(segment(local, 0.1, 0.34)), pf, _a, _b)
      else if (local < 0.54) fov = blendPose(2, 3, ease.inOutCubic(segment(local, 0.34, 0.54)), pf, _a, _b)
      else if (local < 0.93) fov = blendPose(3, 4, ease.inOutQuad(segment(local, 0.54, 0.93)), pf, _a, _b)
      else fov = blendPose(4, 5, ease.inOutCubic(segment(local, 0.93, 1)), pf, _a, _b)
      // squarer landscape screens (4:3 laptops) dolly back so the whole bench stays in frame
      const aspect = frame.width / Math.max(1, frame.height)
      // …and tablets in portrait dolly in, since their wider view shrinks the bench
      const kWide = Math.min(1.3, Math.max(1, Math.pow(1.6 / aspect, 0.9)))
      const kTall = Math.min(1, Math.max(0.8, Math.pow(0.56 / aspect, 0.6)))
      const k = lerp(kWide, kTall, pf)
      if (k !== 1) _a.sub(_b).multiplyScalar(k).add(_b)
      if (!frame.reducedMotion) {
        const t = frame.time
        _a.x += Math.sin(t * 0.21) * 0.06
        _a.y += Math.sin(t * 0.17 + 1.3) * 0.03
      }
      out.position.copy(_a)
      out.target.copy(_b)
      out.fov = fov
      out.roll = 0
      out.parallax = lerp(0.35, 0.18, pf)
    },

    onLeave() {
      window.dispatchEvent(new CustomEvent('hark:tone', { detail: { hz: HUM_HZ, level: 0 } }))
      statusMode = ''
    },
  }
}

