/*
 * The bench scope's dimensions, in world units (bench top at y = 0, the scope
 * centred on x = 0, z = 0, its face toward +z). Shared by the model, the
 * printed faceplate artwork and the chapter's camera framing.
 */

/** bone powder-coat sleeve (rounded rect in x/y, extruded along z) */
export const SHELL = { w: 4.2, h: 2.72, d: 2.5, r: 0.3, wall: 0.15, y0: 0.07 }
/** front lip of the sleeve */
export const FRONT_Z = SHELL.d / 2
/** front surface of the recessed graphite faceplate */
export const FACE_Z = FRONT_Z - 0.06

/** faceplate rect (x0, y0 = bottom-left) + the control section's x range */
export const FACE = { x0: -1.94, y0: 0.23, w: 3.88, h: 2.4, r: 0.15, ctrl0: 0.72, ctrl1: 1.9 }

/** visible CRT glass: 10 × 8 divisions of 0.23 */
export const SCREEN = { x0: -1.77, y0: 0.6, w: 2.3, h: 1.84, bezel: 0.1, cx: -0.62, cy: 1.52, bulge: 0.034 }

export const KNOBS = {
  time: { x: 1.31, y: 1.8, r: 0.2 },
  v1: { x: 1.0, y: 1.12, r: 0.115 },
  v2: { x: 1.62, y: 1.12, r: 0.115 },
  p1: { x: 1.0, y: 0.76, r: 0.065 },
  p2: { x: 1.62, y: 0.76, r: 0.065 },
}

export const BUTTONS = [
  { x: 1.02, y: 2.22, w: 0.28, h: 0.1, label: 'RUN / STOP' },
  { x: 1.6, y: 2.22, w: 0.28, h: 0.1, label: 'AUTOSET' },
]

export const SOFTKEYS = [-1.46, -1.03, -0.6, -0.17, 0.26].map(x => ({ x, y: 0.37, w: 0.3, h: 0.08 }))

export const POWER = { x: -1.8, y: 0.37, r: 0.05 }

export const BNC = [
  { x: 1.0, y: 0.42 },
  { x: 1.62, y: 0.42 },
]
