import { el, rise, setRise } from '../../core/dom'
import { BRAND, SECTIONS, SERVICES } from '../../content'
import { LOGO_HZ, MODES } from './modes'

/*
 * DOM for the Cymatics chapter. Scroll decides WHAT is on screen (which
 * service, whether the intro / finale is up); CSS transitions decide HOW it
 * arrives, so wherever the scroll rests the copy is settled and exact.
 *
 *   intro    eyebrow + "Eleven ways to be heard."
 *   panel    SERVICE 07 / 11 · title (rise) · blurb · tags · 01–11 keys
 *   readout  drive frequency (sweeps with scroll) on a log fader scale
 *   finale   the Hark mark caption
 */

const pad = (n: number) => String(n).padStart(2, '0')
const fmtHz = (hz: number) => Math.round(hz).toLocaleString('en-US')
/** one serif word per title: the last one */
const titleHtml = (t: string) => {
  const i = t.lastIndexOf(' ')
  return i < 0 ? `<em>${t}</em>` : `${t.slice(0, i)} <em>${t.slice(i + 1)}</em>`
}
const setText = (node: HTMLElement, s: string) => {
  if (node.textContent !== s) node.textContent = s
}
const setOn = (node: HTMLElement, on: boolean, cls = 'is-on') => {
  if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on)
}

/** log fader scale 150 Hz – 3 kHz */
const HZ_MIN = 150
const HZ_MAX = 3000
const scaleX = (hz: number) => Math.min(1, Math.max(0, Math.log(Math.max(hz, HZ_MIN) / HZ_MIN) / Math.log(HZ_MAX / HZ_MIN)))

export interface HudState {
  introOn: boolean
  /** -1 none, 0..10 service, 11 finale */
  shown: number
  /** key lit on the 01–11 strip */
  key: number
  hz: number
  /** mode label, e.g. "2 · 5" */
  mode: string
  readoutOn: boolean
  /** 0..1 how hard the plate is being driven (LED meter) */
  drive: number
}

export class Hud {
  private intro: HTMLElement
  private introTitle: HTMLElement
  private panel: HTMLElement
  private headNo: HTMLElement
  private headHz: HTMLElement
  private items: { root: HTMLElement; title: HTMLElement }[] = []
  private keys: HTMLButtonElement[] = []
  private readout: HTMLElement
  private hzNum: HTMLElement
  private modeLbl: HTMLElement
  private needle: HTMLElement
  private finale: HTMLElement
  private finaleTitle: HTMLElement
  private lastShown = -2
  private lastHz = -1

  constructor(
    stage: HTMLElement,
    private jump: (k: number) => void,
  ) {
    /* intro */
    this.intro = el('div', 'svc-intro', undefined, stage)
    el('p', 'hud-eyebrow svc-intro-eyebrow', `${SECTIONS.services.eyebrow} · 01—${pad(SERVICES.length)}`, this.intro)
    this.introTitle = rise(el('h2', 'hud-title svc-intro-title', undefined, this.intro), 'Eleven ways to be <em>heard.</em>')

    /* service panel */
    this.panel = el('div', 'svc-panel', undefined, stage)
    const head = el('div', 'svc-head', undefined, this.panel)
    this.headNo = el('span', 'svc-no', 'Service 01', head)
    el('span', 'svc-of', `/ ${pad(SERVICES.length)}`, head)
    this.headHz = el('span', 'svc-head-hz hud-signal', '', head)
    const stack = el('div', 'svc-stack', undefined, this.panel)
    for (const s of SERVICES) {
      const root = el('div', 'svc-item', undefined, stack)
      const title = rise(el('h3', 'hud-h2 svc-title', undefined, root), titleHtml(s.title))
      el('p', 'hud-body svc-blurb', s.blurb, root)
      const tags = el('ul', 'hud-tags svc-tags', undefined, root)
      for (const t of s.tags) el('li', 'hud-tag', t, tags)
      this.items.push({ root, title })
    }
    const keys = el('div', 'svc-keys', undefined, this.panel)
    SERVICES.forEach((s, k) => {
      const b = el('button', 'svc-key', s.num, keys)
      b.type = 'button'
      b.title = s.title
      b.addEventListener('click', () => this.jump(k))
      this.keys.push(b)
    })

    /* frequency readout */
    this.readout = el('div', 'svc-readout', undefined, stage)
    el('div', 'hud-label svc-readout-lbl', 'Drive · sine', this.readout)
    const hz = el('div', 'svc-hz', undefined, this.readout)
    this.hzNum = el('span', 'svc-hz-num', '0', hz)
    el('span', 'svc-hz-unit', 'Hz', hz)
    const scale = el('div', 'svc-scale', undefined, this.readout)
    for (const m of MODES) {
      const t = el('i', 'svc-tick', undefined, scale)
      t.style.left = `${(scaleX(m.hz) * 100).toFixed(2)}%`
    }
    const lt = el('i', 'svc-tick svc-tick--logo', undefined, scale)
    lt.style.left = `${(scaleX(LOGO_HZ) * 100).toFixed(2)}%`
    // a full-width runner translated by % of its own width = % of the scale
    this.needle = el('i', 'svc-runner', undefined, scale)
    el('i', 'svc-needle', undefined, this.needle)
    const ends = el('div', 'svc-scale-ends hud-label', undefined, this.readout)
    el('span', '', '150', ends)
    el('span', '', '3k', ends)
    this.modeLbl = el('div', 'hud-label svc-mode', '', this.readout)

    /* finale */
    this.finale = el('div', 'svc-finale', undefined, stage)
    el('p', 'hud-eyebrow', `Mode 12 · ${BRAND.short}`, this.finale)
    this.finaleTitle = rise(el('h2', 'hud-h2 svc-finale-title', undefined, this.finale), 'Make the internet <em>listen.</em>')
  }

  update(s: HudState) {
    setOn(this.intro, s.introOn)
    setRise(this.introTitle, s.introOn)

    const panelOn = s.shown >= 0 && s.shown < SERVICES.length
    setOn(this.panel, panelOn)
    if (s.shown !== this.lastShown) {
      this.lastShown = s.shown
      this.items.forEach((it, k) => {
        const on = k === s.shown
        setOn(it.root, on)
        setRise(it.title, on)
      })
      if (panelOn) setText(this.headNo, `Service ${SERVICES[s.shown].num}`)
    }
    this.keys.forEach((b, k) => setOn(b, k === s.key))

    setOn(this.readout, s.readoutOn)
    if (Math.round(s.hz) !== this.lastHz) {
      this.lastHz = Math.round(s.hz)
      setText(this.hzNum, fmtHz(s.hz))
      setText(this.headHz, `${fmtHz(s.hz)} Hz`)
      this.needle.style.transform = `translate3d(${(scaleX(s.hz) * 100).toFixed(2)}%, 0, 0)`
    }
    setText(this.modeLbl, s.mode)
    this.readout.style.setProperty('--drive', s.drive.toFixed(3))

    const fin = s.shown === SERVICES.length
    setOn(this.finale, fin)
    setRise(this.finaleTitle, fin)
  }
}
