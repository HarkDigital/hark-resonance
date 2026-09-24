import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { Callout, el, rise, setRise } from '../../core/dom'
import { clamp, damp, ease, lerp, segment, smoothstep } from '../../core/math'
import { BRAND, CONTACT } from '../../content'
import {
  buildFluidGeometry,
  buildLogoSdf,
  createFloorMaterial,
  createFluidMaterial,
  createTable,
  dishWallGeometry,
  fluidUniforms,
  addBounce,
  BONE,
} from './fluid'
import './contact.css'

/*
 * SAY HELLO — the final chapter (1.5 vh, nav lands at 0.3).
 *
 * The Hark mark as FERROFLUID: glossy black magnetic liquid in a machined
 * aluminium dish with a bone ceramic well. The visitor's cursor is the magnet.
 *
 *   0.00–0.05  a drop has just landed: rings run across a round puddle while
 *              the camera cranes down from overhead (plays against the cut)
 *   0.03–0.26  the puddle flows outward into the mark
 *   0.20–0.38  the field kicks once: spikes flicker up across the whole mark,
 *              overshoot, and settle (damped spring, derived from local)
 *   0.26–1.00  hold: Rosensweig spikes rise under the magnet (pointer / last
 *              touch; a slow autonomous orbit when idle), lean toward it and
 *              trail behind it on a springy lag
 *   0.84–1.00  sign-off: the camera cranes up over the dish, "End of side B"
 */

/** logo units → world units */
const S = 2.0
const TOP = 0.036
const BOTTOM = -0.05
const DESK_FOV = 30
const PORTRAIT_FOV = 34

/** Copy text to the clipboard: async Clipboard API, then a textarea fallback. */
async function copyText(text: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* denied / unsupported: fall through */
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.setAttribute('aria-hidden', 'true')
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;'
  const active = document.activeElement as HTMLElement | null
  document.body.appendChild(ta)
  ta.select()
  ta.setSelectionRange(0, text.length)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  active?.focus?.({ preventScroll: true })
  return ok
}

const RECORD_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
  <circle cx="16" cy="16" r="15.5" class="rec-disc"/>
  <circle cx="16" cy="16" r="13" class="rec-groove"/>
  <circle cx="16" cy="16" r="10.6" class="rec-groove"/>
  <circle cx="16" cy="16" r="8.4" class="rec-groove"/>
  <circle cx="16" cy="16" r="5.6" class="rec-label"/>
  <path d="M16 1.2 A14.8 14.8 0 0 1 28.8 8.6" class="rec-sheen"/>
  <circle cx="16" cy="16" r="1.4" class="rec-led"/>
</svg>`

export default function create(): Chapter {
  const group = new THREE.Group()
  const dish = new THREE.Group()
  const u = fluidUniforms()
  let mobile = false
  let reduced = false
  let motion = 1

  // dish dimensions (logo units), set in init from the mark's real extent
  let RF = 0.62
  let R_OUT = 0.68

  let ledMat!: THREE.MeshBasicMaterial
  let table!: ReturnType<typeof createTable>

  // ---- magnet (logo-space XZ) ------------------------------------------
  const mag = new THREE.Vector2(0.3, 0)
  const magVel = new THREE.Vector2()
  const magLag = new THREE.Vector2(0.3, 0)
  const magTarget = new THREE.Vector2()
  let str = 0
  let strVel = 0
  let follow = false
  const lastRaw = new THREE.Vector2(0, 0)
  let pointerSeen = false
  let lastMove = -99
  let touchAt = -99
  const raycaster = new THREE.Raycaster()
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.03 * S)
  const hit = new THREE.Vector3()
  const anchor = new THREE.Vector3()
  let energy = 0

  // ---- HUD ---------------------------------------------------------------
  const hud = {} as {
    probe: HTMLElement
    wrap: HTMLElement
    col: HTMLElement
    eyebrow: HTMLElement
    title: HTMLElement
    body: HTMLElement
    cta: HTMLElement
    bottom: HTMLElement
    end: HTMLElement
    endTxt: HTMLElement
    endSub: HTMLElement
    copy: HTMLButtonElement
    top: HTMLButtonElement
    callout: Callout
    coK: HTMLElement
    coV: HTMLElement
    coText: string
    isEnd: boolean
  }
  /** layout, measured only when something resizes */
  const box = {
    dirty: true,
    w: 0,
    h: 0,
    safeTop: 90,
    safeBottom: 810,
    gutter: 24,
    colRight: 600,
    wrapTop: 500,
    bottomTop: 780,
    endH: 34,
    calloutW: 150,
  }

  function buildHud(stage: HTMLElement) {
    const probe = el('div', 'ct-probe', undefined, stage)
    probe.setAttribute('aria-hidden', 'true')
    const wrap = el('div', 'ct-wrap', undefined, stage)
    const col = el('div', 'ct-col', undefined, wrap)

    const eyebrow = rise(el('p', 'hud-eyebrow ct-eyebrow', undefined, col), CONTACT.eyebrow)
    const words = CONTACT.title.split(' ')
    const last = words.pop() ?? ''
    const title = rise(el('h2', 'hud-title ct-title', undefined, col), `${words.join(' ')} <em>${last}</em>`)
    const body = rise(el('p', 'hud-body ct-body', undefined, col), CONTACT.body)

    const cta = el('div', 'ct-cta ct-fade', undefined, col)
    const mail = el('a', 'hud-btn ct-mail', undefined, cta)
    mail.href = CONTACT.href
    el('span', 'ct-mail-addr', BRAND.email, mail)
    el('span', 'ct-mail-arrow', '→', mail).setAttribute('aria-hidden', 'true')

    const copyBtn = el('button', 'hud-btn hud-btn--ghost ct-copy', undefined, cta)
    copyBtn.type = 'button'
    copyBtn.setAttribute('aria-label', `Copy ${BRAND.email}`)
    const lbl = el('span', 'ct-copy-lbl', undefined, copyBtn)
    el('span', 'ct-copy-idle', 'Copy email', lbl)
    el('span', 'ct-copy-done', 'Copied', lbl)
    const status = el('span', 'sr-only', '', copyBtn)
    status.setAttribute('aria-live', 'polite')
    let resetT = 0
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(BRAND.email)
      window.clearTimeout(resetT)
      copyBtn.classList.toggle('is-copied', ok)
      copyBtn.classList.toggle('is-failed', !ok)
      status.textContent = ok ? 'Email address copied' : 'Copy failed'
      resetT = window.setTimeout(() => {
        copyBtn.classList.remove('is-copied', 'is-failed')
        status.textContent = ''
      }, 1800)
    })

    // sign-off: in the copy column on desktop, floated above the copy (under the dish) on phones
    const end = el('p', 'ct-end', undefined, col)
    end.setAttribute('aria-hidden', 'true')
    const rec = el('span', 'ct-rec', undefined, end)
    rec.innerHTML = RECORD_SVG
    const endTxt = rise(el('span', 'ct-end-txt', undefined, end), 'End of side B')
    const endSub = rise(el('span', 'ct-end-sub', undefined, end), 'Thanks for listening.')

    const bottom = el('div', 'ct-bottom ct-fade', undefined, wrap)
    const links = el('nav', 'ct-links', undefined, bottom)
    links.setAttribute('aria-label', 'Contact and site links')
    const addLink = (label: string, href: string, ext: boolean) => {
      const a = el('a', 'ct-link', label, links)
      a.href = href
      if (ext) {
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        el('span', 'ct-ext', '↗', a).setAttribute('aria-hidden', 'true')
        el('span', 'sr-only', ' (opens in a new tab)', a)
      }
      el('span', 'ct-sep', '·', links).setAttribute('aria-hidden', 'true')
    }
    addLink('Email', `mailto:${BRAND.email}`, false)
    addLink('Classic site', BRAND.classicSite, true)
    addLink('Orbit concept', BRAND.orbitSite, true)
    const top = el('button', 'ct-link ct-top', 'Back to top', links)
    top.type = 'button'
    el('span', 'ct-top-arrow', '↑', top).setAttribute('aria-hidden', 'true')
    el('span', 'ct-top-led', undefined, top).setAttribute('aria-hidden', 'true')
    top.addEventListener('click', () => window.__hark?.goto(0))

    const foot = el('p', 'ct-foot', undefined, bottom)
    el('span', 'ct-foot-name', `© 2026 ${BRAND.name}`, foot)
    el('span', 'ct-foot-sep', ' · ', foot)
    el('span', 'ct-foot-loc', BRAND.locale, foot)

    const callout = new Callout(stage, { side: 'right', offset: { x: 64, y: -58 } })
    callout.root.classList.add('ct-callout')
    callout.root.setAttribute('aria-hidden', 'true')
    callout.label.innerHTML = `<span class="ct-co-k"></span><span class="ct-co-v"></span>`
    const coK = callout.label.querySelector<HTMLElement>('.ct-co-k')!
    const coV = callout.label.querySelector<HTMLElement>('.ct-co-v')!

    Object.assign(hud, {
      probe,
      wrap,
      col,
      eyebrow,
      title,
      body,
      cta,
      bottom,
      end,
      endTxt,
      endSub,
      copy: copyBtn,
      top,
      callout,
      coK,
      coV,
      coText: '',
      isEnd: false,
    })

    const dirty = () => (box.dirty = true)
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(dirty)
      ro.observe(wrap)
      ro.observe(col)
      ro.observe(end)
      ro.observe(probe)
      new ResizeObserver(() => (box.calloutW = callout.label.offsetWidth || box.calloutW)).observe(callout.label)
    }
    window.addEventListener('resize', dirty)
    document.fonts?.ready.then(dirty).catch(() => {})
  }

  function isPortrait(frame: Frame) {
    return frame.width < 768 || frame.width / Math.max(1, frame.height) < 0.9
  }

  function measure(frame: Frame) {
    if (!hud.wrap) return
    if (!box.dirty && box.w === frame.width && box.h === frame.height) return
    box.dirty = false
    box.w = frame.width
    box.h = frame.height
    const p = hud.probe.getBoundingClientRect()
    box.safeTop = p.top
    box.safeBottom = p.bottom
    box.gutter = p.left
    const c = hud.col.getBoundingClientRect()
    box.colRight = c.right
    box.wrapTop = hud.wrap.getBoundingClientRect().top
    box.bottomTop = hud.bottom.getBoundingClientRect().top
    box.endH = hud.end.offsetHeight || 34
  }

  // ---- camera fitting ------------------------------------------------------
  const fitPts: THREE.Vector3[] = []
  const fT = new THREE.Vector3()
  const fDir = new THREE.Vector3()
  const fF = new THREE.Vector3()
  const fR = new THREE.Vector3()
  const fU = new THREE.Vector3()
  const fC = new THREE.Vector3()
  const fD = new THREE.Vector3()
  const UP = new THREE.Vector3(0, 1, 0)
  const fit = {
    target: new THREE.Vector3(),
    dist: 8,
    wpp: 0.01,
    bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
  }

  function buildFitPoints() {
    fitPts.length = 0
    const n = 20
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const x = Math.cos(a) * R_OUT * S
      const z = Math.sin(a) * R_OUT * S
      fitPts.push(new THREE.Vector3(x, TOP * S, z), new THREE.Vector3(x, BOTTOM * S, z))
    }
  }

  /**
   * Solve target + distance so the dish (fixed view direction) fills the
   * pixel rect [x0,x1]×[y0,y1]. Projection is done by hand; a few fixed-point
   * iterations converge well within a pixel.
   */
  function fitDish(elev: number, azim: number, fovDeg: number, W: number, H: number, x0: number, y0: number, x1: number, y1: number) {
    const tanH = Math.tan((fovDeg * Math.PI) / 360)
    const aspect = W / Math.max(1, H)
    fDir.set(Math.sin(azim) * Math.cos(elev), Math.sin(elev), Math.cos(azim) * Math.cos(elev))
    fF.copy(fDir).negate()
    fR.crossVectors(fF, UP).normalize()
    fU.crossVectors(fR, fF)
    fT.set(0, 0, 0)
    let dist = 8
    const rw = Math.max(40, x1 - x0)
    const rh = Math.max(40, y1 - y0)
    for (let it = 0; it < 5; it++) {
      fC.copy(fT).addScaledVector(fDir, dist)
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (const P of fitPts) {
        fD.copy(P).sub(fC)
        const cz = fD.dot(fF)
        const sx = ((fD.dot(fR) / (cz * tanH * aspect)) * 0.5 + 0.5) * W
        const sy = (1 - ((fD.dot(fU) / (cz * tanH)) * 0.5 + 0.5)) * H
        minX = Math.min(minX, sx)
        maxX = Math.max(maxX, sx)
        minY = Math.min(minY, sy)
        maxY = Math.max(maxY, sy)
      }
      const scale = Math.max((maxX - minX) / rw, (maxY - minY) / rh)
      const wpp = (2 * dist * tanH) / H
      const dx = (x0 + x1) / 2 - (minX + maxX) / 2
      const dy = (y0 + y1) / 2 - (minY + maxY) / 2
      fT.addScaledVector(fR, -dx * wpp).addScaledVector(fU, dy * wpp)
      if (Number.isFinite(scale) && scale > 0) dist *= scale
    }
    // final on-screen bounds of the dish for this pose
    fC.copy(fT).addScaledVector(fDir, dist)
    const b = fit.bounds
    b.minX = b.minY = Infinity
    b.maxX = b.maxY = -Infinity
    for (const P of fitPts) {
      fD.copy(P).sub(fC)
      const cz = fD.dot(fF)
      const sx = ((fD.dot(fR) / (cz * tanH * aspect)) * 0.5 + 0.5) * W
      const sy = (1 - ((fD.dot(fU) / (cz * tanH)) * 0.5 + 0.5)) * H
      b.minX = Math.min(b.minX, sx)
      b.maxX = Math.max(b.maxX, sx)
      b.minY = Math.min(b.minY, sy)
      b.maxY = Math.max(b.maxY, sy)
    }
    fit.wpp = (2 * dist * tanH) / H
    fit.target.copy(fT)
    fit.dist = dist
    return fit
  }

  /** where the dish should sit on screen (CSS px) */
  function dishRect(frame: Frame) {
    const W = frame.width
    const H = frame.height
    measure(frame)
    if (isPortrait(frame)) {
      const g = box.gutter
      const y0 = box.safeTop + 6
      const y1 = Math.max(y0 + 80, box.wrapTop - box.endH - 22)
      return { x0: g, x1: W - g, y0, y1 }
    }
    const x0 = Math.max(box.colRight + W * 0.05, W * 0.47)
    const x1 = W - box.gutter - W * 0.015
    const y0 = box.safeTop + 4
    const y1 = Math.max(y0 + 120, box.bottomTop - 26)
    return { x0, x1, y0, y1 }
  }

  // ---- HUD per frame ------------------------------------------------------
  const scr = new THREE.Vector3()
  function toScreen(p: THREE.Vector3, cam: THREE.Camera, frame: Frame) {
    scr.copy(p).project(cam)
    return { x: (scr.x * 0.5 + 0.5) * frame.width, y: (-scr.y * 0.5 + 0.5) * frame.height }
  }

  function updateHud(l: number, frame: Frame, ctx: ChapterContext, gate: number) {
    setRise(hud.eyebrow, l > 0.045)
    setRise(hud.title, l > 0.065)
    setRise(hud.body, l > 0.09)
    const ctaOn = l > 0.12
    if (hud.cta.classList.contains('is-in') !== ctaOn) hud.cta.classList.toggle('is-in', ctaOn)
    const botOn = l > 0.2
    if (hud.bottom.classList.contains('is-in') !== botOn) hud.bottom.classList.toggle('is-in', botOn)
    const isEnd = l > 0.84
    setRise(hud.endTxt, isEnd)
    setRise(hud.endSub, isEnd)
    if (isEnd !== hud.isEnd) {
      hud.isEnd = isEnd
      hud.end.classList.toggle('is-in', isEnd)
      hud.top.classList.toggle('is-end', isEnd)
    }

    const portrait = isPortrait(frame)

    // callout on the magnet
    anchor.set(mag.x * S, (u.uHeight.value + 0.02) * S, mag.y * S)
    const co = gate * (l > 0.24 ? 1 : 0)
    const c = hud.callout
    const a = toScreen(anchor, ctx.camera, frame)
    const lw = box.calloutW
    let side: 'left' | 'right' = 'right'
    if (portrait) side = a.x > frame.width / 2 ? 'left' : 'right'
    const ox = portrait ? 52 : 108
    if (side === 'right' && a.x + ox + 8 + lw > frame.width - box.gutter) side = 'left'
    if (side === 'left' && a.x - ox - 8 - lw < box.gutter) side = 'right'
    c.side = side
    c.offset.x = ox
    // keep the label under the header band
    c.offset.y = Math.max(portrait ? -30 : -26, box.safeTop + 14 - a.y)
    c.root.classList.toggle('is-left', side === 'left')
    let room = 1
    if (!portrait && side === 'left' && a.x - ox - 8 - lw < box.colRight + 12) room = 0
    if (portrait && a.y > box.wrapTop - box.endH - 10) room = 0
    c.update(anchor, ctx.camera, frame.width, frame.height, co * room)
    const tesla = `${(0.12 + Math.max(0, str) * 0.36).toFixed(2)} T`
    const k = portrait
      ? follow
        ? `Magnet · ${tesla}`
        : 'Tap to move the magnet'
      : follow
        ? 'Magnet · on your cursor'
        : 'Magnet · follows your cursor'
    const txt = portrait ? '' : `B ${tesla}`
    if (co * room > 0 && txt + k !== hud.coText) {
      hud.coText = txt + k
      hud.coV.textContent = txt
      hud.coV.hidden = !txt
      if (hud.coK.textContent !== k) hud.coK.textContent = k
    }
  }

  // ---- magnet -------------------------------------------------------------
  let ridge: Float32Array = new Float32Array(0)
  /** idle tour: pairs of nearby deep points on the mark (mesh xz) */
  const tour: { a: THREE.Vector2; b: THREE.Vector2 }[] = []
  const IDLE_T = 5
  /** idle clock origin, re-based on enter so a fresh visit opens on a bloom */
  let idleT0 = 0
  let idleReset = true

  function nearestRidge(x: number, z: number, out: THREE.Vector2) {
    let best = Infinity
    out.set(x, z)
    for (let i = 0; i < ridge.length; i += 2) {
      const dx = ridge[i] - x
      const dz = ridge[i + 1] - z
      const d = dx * dx + dz * dz
      if (d < best) {
        best = d
        out.set(ridge[i], ridge[i + 1])
      }
    }
    return out
  }

  function buildTour() {
    tour.length = 0
    for (let k = 0; k < 9; k++) {
      const th = k * 2.39996 + 0.7
      const r = 0.16 + 0.2 * ((k * 0.618034) % 1)
      const a = nearestRidge(Math.cos(th) * r, Math.sin(th) * r, new THREE.Vector2())
      // glide a little along the stroke while the field is up
      const tl = Math.hypot(a.x, a.y) || 1
      const b = nearestRidge(a.x - (a.y / tl) * 0.11, a.y + (a.x / tl) * 0.11, new THREE.Vector2())
      if (b.distanceTo(a) > 0.15) b.copy(a)
      tour.push({ a, b })
    }
  }

  /**
   * Idle magnet (no cursor on the dish / no recent touch): it dwells on a
   * spot of the mark and glides a little (spikes bloom with a springy
   * overshoot), then the field drops and it hops to the next spot.
   * Returns whether the field is up.
   */
  function idlePath(t: number, out: THREE.Vector2) {
    if (!tour.length) {
      out.set(0.3, 0)
      return true
    }
    const period = reduced ? IDLE_T * 1.8 : IDLE_T
    const ph = t / period
    const i = Math.floor(ph)
    const f = ph - i
    const w = tour[((i % tour.length) + tour.length) % tour.length]
    out.copy(w.a).lerp(w.b, smoothstep(0.12, 0.86, f))
    return f > 0.1 && f < 0.84
  }

  function updateMagnet(frame: Frame, ctx: ChapterContext, gate: number) {
    const raw = frame.pointerRaw
    if (raw.x !== lastRaw.x || raw.y !== lastRaw.y) {
      // (0,0) is the engine's initial value: only react once a real pointer exists
      pointerSeen = true
      lastMove = frame.time
      lastRaw.copy(raw)
    }
    follow = false
    if (pointerSeen) {
      raycaster.setFromCamera(raw, ctx.camera)
      if (raycaster.ray.intersectPlane(plane, hit)) {
        const lx = hit.x / S
        const lz = hit.z / S
        const r = Math.hypot(lx, lz)
        // touch has no hover: hold the last touch for a while, then drift again
        const held = mobile ? frame.time - Math.max(lastMove, touchAt) < 6 : true
        if (r < RF * 1.2 && held) {
          follow = true
          const k = r > RF * 0.94 ? (RF * 0.94) / r : 1
          magTarget.set(lx * k, lz * k)
        }
      }
    }
    if (idleReset && tour.length) {
      idleReset = false
      const period = reduced ? IDLE_T * 1.8 : IDLE_T
      idleT0 = frame.time - period * 0.02
      idlePath(frame.time - idleT0, mag)
      magLag.copy(mag)
      magVel.set(0, 0)
      str = 0
      strVel = 0
    }
    const idleOn = follow ? true : idlePath(frame.time - idleT0, magTarget)

    // damped spring with a little overshoot (sub-stepped for stability)
    const K = reduced ? 26 : 58
    const C = reduced ? 10.5 : 8.2
    const steps = 3
    const h = frame.dt / steps
    for (let i = 0; i < steps; i++) {
      magVel.x += (K * (magTarget.x - mag.x) - C * magVel.x) * h
      magVel.y += (K * (magTarget.y - mag.y) - C * magVel.y) * h
      mag.x += magVel.x * h
      mag.y += magVel.y * h
      // strength: springy rise when the magnet engages
      const sT = follow ? 1.1 : idleOn ? 0.9 : 0.04
      strVel += (30 * (sT - str) - 4.6 * strVel) * h
      str += strVel * h
    }
    magLag.x = damp(magLag.x, mag.x, 2.4, frame.dt)
    magLag.y = damp(magLag.y, mag.y, 2.4, frame.dt)
    // fast sweeps tear the spikes down (the fluid can't keep up)
    const speed = magVel.length()
    const s = Math.max(0, str) * (1 - clamp(speed * 0.28, 0, 0.42))
    u.uMag.value.set(mag.x, mag.y, s * gate)
    u.uMagLag.value.set(magLag.x, magLag.y, s * gate * 0.62)
    energy = s * gate
  }

  return {
    id: 'contact',
    group,

    async init(ctx) {
      mobile = ctx.mobile
      reduced = ctx.reducedMotion
      motion = reduced ? 0.35 : 1

      const sdf = await buildLogoSdf(mobile ? 256 : 384)
      u.uSdf.value = sdf.tex
      ridge = sdf.ridge
      u.uGeoMax.value = sdf.geoMax
      buildTour()
      RF = sdf.maxR + 0.075
      R_OUT = RF + 0.052
      const spacing = mobile ? 0.046 : 0.04
      u.uSpacing.value = spacing
      const geo = buildFluidGeometry(sdf, spacing, mobile ? 4 : 6, u.uPuddleR.value, u.uOrigin.value)
      const fluid = new THREE.Mesh(geo, createFluidMaterial(u))
      fluid.frustumCulled = false
      fluid.renderOrder = 2

      const floorGeo = new THREE.CircleGeometry(RF + 0.002, 128)
      floorGeo.rotateX(-Math.PI / 2)
      const floor = new THREE.Mesh(floorGeo, createFloorMaterial(u, RF - 0.042, RF - 0.014))

      const wallMat = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color('#d2d3d4'),
        metalness: 1,
        roughness: 0.24,
        clearcoat: 0.3,
        clearcoatRoughness: 0.18,
      })
      wallMat.onBeforeCompile = shader => addBounce(shader, BONE.clone().multiplyScalar(0.9), 0.4, -0.05)
      wallMat.customProgramCacheKey = () => 'hark-ferro-wall'
      const wall = new THREE.Mesh(dishWallGeometry(RF, R_OUT, TOP, BOTTOM), wallMat)

      // the magnet's status LED, set into the front of the dish
      ledMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0, 1, 0.235) })
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.0055, 16, 8), ledMat)
      led.position.set(0, (TOP + BOTTOM) / 2 + 0.004, R_OUT - 0.0005)
      const bezel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0095, 0.0095, 0.004, 24),
        new THREE.MeshPhysicalMaterial({ color: '#111113', roughness: 0.35, metalness: 0.2 }),
      )
      bezel.rotation.x = Math.PI / 2
      bezel.position.set(0, led.position.y, R_OUT - 0.0012)

      dish.add(floor, wall, bezel, led, fluid)
      dish.scale.setScalar(S)
      group.add(dish)

      table = createTable(14, R_OUT * S)
      table.mesh.position.y = BOTTOM * S
      group.add(table.mesh)

      buildFitPoints()
      buildHud(ctx.stage)
    },

    update(l, frame, ctx) {
      const time = frame.time * motion
      u.uTime.value = time
      u.uWobble.value = reduced ? 0.3 : 1

      // arrival: the drop lands, the puddle flows into the mark
      u.uMorph.value = ease.inOutCubic(segment(l, 0.03, 0.21))
      const rip = 1 - segment(l, 0, 0.16)
      u.uRipple.value.set(reduced ? 0 : 0.011 * rip * rip, l * 90 + time * 4)
      // the field kicks once, overshoots, settles
      const x = segment(l, 0.15, 0.33)
      u.uFlick.value =
        x > 0 && x < 1
          ? Math.max(0, (1 - Math.exp(-x * 45)) * Math.exp(-x * 2.6) * (1 + 0.4 * Math.sin(x * 19))) *
            (1 - smoothstep(0.72, 0.95, x)) *
            0.95
          : 0
      const gate = smoothstep(0.19, 0.27, l)
      updateMagnet(frame, ctx, gate)

      // LED: dim standby → bright when the magnet is engaged
      const led = 0.55 + energy * 3.2 + u.uFlick.value * 4
      ledMat.color.setRGB(0, led, led * 0.235)

      // sound hook: the magnet hums on C3, the fifth of the chapter's Fadd9 bed
      window.dispatchEvent(
        new CustomEvent('hark:tone', { detail: { hz: 130.81, level: clamp(energy * (follow ? 0.55 : 0.25)) } }),
      )

      const pp = ctx.post.params
      pp.bloomStrength = 0.5
      pp.bloomRadius = 0.32
      pp.vignette = 0.2
      const sp = ctx.studio.params
      sp.tone = 0
      sp.spot = 0.45
      sp.envIntensity = 1.05

      group.updateMatrixWorld()
      updateHud(l, frame, ctx, gate)
    },

    camera(l, frame, out: CameraPose) {
      const portrait = isPortrait(frame)
      const arr = ease.inOutCubic(segment(l, 0, 0.32))
      const hold = smoothstep(0.28, 0.86, l)
      const end = ease.inOutCubic(segment(l, 0.82, 1))
      const deg = Math.PI / 180
      let elev = lerp(72 * deg, 50 * deg, arr)
      elev = lerp(elev, 46 * deg, hold)
      elev = lerp(elev, (portrait ? 60 : 64) * deg, end)
      let azim = lerp(0.55, -0.16, arr) + hold * 0.26
      azim = lerp(azim, 0, end) + Math.sin(frame.time * 0.13) * 0.012 * motion
      const fov = portrait ? PORTRAIT_FOV : DESK_FOV
      const r = dishRect(frame)
      // zoom = scale the fit rect about its centre, so the dish stays centred in it
      const zoom = lerp(1.6, 1, arr) * lerp(0.95, 0.97, end)
      const cx = (r.x0 + r.x1) / 2
      const cy = (r.y0 + r.y1) / 2
      const hw = ((r.x1 - r.x0) / 2) * zoom
      const hh = ((r.y1 - r.y0) / 2) * zoom
      const f = fitDish(elev, azim, fov, frame.width, frame.height, cx - hw, cy - hh, cx + hw, cy + hh)
      // while the camera is still pushed in, slide the oversized dish off the
      // copy once the copy starts to rise (a lateral dolly, never a collision)
      const clear = smoothstep(0.02, 0.07, l)
      if (clear > 0) {
        const b = f.bounds
        if (portrait) {
          const over = Math.max(0, b.maxY - (box.wrapTop - 14))
          f.target.addScaledVector(fU, -over * clear * f.wpp)
        } else {
          const over = Math.max(0, box.colRight + 28 - b.minX)
          f.target.addScaledVector(fR, -over * clear * f.wpp)
        }
      }
      out.target.copy(f.target)
      out.position.copy(f.target).addScaledVector(fDir, f.dist)
      out.fov = fov
      out.roll = 0
      out.parallax = 0.1 * arr
    },

    onEnter(ctx) {
      box.dirty = true
      idleReset = true
      // HUD states may be stale (prewarm, or where we last left): apply this
      // frame's states instantly, animate only from the next frame on
      ctx.stage.classList.add('ct-snap')
      requestAnimationFrame(() => requestAnimationFrame(() => ctx.stage.classList.remove('ct-snap')))
    },

    onLeave() {
      window.dispatchEvent(new CustomEvent('hark:tone', { detail: { hz: 130.81, level: 0 } }))
    },

    onPointerDown(frame) {
      pointerSeen = true
      touchAt = frame.time
      lastMove = frame.time
      lastRaw.copy(frame.pointerRaw)
    },
  }
}
