import * as THREE from 'three'
import type { Chapter, ChapterContext, Frame } from '../../core/types'
import { Callout, el, reveal, rise, setRise } from '../../core/dom'
import { clamp, damp, ease, lerp, remap, segment } from '../../core/math'
import { SECTIONS, TESTIMONIALS } from '../../content'
import { Led, Ridges, type Voice } from './ridges'
import './voices.css'

/*
 * LINER NOTES (track 03, side A) — client voices as a stacked ridgeline plot
 * (the pulsar plot from Unknown Pleasures), paper-white on graphite. Each
 * testimonial is a cut on this track; its words are baked into a voiceprint
 * that the plot reshapes into with a damped-spring pressure wave running
 * front → back.
 *
 *   0.00–0.07  in-beat, straight off The Crate's spinning record: the rows
 *              arrive as that record's grooves (concentric rings seen from
 *              above, a vinyl sheen, eight cuts split by track gaps), unroll
 *              into straight lines as the camera tilts down, and spring up
 *              front → back into the plot
 *   0.00–0.08  "We listen. They talk." + eyebrow
 *   0.08–0.94  eight cuts, 01–08 (~0.107 each): credits, quote (word-rise),
 *              voice + client; the camera eases to a new angle per cut and
 *              an LED playhead rides the front ridge through the cut
 *   0.93–1.00  out-beat, into Cymatics: the peaks cancel out (a damped swing
 *              through zero), the rows peel away back → front while the camera
 *              squares up and follows what is left, then cranes down onto it:
 *              one level line edge to edge and the LED at its centre (silence),
 *              which the ripple hands to the plate seen edge-on
 *
 * The scroll position decides which card SHOULD show; the DOM (and the plot's
 * reshape) are time-driven so they always settle, and a card that has started
 * to rise is held until it has settled and dwelt, so a steady scroll never
 * cuts a quote off mid-read. Far jumps skip straight to the new position.
 */

const N = TESTIMONIALS.length
const B0 = 0.08
const B1 = 0.94
const SPAN = (B1 - B0) / N
/** scroll hysteresis around every track boundary */
const HYST = 0.007
/** a replacing card rises this long after the previous one starts to sink */
const GAP = 0.3
/** time for a card's word-rise to settle */
const SETTLE = { head: 1.0, track: 1.15 }
/** once settled, hold at least this long before stepping to the next card */
const DWELL = 0.9

const pad = (n: number) => String(n).padStart(2, '0')
const secs = (s: number) => `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`

/**
 * The whole story is one record and this chapter is one track on it, so the
 * testimonials are its cuts: 01–08.
 */
const cutNo = (i: number) => pad(i + 1)

/** In-beat: 1 = the rows are the record's grooves, 0 = straight ridgelines. */
const grooveAt = (local: number) => 1 - ease.inOutCubic(segment(local, 0.006, 0.056))
/** ...and the camera's top-down lean, which lands a touch after the unroll. */
const grooveCamAt = (local: number) => 1 - ease.inOutCubic(segment(local, 0, 0.064))
/** rows spring up front → back once the grooves are nearly straight */
const springAt = (local: number) => clamp((local - 0.02) / 0.046)
/**
 * Out-beat, into Cymatics (shared by the plot and the camera): the peaks
 * cancel, the rows peel away back → front, the camera levels and cranes down
 * onto the one line left, which stretches edge to edge and settles to silence.
 */
const OUT = {
  cancel: (l: number) => segment(l, 0.935, 0.965),
  solo: (l: number) => ease.inOutQuad(segment(l, 0.934, 0.954)),
  fold: (l: number) => ease.inOutCubic(segment(l, 0.945, 0.966)),
  level: (l: number) => ease.inOutCubic(segment(l, 0.936, 0.962)),
  crane: (l: number) => ease.inOutCubic(segment(l, 0.942, 0.975)),
  width: (l: number) => ease.inOutCubic(segment(l, 0.948, 0.988)),
}
/** the furthest row still drawn while the stack peels away (mirrors LINE_FRAG) */
const visibleBack = (l: number) => clamp(1.04 - OUT.solo(l) * 1.01, 0, 1)

/** where a keyboard stop lands for cut i: the middle of its scroll span */
const cutAnchor = (i: number) => B0 + (i + 0.5) * SPAN

/** camera angle per card: [azimuth°, elevation°]; 0 = header, 1..N tracks */
const POSES: [number, number][] = [
  [-13, 22],
  [10, 25],
  [-16, 17],
  [5, 29],
  [18, 20],
  [-7, 14],
  [14, 27],
  [-18, 22],
  [3, 24],
]

interface Card {
  root: HTMLElement
  parts: HTMLElement[]
  on: boolean
}

export default function create(): Chapter {
  const group = new THREE.Group()
  let ridges: Ridges
  let led: Led
  const cards: Card[] = []
  let list: HTMLElement
  let listItems: HTMLElement[] = []
  let playhead: Callout
  let phLabel: HTMLElement
  let durations: number[] = []

  // time-driven state
  let shown = -1
  let inAt = -10
  let pendingAt = -1
  let entered = true
  let morphFrom = 0
  let morphTo = 1
  let morphAt = -10
  let listVis = 0
  let phVis = 0
  let lastList = -2
  let lastLabel = ''

  const tmp = new THREE.Vector3()
  const res = new THREE.Vector2()
  const ndc = new THREE.Vector3()
  // camera-fit scratch
  const pts = Array.from({ length: 11 }, () => new THREE.Vector3())
  const centre = new THREE.Vector3()
  const dir = new THREE.Vector3()
  const fwd = new THREE.Vector3()
  const right = new THREE.Vector3()
  const up = new THREE.Vector3()
  const cam = new THREE.Vector3()
  const v = new THREE.Vector3()

  /* ---------------------------------------------------------------- DOM */

  function buildDom(stage: HTMLElement) {
    const col = el('div', 'vx-col', undefined, stage)

    // header card
    const head = el('div', 'vx-card vx-head', undefined, col)
    const eb = el('p', 'hud-eyebrow vx-eyebrow', undefined, head)
    const ebT = rise(el('span', '', undefined, eb), SECTIONS.voices.eyebrow)
    const m = SECTIONS.voices.title.match(/^(.*?\.)\s+(.*)$/)
    const html = m ? `${m[1]}<br><em>${m[2]}</em>` : SECTIONS.voices.title
    const title = rise(el('h2', 'hud-title vx-title', undefined, head), html)
    cards.push({ root: head, parts: [ebT, title], on: false })

    TESTIMONIALS.forEach((t, i) => {
      const root = el('article', 'vx-card vx-track', undefined, col)
      const top = el('p', 'hud-eyebrow vx-eyebrow', undefined, root)
      // vinyl notation: the chrome numbers chapters as tracks, these are its cuts
      const no = rise(el('span', '', undefined, top), `Cut ${cutNo(i)} / ${pad(N)}`)
      const bq = el('blockquote', 'vx-quote', undefined, root)
      const q = rise(el('p', 'hud-quote', undefined, bq), `“${t.quote}”`)
      el('div', 'vx-rule', undefined, root).setAttribute('aria-hidden', 'true')
      const dl = el('dl', 'vx-credits', undefined, root)
      const row1 = el('div', 'vx-credit', undefined, dl)
      const dt1 = rise(el('dt', '', undefined, row1), 'Voice')
      const dd1 = rise(el('dd', 'vx-name', undefined, row1), t.name)
      const row2 = el('div', 'vx-credit', undefined, dl)
      const dt2 = rise(el('dt', '', undefined, row2), 'Client')
      const dd2 = rise(el('dd', 'vx-co', undefined, row2), t.company)
      cards.push({ root, parts: [no, q, dt1, dd1, dt2, dd2], on: false })
    })

    // the tracklist, back-of-sleeve style
    list = el('div', 'vx-list', undefined, stage)
    list.setAttribute('aria-hidden', 'true')
    const half = Math.ceil(N / 2)
    for (let s = 0; s < 2; s++) {
      const col = el('div', 'vx-side', undefined, list)
      const first = s * half
      const last = Math.min(N, first + half)
      el('p', 'vx-side-h', `Cuts ${cutNo(first)}–${cutNo(last - 1)}`, col)
      const ol = el('ol', '', undefined, col)
      for (let i = first; i < last; i++) {
        const li = el('li', '', undefined, ol)
        el('span', 'vx-li-n', cutNo(i), li)
        el('span', 'vx-li-t', TESTIMONIALS[i].company, li)
        listItems.push(li)
      }
    }

    playhead = new Callout(stage, { side: 'right', offset: { x: 46, y: 44 } })
    playhead.root.classList.add('vx-ph')
    phLabel = playhead.label
    durations = TESTIMONIALS.map(t => Math.round(t.quote.split(/\s+/).length * 0.42 + 6))
  }

  function setCard(i: number, on: boolean) {
    const c = cards[i]
    if (c.on === on) return
    c.on = on
    c.root.classList.toggle('is-on', on)
    for (const p of c.parts) setRise(p, on)
  }

  /** Which card the scroll position asks for: -1 none (out-beat), 0 header, 1..N. */
  function wantAt(local: number) {
    let want = local >= B1 ? -1 : local < B0 ? 0 : 1 + Math.min(N - 1, Math.floor((local - B0) / SPAN))
    // hysteresis: stay on the current neighbour until clearly past the boundary
    if (shown >= 0 && want !== shown) {
      const so = shown
      const wo = want < 0 ? N + 1 : want
      if (Math.abs(wo - so) === 1) {
        const hi = Math.max(wo, so)
        const boundary = hi === N + 1 ? B1 : hi === 0 ? 0 : B0 + (hi - 1) * SPAN
        if (Math.abs(local - boundary) < HYST) want = shown
      }
    }
    return want
  }

  const order = (slot: number) => (slot < 0 ? N + 1 : slot)
  const layerFor = (slot: number) => (slot <= 0 ? 1 : 1 + slot)

  function switchTo(next: number, now: number) {
    const prevVisible = shown >= 0
    if (shown >= 0) setCard(shown, false)
    shown = next
    if (next >= 0) {
      pendingAt = now + (prevVisible ? GAP : 0)
      inAt = pendingAt
      // reshape the plot into this voice (start the wave with the switch)
      const target = layerFor(next)
      if (target !== morphTo) {
        if (now - morphAt > 0.35) morphFrom = morphTo
        morphTo = target
        morphAt = now
      }
    } else pendingAt = -1
  }

  function updateDeck(local: number, frame: Frame, calm: boolean) {
    const now = frame.time
    const want = wantAt(local)
    if (entered) {
      // fresh entry: straight to the card, the plot springs up from silence
      entered = false
      for (let i = 0; i < cards.length; i++) setCard(i, false)
      shown = -1
      morphFrom = 0
      morphTo = layerFor(want < 0 ? N : want)
      morphAt = now
      if (want >= 0) {
        shown = want
        pendingAt = now
        inAt = now
      }
    } else if (want !== shown) {
      const k = calm ? 0.5 : 1
      const age = now - inAt
      const settle = (shown === 0 ? SETTLE.head : SETTLE.track) * k
      const settled = shown < 0 || age >= settle
      const dwelled = shown < 0 || age >= settle + DWELL * k
      const far = Math.abs(order(want) - order(shown)) >= 3
      // the out-beat owns the screen: once past it, the notes simply clear
      const outro = want < 0 && (settled || local > B1 + 0.012)
      if (shown < 0 || outro || (far && settled)) switchTo(want, now)
      else if (dwelled) {
        const next = order(shown) + Math.sign(order(want) - order(shown))
        switchTo(next > N ? -1 : next, now)
      }
    }
    if (shown >= 0 && pendingAt >= 0 && now >= pendingAt) {
      setCard(shown, true)
      pendingAt = -1
    }
  }

  /* ------------------------------------------------------------- pointer */

  const ray = new THREE.Raycaster()
  const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  const hit = new THREE.Vector3()
  const lastPtr = new THREE.Vector2(9, 9)
  const pokePos = new THREE.Vector2(0, 0.5)
  let pokeAmt = 0
  let pokeTarget = 0

  function pokeUpdate(frame: Frame, ctx: ChapterContext, local: number) {
    const pk = ridges.uniforms.uPoke.value as THREE.Vector4
    const p = frame.pointerRaw
    const moved = Math.hypot(p.x - lastPtr.x, p.y - lastPtr.y)
    lastPtr.copy(p)
    let over = false
    if (!ctx.reducedMotion && local > 0.06 && local < 0.93 && moved < 1) {
      ray.setFromCamera(p, ctx.camera)
      if (ray.ray.intersectPlane(floor, hit)) {
        group.worldToLocal(hit)
        const [zb, zf] = ridges.zRange()
        const xN = hit.x / ridges.halfW
        const rN = (zf - hit.z) / Math.max(1e-3, zf - zb)
        if (Math.abs(xN) < 1 && rN > -0.05 && rN < 1.05) {
          over = true
          // glide rather than teleport, so the swell travels through the rows
          pokePos.x = damp(pokePos.x, xN, 10, frame.dt)
          pokePos.y = damp(pokePos.y, rN, 10, frame.dt)
        }
      }
    }
    // moving presses in; resting lets the membrane recover
    pokeTarget = over ? Math.min(1, pokeTarget + moved * 6) : 0
    pokeTarget = damp(pokeTarget, 0, 1.6, frame.dt)
    pokeAmt = damp(pokeAmt, pokeTarget, 6, frame.dt)
    if (pokeAmt < 0.002) pokeAmt = 0
    pk.set(pokePos.x, pokePos.y, pokeAmt, 0)
  }

  /* -------------------------------------------------------------- layout */

  /** 0 landscape .. 1 portrait */
  const portrait = (f: Frame) => clamp(remap(f.width / Math.max(1, f.height), 1.0, 0.7))

  /**
   * The screen rectangle (NDC) the plot must fit: right of the copy column in
   * landscape, the band above the notes in portrait. Mirrors voices.css.
   */
  function plotRect(f: Frame) {
    const w = f.width
    const h = f.height
    const k = portrait(f)
    const ny = (px: number) => 1 - (2 * px) / h
    const nx = (px: number) => (2 * px) / w - 1
    const gutter = clamp(0.034 * w, 16, 48)
    const top = clamp(0.105 * h, 80, 112)
    const bottom = clamp(0.095 * h, 72, 100)
    if (k > 0.5) {
      const colTop = Math.max(0.5 * h, top + 250)
      // the flat ends may bleed off the sides; the burst stays in frame
      return { x0: -1.3, x1: 1.3, y0: ny(colTop - 46), y1: ny(top + 6), fov: 34 }
    }
    const colRight = gutter + Math.min(0.4 * w, 600)
    return { x0: nx(colRight + 40), x1: 1.04, y0: ny(h - bottom - 44), y1: ny(top + 118), fov: 24 }
  }

  /** eased camera angle through the header + cut keys (centre of each cut) */
  const keys = [0.03, ...POSES.slice(1).map((_, i) => B0 + (i + 0.5) * SPAN)]
  function poseAt(local: number) {
    if (local <= keys[0]) return POSES[0]
    for (let i = 0; i < keys.length - 1; i++) {
      if (local <= keys[i + 1]) {
        const t = ease.inOutCubic((local - keys[i]) / (keys[i + 1] - keys[i]))
        return [lerp(POSES[i][0], POSES[i + 1][0], t), lerp(POSES[i][1], POSES[i + 1][1], t)] as [number, number]
      }
    }
    return POSES[POSES.length - 1]
  }

  /** screen x (px) of the front ridge's baseline at plot x, through last frame's camera */
  function frontX(x: number, camera: THREE.Camera, w: number) {
    ridges.plotPoint(x, 0, 0, ndc).applyMatrix4(group.matrixWorld).project(camera)
    return (ndc.x * 0.5 + 0.5) * w
  }

  /**
   * The playhead's travel along the front ridge: ±0.66 of the plot, trimmed
   * so the LED (and its callout elbow) never rides past the screen edge on a
   * narrow viewport, where the plot deliberately bleeds off both sides.
   */
  const span: [number, number] = [-0.66, 0.66]
  function ledSpan(f: Frame, camera: THREE.Camera) {
    const w = f.width
    const margin = clamp(0.034 * w, 16, 48) + 14
    const sL = frontX(-1, camera, w)
    const sR = frontX(1, camera, w)
    span[0] = -0.66
    span[1] = 0.66
    if (!Number.isFinite(sL + sR) || sR - sL < 1) return span
    // near-linear along the front row: one solve, then one secant correction
    const solve = (target: number) => {
      let x = -1 + (2 * (target - sL)) / (sR - sL)
      x += (2 * (target - frontX(x, camera, w))) / (sR - sL)
      return x
    }
    if (sL < margin) span[0] = Math.max(span[0], solve(margin))
    if (sR > w - margin) span[1] = Math.min(span[1], solve(w - margin))
    if (!(span[1] - span[0] > 0.1)) span[0] = span[1] = (span[0] + span[1]) / 2 || 0
    return span
  }

  /* ------------------------------------------------------------- chapter */

  return {
    id: 'voices',
    group,
    // keyboard stops (srContent: one per testimonial) land mid-cut, where the
    // plot has reshaped and the quote has risen and settled
    anchors: TESTIMONIALS.map((_, i) => cutAnchor(i)),

    init(ctx: ChapterContext) {
      ctx.stage.classList.add('is-dark')
      const voices: (Voice | null)[] = [
        null,
        { text: '', seed: 1919 },
        ...TESTIMONIALS.map(t => Ridges.voiceFrom(t.quote, t.name)),
      ]
      ridges = new Ridges(voices, ctx.mobile ? { rows: 48, samples: 200 } : { rows: 80, samples: 280 })
      group.add(ridges.group)
      led = new Led()
      group.add(led.mesh)
      buildDom(ctx.stage)
    },

    onEnter() {
      entered = true
      listVis = 0
      phVis = 0
    },

    onLeave() {
      // sink everything while hidden so a re-entry always replays the rise
      for (let i = 0; i < cards.length; i++) setCard(i, false)
      shown = -1
      pokeAmt = 0
      pokeTarget = 0
    },

    update(local, frame, ctx) {
      const calm = ctx.reducedMotion
      const u = ridges.uniforms
      const now = frame.time

      updateDeck(local, frame, calm)

      // ---- the plot
      const out = OUT.cancel(local)
      // phase cancellation: a damped swing through zero, then silence
      const cancel = Math.exp(-3 * out) * Math.cos(out * Math.PI * 2.5) * (1 - out)
      u.uTime.value = calm ? now * 0.35 : now
      u.uFlow.value = (calm ? 0.35 : 1) * (1 - out)
      u.uCalm.value = calm ? 1 : 0
      u.uIn.value = springAt(local)
      u.uGroove.value = calm ? 0 : grooveAt(local)
      u.uGain.value = cancel
      u.uA.value = morphFrom
      u.uB.value = morphTo
      u.uMorphT.value = now - morphAt
      const fold = OUT.fold(local)
      u.uDepthScale.value = lerp(1, 0.015, fold)
      u.uWScale.value = lerp(1, 1.5, OUT.width(local))
      ctx.renderer.getDrawingBufferSize(res)
      u.uRes.value.copy(res)
      const dpr = ctx.renderer.getPixelRatio()
      u.uLineW.value = (frame.mobile ? 1.15 : 1.35) * dpr
      // the last line glints into HDR as the ripple takes over
      u.uBright.value = 0.94 + ease.inQuad(segment(local, 0.955, 1)) * 1.4
      u.uFadeBack.value = lerp(0.34, 0.12, fold)
      u.uSolo.value = OUT.solo(local)

      // ---- pointer pressure: raycast onto the plot's floor, swell where it moves
      pokeUpdate(frame, ctx, local)

      // ---- studio + post
      ctx.studio.params.tone = 1
      ctx.studio.params.spot = 0.6
      ctx.studio.params.envIntensity = 0.6
      const p = ctx.post.params
      p.vignette = 0.34
      p.aberration = 0.0003
      p.grain = 0.045
      p.bloomStrength = 0.6
      p.bloomRadius = 0.4

      // ---- tracklist
      const listOn = local > 0.012 && local < 0.945
      listVis = damp(listVis, listOn ? 1 : 0, listOn ? 5 : 12, frame.dt)
      if (Math.abs(listVis - (listOn ? 1 : 0)) < 0.004) listVis = listOn ? 1 : 0
      reveal(list, listVis, 10)
      const cur = shown >= 1 ? shown - 1 : -1
      if (cur !== lastList) {
        listItems.forEach((li, i) => {
          li.classList.toggle('is-on', i === cur)
          li.classList.toggle('is-done', cur >= 0 && i < cur)
        })
        lastList = cur
      }

      // ---- LED playhead riding the front ridge through the track; at the
      // out-beat it slides to the centre of the last line and stays lit
      const x = (local - B0) / SPAN
      const ti = Math.floor(x)
      let ph = x - ti
      if (cur >= 0 && ti !== cur) ph = ti > cur ? 1 : 0
      const phOn = cur >= 0 && local > B0 && local < 0.94
      phVis = damp(phVis, phOn ? 1 : 0, phOn ? 6 : 14, frame.dt)
      if (Math.abs(phVis - (phOn ? 1 : 0)) < 0.004) phVis = phOn ? 1 : 0
      const toCentre = ease.inOutCubic(segment(local, 0.945, 0.975))
      const [pa, pb] = ledSpan(frame, ctx.camera)
      const px = lerp(lerp(pa, pb, ease.inOutQuad(clamp(ph))), 0, toCentre)
      ridges.pointAt(px, 0, tmp)
      led.mesh.position.copy(tmp)
      const endGlow = ease.inQuad(segment(local, 0.955, 1))
      const ledOn = Math.max(phVis, cur >= 0 || local >= B1 ? toCentre : 0)
      led.mesh.visible = ledOn > 0.002
      led.uniforms.uIntensity.value = ledOn * (1 + endGlow * 1.5)
      led.uniforms.uRes.value.copy(res)
      led.uniforms.uPx.value = (frame.mobile ? 16 : 18) * dpr * (1 + endGlow * 0.6)
      group.updateMatrixWorld()
      tmp.applyMatrix4(group.matrixWorld)
      ctx.camera.updateMatrixWorld()
      if (phVis > 0 && cur >= 0) {
        const d = durations[cur]
        // phones: time only (the cut number sits right below, in the eyebrow),
        // so the label fits beside the LED instead of over its own elbow
        const time = `${secs(clamp(ph) * d)} / ${secs(d)}`
        const label = frame.width < 560 ? time : `Cut ${cutNo(cur)} · ${time}`
        if (label !== lastLabel) {
          phLabel.textContent = label
          lastLabel = label
        }
      }
      playhead.offset.y = portrait(frame) > 0.5 ? 34 : 44
      playhead.update(tmp, ctx.camera, frame.width, frame.height, phVis)
    },

    camera(local, frame, out) {
      const R = plotRect(frame)
      const [az0, el0] = poseAt(local)
      const calm = frame.reducedMotion
      // in-beat: straight down onto the record, tilting to the plot's angle
      const gc = calm ? 0 : grooveCamAt(local)
      const g = calm ? 0 : grooveAt(local)
      const o = OUT.crane(local)
      // slow scroll-coupled drift so the plot is never quite still
      const drift = (local - 0.5) * 8
      // square to the line before craning down, so it never lands tilted
      const az = THREE.MathUtils.degToRad(lerp(lerp(az0 + drift, -8, gc), 0, OUT.level(local)))
      const elv = THREE.MathUtils.degToRad(lerp(lerp(el0, 66, gc), 2.5, o))
      const fov = R.fov
      const tv = Math.tan(THREE.MathUtils.degToRad(fov / 2))
      const aspect = frame.width / Math.max(1, frame.height)

      // the plot's key points for this local (mirrors the update's uniforms)
      const r = ridges
      const ds = lerp(1, 0.015, OUT.fold(local))
      const ws = lerp(1, 1.5, OUT.width(local))
      // frame only the rows still drawn: as the stack peels away the camera
      // follows what is left of it down to the last line
      const rb = visibleBack(local)
      const zf = r.depth * 0.5
      const zb = zf - r.depth * ds * rb
      // peak height: the grooves are flat until they unroll; the out-beat's
      // cancellation takes the peaks down
      const oc = OUT.cancel(local)
      const hy = 0.85 * (1 - o) * (1 - g) * Math.exp(-3 * oc) * (1 - oc)
      // the front and back rows' outline (the straight plot's corners at
      // ±0.9 or, as grooves, the rings' full extent) + the peak tops
      const xe = 0.9 + 0.1 * Math.min(1, g * 4)
      const X = [-xe, -0.5, 0, 0.5, xe]
      for (let i = 0; i < 5; i++) r.plotPoint(X[i], 0, 0, pts[i], g, ds, ws)
      for (let i = 0; i < 3; i++) r.plotPoint(X[i * 2], rb, 0, pts[5 + i], g, ds, ws)
      for (let i = 0; i < 3; i++) r.plotPoint(0, i * 0.5 * rb, hy, pts[8 + i], g, ds, ws)
      centre.set(0, r.heightScale * 0.25 * (1 - o) * (1 - g), (zf + zb) / 2)

      // target rect → centred full-width line at the out-beat; the record
      // (in-beat) stays whole inside the frame rather than bleeding off it
      const x0 = lerp(lerp(R.x0, Math.max(R.x0, -0.92), gc), -0.94, o)
      const x1 = lerp(lerp(R.x1, Math.min(R.x1, 0.92), gc), 0.94, o)
      const y0 = lerp(R.y0, -0.1, o)
      const y1 = lerp(R.y1, 0.1, o)
      const tx = (x0 + x1) / 2
      const ty = (y0 + y1) / 2

      // fit: distance so the projected bbox fits the rect, truck to centre it
      dir.set(Math.sin(az) * Math.cos(elv), Math.sin(elv), Math.cos(az) * Math.cos(elv))
      fwd.copy(dir).negate()
      right.crossVectors(fwd, THREE.Object3D.DEFAULT_UP).normalize()
      up.crossVectors(right, fwd)
      let d = 14
      let ox = 0
      let oy = 0
      for (let it = 0; it < 4; it++) {
        cam.copy(centre).addScaledVector(dir, d)
        cam.addScaledVector(right, -ox * d * tv * aspect).addScaledVector(up, -oy * d * tv)
        let mnx = Infinity
        let mxx = -Infinity
        let mny = Infinity
        let mxy = -Infinity
        for (const p of pts) {
          v.copy(p).sub(cam)
          const z = Math.max(0.1, v.dot(fwd))
          const px = v.dot(right) / (z * tv * aspect)
          const py = v.dot(up) / (z * tv)
          mnx = Math.min(mnx, px)
          mxx = Math.max(mxx, px)
          mny = Math.min(mny, py)
          mxy = Math.max(mxy, py)
        }
        const k = Math.max((mxx - mnx) / (x1 - x0), (mxy - mny) / Math.max(0.05, y1 - y0))
        ox += tx - (mnx + mxx) / 2
        oy += ty - (mny + mxy) / 2
        d *= Math.max(0.5, Math.min(2, k))
      }
      // a touch wide on the record, pushing in as it becomes the plot
      d *= 1 + gc * 0.14
      out.target.copy(centre).addScaledVector(right, -ox * d * tv * aspect).addScaledVector(up, -oy * d * tv)
      out.position.copy(out.target).addScaledVector(dir, d)
      out.fov = fov
      out.roll = 0
      out.parallax = 0.18 * (1 - o)
    },
  }
}
