import { CONCEPT_TAG, WORDMARK, markSvg } from './mark'
import { holdInert, releaseInert } from './inert'
import { holdScene, releaseScene } from './scene'

/*
 * Phone-landscape gate. The story is composed for portrait on phones, so a
 * short, touch-first landscape viewport gets a full-screen paper card asking
 * for portrait instead of a cramped scene. Tablets and laptops in landscape
 * are taller than 500px and never see it.
 *
 * Visibility is pure CSS (the same query, in ui.css) so it is right on the
 * very first paint; JS makes the rest of the page inert while it shows,
 * announces it to screen readers, and pauses the (fully hidden) scene so a
 * phone read in landscape is not rendering WebGL nobody can see.
 */

export const ROTATE_QUERY = '(orientation: landscape) and (max-height: 500px) and (pointer: coarse)'

let gate: { el: HTMLElement; mq: MediaQueryList; sync: () => void } | null = null

export function mountRotateGate() {
  if (gate || typeof matchMedia === 'undefined') return
  const el = document.createElement('div')
  el.className = 'rot'
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-modal', 'true')
  el.setAttribute('aria-labelledby', 'rot-title')
  el.setAttribute('aria-describedby', 'rot-sub')
  el.tabIndex = -1
  el.innerHTML = `
    <p class="rot-brand" aria-hidden="true"><span class="rot-brand-mark">${markSvg('rot-brand-svg')}</span><span class="rot-brand-text"><span class="rot-word">${WORDMARK}</span><span class="rot-tag">${CONCEPT_TAG}</span></span></p>
    <div class="rot-body">
      <div class="rot-icon" aria-hidden="true">
        <span class="rot-ring"></span><span class="rot-ring rot-ring--2"></span>
        <span class="rot-phone"><span class="rot-screen">${markSvg('rot-mark')}</span><span class="rot-led"></span></span>
      </div>
      <div class="rot-text">
        <p class="rot-eyebrow" aria-hidden="true">Orientation</p>
        <h2 class="rot-title" id="rot-title">Turn your phone <em>upright.</em></h2>
        <p class="rot-sub" id="rot-sub">The story is mixed for portrait.</p>
      </div>
    </div>
    <p class="rot-foot" aria-hidden="true"><span>Landscape</span><i></i><span>Portrait</span></p>
    <p class="sr-only" aria-live="assertive" data-rot-live></p>`
  document.body.appendChild(el)

  const live = el.querySelector<HTMLElement>('[data-rot-live]')!
  const mq = matchMedia(ROTATE_QUERY)
  let on = false
  const sync = () => {
    if (mq.matches === on) return
    on = mq.matches
    el.classList.toggle('is-on', on)
    if (on) {
      holdScene('rotate')
      holdInert('rotate', ['chrome', 'stages', 'track', 'loader'].map(id => document.getElementById(id)))
      holdInert('rotate', [document.querySelector<HTMLElement>('.skip-link')])
      // focus is now stranded in an inert layer (or on <body>): bring it in
      el.focus({ preventScroll: true })
      // a live region only speaks when its text changes after it is shown
      requestAnimationFrame(() => (live.textContent = 'Turn your phone upright. The story is mixed for portrait.'))
    } else {
      releaseInert('rotate')
      releaseScene('rotate')
      live.textContent = ''
    }
  }
  mq.addEventListener?.('change', sync)
  sync()
  gate = { el, mq, sync }
}

/** The plain HTML fallback reads fine in any orientation. */
export function unmountRotateGate() {
  if (!gate) return
  gate.mq.removeEventListener?.('change', gate.sync)
  gate.el.remove()
  releaseInert('rotate')
  releaseScene('rotate')
  gate = null
}
