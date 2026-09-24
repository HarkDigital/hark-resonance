import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { clamp, ease, lerp, segment, smoothstep } from '../../core/math'
import { SERVICES } from '../../content'
import { LOGO_HZ, MODES, ROW_LOGO } from './modes'
import { Sand } from './sand'
import { Plate } from './plate'
import { Hud } from './hud'
import './services.css'

/*
 * CYMATICS — a Chladni plate (4.4 viewport heights, between The Crate and Noise Floor).
 *
 *  0.000–0.088  intro: low raking macro across a plate dusted with sand. A pressure
 *               wave rolls out from the drive bolt (the cut's in-beat), then rest.
 *               "Eleven ways to be heard." Drive readout at 0 Hz.
 *  0.088–0.885  eleven beats, one per service. Each beat: the drive sweeps to the new
 *               frequency, the sand buzzes off the old lines and migrates to the new
 *               nodal lines (first half), then holds. The panel switches once the
 *               new figure has mostly formed, so copy always matches the plate.
 *               Camera: a slow crane up to a 3/4 product angle, then a slow orbit.
 *  0.885–0.930  the finale mode: the sand walks into the Hark mark; the camera
 *               cranes to near top-down so the mark reads.
 *  0.930–0.962  hold on the mark ("Make the internet listen.")
 *  0.962–1.000  the plate rings: a pressure wave throws the sand, camera pushes in,
 *               the engine's ripple cut takes over.
 */

const INTRO_END = 0.088
const SVC_END = 0.885
const BEAT = (SVC_END - INTRO_END) / SERVICES.length
/** fraction of a beat spent forming the new figure */
const FORM = 0.5
/** the panel switches at this fraction of a beat (figure mostly formed) */
const SWITCH = 0.36
const LOGO_END = 0.922
const RING = 0.962

/** raking key light: from the left and a little behind, ~25° up */
const LIGHT = new THREE.Vector3(-0.86, 0.42, -0.3).normalize()

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

/** the figure that is (mostly) on the plate: the new one once it has half formed */
function modeLabel(b: Beat) {
  const k = b.t >= 0.5 ? b.k : b.k - 1
  if (k < 0) return 'Plate at rest'
  if (k >= MODES.length) return 'Mode H · the mark'
  const m = MODES[k]
  return `Mode ${m.n} · ${m.m}  (${m.s > 0 ? '+' : '−'})`
}

const hzOf = (k: number) => (k < 0 ? 0 : k >= MODES.length ? LOGO_HZ : MODES[k].hz)

/* ---------------- camera ---------------- */
interface Shot {
  az: number
  el: number
  /** plate's share of the frame (bigger = closer) */
  fill: number
  fov: number
  /** where the plate centre sits on screen, NDC */
  ox: number
  oy: number
}
const shot = (az: number, el: number, fill: number, fov: number, ox: number, oy: number): Shot => ({ az, el, fill, fov, ox, oy })

const WIDE: [number, Shot][] = [
  [0.0, shot(0.66, 0.3, 1.22, 30, 0.16, 0.0)],
  [0.08, shot(0.58, 0.4, 1.06, 30, 0.2, 0.0)],
  // the rest are re-fitted every frame to the space right of the copy column (fitWide)
  [0.14, shot(0.52, 0.9, 0.66, 28, 0.3, -0.03)],
  [0.885, shot(0.2, 1.0, 0.68, 28, 0.3, -0.03)],
  [0.935, shot(0.0, 1.16, 0.7, 28, 0.3, -0.07)],
  [0.962, shot(0.0, 1.2, 0.72, 28, 0.3, -0.07)],
  [1.0, shot(0.0, 1.3, 0.95, 28, 0.25, -0.04)],
]

/**
 * Fit the plate into the space right of the copy column (services.css:
 * --svc-col and --gutter), so the panel and the plate never collide at any
 * desktop/tablet width.
 */
function fitWide(w: number) {
  const gutter = clamp(0.034 * w, 16, 48)
  const col = w >= 768 && w <= 1100 ? Math.min(380, 0.4 * w) : Math.min(430, 0.34 * w)
  const L = ((gutter + col) / w) * 2 - 1 + 0.07
  const R = 0.95
  const half = Math.min(0.68, (R - L) / 2)
  const cx = (L + R) / 2
  const set = (i: number, fill: number, dx = 0) => {
    WIDE[i][1].fill = fill
    WIDE[i][1].ox = cx + dx
  }
  set(2, half)
  set(3, half * 1.02)
  set(4, half * 0.96)
  set(5, half * 0.99)
  set(6, half * 1.4, -0.05)
}

const TALL: [number, Shot][] = [
  [0.0, shot(0.66, 0.34, 1.5, 34, 0.0, 0.06)],
  [0.08, shot(0.58, 0.46, 1.3, 34, 0.0, 0.1)],
  [0.14, shot(0.52, 0.98, 0.84, 34, 0.0, 0.4)],
  [0.885, shot(0.2, 1.06, 0.84, 34, 0.0, 0.4)],
  [0.935, shot(0.0, 1.2, 0.9, 34, 0.0, 0.3)],
  [0.962, shot(0.0, 1.24, 0.92, 34, 0.0, 0.3)],
  [1.0, shot(0.0, 1.34, 1.12, 34, 0.0, 0.28)],
]

function sampleShot(keys: [number, Shot][], local: number, out: Shot) {
  let i = 0
  while (i < keys.length - 2 && local > keys[i + 1][0]) i++
  const [t0, a] = keys[i]
  const [t1, b] = keys[i + 1]
  const s = ease.inOutCubic(clamp((local - t0) / (t1 - t0)))
  out.az = lerp(a.az, b.az, s)
  out.el = lerp(a.el, b.el, s)
  out.fill = lerp(a.fill, b.fill, s)
  out.fov = lerp(a.fov, b.fov, s)
  out.ox = lerp(a.ox, b.ox, s)
  out.oy = lerp(a.oy, b.oy, s)
  return out
}

const _fwd = new THREE.Vector3()
const _right = new THREE.Vector3()
const _up = new THREE.Vector3()
const Y = new THREE.Vector3(0, 1, 0)

/** Orbit the plate centre, fit it to the frame, then truck so it sits at (ox, oy). */
function composePose(s: Shot, aspect: number, out: CameraPose) {
  const tanY = Math.tan(THREE.MathUtils.degToRad(s.fov) / 2)
  const tanX = tanY * aspect
  // visible half-extents of the plate from this elevation (rough, rotated square)
  const halfW = 1.0 + 0.36 * Math.abs(Math.sin(2 * s.az)) + 0.08
  const halfH = 1.0 * Math.sin(s.el) + 0.28 * Math.cos(s.el) + 0.12
  const dist = Math.max(halfW / (tanX * s.fill), halfH / (tanY * s.fill))
  const ce = Math.cos(s.el)
  out.target.set(0, 0, 0)
  out.position.set(Math.sin(s.az) * ce * dist, Math.sin(s.el) * dist, Math.cos(s.az) * ce * dist)
  _fwd.copy(out.target).sub(out.position).normalize()
  _right.crossVectors(_fwd, Y).normalize()
  _up.crossVectors(_right, _fwd)
  const dx = -s.ox * tanX * dist
  const dy = -s.oy * tanY * dist
  out.position.addScaledVector(_right, dx).addScaledVector(_up, dy)
  out.target.addScaledVector(_right, dx).addScaledVector(_up, dy)
  out.fov = s.fov
  return dist
}

const tone = (hz: number, level: number) =>
  window.dispatchEvent(new CustomEvent('hark:tone', { detail: { hz, level } }))

export default function create(): Chapter {
  const group = new THREE.Group()
  let sand: Sand | null = null
  let plate: Plate | null = null
  let hud: Hud | null = null
  const cur: Shot = shot(0, 0, 1, 30, 0, 0)
  const pose: CameraPose = {
    position: new THREE.Vector3(),
    target: new THREE.Vector3(),
    fov: 30,
    roll: 0,
    parallax: 0,
  }
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
    const l = INTRO_END + (k + 0.75) * BEAT
    const eng = window.__hark?.engine
    if (eng) eng.gotoChapter('services', l, true)
    else window.__hark?.gotoChapter('services', l)
  }

  return {
    id: 'services',
    group,

    async init(ctx: ChapterContext) {
      ctx.stage.classList.add('is-dark')
      calm = ctx.reducedMotion
      sand = new Sand(ctx.mobile, LIGHT)
      await sand.load()
      plate = new Plate(LIGHT, ctx.mobile)
      plate.uniforms.tDensity.value = sand.density.texture
      group.add(plate.group, sand.points)

      const key = new THREE.DirectionalLight(0xffffff, 2.4)
      key.position.copy(LIGHT).multiplyScalar(6)
      group.add(key)
      const fill = new THREE.HemisphereLight(0xdfe4ea, 0x0a0a0b, 0.25)
      group.add(fill)

      hud = new Hud(ctx.stage, jumpTo)
    },

    update(local: number, frame: Frame, ctx: ChapterContext) {
      if (!sand || !plate || !hud) return
      const aspect = frame.width / Math.max(1, frame.height)
      // matches the bottom-sheet breakpoint in services.css
      const tall = aspect < 0.8 || frame.width < 768
      if (!tall) fitWide(frame.width)
      sampleShot(tall ? TALL : WIDE, local, cur)
      composePose(cur, aspect, pose)

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

      // pressure waves: in-beat from the cut, a small kick per new frequency, the final ring
      const w = u.uWave.value
      const ring = segment(local, RING, 1)
      if (local < 0.06) {
        w.set(lerp(0.02, 1.7, ease.outCubic(segment(local, 0, 0.06))), 1 - smoothstep(0.035, 0.06, local), 0.13, 0)
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
      const drive = Math.max(
        local < INTRO_END && local > 0.06 ? 0 : Math.max(kick, ring * 1.2, local < 0.06 ? 1 - local / 0.06 : 0),
        u.uTap.value.w * 0.8,
      )
      const flick = calm ? 1 : 0.92 + 0.08 * Math.sin(frame.time * 60)
      plate.led.color.copy(ledBase).multiplyScalar((local < INTRO_END ? 1.4 : 3.2) + 7 * drive * flick)

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
      const key = b.k < 0 ? -1 : b.k >= SERVICES.length ? -1 : b.t > SWITCH / FORM ? b.k : b.k - 1
      hud.update({
        introOn: local < INTRO_END + SWITCH * BEAT - 0.004,
        shown,
        key,
        hz,
        mode: modeLabel(b),
        readoutOn: local < RING + 0.02,
        drive,
      })

      /* ---------------- sound ---------------- */
      let level = 0
      if (b.k >= 0) level = 0.2 + 0.4 * kick
      if (ring > 0) level = 0.2 + 0.4 * ring
      if (b.k >= 0) level += 0.3 * tv.w
      tone(hz, Math.min(1, level))

      /* ---------------- studio + post ---------------- */
      ctx.studio.params.tone = 0.92
      ctx.studio.params.spot = 0.6
      ctx.studio.params.envIntensity = lerp(0.95, 0.55, smoothstep(SVC_END, LOGO_END, local))
      const p = ctx.post.params
      p.bloomStrength = 0.55
      p.bloomRadius = 0.4
      p.vignette = 0.34
      p.grain = 0.03
      // single-pixel grains fringe badly under aberration: keep it for the ring only
      p.aberration = 0.0003 + 0.002 * ring
      p.exposure = 1 + 0.25 * ease.inQuad(ring)

      pose.parallax = tall ? 0.05 : 0.09 * (1 - ring)
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
