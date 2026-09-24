import * as THREE from 'three'
import { PROCESS } from '../../content'
import { logoShapes } from '../../logo/logo'
import { LAYOUT as L, DB_MARKS } from './layout'

/*
 * The faceplate's screen print, drawn once into a canvas in desk (world)
 * coordinates: channel numbers and names, knob scales, the fader dB legend,
 * strip dividers and the Hark mark on the master section. Used as the colour
 * AND metalness map of the faceplate lid, so the ink reads as matte print on
 * bead-blasted metal rather than dark metal.
 */

const INK = '#1d1d1f'
const INK_SOFT = 'rgba(29,29,31,0.72)'

export function drawPanel(canvas: HTMLCanvasElement, withLogo: boolean) {
  const g = canvas.getContext('2d')!
  const s = canvas.width / L.plateW
  const X = (x: number) => (x - L.plateX0) * s
  const Z = (z: number) => (z - L.plateZ0) * s

  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, canvas.width, canvas.height)
  g.lineCap = 'round'

  const mono = (px: number, w = 500) => `${w} ${Math.round(px * s)}px "IBM Plex Mono", ui-monospace, monospace`
  const sans = (px: number, w = 600) => `${w} ${Math.round(px * s)}px "Inter Tight Variable", "Inter Tight", system-ui, sans-serif`
  const text = (str: string, x: number, z: number, font: string, align: CanvasTextAlign = 'left', color = INK, track = 0) => {
    g.font = font
    g.fillStyle = color
    g.textAlign = align
    g.textBaseline = 'middle'
    if ('letterSpacing' in g) (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${track * s}px`
    g.fillText(str, X(x), Z(z))
  }
  const line = (x0: number, z0: number, x1: number, z1: number, w: number, color = INK) => {
    g.strokeStyle = color
    g.lineWidth = w * s
    g.beginPath()
    g.moveTo(X(x0), Z(z0))
    g.lineTo(X(x1), Z(z1))
    g.stroke()
  }
  const knobScale = (x: number, z: number, r: number, label: string, ticks = 11) => {
    for (let i = 0; i < ticks; i++) {
      const a = (-135 + (270 * i) / (ticks - 1)) * (Math.PI / 180)
      const major = i === 0 || i === ticks - 1 || i === (ticks - 1) / 2
      const r0 = r + 0.012
      const r1 = r + (major ? 0.042 : 0.03)
      // angle 0 = pointing "up" the desk (toward the bridge, -z)
      line(x + Math.sin(a) * r0, z - Math.cos(a) * r0, x + Math.sin(a) * r1, z - Math.cos(a) * r1, major ? 0.0065 : 0.0045)
    }
    text(label, x, z + r + 0.072, mono(0.04), 'center', INK, 0.008)
  }

  // ---- channel strips
  PROCESS.forEach((p, i) => {
    const cx = L.channels[i]
    // strip divider (hairline) on the right of each strip
    if (i > 0) line(cx - L.stripW / 2, L.plateZ0 + 0.1, cx - L.stripW / 2, L.plateZ1 - 0.1, 0.0035, INK_SOFT)

    knobScale(cx, L.knobZ[0], L.knobR, 'GAIN')
    knobScale(cx, L.knobZ[1], L.knobR, 'TONE')

    // channel number + engraved name
    text(String(i + 1).padStart(2, '0'), cx - L.stripW / 2 + 0.07, L.nameZ - 0.075, mono(0.036), 'left', INK_SOFT, 0.006)
    text(p.title, cx - L.stripW / 2 + 0.07, L.nameZ + 0.012, sans(0.088, 640), 'left', INK, -0.003)

    faderLegend(cx + L.slotDX, true)
  })

  function faderLegend(sx: number, withMeterScale: boolean) {
    // dB legend down the left of the slot
    for (const [p, label, major] of DB_MARKS) {
      const z = L.travelZ(p)
      const len = major ? 0.05 : 0.03
      line(sx - 0.045 - len, z, sx - 0.045, z, major ? 0.006 : 0.0045)
      if (label) text(label, sx - 0.115, z, mono(0.036, 500), 'right', INK)
      // unity gets a tick on both sides
      if (label === '0') line(sx + 0.045, z, sx + 0.075, z, 0.006)
    }
    if (withMeterScale) {
      // tiny scale beside the meter ladder
      const mx = sx - L.slotDX + L.meterDX + L.meterW / 2 + 0.03
      line(mx, L.meterZ0, mx, L.meterZ1, 0.003, INK_SOFT)
    }
  }

  // ---- master section
  const mx = L.masterX
  line(L.channels[3] + L.stripW / 2, L.plateZ0 + 0.1, L.channels[3] + L.stripW / 2, L.plateZ1 - 0.1, 0.006, INK)
  faderLegend(mx, false)
  text('Master', L.channels[3] + L.stripW / 2 + 0.09, L.nameZ + 0.012, sans(0.088, 640), 'left', INK, -0.003)
  text('ST', L.channels[3] + L.stripW / 2 + 0.09, L.nameZ - 0.075, mono(0.036), 'left', INK_SOFT, 0.006)
  text('L', L.masterMeters[0], L.meterZ0 - 0.06, mono(0.03), 'center', INK_SOFT)
  text('R', L.masterMeters[1], L.meterZ0 - 0.06, mono(0.03), 'center', INK_SOFT)
  knobScale(L.levelKnob[0], L.levelKnob[1], L.levelKnobR, 'LEVEL', 21)

  // the Hark mark + a small maker's plate (the studio's own name and city, no invented model number)
  const lx = L.logoAt[0]
  const lz = L.logoAt[1]
  if (withLogo) {
    const size = 0.2
    g.fillStyle = INK
    for (const shape of logoShapes()) {
      const path = new Path2D()
      const outline = (pts: THREE.Vector2[]) => {
        pts.forEach((v, k) => {
          const px = X(lx + v.x * size)
          const pz = Z(lz - v.y * size)
          if (k === 0) path.moveTo(px, pz)
          else path.lineTo(px, pz)
        })
        path.closePath()
      }
      outline(shape.getPoints(24))
      for (const h of shape.holes) outline(h.getPoints(24))
      g.fill(path, 'evenodd')
    }
  }
  text('Hark', lx + 0.16, lz - 0.035, sans(0.09, 680), 'left', INK, -0.004)
  text('CH 1–4 · MASTER', lx + 0.165, lz + 0.06, mono(0.026), 'left', INK_SOFT, 0.005)
  text('PHILADELPHIA', lx + 0.165, lz + 0.1, mono(0.026), 'left', INK_SOFT, 0.005)
}

/** Build the faceplate print as a texture mapped in desk coordinates onto the lid UVs (shape x, -z). */
export function panelTexture(mobile: boolean) {
  const canvas = document.createElement('canvas')
  canvas.width = mobile ? 1536 : 2560
  canvas.height = Math.round((canvas.width * L.plateD) / L.plateW)
  drawPanel(canvas, true)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  // lid uv = (x, -z) in desk units → [0,1]
  tex.repeat.set(1 / L.plateW, 1 / L.plateD)
  tex.offset.set(-L.plateX0 / L.plateW, L.plateZ1 / L.plateD)
  return { tex, canvas }
}
