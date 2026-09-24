/*
 * The desk, measured. World units, desk sitting on y = 0, the operator at +z.
 * x runs across the strips, z runs from the meter bridge (-z) to the front
 * edge (+z). Fader travel: 0 = bottom (front, -inf) .. 1 = top (+10 dB).
 */

const W = 4.8
const D = 3.0
const plateZ0 = -0.94
const plateZ1 = 1.4
const travelBottom = 1.2
const travelTop = 0.2

export const LAYOUT = {
  W,
  D,
  corner: 0.16,
  /** plinth (black rubber base) and body heights */
  plinthH: 0.035,
  bodyTop: 0.24,
  plateTop: 0.262,
  /** faceplate extent */
  plateX0: -2.32,
  plateX1: 2.32,
  plateW: 4.64,
  plateZ0,
  plateZ1,
  plateD: plateZ1 - plateZ0,

  stripW: 0.78,
  channels: [-1.93, -1.15, -0.37, 0.41],
  masterX: 1.24,
  masterMeters: [1.44, 1.52],
  levelKnob: [1.88, -0.62] as [number, number],
  levelKnobR: 0.13,
  logoAt: [1.52, 0.98] as [number, number],

  /** fader slot, relative to the strip centre */
  slotDX: -0.07,
  slotW: 0.03,
  slotZ0: 0.1,
  slotZ1: 1.3,
  travelBottom,
  travelTop,
  travelZ: (p: number) => travelBottom + (travelTop - travelBottom) * p,

  /** meter ladder, relative to the strip centre */
  meterDX: 0.2,
  meterW: 0.046,
  meterZ0: 0.16,
  meterZ1: 1.24,
  segments: 18,

  knobZ: [-0.74, -0.4],
  knobR: 0.078,
  nameZ: -0.14,
  ledDX: 0.3,

  /** meter bridge */
  bridgeZ0: -0.97,
  bridgeZ1: -1.44,
  bridgeTop: 0.7,
  bridgeTilt: Math.PI / 6,
  displayX: [-1.45, 0, 1.45],
  displayW: 1.08,
  displayH: 0.25,
}

/** [fader position, legend, major] */
export const DB_MARKS: [number, string, boolean][] = [
  [1, '+10', true],
  [0.875, '5', false],
  [0.75, '0', true],
  [0.625, '5', false],
  [0.5, '10', true],
  [0.36, '20', true],
  [0.23, '30', false],
  [0.12, '40', false],
  [0, '∞', true],
]

/** fader position → dB, for the HUD readout (piecewise-linear over the legend) */
export function faderDb(p: number): number {
  const table: [number, number][] = [
    [0, -90],
    [0.12, -40],
    [0.23, -30],
    [0.36, -20],
    [0.5, -10],
    [0.625, -5],
    [0.75, 0],
    [0.875, 5],
    [1, 10],
  ]
  if (p <= 0.004) return -Infinity
  for (let i = 1; i < table.length; i++) {
    const [p1, d1] = table[i]
    const [p0, d0] = table[i - 1]
    if (p <= p1) return d0 + ((p - p0) / (p1 - p0)) * (d1 - d0)
  }
  return 10
}
