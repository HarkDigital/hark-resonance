import { MARK_PATHS, MARK_VIEWBOX, markSvg } from './mark'
import { BRAND } from '../content'
import { mountRotateGate } from './rotate'
import { createSwap } from './swap'

/*
 * Boot screen: a studio VU meter on bone paper. The Hark mark is traced in a
 * fine ink line on the meter face, the needle rides the load progress with
 * real VU ballistics (a damped spring with a little overshoot, plus a
 * "programme" wobble that grows as things come up), a 000→100 counter, and
 * studio status lines that rise in one after another.
 *
 * On finish() the needle kicks into the red (well, the ink) and the PEAK LED
 * lights, then a crisp circular iris opens from the centre with trailing
 * pressure rings, the same ripple the site uses for its chapter cuts.
 *
 * API: createLoader(root, { skip }) -> { progress(0..1), finish(): Promise<void> }
 * finish() resolves as the iris starts (so the chrome reveal overlaps it) and
 * the node removes itself once the iris is fully open. Never blocks:
 * progress is cosmetic; finish() is the authority.
 */

const MIN_DISPLAY = 1.3 // seconds before the counter may reach 100 (lets the mark finish tracing)
const STATUS_HOLD = 0.42 // seconds each status line holds before the next may rise
const SLOW_AFTER = 9 // seconds without finish() before the status admits a slow link
const STATUS: [number, string][] = [
  [0, 'Warming up the valves'],
  [0.3, 'Treating the room'],
  [0.62, 'Checking levels'],
  [0.9, 'Setting the gain'],
]
const IRIS_MS = 1050

// VU scale: position is linear in voltage, from −20 dB (0.1) to +3 dB (1.413)
const SWEEP = 46 // degrees either side of vertical
const vuAngle = (db: number) => {
  const v = Math.pow(10, db / 20)
  return -SWEEP + ((v - 0.1) / (1.4125 - 0.1)) * SWEEP * 2
}
const PIVOT = { x: 160, y: 222 }
const R = 170

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const polar = (deg: number, r: number) => {
  const a = ((deg - 90) * Math.PI) / 180
  return [PIVOT.x + Math.cos(a) * r, PIVOT.y + Math.sin(a) * r] as const
}
const f1 = (n: number) => n.toFixed(1)

function scaleSvg() {
  const parts: string[] = []
  // main arc (−20 → 0) hairline, the + zone as a solid band
  const arc = (a0: number, a1: number, r: number) => {
    const [x0, y0] = polar(a0, r)
    const [x1, y1] = polar(a1, r)
    return `M${f1(x0)},${f1(y0)} A${r},${r} 0 0 1 ${f1(x1)},${f1(y1)}`
  }
  const zero = vuAngle(0)
  parts.push(`<path class="ld-arc" d="${arc(-SWEEP, zero, R)}"/>`)
  parts.push(`<path class="ld-arc ld-arc--hot" d="${arc(zero, SWEEP, R + 3)}"/>`)
  // dB ticks + labels
  const DB: [number, boolean][] = [
    [-20, true],
    [-10, true],
    [-7, true],
    [-6, false],
    [-5, true],
    [-4, false],
    [-3, true],
    [-2, false],
    [-1, false],
    [0, true],
    [1, true],
    [2, true],
    [3, true],
  ]
  for (const [db, major] of DB) {
    const a = vuAngle(db)
    const [x0, y0] = polar(a, R)
    const [x1, y1] = polar(a, R + (major ? 11 : 6))
    parts.push(`<line class="ld-tick${db > 0 ? ' is-hot' : ''}" x1="${f1(x0)}" y1="${f1(y0)}" x2="${f1(x1)}" y2="${f1(y1)}"/>`)
    if (major) {
      const [tx, ty] = polar(a, R + 21)
      const label = db > 0 ? `+${db}` : String(Math.abs(db))
      parts.push(`<text class="ld-num${db > 0 ? ' is-hot' : ''}" x="${f1(tx)}" y="${f1(ty)}">${label}</text>`)
    }
  }
  // inner percentage scale (0 · 50 · 100 at 0 VU)
  for (let p = 0; p <= 100; p += 10) {
    const v = Math.max(0.1, p / 100)
    const a = -SWEEP + ((v - 0.1) / (1.4125 - 0.1)) * SWEEP * 2
    const [x0, y0] = polar(a, R - 6)
    const [x1, y1] = polar(a, R - (p % 50 ? 10 : 13))
    parts.push(`<line class="ld-tick ld-tick--pct" x1="${f1(x0)}" y1="${f1(y0)}" x2="${f1(x1)}" y2="${f1(y1)}"/>`)
    if (p === 50 || p === 100) {
      const [tx, ty] = polar(a, R - 22)
      parts.push(`<text class="ld-num ld-num--pct" x="${f1(tx)}" y="${f1(ty)}">${p}</text>`)
    }
  }
  parts.push(`<path class="ld-arc ld-arc--pct" d="${arc(-SWEEP, SWEEP, R - 6)}"/>`)
  return parts.join('')
}

export function createLoader(root: HTMLElement, { skip = false } = {}) {
  // phones held sideways get the rotate card from the very first frame
  mountRotateGate()
  if (skip) {
    root.remove()
    return { progress() {}, finish: () => Promise.resolve() }
  }

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const markPaths = [...MARK_PATHS.loops, MARK_PATHS.diamond]
    .map((d, i, all) => `<path class="${i === all.length - 1 ? 'ld-mk-diamond' : 'ld-mk-loop'}" style="--d:${i}" d="${d}" pathLength="1"/>`)
    .join('')

  root.innerHTML = `
  <div class="ld" data-phase="boot">
    <p class="sr-only" role="status">Loading ${BRAND.name}</p>
    <div class="ld-corner ld-corner--tl" aria-hidden="true"><span class="ld-brand-mark">${markSvg('ld-brand-svg')}</span><span>Hark Digital <em>Resonance</em></span></div>
    <div class="ld-corner ld-corner--tr" aria-hidden="true">Session 01 <b>·</b> Take 01</div>
    <div class="ld-corner ld-corner--bl" aria-hidden="true">${BRAND.locale}</div>
    <div class="ld-corner ld-corner--br" aria-hidden="true"><em>Hark</em> means listen.</div>

    <div class="ld-center" aria-hidden="true">
      <div class="ld-bezel">
        <div class="ld-face">
          <svg class="ld-scale" viewBox="0 0 320 190" preserveAspectRatio="xMidYMid meet">
            <g class="ld-scale-g">${scaleSvg()}</g>
            <text class="ld-vu" x="34" y="170">VU</text>
            <g class="ld-peak"><circle class="ld-peak-led" cx="283" cy="158" r="3.4"/><text class="ld-peak-t" x="276" y="162">PEAK</text></g>
            <svg class="ld-mark" x="136" y="92" width="48" height="48" viewBox="${MARK_VIEWBOX}">${markPaths}</svg>
            <g class="ld-needle-g"><line class="ld-needle" x1="${PIVOT.x}" y1="${PIVOT.y}" x2="${PIVOT.x}" y2="${PIVOT.y - R - 8}"/></g>
            <path class="ld-hood" d="M${PIVOT.x - 40},190 A40,40 0 0 1 ${PIVOT.x + 40},190 Z"/>
          </svg>
          <span class="ld-glass"></span>
        </div>
      </div>
      <div class="ld-readout">
        <span class="ld-led"></span>
        <span class="ld-status"></span>
        <span class="ld-count"><span class="ld-count-n">000</span></span>
      </div>
    </div>
  </div>
  <div class="ld-rings" aria-hidden="true"><i></i><i></i><i></i></div>`

  const wrap = root.querySelector<HTMLElement>('.ld')!
  const num = root.querySelector<HTMLElement>('.ld-count-n')!
  const needle = root.querySelector<SVGGElement>('.ld-needle-g')!
  const ringsEl = root.querySelector<HTMLElement>('.ld-rings')!
  const rings = [...ringsEl.querySelectorAll<HTMLElement>('i')]
  const status = createSwap(root.querySelector<HTMLElement>('.ld-status')!)

  const t0 = performance.now()
  let target = 0
  let shown = 0
  let statusIx = -1
  let statusAt = -1
  let finishing = false
  let kick = false
  let slow = false
  let raf = 0
  let last = t0
  // needle ballistics
  let ang = -SWEEP - 2
  let angV = 0

  const render = (now: number) => {
    const pct = Math.min(100, Math.floor(shown * 100 + 1e-4))
    const s = String(pct).padStart(3, '0')
    if (num.textContent !== s) num.textContent = s
    let ix = 0
    for (let i = 0; i < STATUS.length; i++) if (shown >= STATUS[i][0]) ix = i
    const sec = now / 1000
    if (!finishing && !slow && ix > statusIx && sec - statusAt > STATUS_HOLD) {
      statusIx++
      statusAt = sec
      status.set(STATUS[statusIx][1], statusIx === 0)
    }
    if (!finishing && !slow && (now - t0) / 1000 > SLOW_AFTER) {
      // never look frozen on a slow link: say so, keep the creep going
      slow = true
      status.set('Slow line, still listening')
    }
  }

  const tick = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    const elapsed = (now - t0) / 1000
    // the time cap keeps the count readable even when loading is instant
    const cap = finishing ? 1 : Math.min(0.97, elapsed / MIN_DISPLAY)
    // if loading stalls, keep a slow creep so the screen never looks frozen
    const creep = Math.min(0.9, shown + dt * 0.02)
    const goal = Math.min(cap, Math.max(target, finishing ? 1 : creep))
    const k = 1 - Math.exp(-(finishing ? 9 : 4.5) * dt)
    shown += (goal - shown) * k
    if (finishing && goal - shown < 0.004) shown = 1
    render(now)

    // the needle: signal level follows progress, with a programme wobble on top
    let aim: number
    if (kick) aim = vuAngle(2.6)
    else {
      const lvl = shown
      const db = -20 + lvl * 19.2
      const wob = reduced ? 0 : (Math.sin(elapsed * 7.3) * 0.6 + Math.sin(elapsed * 12.9 + 1) * 0.4) * (0.6 + lvl * 1.8)
      aim = vuAngle(Math.min(1, db + wob))
    }
    if (reduced) ang = aim
    else {
      // damped spring (VU ballistics: ~300 ms rise, a little overshoot)
      const stiff = 150
      const damp = 15
      angV += (stiff * (aim - ang) - damp * angV) * dt
      ang += angV * dt
      ang = Math.max(-SWEEP - 3, Math.min(SWEEP + 3, ang))
    }
    needle.setAttribute('transform', `rotate(${ang.toFixed(2)} ${PIVOT.x} ${PIVOT.y})`)
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  render(t0)

  const iris = () =>
    new Promise<void>(resolve => {
      const start = performance.now()
      const w = window.innerWidth
      const h = window.innerHeight
      const max = Math.hypot(w, h) / 2 + 40
      const step = (now: number) => {
        const x = Math.min(1, (now - start) / IRIS_MS)
        // slow bloom, then a fast sweep to the edges
        const e = x < 0.5 ? 8 * x * x * x * x : 1 - Math.pow(-2 * x + 2, 4) / 2
        const r = e * max
        const m = `radial-gradient(circle at 50% 50%, transparent ${r.toFixed(1)}px, #000 ${(r + 0.8).toFixed(1)}px)`
        wrap.style.maskImage = m
        wrap.style.webkitMaskImage = m
        rings.forEach((ring, i) => {
          const rr = Math.max(0, r * (1 - i * 0.12) - i * 10)
          ring.style.width = ring.style.height = `${(rr * 2).toFixed(1)}px`
          ring.style.opacity = rr > 1 ? String((1 - x) * (0.55 - i * 0.16)) : '0'
        })
        if (x < 1) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })

  let done: Promise<void> | null = null

  return {
    progress(p: number) {
      if (Number.isFinite(p)) target = Math.max(target, Math.min(1, Math.max(0, p)))
    },
    finish(): Promise<void> {
      if (done) return done
      done = (async () => {
        const elapsed = (performance.now() - t0) / 1000
        if (elapsed < MIN_DISPLAY) await wait((MIN_DISPLAY - elapsed) * 1000)
        finishing = true
        target = 1
        // let the counter land on 100
        const land = performance.now()
        while (shown < 1 && performance.now() - land < 900) await wait(30)
        shown = 1
        render(performance.now())
        status.set('Rolling tape')
        kick = true
        wrap.dataset.phase = 'peak'
        await wait(reduced ? 150 : 420)
        wrap.dataset.phase = 'open'
        if (reduced) {
          await wait(320)
          cancelAnimationFrame(raf)
          root.remove()
          return
        }
        const opened = iris()
        // resolve while the iris is opening so the chrome reveal overlaps it
        opened.then(() => {
          cancelAnimationFrame(raf)
          root.remove()
        })
        await wait(IRIS_MS * 0.4)
      })()
      return done
    },
  }
}
