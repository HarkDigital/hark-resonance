import * as THREE from 'three'
import { FACE, KNOBS, BNC, SCREEN, SOFTKEYS, BUTTONS, POWER } from './layout'

/*
 * Printed artwork for the scope, drawn once into canvases:
 *  - faceplate: graphite powder coat with light silk-screen (dial scales,
 *    labels, channel colour marks, the Hark badge)
 *  - screen overlay: dim phosphor readouts along the top and the soft-key
 *    menu along the bottom of the CRT
 * Both draw immediately with whatever faces are available and redraw once
 * the web fonts arrive (never blocks init).
 */

const PPU = 512 // faceplate pixels per world unit

const INK = '#e4ddcf'
const INK_DIM = 'rgba(228, 221, 207, 0.62)'
const CH1 = '#e4694c'
const CH2 = '#5cc392'
const MONO = '"IBM Plex Mono", ui-monospace, monospace'
const SANS = '"Inter Tight", "Helvetica Neue", Arial, sans-serif'

function faceSize() {
  return { w: Math.round(FACE.w * PPU), h: Math.round(FACE.h * PPU) }
}

/** world (x, y) on the faceplate → canvas px */
const X = (x: number) => (x - FACE.x0) * PPU
const Y = (y: number) => (FACE.y0 + FACE.h - y) * PPU

function rrect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath()
  g.moveTo(x + r, y)
  g.arcTo(x + w, y, x + w, y + h, r)
  g.arcTo(x + w, y + h, x, y + h, r)
  g.arcTo(x, y + h, x, y, r)
  g.arcTo(x, y, x + w, y, r)
  g.closePath()
}

function text(g: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, opts: { font?: string; color?: string; align?: CanvasTextAlign; track?: number; weight?: number } = {}) {
  g.font = `${opts.weight ?? 500} ${Math.round(size * PPU)}px ${opts.font ?? MONO}`
  g.fillStyle = opts.color ?? INK_DIM
  g.textAlign = opts.align ?? 'center'
  g.textBaseline = 'middle'
  const track = opts.track ?? 0.12
  if ('letterSpacing' in g) (g as unknown as { letterSpacing: string }).letterSpacing = `${(size * PPU * track).toFixed(1)}px`
  g.fillText(s, X(x), Y(y))
}

/** a dial scale: ticks on an arc around a knob, 270° sweep */
function dial(g: CanvasRenderingContext2D, cx: number, cy: number, r0: number, r1: number, n: number, color: string) {
  g.strokeStyle = color
  g.lineCap = 'round'
  for (let i = 0; i < n; i++) {
    const a = THREE.MathUtils.degToRad(225 - (270 * i) / (n - 1))
    const major = i % 2 === 0
    const ra = r0
    const rb = major ? r1 : r0 + (r1 - r0) * 0.55
    g.lineWidth = (major ? 0.009 : 0.006) * PPU
    g.beginPath()
    g.moveTo(X(cx + Math.cos(a) * ra), Y(cy + Math.sin(a) * ra))
    g.lineTo(X(cx + Math.cos(a) * rb), Y(cy + Math.sin(a) * rb))
    g.stroke()
  }
}

function drawFace(c: HTMLCanvasElement) {
  const g = c.getContext('2d')!
  const { w, h } = faceSize()
  // graphite powder coat: a faint top-down falloff
  const grad = g.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, '#2a2a2e')
  grad.addColorStop(1, '#1f1f22')
  g.fillStyle = grad
  g.fillRect(0, 0, w, h)

  // engraved frame around the CRT bezel
  g.strokeStyle = 'rgba(0, 0, 0, 0.5)'
  g.lineWidth = 0.012 * PPU
  const m = SCREEN.bezel + 0.035
  rrect(g, X(SCREEN.x0 - m), Y(SCREEN.y0 + SCREEN.h + m), (SCREEN.w + m * 2) * PPU, (SCREEN.h + m * 2) * PPU, 0.16 * PPU)
  g.stroke()
  g.strokeStyle = 'rgba(255, 255, 255, 0.06)'
  g.lineWidth = 0.005 * PPU
  rrect(g, X(SCREEN.x0 - m) + 0.008 * PPU, Y(SCREEN.y0 + SCREEN.h + m) + 0.008 * PPU, (SCREEN.w + m * 2) * PPU, (SCREEN.h + m * 2) * PPU, 0.16 * PPU)
  g.stroke()

  // control section: badge
  const cx = KNOBS.time.x
  text(g, 'HARK', FACE.ctrl0 + 0.02, 2.5, 0.095, { font: SANS, weight: 700, color: INK, align: 'left', track: 0.02 })
  text(g, 'RS-04', FACE.ctrl1 - 0.02, 2.515, 0.042, { color: INK, align: 'right', track: 0.14 })
  text(g, 'ANTI-PHASE SCOPE', FACE.ctrl1 - 0.02, 2.46, 0.028, { align: 'right', track: 0.16 })
  g.fillStyle = 'rgba(228, 221, 207, 0.22)'
  g.fillRect(X(FACE.ctrl0 + 0.02), Y(2.395), (FACE.ctrl1 - FACE.ctrl0 - 0.04) * PPU, 0.005 * PPU)

  // buttons row
  for (const b of BUTTONS) text(g, b.label, b.x, b.y - 0.105, 0.028, { track: 0.14 })

  // TIME/DIV
  dial(g, cx, KNOBS.time.y, KNOBS.time.r + 0.05, KNOBS.time.r + 0.1, 13, INK_DIM)
  text(g, 'TIME / DIV', cx, KNOBS.time.y - KNOBS.time.r - 0.15, 0.03, { color: INK, track: 0.18 })
  text(g, '1 s', cx - 0.25, KNOBS.time.y - 0.24, 0.024, { align: 'right' })
  text(g, '5 ns', cx + 0.25, KNOBS.time.y - 0.24, 0.024, { align: 'left' })

  // channel verticals
  const chans = [
    { k: KNOBS.v1, p: KNOBS.p1, b: BNC[0], col: CH1, name: 'CH1' },
    { k: KNOBS.v2, p: KNOBS.p2, b: BNC[1], col: CH2, name: 'CH2' },
  ]
  for (const ch of chans) {
    // channel tab above the volts knob
    g.fillStyle = ch.col
    g.fillRect(X(ch.k.x - 0.13), Y(ch.k.y + ch.k.r + 0.135), 0.035 * PPU, 0.035 * PPU)
    text(g, ch.name, ch.k.x - 0.075, ch.k.y + ch.k.r + 0.1175, 0.032, { color: INK, align: 'left', track: 0.14 })
    dial(g, ch.k.x, ch.k.y, ch.k.r + 0.035, ch.k.r + 0.07, 9, INK_DIM)
    text(g, 'VOLTS/DIV', ch.k.x, ch.k.y - ch.k.r - 0.09, 0.024, { track: 0.14 })
    text(g, 'POSITION', ch.p.x, ch.p.y - ch.p.r - 0.06, 0.022, { track: 0.14 })
    // colour ring printed around the input
    g.strokeStyle = ch.col
    g.lineWidth = 0.012 * PPU
    g.beginPath()
    g.arc(X(ch.b.x), Y(ch.b.y), 0.105 * PPU, 0, Math.PI * 2)
    g.stroke()
  }
  text(g, '1 MΩ  ‖  15 pF    300 V CAT II', (BNC[0].x + BNC[1].x) / 2, BNC[0].y - 0.15, 0.019, { track: 0.1 })

  // power
  text(g, 'PWR', POWER.x, POWER.y - 0.1, 0.022, { track: 0.14 })
  // under the soft keys: the menu is on the CRT, keep a hairline tray
  g.fillStyle = 'rgba(0, 0, 0, 0.35)'
  const k0 = SOFTKEYS[0]
  const k1 = SOFTKEYS[SOFTKEYS.length - 1]
  rrect(g, X(k0.x - k0.w / 2 - 0.05), Y(k0.y + 0.075), (k1.x - k0.x + k0.w + 0.1) * PPU, 0.15 * PPU, 0.04 * PPU)
  g.fill()
}

export function faceTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  const { w, h } = faceSize()
  c.width = w
  c.height = h
  drawFace(c)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
  // extrude caps carry world-space (x, y) UVs: map the faceplate rect onto 0..1
  tex.repeat.set(1 / FACE.w, 1 / FACE.h)
  tex.offset.set(-FACE.x0 / FACE.w, -FACE.y0 / FACE.h)
  whenFonts(() => {
    drawFace(c)
    tex.needsUpdate = true
  })
  return tex
}

// ---------------------------------------------------------------- CRT overlay

const OW = 1024
const OH = Math.round((OW * SCREEN.h) / SCREEN.w)

function drawOverlay(c: HTMLCanvasElement) {
  const g = c.getContext('2d')!
  g.clearRect(0, 0, OW, OH)
  const px = OW / 10 // one division
  g.textBaseline = 'middle'
  const set = (size: number, color: string, align: CanvasTextAlign = 'left') => {
    g.font = `500 ${size}px ${MONO}`
    g.fillStyle = color
    g.textAlign = align
    if ('letterSpacing' in g) (g as unknown as { letterSpacing: string }).letterSpacing = `${(size * 0.08).toFixed(1)}px`
  }
  const G = 'rgba(120, 255, 180, 0.9)'
  const R = 'rgba(255, 120, 90, 0.9)'
  // top status line
  set(19, G)
  g.fillText('RS-04', 16, 22)
  g.fillStyle = 'rgba(120, 255, 180, 0.9)'
  g.fillRect(96, 15, 12, 12)
  g.fillText('RUN', 116, 22)
  set(19, R)
  g.fillText('1  500 mV', px * 3.1, 22)
  set(19, G)
  g.fillText('2  500 mV', px * 4.9, 22)
  set(19, G, 'right')
  g.fillText('M 2.00 ms   Σ 1+2', OW - 16, 22)
  // soft-key menu along the bottom
  const labels = ['CH1', 'CH2', 'MATH Σ', 'TRIG', 'GUARD']
  SOFTKEYS.forEach((k, i) => {
    const u = (k.x - SCREEN.x0) / SCREEN.w
    const x = u * OW
    const bw = (k.w / SCREEN.w) * OW
    g.strokeStyle = 'rgba(120, 255, 180, 0.55)'
    g.lineWidth = 2
    rrect(g, x - bw / 2, OH - 44, bw, 34, 4)
    g.stroke()
    set(17, i === 0 ? R : G, 'center')
    g.fillText(labels[i], x, OH - 27)
  })
}

export function overlayTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = OW
  c.height = OH
  drawOverlay(c)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  whenFonts(() => {
    drawOverlay(c)
    tex.needsUpdate = true
  })
  return tex
}

function whenFonts(fn: () => void) {
  if (!document.fonts) return
  const want = ['500 20px "IBM Plex Mono"', '700 20px "Inter Tight"']
  if (want.every(f => document.fonts.check(f))) return
  Promise.all(want.map(f => document.fonts.load(f)))
    .then(fn)
    .catch(() => {})
}
