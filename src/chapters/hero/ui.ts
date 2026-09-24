import * as THREE from 'three'
import { BRAND, MICROCOPY } from '../../content'
import { Callout, el, rise, setRise } from '../../core/dom'
import { clamp } from '../../core/math'
import { T } from './shared'

const _p = new THREE.Vector3()

/**
 * A 0..1 visibility *triggered* by scroll but run on time, so a callout always
 * settles fully in or out when scrolling stops (never parked half-faded).
 */
class Gate {
  v = 0
  constructor(
    private inS = 0.45,
    private outS = 0.25,
  ) {}
  step(on: boolean, dt: number) {
    this.v = clamp(this.v + (on ? dt / this.inS : -dt / this.outS))
    return this.v * this.v * (3 - 2 * this.v)
  }
}

export interface HeroCallout {
  callout: Callout
  gate: Gate
  db: number
  shown: string
  kind: 'wedge' | 'source'
}

const WAVE_PATH = (() => {
  // two and a half cycles of a sine, 10 units per cycle, drawn as quadratic arcs
  let d = 'M0 7'
  for (let i = 0; i < 12; i++) d += ` q2.5 ${i % 2 ? 5 : -5} 5 0`
  return d
})()

/** the tagline with its last word set in the serif italic */
const TAGLINE = BRAND.tagline.replace(/(\S+)$/, '<em>$1</em>')
/** 'Hark Digital Design · Philadelphia' — a record-sleeve credit, straight from the brand */
const CREDIT = `${BRAND.name} · ${BRAND.locale.split('·')[0].trim()}`

/**
 * The hero's DOM: the room-tone statement (a sleeve note, bottom left), the
 * scroll hint with its waveform glyph, the pressure-test readout and wedge
 * callouts, and the payoff: an album cover, the tagline set as a centred
 * liner credit beneath the mark. Text reveals with the shared word-rise.
 */
export class HeroUI {
  root: HTMLDivElement
  private manifesto: HTMLElement
  private manifestoText: HTMLElement
  private hint: HTMLElement
  private meter: HTMLElement
  private meterSegs: HTMLElement[] = []
  private meterVal: HTMLElement
  private meterPulse: HTMLElement
  private payoff: HTMLElement
  private scrim: HTMLElement
  private sleeve: HTMLElement
  private credit: HTMLElement
  private creditText: HTMLElement
  private title: HTMLElement
  private ctas: HTMLElement
  callouts: HeroCallout[] = []
  private probe: HTMLElement
  private safe = { top: 96, bottom: 90, side: 24 }
  private lastSegs = -1
  private lastPulse = ''
  private lastDb = ''

  constructor(stage: HTMLElement, mobile: boolean) {
    this.root = el('div', 'hero-root', undefined, stage)
    this.probe = el('div', 'hero-safe-probe', undefined, this.root)
    this.probe.setAttribute('aria-hidden', 'true')
    requestAnimationFrame(() => this.measureSafe())
    window.addEventListener('resize', () => this.measureSafe())

    // --- room tone: the sleeve note (bottom left on wide screens, top on phones) ---
    this.manifesto = el('div', 'hero-manifesto', undefined, this.root)
    el('p', 'hud-eyebrow hero-fade', MICROCOPY.signalEyebrow, this.manifesto)
    this.manifestoText = rise(el('p', 'hero-manifesto__text', undefined, this.manifesto), BRAND.manifesto)

    // --- scroll hint (bottom centre) ---
    this.hint = el('div', 'hero-hint hero-fade', undefined, this.root)
    const glyph = el('span', 'hero-hint__glyph', undefined, this.hint)
    glyph.innerHTML = `<svg viewBox="0 0 30 14" aria-hidden="true"><path d="${WAVE_PATH}"/></svg>`
    el('span', 'hud-label hero-hint__label', MICROCOPY.scrollHint, this.hint)

    // --- pressure readout (bottom left, sound phase) ---
    this.meter = el('div', 'hero-meter hero-fade', undefined, this.root)
    const head = el('div', 'hero-meter__head', undefined, this.meter)
    el('span', 'hud-label', 'Pressure test', head)
    this.meterPulse = el('span', 'hud-label hero-meter__pulse', 'Pulse 00', head)
    const bar = el('div', 'hero-meter__bar', undefined, this.meter)
    const n = mobile ? 18 : 24
    for (let i = 0; i < n; i++) {
      const s = el('i', i >= n - 3 ? 'is-peak' : '', undefined, bar)
      this.meterSegs.push(s)
    }
    const foot = el('div', 'hero-meter__foot', undefined, this.meter)
    this.meterVal = el('span', 'hero-meter__val', '−∞ dB', foot)
    el('span', 'hud-label', 'Anechoic · 0.00 s RT60', foot)

    // --- payoff: an album cover. The mark is the art; the tagline is its liner credit ---
    this.scrim = el('div', 'hero-scrim', undefined, this.root)
    // crop marks at the corners of a square sleeve, between the chrome bands
    this.sleeve = el('div', 'hero-sleeve', undefined, this.root)
    this.payoff = el('div', 'hero-payoff', undefined, this.root)
    this.credit = el('p', 'hud-label hero-credit', undefined, this.payoff)
    this.creditText = rise(el('span', 'hero-credit__text', undefined, this.credit), CREDIT)
    this.title = rise(el('h2', 'hud-title hero-title', undefined, this.payoff), TAGLINE)
    this.ctas = el('div', 'hero-ctas hero-fade', undefined, this.payoff)
    const work = el('button', 'hud-btn', 'See the work', this.ctas)
    work.type = 'button'
    work.addEventListener('click', () => window.__hark?.land('work'))
    const contact = el('a', 'hero-link', 'Start a project', this.ctas)
    contact.href = '#contact'
    contact.addEventListener('click', e => {
      e.preventDefault()
      window.__hark?.land('contact')
    })
  }

  addCallouts(count: number, dbs: number[]) {
    for (let i = 0; i < count; i++) {
      const left = i === 1
      const callout = new Callout(this.root, { side: left ? 'left' : 'right', offset: { x: 70, y: i === 0 ? 46 : -54 } })
      callout.root.classList.add('hero-callout')
      callout.label.textContent = `${fmtDb(dbs[i])} · ABSORBED`
      this.callouts.push({ callout, gate: new Gate(), db: dbs[i], shown: '', kind: 'wedge' })
    }
    const src = new Callout(this.root, { side: 'right', offset: { x: 96, y: -78 } })
    src.root.classList.add('hero-callout', 'hero-callout--source')
    src.label.textContent = 'SOURCE · LED 01'
    this.callouts.push({ callout: src, gate: new Gate(), db: 0, shown: '', kind: 'source' })
  }

  /** anchors: world positions per callout (same order as addCallouts); press: live pressure per wedge */
  updateCallouts(
    on: boolean,
    anchors: THREE.Vector3[],
    press: number[],
    camera: THREE.Camera,
    w: number,
    h: number,
    dt: number,
  ) {
    this.callouts.forEach((c, i) => {
      // only while the dot *and* its label sit inside the safe area (the chrome owns the bands)
      _p.copy(anchors[i]).project(camera)
      const x = (_p.x * 0.5 + 0.5) * w
      const y = (-_p.y * 0.5 + 0.5) * h
      const ly = y + c.callout.offset.y
      const m = this.safe
      const inside =
        _p.z < 1 &&
        Math.min(y, ly) > m.top + 14 &&
        Math.max(y, ly) < h - m.bottom - 18 &&
        x > m.side &&
        x < w - m.side
      const v = c.gate.step(on && inside, dt)
      c.callout.update(anchors[i], camera, w, h, v)
      if (v > 0 && c.kind === 'wedge') {
        const txt = `${fmtDb(c.db + Math.abs(press[i] ?? 0) * 11)} · ABSORBED`
        if (txt !== c.shown) {
          c.shown = txt
          c.callout.label.textContent = txt
        }
      }
    })
  }

  /** where the mark's lower edge sits (0..1 of screen height) in the settled payoff frame */
  setCaptionTop(f: number) {
    this.root.style.setProperty('--cap-top', `${(f * 100).toFixed(2)}%`)
  }

  /** the chrome's safe bands, measured once and on resize (never per frame) */
  private measureSafe() {
    const r = this.probe.getBoundingClientRect()
    const host = this.root.getBoundingClientRect()
    this.safe.top = r.top - host.top
    this.safe.bottom = host.bottom - r.bottom
    this.safe.side = r.left - host.left
  }

  update(p: {
    local: number
    introT: number
    level: number
    pulse: number
    sound: boolean
    reduced: boolean
  }) {
    const { local, introT } = p
    const ready = introT > 0.9
    const quiet = ready && local < 0.105
    this.manifesto.classList.toggle('is-in', quiet)
    setRise(this.manifestoText, quiet)
    this.hint.classList.toggle('is-in', ready && local < 0.07)

    this.meter.classList.toggle('is-in', p.sound)
    if (p.sound) {
      const n = this.meterSegs.length
      const lit = Math.round(clamp(p.level) * n)
      if (lit !== this.lastSegs) {
        this.lastSegs = lit
        this.meterSegs.forEach((s, i) => s.classList.toggle('is-on', i < lit))
      }
      const pulse = `Pulse ${String(((p.pulse % 100) + 100) % 100).padStart(2, '0')}`
      if (pulse !== this.lastPulse) this.meterPulse.textContent = this.lastPulse = pulse
      const db = p.level < 0.02 ? '−∞ dB' : `${fmtDb(-48 + p.level * 44)}`
      if (db !== this.lastDb) this.meterVal.textContent = this.lastDb = db
    }

    const pay = local > T.captionA && local < T.captionB
    this.credit.classList.toggle('is-in', pay)
    setRise(this.creditText, pay)
    this.scrim.classList.toggle('is-in', pay)
    this.sleeve.classList.toggle('is-in', pay)
    setRise(this.title, pay)
    this.ctas.classList.toggle('is-in', pay)
  }
}

function fmtDb(v: number) {
  const r = Math.round(v)
  return `${r < 0 ? '−' : '+'}${Math.abs(r)} dB`
}
