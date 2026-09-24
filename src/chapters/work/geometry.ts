import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/*
 * Geometry for THE CRATE: a record-shop browser bin in black anodized
 * aluminium with diamond-cut chamfers, the 12" sleeves, and a lathed vinyl
 * record with a real profile (label plateau, dead wax, edge bead).
 *
 * World units: a sleeve is 1 x 1. The crate sits on the floor (y = 0),
 * centred on x, front wall toward +z (the camera side).
 */

export const SLEEVE = { w: 1, h: 1, t: 0.014 }
/** a 12" record in a 12.4" sleeve */
export const RECORD_R = 0.476
export const LABEL_R = 0.158

export const CRATE = {
  /** inner half width (sleeves are 1 wide) */
  inner: 0.535,
  wall: 0.032,
  zFront: 0.6,
  zBack: -0.6,
  backH: 0.8,
  frontH: 0.24,
  floor: 0.032,
  feet: 0.018,
  /** top of the inner floor, where sleeves stand */
  get y0() {
    return this.feet + this.floor
  },
}

/** crate wall height (world y of the rim) at depth z along the sloped sides */
export const rimAt = (z: number) => {
  const t = (z - CRATE.zBack) / (CRATE.zFront - CRATE.zBack)
  return CRATE.backH + (CRATE.frontH - CRATE.backH) * Math.min(1, Math.max(0, t))
}

/** A 2D polygon with every corner cut by `c` (so extrusions get chamfers all round). */
function chamferPoly(pts: THREE.Vector2[], c: number): THREE.Vector2[] {
  const out: THREE.Vector2[] = []
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    const a = pts[(i + n - 1) % n]
    const b = pts[(i + 1) % n]
    const da = a.clone().sub(p)
    const db = b.clone().sub(p)
    const ca = Math.min(c, da.length() * 0.45)
    const cb = Math.min(c, db.length() * 0.45)
    out.push(p.clone().addScaledVector(da.normalize(), ca))
    out.push(p.clone().addScaledVector(db.normalize(), cb))
  }
  return out
}

function stadium(cx: number, cy: number, w: number, h: number, seg = 10): THREE.Path {
  const r = h / 2
  const path = new THREE.Path()
  const pts: THREE.Vector2[] = []
  for (let i = 0; i <= seg; i++) {
    const a = -Math.PI / 2 + (i / seg) * Math.PI
    pts.push(new THREE.Vector2(cx + w / 2 - r + Math.cos(a) * r, cy + Math.sin(a) * r))
  }
  for (let i = 0; i <= seg; i++) {
    const a = Math.PI / 2 + (i / seg) * Math.PI
    pts.push(new THREE.Vector2(cx - w / 2 + r + Math.cos(a) * r, cy + Math.sin(a) * r))
  }
  // holes wind opposite to the outline
  pts.reverse()
  path.setFromPoints(pts)
  return path
}

/**
 * Extrude a (chamfered) outline by `depth` with a flat 1-segment bevel, centred
 * on z. Returns non-indexed geometry with flat facet normals.
 */
function slab(outline: THREE.Vector2[], depth: number, c: number, holes: THREE.Path[] = []): THREE.BufferGeometry {
  const shape = new THREE.Shape(chamferPoly(outline, c))
  shape.holes.push(...holes)
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.001, depth - 2 * c),
    bevelEnabled: true,
    bevelThickness: c,
    bevelSize: c * 0.999,
    bevelOffset: -c,
    bevelSegments: 1,
    curveSegments: 10,
    steps: 1,
  })
  g.translate(0, 0, -(depth - 2 * c) / 2)
  return g
}

const rect = (x0: number, y0: number, x1: number, y1: number) => [
  new THREE.Vector2(x0, y0),
  new THREE.Vector2(x1, y0),
  new THREE.Vector2(x1, y1),
  new THREE.Vector2(x0, y1),
]

/**
 * The crate as ONE merged geometry with an `aChamfer` attribute (1 on the
 * diamond-cut bevels and machined cut edges, 0 on the anodized faces) so a
 * single material can render both.
 */
export function crateGeometry(): THREE.BufferGeometry {
  const C = CRATE
  const c = 0.006
  const parts: THREE.BufferGeometry[] = []
  const yb = C.feet
  const outer = C.inner + C.wall

  // floor: XZ slab (extrude along y)
  {
    const g = slab(rect(-outer, C.zBack, outer, C.zFront), C.floor, c)
    g.rotateX(Math.PI / 2)
    g.translate(0, yb + C.floor / 2, 0)
    parts.push(g)
  }
  // side walls: a profile in (z, y), extruded along x, with a hand-hole
  for (const side of [-1, 1]) {
    const prof = [
      new THREE.Vector2(C.zBack, yb),
      new THREE.Vector2(C.zFront, yb),
      new THREE.Vector2(C.zFront, C.frontH),
      new THREE.Vector2(C.zBack, C.backH),
    ]
    const hole = stadium(C.zBack + 0.27, C.backH - 0.13, 0.26, 0.075)
    const g = slab(prof, C.wall, c, [hole])
    // shape (x=z, y=y), extrude z -> world x
    g.rotateY(-Math.PI / 2)
    g.translate(side * (C.inner + C.wall / 2), 0, 0)
    parts.push(g)
  }
  // back wall
  {
    const g = slab(rect(-C.inner, yb + C.floor * 0.5, C.inner, C.backH), C.wall, c)
    g.translate(0, 0, C.zBack + C.wall / 2)
    parts.push(g)
  }
  // front wall (lower), with a thumb notch
  {
    const g = slab(rect(-C.inner, yb + C.floor * 0.5, C.inner, C.frontH), C.wall, c)
    g.translate(0, 0, C.zFront - C.wall / 2)
    parts.push(g)
  }
  // rubber feet
  for (const [x, z] of [
    [-outer + 0.07, C.zBack + 0.07],
    [outer - 0.07, C.zBack + 0.07],
    [-outer + 0.07, C.zFront - 0.07],
    [outer - 0.07, C.zFront - 0.07],
  ]) {
    const g = new THREE.CylinderGeometry(0.04, 0.045, C.feet, 20, 1)
    g.translate(x, C.feet / 2, z)
    parts.push(g)
  }

  const clean = parts.map(g => {
    const n = g.index ? g.toNonIndexed() : g
    for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') n.deleteAttribute(k)
    return n
  })
  const merged = mergeGeometries(clean, false)!
  // classify facets: axis-aligned (and the gently sloped side tops) are anodized,
  // anything more oblique is a bright machined bevel
  const nrm = merged.attributes.normal
  const pos = merged.attributes.position
  const ch = new Float32Array(nrm.count)
  for (let i = 0; i < nrm.count; i++) {
    const m = Math.max(Math.abs(nrm.getX(i)), Math.abs(nrm.getY(i)), Math.abs(nrm.getZ(i)))
    // feet stay rubber
    const y = pos.getY(i)
    ch[i] = y < C.feet + 1e-4 ? 0 : m < 0.86 ? 1 : 0
  }
  merged.setAttribute('aChamfer', new THREE.BufferAttribute(ch, 1))
  merged.computeBoundingSphere()
  return merged
}

/**
 * A sleeve: a thin box, pivot at the bottom-centre edge (so flips hinge on
 * the crate floor). Local x in [-0.5, 0.5], y in [0, 1], z in ±t/2.
 */
export function sleeveGeometry(t = SLEEVE.t): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(SLEEVE.w, SLEEVE.h, t, 1, 1, 1)
  g.translate(0, SLEEVE.h / 2, 0)
  return g
}

/**
 * The record: a lathed profile (axis = local z) — label plateau with a
 * raised ring, a step down to the dead wax, the grooved field, and a rolled
 * edge bead. Side A faces +z.
 */
export function recordGeometry(segments = 128): THREE.BufferGeometry {
  const R = RECORD_R
  const L = LABEL_R
  const top: [number, number][] = [
    [0.012, 0.003],
    [L - 0.004, 0.003],
    [L + 0.003, 0.0035],
    [L + 0.011, 0.0026],
    [L + 0.03, 0.0022],
    [R - 0.024, 0.0022],
    [R - 0.013, 0.0025],
    [R - 0.006, 0.0036],
    [R - 0.0015, 0.0026],
    [R, 0.0],
  ]
  const pts: THREE.Vector2[] = []
  for (const [r, h] of top) pts.push(new THREE.Vector2(r, h))
  for (let i = top.length - 2; i >= 0; i--) pts.push(new THREE.Vector2(top[i][0], -top[i][1]))
  pts.push(new THREE.Vector2(0.012, 0.003))
  // LatheGeometry revolves (x = radius, y = height) around +y
  const g = new THREE.LatheGeometry(pts, segments)
  g.rotateX(Math.PI / 2)
  g.computeVertexNormals()
  return g
}

/** Soft floor shadow quad (XZ), unit size — scaled by the caller. */
export function shadowQuad(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1)
  g.rotateX(-Math.PI / 2)
  return g
}
