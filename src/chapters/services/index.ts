import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { clamp, ease, lerp, segment, smoothstep } from '../../core/math'
import { BRAND, SERVICES } from '../../content'
import { LOGO_HZ, MODES, ROW_LOGO } from './modes'
import { Sand } from './sand'
import { FLOOR_Y, Plate, THICK } from './plate'
import { Hud, type HudMetrics } from './hud'
import './services.css'

/*
 * CYMATICS — a Chladni plate (3.6 viewport heights, between Liner Notes and
 * Noise Floor). The camera walks half way round the plate in four set-ups,
 * so eleven services read as four scenes rather than one list:
 *
 *  0.000–0.090  in-beat: Liner Notes ends on one flat line in the dark; we
 *               open edge-on to the plate, so its lit edge is that line with
 *               the accelerometer LED on it. A pressure wave runs along it,
 *               then the camera cranes up and the line opens into the plate.
 *               "Eleven ways to be heard."
 *  0.090–0.862  eleven beats, one per service. Each beat: the drive sweeps to the
 *               new frequency, the sand buzzes off the old lines and migrates to
 *               the new nodal lines (first half), then holds. The panel switches
 *               once the new figure has mostly formed, so copy always matches.
 *                 01–03  the 3/4 product view
 *                 04–06  overhead, looking straight down on the figure
 *                 07–09  low and grazing, the key dropped to rake long shadows
 *                 10–11  close on the accelerometer puck and its LED
 *               Each change of set-up rides the migration of its first beat.
 *  0.862–0.902  the finale mode: the sand walks into the Hark mark while the
 *               camera pulls back and cranes to near top-down so the mark reads.
 *  0.902–0.962  hold on the mark ("Every frequency, one studio.")
 *  0.962–1.000  the plate rings: a pressure wave throws the sand, camera pushes in,
 *               the engine's ripple cut takes over (Noise Floor is next).
 */

const INTRO_END = 0.09
const SVC_END = 0.862
const BEAT = (SVC_END - INTRO_END) / SERVICES.length
/** fraction of a beat spent forming the new figure */
const FORM = 0.5
/** the panel switches at this fraction of a beat (figure mostly formed) */
const SWITCH = 0.36
const LOGO_END = 0.902
const RING = 0.962
/** where service k's figure has formed, the camera has settled and its copy is up */
const ANCHORS = SERVICES.map((_, k) => INTRO_END + (k + 0.75) * BEAT)
const beatStart = (k: number) => INTRO_END + k * BEAT

interface Beat {
  /** -1 intro, 0..10 services, 11 logo */
  k: number
  /** formation 0..1 */
  t: number
  rowA: number
  rowB: number
}

function beatAt(local: number): Beat {
  if (local < INTRO_END) return { k: -1, t: 1, rowA: 0, rowB: 0 }
  if (local < SVC_END) {
    const k = Math.min(SERVICES.length - 1, Math.floor((local - INTRO_END) / BEAT))
    const p = (local - INTRO_END - k * BEAT) / BEAT
    return { k, t: segment(p, 0, FORM), rowA: k, rowB: k + 1 }
  }
  return { k: SERVICES.length, t: segment(local, SVC_END, LOGO_END), rowA: ROW_LOGO - 1, rowB: ROW_LOGO }
}

const MARK_LABEL = `Mode H · ${BRAND.short}`

/** the figure that is (mostly) on the plate: the new one once it has half formed */
function modeLabel(b: Beat) {
  const k = b.t >= 0.5 ? b.k : b.k - 1
  if (k < 0) return 'Plate at rest'
  if (k >= MODES.length) return MARK_LABEL
  const m = MODES[k]
  return `Mode ${m.n} · ${m.m}  (${m.s > 0 ? '+' : '−'})`
}

const hzOf = (k: number) => (k < 0 ? 0 : k >= MODES.length ? LOGO_HZ : MODES[k].hz)

/* ---------------- camera ---------------- */

/**
 * A set-up: an orbit round the plate centre (az, el) and a lens, which part
 * of the plate must be framed (a box on the plate, optionally with the
 * shaker hanging below it), how big it sits in its screen region (1 = just
 * contained; above 1 it bleeds past the region's far side) and where it is
 * anchored in that region. The region blends (sx across, sy down) from the
 * whole screen (0) to the free space beside the copy column / above the
 * phone sheet (1), so the
 * plate can never run under the panel; `ct` also keeps the whole plate
 * below the region's top when only a corner is framed. Each set-up also
 * places the key light relative to the camera, so a group can relight the
 * plate, and sets how much of the room the metal reflects (env).
 */
const SHOT_KEYS = ['az', 'el', 'fov', 'x0', 'x1', 'z0', 'z1', 'base', 'sw', 'sh', 'ax', 'ay', 'sx', 'sy', 'rt', 'ct', 'la', 'le', 'env'] as const
type Shot = Record<(typeof SHOT_KEYS)[number], number>

const PLATE = { x0: -1, x1: 1, z0: -1, z1: 1 }
/** the corner with the accelerometer puck (see modes.PUCK) */
const PUCK_BOX = { x0: 0.12, x1: 1, z0: -1, z1: -0.12 }
/** the key light as the original rig had it: from the far left, ~25° up */
const KEY = { la: -2.45, le: 0.44 }

const S = (o: Partial<Shot>): Shot => ({
  az: 0,
  el: 0.8,
  fov: 28,
  ...PLATE,
  base: 0,
  sw: 1,
  sh: 1,
  ax: 0,
  ay: 0,
  sx: 1,
  sy: 1,
  rt: 0,
  ct: 0,
  ...KEY,
  env: 1,
  ...o,
})

/* the set-ups (desktop / tablet landscape) */
// edge-on through a long lens: the plate is one lit line with the LED on it
const EDGE_A = S({ az: -0.74, el: 0.012, fov: 9, sw: 1.05, sh: 40, sx: 0, sy: 0 })
const EDGE_B = S({ az: -0.7, el: 0.02, fov: 10, sw: 1.04, sh: 40, sx: 0, sy: 0 })
// the landing: craning up, the plate opens out beside the title
const OPEN = S({ az: 0.08, el: 0.5, fov: 24, sx: 0.55, rt: 1, ax: 0.6, ay: 0.3, base: 0.4 })
const OBL_A = S({ az: 0.4, el: 0.86, base: 0.2, rt: 0.5 })
const OBL_B = S({ az: 0.62, el: 0.93, base: 0.2, rt: 0.5 })
const TOP_A = S({ az: 1.46, el: 1.46, fov: 22, rt: 1, la: -2.3, le: 0.5, env: 0.62 })
const TOP_B = S({ az: 1.68, el: 1.5, fov: 22, rt: 1, la: -2.3, le: 0.5, env: 0.62 })
const LOW_A = S({ az: 2.06, el: 0.34, fov: 32, base: 1, sw: 1.42, ax: -1, rt: 1, ct: 1, la: -1.95, le: 0.15 })
const LOW_B = S({ az: 2.3, el: 0.29, fov: 32, base: 1, sw: 1.42, ax: -1, rt: 1, ct: 1, la: -1.9, le: 0.13 })
const PUCK_A = S({ az: 3.2, el: 0.6, fov: 30, ...PUCK_BOX, sw: 1.1, ax: -1, ay: -1, rt: 1, ct: 1, la: -2.5, le: 0.38 })
const PUCK_B = S({ az: 3.3, el: 0.56, fov: 30, ...PUCK_BOX, sw: 1.1, ax: -1, ay: -1, rt: 1, ct: 1, la: -2.55, le: 0.36 })
// pull back and crane up: the mark reads square to the frame
const MARK_A = S({ az: Math.PI, el: 1.26, fov: 28, rt: 1, ct: 1, le: 0.5 })
const MARK_B = S({ az: Math.PI, el: 1.3, fov: 28, rt: 1, ct: 1, le: 0.5 })
const MARK_RING = S({ az: Math.PI, el: 1.38, fov: 28, sw: 1.34, sh: 1.34, rt: 1, le: 0.5 })

/** a set-up change rides the migration of its group's first beat */
const into = (k: number) => beatStart(k) + 0.55 * BEAT
const outOf = (k: number) => beatStart(k) - 0.2 * BEAT

const WIDE: [number, Shot][] = [
  [0.0, EDGE_A],
  [0.03, EDGE_B],
  [0.08, OPEN],
  [0.14, OBL_A],
  [outOf(3), OBL_B],
  [into(3), TOP_A],
  [outOf(6), TOP_B],
  [into(6), LOW_A],
  [outOf(9), LOW_B],
  [into(9), PUCK_A],
  [SVC_END - 0.1 * BEAT, PUCK_B],
  [LOGO_END + 0.012, MARK_A],
  [RING, MARK_B],
  [1.0, MARK_RING],
]

/* phones: the plate lives above the sheet; nothing sits at the sides, so wide set-ups bleed both ways */
const TALL: [number, Shot][] = WIDE.map(([t, s]) => {
  const o: Partial<Shot> = { ax: 0 }
  if (s === EDGE_A || s === EDGE_B) Object.assign(o, { sw: 1.2 })
  if (s === OPEN) Object.assign(o, { sy: 0.4, ay: 0.4, sw: 1.1 })
  if (s === OBL_A || s === OBL_B) Object.assign(o, { sw: 1.02 })
  if (s === LOW_A || s === LOW_B) Object.assign(o, { sw: 1.55, fov: 36 })
  if (s === PUCK_A || s === PUCK_B) Object.assign(o, { sw: 1.25, ay: -0.2, fov: 34 })
  if (s === MARK_RING) Object.assign(o, { sw: 1.22, sh: 1.22 })
  return [t, { ...s, ...o }]
})

function sampleShot(keys: [number, Shot][], local: number, out: Shot) {
  let i = 0
  while (i < keys.length - 2 && local > keys[i + 1][0]) i++
  const [t0, a] = keys[i]
  const [t1, b] = keys[i + 1]
  const s = ease.inOutCubic(clamp((local - t0) / (t1 - t0)))
  for (const k of SHOT_KEYS) out[k] = lerp(a[k], b[k], s)
  return out
}

interface Region {
  l: number
  r: number
  b: number
  t: number
}

/** The screen region (NDC) a shot frames the plate into, from the HUD's live layout. */
function regionOf(s: Shot, tall: boolean, m: HudMetrics, w: number, h: number, out: Region) {
  const nx = (px: number) => (2 * px) / w - 1
  const ny = (px: number) => 1 - (2 * px) / h
  let l: number, r: number, b: number, t: number
  if (tall) {
    // above the sheet, clear of the nav
    l = -0.93
    r = 0.93
    b = ny(m.panelTop - 16)
    t = ny(m.safeTop)
  } else {
    // right of the copy column; optionally below the Hz readout
    l = nx(m.colRight + clamp(0.035 * w, 24, 64))
    r = 0.95
    b = ny(m.panelBottom)
    t = lerp(ny(m.safeTop), ny(m.readoutBottom + 20), s.rt)
  }
  out.l = lerp(-1, l, s.sx)
  out.r = lerp(1, r, s.sx)
  out.b = lerp(-1, b, s.sy)
  out.t = lerp(1, t, s.sy)
  return out
}

const N_PTS = 16
const _pa = new Float64Array(N_PTS)
const _pb = new Float64Array(N_PTS)
const _pc = new Float64Array(N_PTS)
const _right = new THREE.Vector3()
const _up = new THREE.Vector3()
const _back = new THREE.Vector3()

/**
 * Solve the camera for a shot: distance by bisection so the framed box fills
 * its region as asked, then a truck (shift) that anchors it in the region.
 * Exact for the projected box corners, so it holds at every aspect ratio.
 * Returns the camera distance.
 */
function solveShot(s: Shot, reg: Region, aspect: number, out: CameraPose) {
  const tanY = Math.tan(THREE.MathUtils.degToRad(s.fov) / 2)
  const tanX = tanY * aspect
  const ce = Math.cos(s.el)
  _back.set(Math.sin(s.az) * ce, Math.sin(s.el), Math.cos(s.az) * ce)
  _right.set(Math.cos(s.az), 0, -Math.sin(s.az))
  // up = right × fwd, fwd = -back
  _up.set(_right.z * _back.y, _right.x * _back.z - _right.z * _back.x, -_right.x * _back.y)

  // the box corners (top face with a little headroom for the puck, bottom face) + the shaker foot
  let n = 0
  let dMin = 0
  const push = (x: number, y: number, z: number) => {
    _pa[n] = x * _right.x + y * _right.y + z * _right.z
    _pb[n] = x * _up.x + y * _up.y + z * _up.z
    const c = -(x * _back.x + y * _back.y + z * _back.z)
    _pc[n] = c
    dMin = Math.max(dMin, -c + 0.15)
    n++
  }
  for (let i = 0; i < 4; i++) {
    const x = i & 1 ? s.x1 : s.x0
    const z = i & 2 ? s.z1 : s.z0
    push(x, 0.03, z)
    push(x, -THICK, z)
  }
  const ys = lerp(-THICK, FLOOR_Y, s.base)
  push(0.38, ys, 0)
  push(-0.38, ys, 0)
  push(0, ys, 0.38)
  push(0, ys, -0.38)
  const nFit = n
  // the whole plate's top face: only has to stay under the region's top (ct)
  for (let i = 0; i < 4; i++) push(i & 1 ? 1 : -1, 0.03, i & 2 ? 1 : -1)

  const fx = (s.ax + 1) / 2
  const fy = (s.ay + 1) / 2
  let dx = 0
  let dy = 0
  const measure = (d: number) => {
    let dxL = Infinity,
      dxR = -Infinity,
      dyB = Infinity,
      dyT = -Infinity
    for (let i = 0; i < nFit; i++) {
      const z = _pc[i] + d
      dxL = Math.min(dxL, _pa[i] - reg.l * z * tanX)
      dxR = Math.max(dxR, _pa[i] - reg.r * z * tanX)
      dyB = Math.min(dyB, _pb[i] - reg.b * z * tanY)
      dyT = Math.max(dyT, _pb[i] - reg.t * z * tanY)
    }
    dx = lerp(dxL, dxR, fx)
    dy = lerp(dyB, dyT, fy)
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity
    for (let i = 0; i < nFit; i++) {
      const z = _pc[i] + d
      const X = (_pa[i] - dx) / (z * tanX)
      const Y = (_pb[i] - dy) / (z * tanY)
      x0 = Math.min(x0, X)
      x1 = Math.max(x1, X)
      y0 = Math.min(y0, Y)
      y1 = Math.max(y1, Y)
    }
    const rh = Math.max(0.05, reg.t - reg.b)
    let fill = Math.max((x1 - x0) / (s.sw * Math.max(0.05, reg.r - reg.l)), (y1 - y0) / (s.sh * rh))
    if (s.ct > 0) {
      // the image shrinks toward its anchor: how far past the region's top does the plate reach?
      let top = -Infinity
      for (let i = nFit; i < n; i++) top = Math.max(top, (_pb[i] - dy) / ((_pc[i] + d) * tanY))
      const ya = lerp(reg.b, reg.t, fy)
      fill = Math.max(fill, lerp(0, (top - ya) / Math.max(0.02, reg.t - ya), s.ct))
    }
    return fill
  }
  // fill falls with distance: bisect (in log space) for fill = 1
  let lo = Math.log(dMin)
  let hi = Math.log(200)
  for (let it = 0; it < 30; it++) {
    const mid = (lo + hi) / 2
    if (measure(Math.exp(mid)) > 1) lo = mid
    else hi = mid
  }
  const d = Math.exp(hi)
  measure(d)
  out.target.set(0, 0, 0).addScaledVector(_right, dx).addScaledVector(_up, dy)
  out.position.copy(out.target).addScaledVector(_back, d)
  out.fov = s.fov
  return d
}

const tone = (hz: number, level: number) =>
  window.dispatchEvent(new CustomEvent('hark:tone', { detail: { hz, level } }))

export default function create(): Chapter {
  const group = new THREE.Group()
  let sand: Sand | null = null
  let plate: Plate | null = null
  let hud: Hud | null = null
  let key: THREE.DirectionalLight | null = null
  const cur: Shot = S({})
  const reg: Region = { l: -1, r: 1, b: -1, t: 1 }
  const pose: CameraPose = {
    position: new THREE.Vector3(),
    target: new THREE.Vector3(),
    fov: 30,
    roll: 0,
    parallax: 0,
  }
  const light = new THREE.Vector3()
  const buf = new THREE.Vector2()
  const ledBase = new THREE.Color('#00ff85')
  let calm = false
  /** last knock on the plate (pointer down): x, z, time */
  const tap = { x: 0, z: 0, t: -99 }
  const ray = new THREE.Raycaster()
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  const hit = new THREE.Vector3()

  /** jump the scroll to the settled hold of service k */
  const jumpTo = (k: number) => {
    const l = ANCHORS[k]
    const eng = window.__hark?.engine
    if (eng) eng.gotoChapter('services', l, true)
    else window.__hark?.gotoChapter('services', l)
  }

  return {
    id: 'services',
    group,
    anchors: ANCHORS,

    async init(ctx: ChapterContext) {
      ctx.stage.classList.add('is-dark')
      calm = ctx.reducedMotion
      light.set(-0.86, 0.42, -0.3).normalize()
      sand = new Sand(ctx.mobile, light)
      await sand.load()
      plate = new Plate(light, ctx.mobile)
      plate.uniforms.tDensity.value = sand.density.texture
      group.add(plate.group, sand.points)

      key = new THREE.DirectionalLight(0xffffff, 2.4)
      key.position.copy(light).multiplyScalar(6)
      group.add(key)
      const fill = new THREE.HemisphereLight(0xdfe4ea, 0x0a0a0b, 0.25)
      group.add(fill)

      hud = new Hud(ctx.stage, jumpTo, MARK_LABEL)
    },

    update(local: number, frame: Frame, ctx: ChapterContext) {
      if (!sand || !plate || !hud || !key) return
      const aspect = frame.width / Math.max(1, frame.height)
      // matches the bottom-sheet breakpoint in services.css
      const tall = aspect < 0.8 || frame.width < 768
      sampleShot(tall ? TALL : WIDE, local, cur)
      regionOf(cur, tall, hud.metrics(), frame.width, frame.height, reg)
      const dist = solveShot(cur, reg, aspect, pose)

      /* ---------------- key light: follows the set-up ---------------- */
      const la = cur.az + cur.la
      const cle = Math.cos(cur.le)
      light.set(Math.sin(la) * cle, Math.sin(cur.le), Math.cos(la) * cle)
      key.position.copy(light).multiplyScalar(6)
      sand.uniforms.uLight.value.copy(light)
      plate.setLight(light)

      /* ---------------- sand state ---------------- */
      const b = beatAt(local)
      const u = sand.uniforms
      u.uRowA.value = b.rowA * sand.rowsPer
      u.uRowB.value = b.rowB * sand.rowsPer
      u.uT.value = b.t
      u.uTime.value = frame.time
      u.uVib.value = calm ? 0 : 1
      const md = b.k >= 0 && b.k < MODES.length ? MODES[b.k] : null
      if (md) u.uModeB.value.set(md.n, md.m, md.s)
      else u.uModeB.value.set(0, 0, 0)

      // how hard the plate is being driven: kick at each new frequency, easing to a hum
      const forming = b.k >= 0 && b.t > 0 && b.t < 1
      const kick = forming ? smoothstep(0, 0.06, b.t) * (1 - smoothstep(0.5, 1, b.t)) : 0

      // pressure waves: in-beat along the edge-on line, a small kick per new frequency, the final ring
      const w = u.uWave.value
      const ring = segment(local, RING, 1)
      if (local < 0.07) {
        w.set(lerp(0.02, 1.7, ease.outCubic(segment(local, 0.004, 0.07))), 1 - smoothstep(0.045, 0.07, local), 0.13, 0)
      } else if (ring > 0) {
        w.set(lerp(0.05, 1.8, ease.outQuad(ring)), smoothstep(0, 0.12, ring) * (1 - smoothstep(0.85, 1, ring) * 0.4), 0.16, 0)
      } else if (forming && b.t < 0.35) {
        w.set(lerp(0.05, 1.6, ease.outCubic(b.t / 0.35)), 0.3 * (1 - smoothstep(0.2, 0.35, b.t)), 0.1, 0)
      } else w.set(0, 0, 0.1, 0)
      if (calm) w.y = 0
      plate.uniforms.uWave.value.copy(w)
      // a knock: a ring from wherever the visitor tapped the plate (decays in ~2s)
      const age = frame.time - tap.t
      const tv = u.uTap.value
      if (age >= 0 && age < 2.5 && !calm) tv.set(tap.x, tap.z, age * 1.25, Math.exp(-age * 1.6))
      else tv.set(0, 0, 0, 0)
      plate.uniforms.uTap.value.copy(tv)
      plate.uniforms.uTime.value = frame.time
      const pm = md ?? MODES[MODES.length - 1]
      plate.uniforms.uModeB.value.set(pm.n, pm.m, pm.s)
      plate.uniforms.uShimmer.value = calm ? 0 : md ? 0.0012 + 0.0045 * kick : 0.0006 * (1 - segment(local, SVC_END, LOGO_END))

      // grain size in pixels follows the drawing buffer and the lens
      ctx.renderer.getDrawingBufferSize(buf)
      u.uPx.value = buf.y / (2 * Math.tan(THREE.MathUtils.degToRad(pose.fov) / 2))
      sand.renderDensity(ctx.renderer)

      // accelerometer LED: steady when armed, flares while the plate is driven hard
      const inBeat = local < 0.07 ? 1 - smoothstep(0.03, 0.07, local) : 0
      const drive = Math.max(local < INTRO_END ? inBeat : Math.max(kick, ring * 1.2), u.uTap.value.w * 0.8)
      const flick = calm ? 1 : 0.92 + 0.08 * Math.sin(frame.time * 60)
      plate.led.color.copy(ledBase).multiplyScalar((local < INTRO_END ? 1.6 : 3.2) + 7 * drive * flick)

      /* ---------------- HUD ---------------- */
      let shown = -1
      if (local >= INTRO_END + SWITCH * BEAT) {
        shown = local < SVC_END ? Math.min(SERVICES.length - 1, Math.floor((local - INTRO_END - SWITCH * BEAT) / BEAT)) : SERVICES.length - 1
        if (local >= SVC_END + 0.62 * (LOGO_END - SVC_END)) shown = SERVICES.length
      }
      if (local > RING + 0.024) shown = -1
      const hzA = hzOf(b.k - 1)
      const hzB = hzOf(b.k)
      const hz = b.k < 0 ? 0 : lerp(hzA, hzB, ease.inOutCubic(b.t))
      const lit = b.k < 0 ? -1 : b.k >= SERVICES.length ? -1 : b.t > SWITCH / FORM ? b.k : b.k - 1
      hud.update({
        // wait for the cut's paper wash to clear so the title's rise is seen
        introOn: local > 0.018 && local < INTRO_END + SWITCH * BEAT - 0.004,
        shown,
        key: lit,
        hz,
        mode: modeLabel(b),
        readoutOn: local > 0.018 && local < RING + 0.02,
        drive,
      })

      /* ---------------- sound ---------------- */
      let level = 0
      if (b.k >= 0) level = 0.2 + 0.4 * kick
      if (ring > 0) level = 0.2 + 0.4 * ring
      if (b.k >= 0) level += 0.3 * tv.w
      tone(hz, Math.min(1, level))

      /* ---------------- studio + post ---------------- */
      // edge-on we look at the back wall: take the room fully dark so the line
      // matches the one Liner Notes ends on, then ease back to the plate's room
      ctx.studio.params.tone = lerp(1, 0.92, smoothstep(0.04, 0.12, local))
      ctx.studio.params.spot = 0.6
      ctx.studio.params.envIntensity = cur.env * lerp(0.95, 0.55, smoothstep(SVC_END, LOGO_END, local))
      // edge-on, the post and shaker sink into the dark so the plate reads as one line
      plate.setUnder(lerp(0.05, 1, smoothstep(0.035, 0.1, local)))
      const p = ctx.post.params
      p.bloomStrength = 0.55
      p.bloomRadius = 0.4
      p.vignette = 0.34
      p.grain = 0.03
      // single-pixel grains fringe badly under aberration: keep it for the ring only
      p.aberration = 0.0003 + 0.002 * ring
      p.exposure = 1 + 0.25 * ease.inQuad(ring)

      // parallax in proportion to the set-up's distance; almost none while edge-on
      const edge = 1 - smoothstep(0.03, 0.1, local)
      pose.parallax = dist * (tall ? 0.008 : 0.016) * (1 - ring) * (1 - 0.8 * edge)
    },

    camera(_local: number, _frame: Frame, out: CameraPose) {
      out.position.copy(pose.position)
      out.target.copy(pose.target)
      out.fov = pose.fov
      out.roll = 0
      out.parallax = pose.parallax
    },

    onPointerDown(frame: Frame, ctx: ChapterContext) {
      ray.setFromCamera(frame.pointerRaw, ctx.camera)
      if (!ray.ray.intersectPlane(ground, hit)) return
      if (Math.abs(hit.x) > 1 || Math.abs(hit.z) > 1) return
      tap.x = hit.x
      tap.z = hit.z
      tap.t = frame.time
    },

    onLeave() {
      tone(0, 0)
    },
  }
}
