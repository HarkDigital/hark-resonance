import { BRAND, type WorkItem } from '../../content'
import { logoShapes } from '../../logo/logo'
import { rng } from '../../core/math'

/*
 * Print design for THE CRATE, drawn with 2D canvas in the site's own faces:
 * a house series of 12" sleeves (catalogue HRK–001…), back covers with liner
 * notes, and centre labels. Paper grain, ring wear and the screenshot's
 * "print" are added in the sleeve shader, so these canvases are pure type
 * and layout (cheap to redraw once the web fonts land).
 */

export const FONT = {
  sans: '"Inter Tight Variable", "Inter Tight", system-ui, sans-serif',
  serif: '"Instrument Serif", Georgia, serif',
  mono: '"IBM Plex Mono", ui-monospace, monospace',
}

let fontsPromise: Promise<void> | null = null
/** Load the faces the canvases use (they aren't fetched until something asks). */
export function loadFonts(): Promise<void> {
  if (fontsPromise) return fontsPromise
  const fonts = document.fonts
  if (!fonts?.load) return (fontsPromise = Promise.resolve())
  const faces = [
    `650 40px ${FONT.sans}`,
    `500 40px ${FONT.sans}`,
    `italic 400 40px ${FONT.serif}`,
    `400 40px ${FONT.serif}`,
    `500 20px ${FONT.mono}`,
    `400 20px ${FONT.mono}`,
  ]
  const all = Promise.all(faces.map(f => fonts.load(f, 'Hark 33⅓ –').catch(() => []))).then(() => undefined)
  const timeout = new Promise<void>(r => setTimeout(r, 4000))
  fontsPromise = Promise.race([all, timeout])
  return fontsPromise
}

export interface SleeveSpec {
  index: number
  item: WorkItem
  cat: string
  /** 'PREVIEW BUILD' for staging URLs, else the host */
  src: string
  ink: boolean
  paper: string
}

export const INK = '#121214'
export const BONE = '#ede9e0'

/** Image window on the FRONT cover, in cover units (0..1000, y down). */
export const IMG = { x: 48, y: 96, w: 904, h: 565 }

type Ctx = CanvasRenderingContext2D

const track = (ctx: Ctx, px: number) => {
  ;(ctx as Ctx & { letterSpacing?: string }).letterSpacing = `${px}px`
}

/** Largest font size (<= px) at which `text` fits `maxW`. */
function fit(ctx: Ctx, text: string, font: (px: number) => string, px: number, maxW: number, min = 8) {
  let s = px
  for (let i = 0; i < 12; i++) {
    ctx.font = font(s)
    const w = ctx.measureText(text).width
    if (w <= maxW || s <= min) break
    s = Math.max(min, s * (maxW / w) * 0.995)
  }
  ctx.font = font(s)
  return s
}

function wrap(ctx: Ctx, text: string, maxW: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const t = line ? `${line} ${w}` : w
    if (ctx.measureText(t).width > maxW && line) {
      lines.push(line)
      line = w
    } else line = t
  }
  if (line) lines.push(line)
  return lines
}

let markPath: Path2D | null = null
/** The Hark mark as a Path2D, 1 unit tall, centred, y-down. */
function mark(): Path2D {
  if (markPath) return markPath
  const p = new Path2D()
  for (const s of logoShapes()) {
    const add = (pts: { x: number; y: number }[]) => {
      pts.forEach((v, i) => (i ? p.lineTo(v.x, -v.y) : p.moveTo(v.x, -v.y)))
      p.closePath()
    }
    add(s.getPoints(24))
    for (const h of s.holes) add(h.getPoints(24))
  }
  markPath = p
  return p
}

function drawMark(ctx: Ctx, cx: number, cy: number, h: number, color: string) {
  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(h, h)
  ctx.fillStyle = color
  ctx.fill(mark(), 'evenodd')
  ctx.restore()
}

const ui = (u: number) => (v: number) => v * u

/**
 * FRONT cover into the square (x0, y0, size). `image` (optional) is printed
 * straight into the canvas (the nine smaller sleeves); the featured sleeves
 * leave the window for the shader and draw a quiet placeholder there.
 */
export function drawFront(ctx: Ctx, x0: number, y0: number, size: number, s: SleeveSpec, image?: CanvasImageSource | null) {
  const u = ui(size / 1000)
  const fg = s.ink ? BONE : INK
  const muted = s.ink ? 'rgba(237,233,224,0.62)' : 'rgba(18,18,20,0.6)'
  ctx.save()
  ctx.translate(x0, y0)
  ctx.beginPath()
  ctx.rect(0, 0, size, size)
  ctx.clip()
  ctx.fillStyle = s.paper
  ctx.fillRect(0, 0, size, size)

  // top rule: catalogue, name (reads as the "spine" in the crate), source
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = fg
  track(ctx, u(2.6))
  ctx.font = `500 ${u(19)}px ${FONT.mono}`
  ctx.textAlign = 'left'
  ctx.fillText(s.cat, u(48), u(58))
  const catW = ctx.measureText(s.cat).width
  ctx.textAlign = 'right'
  ctx.fillStyle = muted
  ctx.fillText(s.src.toUpperCase(), u(952), u(58))
  const srcW = ctx.measureText(s.src.toUpperCase()).width
  ctx.textAlign = 'left'
  ctx.fillStyle = fg
  const room = u(904) - catW - srcW - u(60)
  if (room > u(120)) {
    fit(ctx, s.item.name.toUpperCase(), px => `500 ${px}px ${FONT.mono}`, u(19), room, u(12))
    ctx.fillText(s.item.name.toUpperCase(), u(48) + catW + u(30), u(58))
  }
  ctx.fillStyle = fg
  ctx.globalAlpha = 0.85
  ctx.fillRect(u(48), u(74), u(904), Math.max(1, u(2)))
  ctx.globalAlpha = 1

  // image window
  const ix = u(IMG.x)
  const iy = u(IMG.y)
  const iw = u(IMG.w)
  const ih = u(IMG.h)
  if (image) {
    ctx.save()
    ctx.globalCompositeOperation = s.ink ? 'source-over' : 'multiply'
    ctx.drawImage(image, ix, iy, iw, ih)
    ctx.restore()
  } else {
    ctx.fillStyle = s.ink ? '#1f1f22' : 'rgba(18,18,20,0.07)'
    ctx.fillRect(ix, iy, iw, ih)
    ctx.fillStyle = muted
    ctx.textAlign = 'center'
    track(ctx, u(3))
    ctx.font = `500 ${u(16)}px ${FONT.mono}`
    ctx.fillText(`${s.cat} · SIDE A`, ix + iw / 2, iy + ih / 2 + u(6))
    ctx.textAlign = 'left'
  }
  // keyline around the window
  ctx.strokeStyle = s.ink ? 'rgba(237,233,224,0.35)' : 'rgba(18,18,20,0.22)'
  ctx.lineWidth = Math.max(1, u(1.5))
  ctx.strokeRect(ix + u(0.75), iy + u(0.75), iw - u(1.5), ih - u(1.5))

  // title block
  const tracks = s.item.tags
  ctx.fillStyle = fg
  track(ctx, -u(3.2))
  const namePx = fit(ctx, s.item.name, px => `650 ${px}px ${FONT.sans}`, u(88), u(904), u(40))
  ctx.fillText(s.item.name, u(44), u(IMG.y + IMG.h) + u(30) + namePx * 0.92)
  track(ctx, 0)
  ctx.fillStyle = muted
  ctx.font = `italic 400 ${u(50)}px ${FONT.serif}`
  ctx.fillText(s.item.industry, u(48), u(IMG.y + IMG.h) + u(30) + namePx * 0.92 + u(58))

  // tracklist, right aligned above the footer
  ctx.textAlign = 'right'
  track(ctx, u(2.2))
  ctx.font = `500 ${u(17)}px ${FONT.mono}`
  ctx.fillStyle = fg
  tracks.forEach((t, i) => {
    const y = u(876) - (tracks.length - 1 - i) * u(27)
    ctx.fillText(`A${i + 1}   ${t.toUpperCase()}`, u(952), y)
  })
  ctx.textAlign = 'left'

  // footer
  ctx.globalAlpha = 0.85
  ctx.fillRect(u(48), u(906), u(904), Math.max(1, u(2)))
  ctx.globalAlpha = 1
  drawMark(ctx, u(62), u(944), u(30), fg)
  track(ctx, u(2.4))
  ctx.font = `500 ${u(16)}px ${FONT.mono}`
  ctx.fillText('HARK DIGITAL DESIGN', u(90), u(950))
  ctx.textAlign = 'right'
  ctx.fillStyle = muted
  ctx.fillText('33⅓ RPM · STEREO', u(952), u(950))
  ctx.restore()
}

/**
 * BACK cover into (x0, y0, size). Drawn rotated 180°: in a crate the flipped
 * sleeves lie forward with their backs up, so this is the way the digger
 * reads them.
 */
export function drawBack(ctx: Ctx, x0: number, y0: number, size: number, s: SleeveSpec) {
  const u = ui(size / 1000)
  const fg = s.ink ? BONE : INK
  const muted = s.ink ? 'rgba(237,233,224,0.6)' : 'rgba(18,18,20,0.58)'
  ctx.save()
  ctx.translate(x0, y0)
  ctx.beginPath()
  ctx.rect(0, 0, size, size)
  ctx.clip()
  ctx.fillStyle = s.paper
  ctx.fillRect(0, 0, size, size)
  ctx.translate(size, size)
  ctx.rotate(Math.PI)
  ctx.textBaseline = 'alphabetic'

  ctx.fillStyle = fg
  track(ctx, u(2.6))
  ctx.font = `500 ${u(19)}px ${FONT.mono}`
  ctx.fillText(`${s.cat} · SIDE A`, u(48), u(70))
  ctx.textAlign = 'right'
  ctx.fillText(s.item.industry.toUpperCase(), u(952), u(70))
  ctx.textAlign = 'left'
  ctx.fillRect(u(48), u(88), u(904), Math.max(1, u(2)))

  track(ctx, -u(4))
  const namePx = fit(ctx, s.item.name, px => `650 ${px}px ${FONT.sans}`, u(120), u(904), u(48))
  ctx.fillText(s.item.name, u(44), u(110) + namePx * 0.95)
  track(ctx, 0)

  // liner notes
  const top = u(110) + namePx * 0.95 + u(80)
  ctx.fillStyle = fg
  ctx.font = `italic 400 ${u(52)}px ${FONT.serif}`
  const lines = wrap(ctx, `“${s.item.blurb}”`, u(820))
  lines.forEach((l, i) => ctx.fillText(l, u(48), top + i * u(58)))

  // tracklist
  let y = top + lines.length * u(58) + u(70)
  track(ctx, u(2.2))
  ctx.font = `500 ${u(20)}px ${FONT.mono}`
  s.item.tags.forEach((t, i) => {
    ctx.fillStyle = fg
    ctx.fillText(`A${i + 1}`, u(48), y)
    ctx.fillText(t.toUpperCase(), u(120), y)
    ctx.fillStyle = muted
    ctx.globalAlpha = 0.5
    ctx.fillRect(u(120), y + u(12), u(560), Math.max(1, u(1)))
    ctx.globalAlpha = 1
    y += u(40)
  })

  // barcode + small print
  const rand = rng(97 + s.index * 13)
  const bx = u(702)
  const by = u(812)
  ctx.fillStyle = s.ink ? BONE : '#fbfaf6'
  ctx.fillRect(bx - u(14), by - u(14), u(264), u(140))
  ctx.fillStyle = INK
  let x = bx
  while (x < bx + u(236)) {
    const w = u(rand() < 0.5 ? 2.5 : rand() < 0.7 ? 5 : 8)
    ctx.fillRect(x, by, w, u(84))
    x += w + u(rand() < 0.5 ? 3 : 6)
  }
  track(ctx, u(4))
  ctx.font = `500 ${u(15)}px ${FONT.mono}`
  ctx.fillText(`0 26${String(100 + s.index).padStart(4, '0')} 33 1`, bx, by + u(112))

  ctx.fillStyle = muted
  track(ctx, u(2))
  ctx.font = `500 ${u(15)}px ${FONT.mono}`
  ctx.fillText('DESIGNED & BUILT BY HARK DIGITAL DESIGN', u(48), u(890))
  ctx.fillText(BRAND.locale.toUpperCase().replace(/·/g, '/'), u(48), u(918))
  ctx.fillText(s.src.toUpperCase(), u(48), u(946))
  drawMark(ctx, u(640), u(904), u(64), fg)
  ctx.restore()
}

/**
 * The centre label, into a square canvas of `size`. The record's lathe hole is
 * geometric; this just prints.
 */
export function drawLabel(
  ctx: Ctx,
  size: number,
  opts: { name: string; line2: string; cat: string; side: string; ink: boolean; paper: string; big?: boolean },
) {
  const u = ui(size / 512)
  const c = size / 2
  const fg = opts.ink ? BONE : INK
  const muted = opts.ink ? 'rgba(237,233,224,0.66)' : 'rgba(18,18,20,0.62)'
  ctx.save()
  ctx.clearRect(0, 0, size, size)
  ctx.fillStyle = opts.paper
  ctx.fillRect(0, 0, size, size)
  ctx.textBaseline = 'alphabetic'

  // printed rings
  ctx.strokeStyle = fg
  ctx.globalAlpha = 0.5
  ctx.lineWidth = u(1.2)
  ctx.beginPath()
  ctx.arc(c, c, u(214), 0, Math.PI * 2)
  ctx.stroke()
  ctx.globalAlpha = 0.28
  ctx.beginPath()
  ctx.arc(c, c, u(40), 0, Math.PI * 2)
  ctx.stroke()
  ctx.globalAlpha = 1

  // rim text
  const rim = `${BRAND.tagline.toUpperCase()} · HARK DIGITAL DESIGN · ${BRAND.locale.toUpperCase()} · `
  ctx.font = `500 ${u(13)}px ${FONT.mono}`
  track(ctx, 0)
  ctx.fillStyle = muted
  const R = u(232)
  const circ = Math.PI * 2 * R
  let a = -Math.PI / 2
  const text = rim.repeat(3)
  let used = 0
  for (const ch of text) {
    const w = ctx.measureText(ch).width + u(2.2)
    if (used + w > circ - u(6)) break
    ctx.save()
    ctx.translate(c + Math.cos(a) * R, c + Math.sin(a) * R)
    ctx.rotate(a + Math.PI / 2)
    ctx.fillText(ch, -w / 2, 0)
    ctx.restore()
    a += w / R
    used += w
  }

  ctx.fillStyle = fg
  if (opts.big) {
    drawMark(ctx, c, c - u(118), u(96), fg)
  } else {
    drawMark(ctx, c, c - u(146), u(44), fg)
    track(ctx, u(2.6))
    ctx.font = `500 ${u(12.5)}px ${FONT.mono}`
    ctx.textAlign = 'center'
    ctx.fillText('HARK DIGITAL DESIGN', c, c - u(96))
  }
  ctx.textAlign = 'center'
  track(ctx, u(2.2))
  ctx.font = `500 ${u(15)}px ${FONT.mono}`
  ctx.fillText(opts.side, c - u(110), c + u(5))
  ctx.fillText('33⅓', c + u(110), c + u(5))

  track(ctx, -u(1.2))
  const namePx = fit(ctx, opts.name, px => `650 ${px}px ${FONT.sans}`, u(opts.big ? 40 : 34), u(300), u(16))
  ctx.fillText(opts.name, c, c + u(64) + namePx * 0.35)
  track(ctx, 0)
  ctx.fillStyle = muted
  fit(ctx, opts.line2, px => `italic 400 ${px}px ${FONT.serif}`, u(25), u(280), u(12))
  ctx.fillText(opts.line2, c, c + u(104) + namePx * 0.35)
  ctx.fillStyle = fg
  track(ctx, u(2.4))
  ctx.font = `500 ${u(12)}px ${FONT.mono}`
  ctx.fillText(opts.cat, c, c + u(150))
  ctx.textAlign = 'left'
  ctx.restore()
}

/** The white paper inner sleeve (front | back halves), for the house pressing. */
export function drawInner(ctx: Ctx, w: number, h: number) {
  const size = h
  for (const half of [0, 1]) {
    const u = ui(size / 1000)
    ctx.save()
    ctx.translate(half * size, 0)
    ctx.fillStyle = '#f7f5f0'
    ctx.fillRect(0, 0, size, size)
    ctx.fillStyle = 'rgba(18,18,20,0.55)'
    ctx.textBaseline = 'alphabetic'
    track(ctx, u(3))
    ctx.font = `500 ${u(16)}px ${FONT.mono}`
    ctx.textAlign = 'center'
    ctx.fillText('HRK–000 · HOUSE PRESSING', size / 2, u(70))
    ctx.fillText('HARK DIGITAL DESIGN · PHILADELPHIA', size / 2, u(944))
    ctx.restore()
  }
  void w
}

/** Front-panel legend for the crate: silver ink on anodized black. */
export function drawPlate(ctx: Ctx, w: number, h: number) {
  ctx.clearRect(0, 0, w, h)
  const u = h / 100
  ctx.fillStyle = 'rgba(220,218,212,0.92)'
  ctx.textBaseline = 'middle'
  track(ctx, u * 3.2)
  ctx.font = `500 ${u * 22}px ${FONT.mono}`
  ctx.textAlign = 'left'
  ctx.fillText('HRK · SELECTED WORK', u * 6, h / 2)
  ctx.textAlign = 'right'
  ctx.fillText('15 × 12"', w - u * 60, h / 2)
}
