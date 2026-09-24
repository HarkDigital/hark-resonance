import { el, rise, setRise } from '../../core/dom'
import { PROCESS, STATS } from '../../content'

/*
 * The Desk's HUD: headline, a four-row channel list (the process) whose
 * active row opens to show its text, and a three-up stats row that lines up
 * under the bridge readouts.
 */

/** The three stats the bridge shows, in bridge order. */
export const DESK_STATS = ['10 years', '$1M+', '15'].map(v => STATS.find(s => s.value === v)!).filter(Boolean)

export class DeskHud {
  root: HTMLElement
  /** paper light-falloff behind the copy column (opacity driven per frame) */
  scrim: HTMLElement
  private eyebrow: HTMLElement
  private title: HTMLElement
  private list: HTMLElement
  private rows: { row: HTMLElement; title: HTMLElement; body: HTMLElement; db: HTMLElement; last: string }[] = []
  private stats: HTMLElement
  private statsEyebrow: HTMLElement
  private statItems: { v: HTMLElement; l: HTMLElement }[] = []
  private lastBox = ''
  /** free vertical band between the headline and the list, in px (portrait framing) */
  band = { top: 0, bottom: 0, statsTop: 0, headTop: 0 }

  constructor(stage: HTMLElement) {
    this.root = el('div', 'pr', undefined, stage)
    this.scrim = el('div', 'pr-scrim', undefined, this.root)

    const head = el('div', 'pr-head', undefined, this.root)
    this.eyebrow = el('p', 'hud-eyebrow pr-eyebrow', 'Process', head)
    this.title = rise(el('h2', 'hud-h2 pr-title', undefined, head), 'How we <em>work.</em>')

    this.list = el('ol', 'pr-list', undefined, this.root)
    PROCESS.forEach((p, i) => {
      const row = el('li', 'pr-row', undefined, this.list)
      const line = el('div', 'pr-row-line', undefined, row)
      el('span', 'pr-led', undefined, line)
      el('span', 'pr-num', String(i + 1).padStart(2, '0'), line)
      const title = rise(el('span', 'pr-row-title', undefined, line), p.title)
      const db = el('span', 'pr-db', '−∞', line)
      const wrap = el('div', 'pr-row-body', undefined, row)
      const body = rise(el('p', 'hud-body pr-body', undefined, el('div', 'pr-row-inner', undefined, wrap)), p.text)
      this.rows.push({ row, title, body, db, last: '' })
    })

    // keep the paper falloff and the portrait framing locked to where the copy actually is
    const measure = () => {
      const h = this.root.clientHeight || window.innerHeight
      const top = head.offsetTop + head.offsetHeight
      const bottom = this.list.offsetTop
      if (!h || !Number.isFinite(top + bottom)) return
      this.band.top = top
      this.band.bottom = bottom
      this.band.headTop = head.offsetTop
      this.band.statsTop = this.stats ? this.stats.offsetTop : 0
      this.root.style.setProperty('--pr-head-b', `${Math.round(top)}px`)
      this.root.style.setProperty('--pr-list-b', `${Math.round(h - bottom)}px`)
    }
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure)
      ro.observe(head)
      ro.observe(this.list)
      ro.observe(this.root)
      queueMicrotask(() => this.stats && ro.observe(this.stats))
    }
    requestAnimationFrame(measure)

    this.stats = el('div', 'pr-stats', undefined, this.root)
    this.statsEyebrow = el('p', 'hud-eyebrow pr-stats-eyebrow', 'Levels', this.stats)
    const grid = el('div', 'pr-stats-grid', undefined, this.stats)
    DESK_STATS.forEach(s => {
      const item = el('div', 'pr-stat', undefined, grid)
      const v = rise(el('p', 'pr-stat-v', undefined, item), s.value)
      const l = rise(el('p', 'pr-stat-l', undefined, item), s.label)
      this.statItems.push({ v, l })
    })
  }

  /**
   * @param step active process row (-1 none) @param live rows whose faders are up
   * @param head title visible @param list list visible @param stats per-stat visibility
   */
  update(o: { head: boolean; list: boolean; step: number; live: boolean[]; db: number[]; stats: boolean[]; statsOn: boolean }) {
    setRise(this.title, o.head)
    this.eyebrow.classList.toggle('is-in', o.head)
    this.list.classList.toggle('is-in', o.list)
    this.rows.forEach((r, i) => {
      const active = o.list && o.step === i
      r.row.classList.toggle('is-active', active)
      r.row.classList.toggle('is-live', o.live[i])
      setRise(r.title, o.list)
      setRise(r.body, active)
      const d = o.db[i]
      const txt = d === -Infinity ? '−∞' : `${d >= 0.05 ? '+' : d <= -0.05 ? '−' : ''}${Math.abs(d).toFixed(1)}`
      if (txt !== r.last) {
        r.db.textContent = txt
        r.last = txt
      }
    })
    this.stats.classList.toggle('is-in', o.statsOn)
    this.statsEyebrow.classList.toggle('is-in', o.statsOn)
    this.statItems.forEach((s, i) => {
      setRise(s.v, o.stats[i])
      setRise(s.l, o.stats[i])
    })
  }

  /** Line the stats grid up under the bridge readouts (desktop). */
  placeStats(left: number, right: number, top: number, portrait: boolean) {
    const key = portrait ? 'p' : `${Math.round(left)}|${Math.round(right)}|${Math.round(top)}`
    if (key === this.lastBox) return
    this.lastBox = key
    const s = this.stats.style
    if (portrait) {
      s.left = s.width = s.top = ''
      return
    }
    s.left = `${left}px`
    s.width = `${Math.max(0, right - left)}px`
    s.top = Number.isFinite(top) ? `${top}px` : ''
  }
}
