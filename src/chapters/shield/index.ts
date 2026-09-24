import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { Callout, el, reveal, rise, setRise } from '../../core/dom'
import { ease, lerp, segment, smoothstep, window01 } from '../../core/math'
import { SECURITY, STATS } from '../../content'
import { FACE_Z, SCREEN } from './layout'
import { Scope } from './scope'
import './shield.css'

/*
 * NOISE FLOOR — "Hacked? Breathe."  A hack is noise; Hark is the anti-noise.
 *
 * A bench oscilloscope on the bone bench. The story plays on its CRT.
 *
 *   0.00–0.13  in-beat, from Cymatics' dark room: the scope glows in the dark
 *              with the plate's ringing tone on screen, a dim bench lamp comes
 *              up, and red noise erupts over the tone (the intrusion)
 *   0.12–0.345 NOISE: the camera pushes into the CRT. Jagged red trace with
 *              phosphor afterglow, burst transients, one sustained spike;
 *              callout INTRUSION DETECTED · NOISE FLOOR +18 dB; tape wow
 *   0.345–0.42 "Breathe": the camera exhales back to the whole instrument as
 *              the room lights come up; the display splits into CH1 (noise),
 *              CH2 and Σ = CH1 + CH2. Eyebrow + 'Hacked? Breathe.' + body
 *              rise from 0.41 (in and settled at the 0.45 nav landing)
 *   0.41–0.64  ANTI-PHASE: a green beam head writes CH2 = −CH1 left → right;
 *              behind it Σ collapses to a flat green line
 *   0.64–0.93  CALM: CH1/CH2 fade, Σ glides to centre and breathes as a slow
 *              clean sine on a visible time-base sweep; 24/7 + label + CTA;
 *              callout NOISE FLOOR −96 dB
 *   0.93–1.00  out-beat: the sine settles flat, one pulse runs along it and
 *              the camera dives into the glass as the ripple takes over
 */

const HUM_HZ = 116.54
const STAT = STATS.find(s => s.value === '24/7') ?? STATS[STATS.length - 1]
const HERO_U = 0.63
const HERO_AMP = 2.3

// ---------------------------------------------------------------- camera

interface Shot {
  /** 8 world points that must be framed (a box's corners, or a hand-picked hull) */
  p: number[]
  az: number
  el: number
  fov: number
  /** fraction of the region the points span (> 1 overfills) */
  fill: number
  /** 0 = whole frame, 1 = the space the copy leaves */
  band: number
  /** horizontal anchor inside the region, -1 left .. 1 right */
  ox: number
}

type V3 = [number, number, number]
const box = (c: V3, e: V3) => {
  const p: number[] = []
  for (let i = 0; i < 8; i++) p.push(c[0] + (i & 1 ? 1 : -1) * e[0], c[1] + (i & 2 ? 1 : -1) * e[1], c[2] + (i & 4 ? 1 : -1) * e[2])
  return p
}
/** the whole instrument (3/4 views) */
const SCOPE = box([0.05, 1.46, 0.05], [2.22, 1.46, 1.3])
/** the CRT glass */
const SCR = box([SCREEN.cx, SCREEN.cy, FACE_Z + 0.02], [SCREEN.w / 2, SCREEN.h / 2, 0.02])
/** the scope's silhouette from the front + the cables curled on the bench */
const BENCH = [
  -2.15, 0.02, 1.26, -2.15, 2.8, 1.26, 2.15, 2.8, 1.26, 0, 2.93, -0.32,
  2.15, 2.8, -1.25, -2.15, 2.8, -1.25, 3.34, 0.0, 0.7, 2.3, 0.0, 2.08,
]
/** phones: the face and the cable droop, the far cable loop may crop */
const BENCH_TALL = [
  -2.15, 0.02, 1.26, -2.15, 2.8, 1.26, 2.15, 2.8, 1.26, 0, 2.93, -0.32,
  2.15, 0.02, 1.26, -2.15, 2.8, -1.25, 2.15, 2.8, -1.25, 1.6, 0.0, 1.95,
]

const shot = (s: Partial<Shot> & Pick<Shot, 'p' | 'az' | 'el'>): Shot => ({ fov: 30, fill: 1, band: 0, ox: 0, ...s, p: s.p.slice() })

// landscape key shots
const WIDE: Shot[] = [
  shot({ p: SCOPE, az: -0.66, el: 0.2, fill: 0.74 }), // 0 in the dark
  shot({ p: SCOPE, az: -0.52, el: 0.16, fill: 0.86 }), // 1 lamp up
  shot({ p: SCR, az: -0.06, el: 0.03, fill: 1.08 }), // 2 pushed into the CRT
  shot({ p: BENCH, az: 0.0, el: 0.08, fill: 1, band: 1 }), // 3 breathe out
  shot({ p: BENCH, az: 0.05, el: 0.08, fill: 1.03, band: 1 }), // 4 anti-phase
  shot({ p: BENCH, az: 0.3, el: 0.14, fill: 1, band: 1 }), // 5 calm
  shot({ p: BENCH, az: 0.36, el: 0.13, fill: 1.03, band: 1 }), // 6 calm drift
  shot({ p: SCR, az: 0.0, el: 0.0, fill: 1.9 }), // 7 dive
]
// portrait key shots (phones, portrait tablets)
const TALL: Shot[] = [
  shot({ p: SCOPE, az: -0.48, el: 0.2, fov: 36, fill: 0.92 }),
  shot({ p: SCOPE, az: -0.4, el: 0.16, fov: 36, fill: 0.98 }),
  shot({ p: SCR, az: -0.04, el: 0.03, fov: 36, fill: 1.04 }),
  shot({ p: BENCH_TALL, az: 0.0, el: 0.08, fov: 34, fill: 1, band: 1 }),
  shot({ p: BENCH_TALL, az: 0.04, el: 0.08, fov: 34, fill: 1.03, band: 1 }),
  shot({ p: BENCH_TALL, az: 0.24, el: 0.14, fov: 34, fill: 1, band: 1 }),
  shot({ p: BENCH_TALL, az: 0.3, el: 0.13, fov: 34, fill: 1.03, band: 1 }),
  shot({ p: SCR, az: 0.0, el: 0.0, fov: 34, fill: 1.9 }),
]
/** [local, shot index, ease] — the camera runs through the key shots */
const KEYS: [number, (t: number) => number][] = [
  [0.0, ease.outCubic],
  [0.14, ease.inOutCubic],
  [0.345, ease.inOutCubic],
  [0.415, ease.inOutQuad],
  [0.64, ease.inOutCubic],
  [0.8, ease.inOutQuad],
  [0.93, ease.inCubic],
  [1.0, ease.inCubic],
]

const _s: Shot = shot({ p: SCOPE, az: 0, el: 0 })
const _t: Shot = shot({ p: SCOPE, az: 0, el: 0 })
function mixShot(a: Shot, b: Shot, k: number, out: Shot) {
  for (let i = 0; i < 24; i++) out.p[i] = lerp(a.p[i], b.p[i], k)
  out.az = lerp(a.az, b.az, k)
  out.el = lerp(a.el, b.el, k)
  out.fov = lerp(a.fov, b.fov, k)
  out.fill = lerp(a.fill, b.fill, k)
  out.band = lerp(a.band, b.band, k)
  out.ox = lerp(a.ox, b.ox, k)
  return out
}

const _right = new THREE.Vector3()
const _up = new THREE.Vector3()
const _back = new THREE.Vector3()
const _ca = new Float64Array(8)
const _cb = new Float64Array(8)
const _cz = new Float64Array(8)

/**
 * Frame 8 points in a screen region (NDC): distance by bisection so their
 * projections span `fill` of the region, then a truck so the box sits
 * where the region wants it. Exact at every aspect ratio.
 */
function solve(s: Shot, reg: { x0: number; x1: number; y0: number; y1: number }, aspect: number, outP: THREE.Vector3, outT: THREE.Vector3) {
  const tanY = Math.tan(THREE.MathUtils.degToRad(s.fov) / 2)
  const tanX = tanY * aspect
  const ce = Math.cos(s.el)
  _back.set(Math.sin(s.az) * ce, Math.sin(s.el), Math.cos(s.az) * ce)
  _right.set(Math.cos(s.az), 0, -Math.sin(s.az))
  _up.crossVectors(_back, _right)
  let cx = 0
  let cy = 0
  let cz = 0
  for (let i = 0; i < 8; i++) {
    cx += s.p[i * 3] / 8
    cy += s.p[i * 3 + 1] / 8
    cz += s.p[i * 3 + 2] / 8
  }
  let zMax = 0
  for (let i = 0; i < 8; i++) {
    const x = s.p[i * 3] - cx
    const y = s.p[i * 3 + 1] - cy
    const z = s.p[i * 3 + 2] - cz
    _ca[i] = x * _right.x + y * _right.y + z * _right.z
    _cb[i] = x * _up.x + y * _up.y + z * _up.z
    _cz[i] = x * _back.x + y * _back.y + z * _back.z
    zMax = Math.max(zMax, _cz[i])
  }
  const rw = Math.max(0.05, reg.x1 - reg.x0)
  const rh = Math.max(0.05, reg.y1 - reg.y0)
  let lo = zMax + 0.2
  let hi = 400
  let mx = 0
  let my = 0
  let sx = 0
  for (let it = 0; it < 32; it++) {
    const d = (lo + hi) / 2
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (let i = 0; i < 8; i++) {
      const depth = d - _cz[i]
      const nx = _ca[i] / (depth * tanX)
      const ny = _cb[i] / (depth * tanY)
      if (nx < x0) x0 = nx
      if (nx > x1) x1 = nx
      if (ny < y0) y0 = ny
      if (ny > y1) y1 = ny
    }
    const f = Math.max((x1 - x0) / rw, (y1 - y0) / rh)
    mx = (x0 + x1) / 2
    my = (y0 + y1) / 2
    sx = x1 - x0
    if (f > s.fill) lo = d
    else hi = d
  }
  const d = (lo + hi) / 2
  const wantX = (reg.x0 + reg.x1) / 2 + s.ox * Math.max(0, rw - sx) * 0.5
  const wantY = (reg.y0 + reg.y1) / 2
  const tx = -(wantX - mx) * d * tanX
  const ty = -(wantY - my) * d * tanY
  outT.set(cx, cy, cz).addScaledVector(_right, tx).addScaledVector(_up, ty)
  outP.copy(outT).addScaledVector(_back, d)
}

/** portrait factor: 0 landscape .. 1 phone portrait */
const portrait = (f: Frame) => smoothstep(1.2, 0.62, f.width / Math.max(1, f.height))

const _p = new THREE.Vector3()
const _v = new THREE.Vector3()

/** 0..1: how comfortably a world point sits inside the frame (fades near the edges, 0 off-screen) */
function onScreen(world: THREE.Vector3, camera: THREE.Camera, w: number, h: number) {
  _p.copy(world).project(camera)
  if (!Number.isFinite(_p.x) || !Number.isFinite(_p.y) || _p.z > 1) return 0
  const x = (_p.x * 0.5 + 0.5) * w
  const y = (-_p.y * 0.5 + 0.5) * h
  const m = 24
  return Math.min(smoothstep(0, m, x), smoothstep(0, m, w - x), smoothstep(0, m, y), smoothstep(0, m, h - y))
}

// ---------------------------------------------------------------- timeline

/** CH2's write head, 0..1 across the screen */
const sweepAt = (local: number) => lerp(-0.04, 1.04, ease.inOutQuad(segment(local, 0.41, 0.64)))
/** the room: 1 dark (in-beat + noise) .. 0 lit bone studio */
const darkAt = (local: number) => 1 - smoothstep(0.365, 0.41, local)

export default function create(): Chapter {
  const group = new THREE.Group()
  let scope: Scope
  let intrusion: Callout
  let status: Callout
  let statusText: HTMLElement
  let statusMode = ''
  let stage: HTMLElement
  let top: HTMLElement
  let head: HTMLElement
  let side: HTMLElement
  let calmBox: HTMLElement
  let probe: HTMLElement
  const dom: Record<string, HTMLElement> = {}
  const res = new THREE.Vector2()
  /** time-base: accumulated sweeps (the rate changes with the story) */
  let sweepClock = 0
  let lastT = -1
  let stageDark = false
  // cached layout (CSS px), refreshed on resize / font load
  const m = { w: 0, h: 0, headB: 0, bodyB: 0, calmB: 0, sideL: 0, wide: true, safeTop: 96, safeBottom: 86, gutter: 24 }

  function measure(w: number, h: number) {
    m.w = w
    m.h = h
    if (!top) return
    m.headB = head.getBoundingClientRect().bottom
    const sr = side.getBoundingClientRect()
    m.sideL = sr.left
    m.bodyB = dom.body.getBoundingClientRect().bottom
    m.calmB = calmBox.getBoundingClientRect().bottom
    m.wide = sr.left > w * 0.5
    const cs = getComputedStyle(probe)
    m.safeTop = parseFloat(cs.paddingTop) || 96
    m.safeBottom = parseFloat(cs.paddingBottom) || 86
    m.gutter = parseFloat(cs.paddingLeft) || 24
  }

  const reg = { x0: -1, x1: 1, y0: -1, y1: 1 }
  function region(band: number, calmK: number, w: number, h: number) {
    const ndcX = (px: number) => (px / w) * 2 - 1
    const ndcY = (py: number) => 1 - (py / h) * 2
    const bottom = h - m.safeBottom - 6
    const fullTop = m.safeTop * 0.82
    // wide layouts: centred under the headline + body, then (as the taller
    // 24/7 block arrives) beside that column; narrow layouts: under all copy
    const sideB = m.wide ? lerp(m.bodyB, m.headB, calmK) : lerp(m.bodyB, m.calmB, calmK)
    const copyTop = Math.max(m.headB, sideB) + 20
    const right = m.wide ? lerp(w - m.gutter, lerp(w - m.gutter, m.sideL - 28, calmK), band) : w - m.gutter
    reg.x0 = ndcX(m.gutter)
    reg.x1 = ndcX(right)
    reg.y1 = ndcY(lerp(fullTop, Math.min(copyTop, bottom - 120), band))
    reg.y0 = ndcY(bottom)
    return reg
  }

  return {
    id: 'shield',
    group,
    // the one item in the copy layer is the CTA: land where it's on screen
    anchors: [0.8],

    init(ctx: ChapterContext) {
      scope = new Scope(ctx.renderer, ctx.mobile, ctx.studio.envMap)
      group.add(scope.object)

      // ---------------- DOM ----------------
      stage = ctx.stage
      probe = el('div', 'sh-probe', undefined, stage)
      top = el('div', 'sh-top', undefined, stage)
      head = el('div', 'sh-head', undefined, top)
      const eyebrow = el('p', 'hud-eyebrow sh-eyebrow', undefined, head)
      dom.eyebrow = eyebrow
      dom.eyebrowText = rise(el('span', 'sh-eyebrow-text', undefined, eyebrow), SECURITY.eyebrow)
      dom.title = rise(el('h2', 'hud-title sh-title', undefined, head), SECURITY.title.replace(/(\S+)$/, '<em>$1</em>'))
      side = el('div', 'sh-side', undefined, top)
      dom.body = rise(el('p', 'hud-body sh-body', undefined, side), SECURITY.body)
      calmBox = el('div', 'sh-calm', undefined, side)
      dom.stat = rise(el('p', 'sh-stat', undefined, calmBox), STAT.value)
      dom.statLabel = rise(el('p', 'hud-body sh-stat-label', undefined, calmBox), STAT.label)
      const cta = el('a', 'hud-btn sh-cta', SECURITY.cta, calmBox)
      cta.href = SECURITY.href
      dom.cta = cta

      intrusion = new Callout(stage, { side: 'right', offset: { x: 78, y: -52 } })
      intrusion.root.classList.add('sh-callout', 'sh-callout--alert')
      intrusion.label.innerHTML = '<span class="sh-co-k">Intrusion detected</span><span class="sh-co-v">Noise floor +18 dB</span>'
      status = new Callout(stage, { side: 'right', offset: { x: 70, y: -58 } })
      status.root.classList.add('sh-callout')
      statusText = el('span', 'sh-co-k', '', status.label)
      reveal(intrusion.root, 0, 0)
      reveal(status.root, 0, 0)

      const remeasure = () => measure(m.w || window.innerWidth, m.h || window.innerHeight)
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(remeasure).observe(top)
      document.fonts?.ready.then(remeasure).catch(() => {})
    },

    update(local: number, frame: Frame, ctx: ChapterContext) {
      const t = frame.time
      const dt = lastT < 0 ? 0 : Math.min(0.1, Math.max(0, t - lastT))
      lastT = t
      const rm = frame.reducedMotion
      const u = scope.screen.uniforms
      const dark = darkAt(local)

      // ---- time-base: fast shimmer in the noise, a slow visible sweep in the calm
      const rate = rm ? 0.3 : Math.exp(lerp(Math.log(13), Math.log(0.42), smoothstep(0.36, 0.74, local)))
      sweepClock += dt * rate
      if (sweepClock > 1e4) sweepClock -= 1e4
      u.uStep.value.set(Math.floor(sweepClock), sweepClock - Math.floor(sweepClock))
      u.uDecay.value = lerp(1.25, 1.7, smoothstep(0.4, 0.75, local))

      // ---- signal
      const erupt = segment(local, 0.05, 0.12)
      const noise = erupt >= 1 ? 1 : Math.max(0, ease.outBack(erupt))
      u.uNoise.value = noise
      u.uDensity.value = lerp(0.45, 0.66, smoothstep(0.08, 0.3, local))
      u.uHero.value.set(HERO_U, HERO_AMP * smoothstep(0.065, 0.12, local), 0)
      const split = ease.inOutCubic(segment(local, 0.335, 0.415))
      const merge = ease.inOutCubic(segment(local, 0.64, 0.72))
      const gain = lerp(1, 0.34, split)
      u.uScale.value.set(gain, gain, local < 0.2 ? 0 : gain)
      u.uRowY.value.set(lerp(lerp(0, 2.45, split), 0, merge), 0, local < 0.2 ? 0 : lerp(-2.45, 0, merge))
      const ring = 1 - smoothstep(0.07, 0.13, local)
      u.uRowA.value.set(
        smoothstep(0.035, 0.055, local) * (1 - smoothstep(0.64, 0.7, local)),
        smoothstep(0.37, 0.41, local) * (1 - smoothstep(0.64, 0.7, local)),
        local < 0.2 ? ring : smoothstep(0.37, 0.41, local),
      )
      const sweep = sweepAt(local)
      u.uSweep.value = sweep
      // Σ sine: the cymatics plate's ringing tone in the in-beat, the calm breath later
      const flat = smoothstep(0.925, 0.955, local)
      if (local < 0.2) u.uCalm.value.set(0.95 * ring, 6, t * 1.4, 0)
      else {
        const breath = rm ? 1 : 0.84 + 0.16 * Math.sin(t * 0.9)
        u.uCalm.value.set(1.2 * breath * smoothstep(0.68, 0.8, local) * (1 - flat), 2, rm ? 0.25 : t * 0.07, 0)
      }
      const pk = segment(local, 0.945, 0.995)
      u.uPulse.value.set(lerp(-0.08, 1.08, pk), 1.9 * Math.sin(Math.PI * Math.min(1, pk * 1.15)), 0.028, 0)
      u.uBright.value = lerp(0.82, 1, dark) + 0.9 * Math.sin(Math.PI * pk)
      u.uHaze.value.setRGB(0.012, 0.004, 0.002).lerp(_c.setRGB(0.002, 0.016, 0.008), smoothstep(0.38, 0.6, local))
      u.uGrat.value = lerp(1.15, 0.85, 1 - dark)

      ctx.renderer.getDrawingBufferSize(res)
      u.uRes.value.copy(res)
      u.uPx.value = ctx.renderer.getPixelRatio()

      // ---- hardware: the time-base knob steps down as the sweep slows, CH2 dials in
      scope.knobs.time.rotation.z = -Math.round(lerp(0, 5, smoothstep(0.36, 0.74, local))) * (Math.PI / 6) * 0.75 + 1.1
      scope.knobs.v2.rotation.z = lerp(1.6, -0.6, ease.inOutCubic(segment(local, 0.37, 0.43)))
      scope.knobs.v1.rotation.z = -0.4
      scope.knobs.p1.rotation.z = lerp(0.3, -0.9, split)
      scope.knobs.p2.rotation.z = 0.6
      scope.setLed(rm ? 1 : 0.55 + 0.45 * (Math.sin(t * 5.2) > -0.3 ? 1 : 0.2))

      // ---- light: dark room + bench lamp → lit bone studio
      const lamp = smoothstep(0.02, 0.15, local)
      const redness = smoothstep(0.05, 0.11, local) * (1 - smoothstep(0.4, 0.58, local))
      const fu = scope.floorUniforms
      fu.uPool.value = 0.85 * lamp * dark
      fu.uShadow.value = lerp(0.35, 1, 1 - dark)
      fu.uGlowCol.value.setRGB(lerp(0.0, 0.5, redness), lerp(0.3, 0.05, redness), lerp(0.14, 0.02, redness))
      fu.uGlow.value = lerp(0.1, 0.62, dark) * (1 + 0.5 * Math.sin(Math.PI * pk))
      scope.key.intensity = lerp(1.35, lerp(0.15, 1.7, lamp), dark)
      scope.key.color.setRGB(1, lerp(0.95, 0.86, dark), lerp(0.88, 0.72, dark))
      scope.spill.color.setRGB(lerp(0.12, 1.0, redness), lerp(1.0, 0.25, redness), lerp(0.5, 0.15, redness))
      scope.spill.intensity = lerp(0.25, 1.6, dark)

      // ---- DOM beats (headline + body settled by the 0.45 landing)
      const headOn = local > 0.41 && local < 0.955
      setRise(dom.eyebrowText, headOn)
      dom.eyebrow.classList.toggle('is-on', headOn)
      setRise(dom.title, headOn)
      setRise(dom.body, local > 0.42 && local < 0.705)
      const calmOn = local > 0.72 && local < 0.955
      setRise(dom.stat, calmOn)
      setRise(dom.statLabel, calmOn)
      dom.cta.classList.toggle('is-in', calmOn)

      // the stage copy follows the room (callouts only while it's dark)
      const tone = ctx.studio.tone
      if (!stageDark && tone > 0.55) stageDark = true
      else if (stageDark && tone < 0.45) stageDark = false
      if (stage.classList.contains('is-dark') !== stageDark) stage.classList.toggle('is-dark', stageDark)

      // callouts (anchored on the glass)
      const w = frame.width
      const h = frame.height
      scope.screen.worldAt(HERO_U, u.uRowY.value.x + gain * u.uHero.value.y * noise, _v)
      intrusion.update(_v, ctx.camera, w, h, window01(local, 0.12, 0.345, 0.03) * onScreen(_v, ctx.camera, w, h))
      const mode = local < 0.7 ? 'anti' : 'calm'
      if (mode !== statusMode) {
        statusMode = mode
        statusText.textContent = mode === 'anti' ? 'Anti-phase · 180°' : 'Noise floor −96 dB'
      }
      if (mode === 'anti') scope.screen.worldAt(Math.min(1, Math.max(0, sweep)), u.uRowY.value.y, _v)
      else {
        const cu = 0.78
        const c = u.uCalm.value
        scope.screen.worldAt(cu, u.uRowY.value.z + c.x * Math.sin((cu * c.y - c.z) * Math.PI * 2), _v)
      }
      status.side = mode === 'anti' && sweep > 0.55 ? 'left' : 'right'
      const sv = mode === 'anti' ? window01(local, 0.425, 0.655, 0.025) : window01(local, 0.75, 0.925, 0.025)
      status.update(_v, ctx.camera, w, h, sv * onScreen(_v, ctx.camera, w, h))

      // ---- post + studio
      const noisy = window01(local, 0.04, 0.4, 0.05)
      ctx.post.params.glitch = rm ? 0 : noisy * (0.06 + 0.09 * Math.max(0, Math.sin(t * 2.3) * Math.sin(t * 3.7)))
      ctx.post.params.bloomStrength = lerp(0.55, 0.85, dark) + 0.25 * Math.sin(Math.PI * pk)
      ctx.post.params.bloomRadius = 0.5
      ctx.post.params.vignette = lerp(0.22, 0.34, dark)
      ctx.studio.params.tone = dark
      ctx.studio.params.spot = lerp(0.45, 0.75, dark)
      ctx.studio.params.warmth = 0.1
      ctx.studio.params.envIntensity = lerp(1, lerp(0.06, 0.3, lamp), dark)

      // ---- sound: a Bb2 hum a semitone against the room's A chord, cancelled by CH2
      const hum = 0.55 * noisy * (1 - Math.min(1, Math.max(0, sweep)))
      window.dispatchEvent(new CustomEvent('hark:tone', { detail: { hz: HUM_HZ, level: hum } }))
    },

    camera(local: number, frame: Frame, out: CameraPose) {
      const w = frame.width
      const h = frame.height
      if (w !== m.w || h !== m.h) measure(w, h)
      const pf = portrait(frame)
      let i = 0
      while (i < KEYS.length - 2 && local >= KEYS[i + 1][0]) i++
      const k = KEYS[i][1](segment(local, KEYS[i][0], KEYS[i + 1][0]))
      mixShot(mixShot(WIDE[i], WIDE[i + 1], k, _s), mixShot(TALL[i], TALL[i + 1], k, _t), pf, _s)
      const calmK = smoothstep(0.66, 0.74, local)
      solve(_s, region(_s.band, calmK, w, h), w / Math.max(1, h), out.position, out.target)
      if (!frame.reducedMotion) {
        const t = frame.time
        out.position.x += Math.sin(t * 0.21) * 0.04
        out.position.y += Math.sin(t * 0.17 + 1.3) * 0.02
      }
      out.fov = _s.fov
      out.roll = 0
      out.parallax = lerp(0.22, 0.12, pf) * (1 - smoothstep(0.93, 1, local))
    },

    onLeave() {
      window.dispatchEvent(new CustomEvent('hark:tone', { detail: { hz: HUM_HZ, level: 0 } }))
      statusMode = ''
    },
  }
}

const _c = new THREE.Color()
