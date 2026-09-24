import type { Engine, EngineState } from '../core/Engine'
import type { Frame } from '../core/types'
import type { Sound } from './sound'
import { BRAND, MICROCOPY } from '../content'
import { markSvg } from './mark'
import { holdInert, releaseInert } from './inert'
import { mountRotateGate } from './rotate'
import { createSwap } from './swap'

/*
 * Persistent chrome: a quiet piece of studio hardware around the story.
 *
 *   top-left      the Hark mark (its diamond is the power LED) + "Hark Digital
 *                 Resonance" + locale line in mono (→ back to start)
 *   top-right     Work · Services · Contact + "Start a project" pill
 *                 (≤ 820px: Menu → full-screen tracklist dialog)
 *   bottom-left   AUDIO slide switch with an LED ladder that meters the
 *                 actual output
 *   bottom-right  tape deck readout: reels whose tape packs wind from left to
 *                 right with the story, "Track 02 — The Crate · Work", an
 *                 odometer-style mm:ss tape counter, and a segmented tape
 *                 (one clickable segment per chapter, proportional to length)
 *
 * The chrome reads engine.studio.tone every frame and flips to light-on-dark
 * (.is-dark) over graphite chapters, with a smooth colour transition. All
 * bands respect env(safe-area-inset-*). Visitor jumps go through engine.land().
 *
 * API: createChrome(root, engine, sound) -> { update(frame, state) }
 */

const NAV = [
  { id: 'work', label: 'Work' },
  { id: 'services', label: 'Services' },
  { id: 'contact', label: 'Contact' },
]

/** Plain business names shown beside each chapter's poetic track name. */
const PLAIN: Record<string, string> = {
  hero: 'Home',
  work: 'Work',
  services: 'Services',
  shield: 'Security',
  voices: 'Clients',
  process: 'Process',
  contact: 'Contact',
}

/** The tape: one viewport of scroll is one minute of tape. */
const SECONDS_PER_VH = 60

const pad2 = (n: number) => String(n).padStart(2, '0')
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const mmss = (sec: number) => {
  const s = Math.round(sec)
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`
}
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** An odometer wheel: a strip of digits 0..base-1 plus a trailing 0 for the carry roll. */
function wheel(base: number, cls = '') {
  const el = document.createElement('span')
  el.className = `ch-wheel ${cls}`.trim()
  const strip = document.createElement('span')
  strip.className = 'ch-wheel-strip'
  strip.innerHTML = Array.from({ length: base + 1 }, (_, i) => `<span>${i % base}</span>`).join('')
  el.appendChild(strip)
  let last = -1
  return {
    el,
    set(pos: number) {
      const p = Math.round(pos * 200) / 200
      if (p === last) return
      last = p
      strip.style.transform = `translate3d(0, ${((-p / (base + 1)) * 100).toFixed(3)}%, 0)`
    },
  }
}

/** A cassette window: two tape packs that wind left → right with the story, and turning hubs. */
function reelSvg() {
  const hub = (cx: number, side: string) =>
    `<g class="ch-reel ch-reel--${side}"><circle class="ch-hub" cx="${cx}" cy="11" r="3.4"/>${[0, 60, 120, 180, 240, 300]
      .map(a => `<line class="ch-spoke" x1="${cx}" y1="8.9" x2="${cx}" y2="7.6" transform="rotate(${a} ${cx} 11)"/>`)
      .join('')}</g>`
  return `<svg class="ch-reels" viewBox="0 0 56 22" aria-hidden="true" focusable="false">
    <rect class="ch-cass" x="0.5" y="0.5" width="55" height="21" rx="4"/>
    <circle class="ch-pack ch-pack--l" cx="15" cy="11" r="7"/>
    <circle class="ch-pack ch-pack--r" cx="41" cy="11" r="5"/>
    <line class="ch-tapeline" x1="15" y1="20" x2="41" y2="20"/>
    ${hub(15, 'l')}${hub(41, 'r')}
  </svg>`
}

export function createChrome(root: HTMLElement, engine: Engine, sound: Sound) {
  const slots = engine.slots
  const total = slots.length
  const indexOf = (id: string) => slots.findIndex(s => s.def.id === id)
  const plainOf = (id: string, fallback: string) => PLAIN[id] ?? fallback
  const nav = NAV.filter(n => indexOf(n.id) >= 0)
  const lenSum = slots.reduce((a, s) => a + s.def.length, 0) || 1

  mountRotateGate()
  // dev-only handle for audio level checks in headless tests
  if (import.meta.env.DEV) (window as unknown as { __harkSound?: Sound }).__harkSound = sound

  const navLinks = nav
    .map(
      n =>
        `<a class="ch-link" href="#${n.id}" data-goto="${n.id}"><span class="ch-link-led" aria-hidden="true"></span><span class="ch-link-txt">${n.label}</span></a>`,
    )
    .join('')

  // one segment per chapter, as long as the chapter is: a tape with its tracks
  const segs = slots
    .map((s, i) => {
      const plain = plainOf(s.def.id, s.def.label)
      return `<button class="ch-seg" type="button" data-goto="${s.def.id}" data-i="${i}" style="flex:${s.def.length} 1 0" aria-label="Track ${i + 1} of ${total}: ${esc(s.def.label)} · ${esc(plain)}"><i class="ch-seg-bar"><b></b></i></button>`
    })
    .join('')

  const tracklist = slots
    .map((s, i) => {
      const plain = plainOf(s.def.id, s.def.label)
      return `<li style="--i:${i}"><a class="ch-ml" href="#${s.def.id}" data-goto="${s.def.id}" aria-label="${esc(plain)}, ${esc(s.def.label)}">
        <span class="ch-ml-n" aria-hidden="true">${pad2(i + 1)}</span>
        <span class="ch-ml-name">${esc(plain)}</span>
        <span class="ch-ml-tag" aria-hidden="true">${esc(s.def.label)}</span>
        <span class="ch-ml-dur" aria-hidden="true">${mmss(s.def.length * SECONDS_PER_VH)}</span>
      </a></li>`
    })
    .join('')

  const brandInner = `<span class="ch-mark">${markSvg('ch-mark-svg')}</span>
        <span class="ch-brand-text" aria-hidden="true">
          <span class="ch-word"><span class="ch-word-a">Hark Digital</span> <em>Resonance</em></span>
          <span class="ch-sub">${esc(BRAND.locale)}</span>
        </span>`

  root.innerHTML = `
  <div class="chrome">
    <header class="ch-top">
      <a class="ch-brand" href="#hero" data-goto="hero" aria-label="${esc(BRAND.name)}, back to start">
        ${brandInner}
      </a>
      <nav class="ch-nav" aria-label="Primary">
        <span class="ch-links">${navLinks}</span>
        <a class="ch-cta" href="#contact" data-goto="contact" data-focus><span>Start a project</span><span class="ch-cta-led" aria-hidden="true"></span></a>
      </nav>
      <button class="ch-menu-btn" type="button" aria-expanded="false" aria-controls="ch-menu" aria-haspopup="dialog">
        <span class="ch-menu-btn-txt">Menu</span><span class="ch-menu-icon" aria-hidden="true"><i></i><i></i></span>
      </button>
    </header>

    <div class="ch-menu" id="ch-menu" role="dialog" aria-modal="true" aria-labelledby="ch-menu-title" data-lenis-prevent hidden>
      <div class="ch-menu-top">
        <span class="ch-brand ch-menu-brand" aria-hidden="true">${brandInner}</span>
        <button class="ch-menu-btn ch-menu-close" type="button" aria-label="Close menu">
          <span class="ch-menu-btn-txt" aria-hidden="true">Close</span><span class="ch-menu-icon" aria-hidden="true"><i></i><i></i></span>
        </button>
      </div>
      <div class="ch-menu-body">
        <p class="ch-menu-eyebrow" id="ch-menu-title"><span class="ch-menu-eyebrow-led" aria-hidden="true"></span>Tracklist</p>
        <ol class="ch-menu-list">${tracklist}</ol>
        <div class="ch-menu-foot">
          <a class="hud-btn ch-menu-cta" href="#contact" data-goto="contact">Start a project</a>
          <a class="ch-menu-mail" href="mailto:${BRAND.email}">${BRAND.email}</a>
        </div>
      </div>
      <p class="ch-menu-side" aria-hidden="true">Side A <b>·</b> ${mmss(lenSum * SECONDS_PER_VH)}</p>
    </div>

    <div class="ch-bottom">
      <button class="ch-audio" type="button" data-sound-toggle aria-pressed="false">
        <span class="ch-switch" aria-hidden="true"><i></i></span>
        <span class="ch-audio-txt">${MICROCOPY.audio}<span class="ch-audio-colon" aria-hidden="true">:</span> <span class="ch-audio-state" aria-hidden="true">${MICROCOPY.audioOff}</span></span>
        <span class="ch-ladder" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
      </button>

      <div class="ch-deck">
        <div class="ch-readout" aria-hidden="true">
          ${reelSvg()}
          <span class="ch-trk"><span class="ch-trk-k">Track</span><span class="ch-trk-n"></span></span>
          <span class="ch-dash">—</span>
          <span class="ch-title"></span>
          <span class="ch-plain"></span>
          <span class="ch-counter"></span>
        </div>
        <nav class="ch-tape" aria-label="Chapters">${segs}</nav>
      </div>
    </div>
  </div>`

  const $ = <T extends Element = HTMLElement>(s: string) => root.querySelector<T>(s)!
  const chrome = $('.chrome')
  const soundBtn = $<HTMLButtonElement>('.ch-audio')
  const soundState = $('.ch-audio-state')
  const ladder = [...root.querySelectorAll<HTMLElement>('.ch-ladder i')]
  const menuBtn = $<HTMLButtonElement>('.ch-top .ch-menu-btn')
  const menuClose = $<HTMLButtonElement>('.ch-menu-close')
  const menu = $('.ch-menu')
  const segEls = [...root.querySelectorAll<HTMLButtonElement>('.ch-seg')]
  const navEls = [...root.querySelectorAll<HTMLAnchorElement>('.ch-link')]
  const menuLinks = [...root.querySelectorAll<HTMLAnchorElement>('.ch-ml')]
  const title = createSwap($('.ch-title'))
  const plainSw = createSwap($('.ch-plain'))
  const trkKey = $('.ch-trk-k')
  const packL = $<SVGCircleElement>('.ch-pack--l')
  const packR = $<SVGCircleElement>('.ch-pack--r')
  const reelL = $<SVGGElement>('.ch-reel--l')
  const reelR = $<SVGGElement>('.ch-reel--r')

  // odometers: the track number (discrete, CSS-eased) and the mm:ss tape counter
  const trkWheels = [wheel(10, 'is-eased'), wheel(10, 'is-eased')]
  $('.ch-trk-n').append(...trkWheels.map(w => w.el))
  const cM10 = wheel(10)
  const cM1 = wheel(10)
  const cS10 = wheel(6)
  const cS1 = wheel(10)
  const colon = document.createElement('span')
  colon.className = 'ch-colon'
  colon.textContent = ':'
  $('.ch-counter').append(cM10.el, cM1.el, colon, cS10.el, cS1.el)

  // header-first tab order: the chrome comes before the active chapter's content
  const stagesEl = document.getElementById('stages')
  if (stagesEl && stagesEl.parentNode === root.parentNode && root.compareDocumentPosition(stagesEl) & Node.DOCUMENT_POSITION_PRECEDING) {
    stagesEl.parentNode!.insertBefore(root, stagesEl)
  }

  // ---------------------------------------------------------------- navigation

  const go = (id: string) => {
    if (indexOf(id) >= 0) engine.land(id)
  }

  /**
   * Move keyboard / screen-reader focus to the destination chapter's heading
   * in the linear copy layer, so the next Tab continues from there (the way a
   * route change should behave). preventScroll keeps the page still.
   */
  const focusChapter = (id: string) => {
    const heading = document.getElementById(id)?.querySelector<HTMLElement>('h1, h2')
    if (!heading) return
    if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1
    heading.focus({ preventScroll: true })
  }

  root.addEventListener('click', e => {
    const a = (e.target as Element).closest<HTMLElement>('[data-goto]')
    if (!a || !root.contains(a)) return
    e.preventDefault()
    const id = a.dataset.goto!
    const fromMenu = menuOpen && menu.contains(a)
    if (menuOpen) closeMenu(false)
    go(id)
    // menu links always hand focus on (the menu they lived in is gone); the
    // top nav, CTA and tape segments do it for keyboard activation (click.detail 0)
    if (fromMenu || (e.detail === 0 && (a.matches('.ch-link, .ch-seg, .ch-brand') || a.hasAttribute('data-focus')))) focusChapter(id)
  })

  // tactile clicks on hover
  root.querySelectorAll<HTMLElement>('.ch-link, .ch-cta, .ch-seg, .ch-brand, .ch-audio, .ch-menu-btn, .ch-ml').forEach((node, i) => {
    node.addEventListener('pointerenter', e => {
      if ((e as PointerEvent).pointerType !== 'touch') sound.blip(i)
    })
  })

  // ---------------------------------------------------------- tape + readout

  let lastIndex = -1
  let cueIndex = -1
  const showTrack = (i: number, instant = false) => {
    const s = slots[i]
    if (!s) return
    const n = i + 1
    trkWheels[0].set(Math.floor(n / 10) % 10)
    trkWheels[1].set(n % 10)
    title.set(esc(s.def.label), instant)
    plainSw.set(`· ${esc(plainOf(s.def.id, s.def.label))}`, instant)
  }
  const cue = (i: number) => {
    cueIndex = i
    chrome.classList.add('is-cue')
    trkKey.textContent = 'Cue'
    showTrack(i)
  }
  const uncue = () => {
    if (cueIndex < 0) return
    cueIndex = -1
    chrome.classList.remove('is-cue')
    trkKey.textContent = 'Track'
    if (lastIndex >= 0) showTrack(lastIndex)
  }
  segEls.forEach((seg, i) => {
    seg.addEventListener('pointerenter', () => cue(i))
    seg.addEventListener('focus', () => cue(i))
    seg.addEventListener('pointerleave', uncue)
    seg.addEventListener('blur', uncue)
  })

  // --------------------------------------------------------------------- sound

  const syncSound = (on: boolean) => {
    soundBtn.setAttribute('aria-pressed', String(on))
    soundState.textContent = on ? MICROCOPY.audioOn : MICROCOPY.audioOff
    chrome.classList.toggle('is-live', on)
  }
  soundBtn.addEventListener('click', () => sound.toggle())
  sound.onChange.push(syncSound)
  syncSound(sound.enabled)

  // ---------------------------------------------------------------- mobile menu

  // A real modal: its own Close button lives inside the dialog (drawn exactly
  // where Menu sits), focus moves in on open and back on close, Escape closes,
  // and everything behind it is inert while it is open. It opens as an iris
  // from the Menu button, the same pressure-wave shape as the chapter cuts.
  let menuOpen = false
  let hideTimer = 0
  const focusables = () =>
    [...menu.querySelectorAll<HTMLElement>('a[href], button')].filter(el => !el.hidden && el.getClientRects().length > 0)
  const setIrisOrigin = () => {
    const r = menuBtn.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    const far = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))
    menu.style.setProperty('--mx', `${x.toFixed(1)}px`)
    menu.style.setProperty('--my', `${y.toFixed(1)}px`)
    menu.style.setProperty('--mr', `${Math.ceil(far + 8)}px`)
  }
  const openMenu = () => {
    if (menuOpen) return
    menuOpen = true
    clearTimeout(hideTimer)
    setIrisOrigin()
    menu.hidden = false
    // flush the closed state so the iris transition runs
    void menu.offsetWidth
    chrome.classList.add('is-menu')
    menuBtn.setAttribute('aria-expanded', 'true')
    holdInert('menu', [
      document.getElementById('stages'),
      document.getElementById('track'),
      document.querySelector<HTMLElement>('.skip-link'),
      $('.ch-top'),
      $('.ch-bottom'),
    ])
    engine.lenis.stop()
    menu.scrollTop = 0
    const now = menuLinks[lastIndex] ?? menuLinks[0]
    now?.focus({ preventScroll: true })
  }
  const closeMenu = (restoreFocus = true) => {
    if (!menuOpen) return
    menuOpen = false
    chrome.classList.remove('is-menu')
    menuBtn.setAttribute('aria-expanded', 'false')
    releaseInert('menu')
    engine.lenis.start()
    hideTimer = window.setTimeout(() => {
      if (!menuOpen) menu.hidden = true
    }, 700)
    if (restoreFocus) menuBtn.focus({ preventScroll: true })
  }
  menuBtn.addEventListener('click', () => (menuOpen ? closeMenu() : openMenu()))
  menuClose.addEventListener('click', () => closeMenu())
  window.addEventListener('keydown', e => {
    if (!menuOpen) return
    if (e.key === 'Escape') {
      e.preventDefault()
      closeMenu()
    } else if (e.key === 'Tab') {
      const f = focusables()
      if (!f.length) return
      const i = f.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i < 0 || i === f.length - 1 ? 0 : i + 1
      e.preventDefault()
      f[next].focus()
    }
  })
  matchMedia('(min-width: 821px)').addEventListener('change', e => {
    if (e.matches) closeMenu(false)
  })

  // -------------------------------------------------------------------- reveal

  const revealChrome = () => chrome.classList.add('is-in')
  if (document.documentElement.dataset.ready) revealChrome()
  else window.addEventListener('hark:reveal', revealChrome, { once: true })
  // safety net: never leave the chrome hidden
  window.setTimeout(revealChrome, 9000)

  // -------------------------------------------------------------------- update

  let dark = false
  let cutTimer = 0
  let lastF = -1
  let meterV = 0
  let lit = -1

  const pulseCut = () => {
    chrome.classList.remove('is-cut')
    void chrome.offsetWidth
    chrome.classList.add('is-cut')
    clearTimeout(cutTimer)
    cutTimer = window.setTimeout(() => chrome.classList.remove('is-cut'), 900)
  }

  return {
    update(frame: Frame, state: EngineState) {
      const slot = state.slots[state.index]
      if (!slot) return

      if (state.index !== lastIndex) {
        const first = lastIndex < 0
        lastIndex = state.index
        if (cueIndex < 0) showTrack(state.index, first)
        segEls.forEach((t, i) => {
          t.classList.toggle('is-active', i === state.index)
          t.classList.toggle('is-past', i < state.index)
          if (i === state.index) t.setAttribute('aria-current', 'step')
          else t.removeAttribute('aria-current')
        })
        navEls.forEach(a => {
          const on = a.dataset.goto === slot.def.id
          a.classList.toggle('is-active', on)
          if (on) a.setAttribute('aria-current', 'location')
          else a.removeAttribute('aria-current')
        })
        menuLinks.forEach((a, i) => {
          a.classList.toggle('is-now', i === state.index)
          if (i === state.index) a.setAttribute('aria-current', 'location')
          else a.removeAttribute('aria-current')
        })
        chrome.dataset.chapter = slot.def.id
        lastF = -1
        if (!first) pulseCut()
      }

      // light-on-dark over graphite chapters; the paper wash at a cut peak counts as light
      const post = engine.post
      const wash = Math.max(smooth(0.55, 1, post.transition) * 0.92, post.params.flash, post.fade)
      const dk = engine.studio.tone * (1 - wash)
      if (!dark && dk > 0.55) dark = true
      else if (dark && dk < 0.45) dark = false
      if (chrome.classList.contains('is-dark') !== dark) chrome.classList.toggle('is-dark', dark)

      // active segment fill (the LED playhead rides its end)
      const f = Math.min(1, Math.max(0, state.local))
      if (Math.abs(f - lastF) > 0.0008) {
        lastF = f
        segEls[state.index]?.style.setProperty('--f', f.toFixed(4))
      }

      // tape position → odometer counter, reels and tape packs (all derived from scroll)
      const pos = Math.min(lenSum, slot.start + f * slot.def.length)
      const secs = pos * SECONDS_PER_VH
      const n = Math.floor(secs)
      const roll = smooth(0.78, 1, secs - n)
      const d0 = n % 10
      const d1 = Math.floor(n / 10) % 6
      const d2 = Math.floor(n / 60) % 10
      const d3 = Math.floor(n / 600) % 10
      const c1 = d0 === 9 ? roll : 0
      const c2 = c1 && d1 === 5 ? roll : 0
      const c3 = c2 && d2 === 9 ? roll : 0
      cS1.set(d0 + roll)
      cS10.set(d1 + c1)
      cM1.set(d2 + c2)
      cM10.set(d3 + c3)

      const p = pos / lenSum
      packL.setAttribute('r', (9 - p * 4.6).toFixed(2))
      packR.setAttribute('r', (4.4 + p * 4.6).toFixed(2))
      // the smaller pack's hub turns faster (constant tape speed)
      const turn = secs * 9
      reelL.setAttribute('transform', `rotate(${(turn * (0.8 + p * 0.6)).toFixed(1)} 15 11)`)
      reelR.setAttribute('transform', `rotate(${(turn * (1.4 - p * 0.6)).toFixed(1)} 41 11)`)

      // LED ladder meters the real output (quick attack, slow VU-like release)
      const level = sound.enabled ? sound.meter() : 0
      meterV = level > meterV ? level : Math.max(level, meterV - frame.dt * 1.4)
      const on = sound.enabled ? Math.max(1, Math.round(meterV * 5)) : 0
      if (on !== lit) {
        lit = on
        ladder.forEach((l, i) => l.classList.toggle('is-on', i < on))
      }
    },
  }
}
