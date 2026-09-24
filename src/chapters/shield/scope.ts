import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { BNC, BUTTONS, FACE, FACE_Z, KNOBS, POWER, SCREEN, SHELL, SOFTKEYS } from './layout'
import { faceTexture, overlayTexture } from './panel'
import { Screen } from './screen'

/*
 * The bench scope, built like a product render: a bone powder-coat sleeve
 * with a chrome carry handle, a recessed graphite faceplate with silk-screened
 * scales, a soft-touch bezel around the domed CRT, knurled black knobs with
 * machined aluminium caps, soft keys, two BNC inputs with probe cables that
 * droop to the bench and curl away to their probes, rubber feet, and one
 * analytic contact-shadow pass on the bench (no shadow maps). The bench also
 * carries a warm lamp pool and the screen's own spill for the dark in-beat.
 */

const FLOOR_VERT = /* glsl */ `
varying vec2 vP;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vP = w.xz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

const FLOOR_FRAG = /* glsl */ `
uniform sampler2D uCables;
uniform vec4 uCableRect;
uniform vec3 uShadowCol;
uniform float uShadow;
uniform vec3 uPoolCol;
uniform float uPool;
uniform vec3 uGlowCol;
uniform float uGlow;
varying vec2 vP;

float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

void main() {
  // cables + probes, baked (sampled unconditionally, masked after)
  vec2 cu = (vP - uCableRect.xy) / uCableRect.zw;
  float inside = step(0.0, cu.x) * step(cu.x, 1.0) * step(0.0, cu.y) * step(cu.y, 1.0);
  float cab = texture2D(uCables, clamp(cu, 0.0, 1.0)).r * inside;

  // the scope on its feet: a crisp contact line + a wide soft skirt
  float sd = sdBox(vP, vec2(2.02, 1.18));
  float sf = max(sd, 0.0);
  float a = sd > 0.0 ? 0.46 * exp(-sf * 6.5) + 0.2 * exp(-sf * 1.1) : 0.66;
  float sh = (1.0 - (1.0 - a) * (1.0 - cab * 0.8)) * uShadow;

  // bench lamp pool and CRT spill (they light the dark room; they vanish on bone)
  vec2 q = (vP - vec2(0.2, 1.5)) / vec2(5.2, 3.6);
  float pool = exp(-dot(q, q) * 2.2) * uPool;
  vec2 g = (vP - vec2(${SCREEN.cx.toFixed(3)}, 1.75)) / vec2(1.7, 1.0);
  float glow = exp(-dot(g, g) * 1.6) * uGlow * step(1.1, vP.y);
  float la = clamp(pool + glow, 0.0, 1.0);
  vec3 light = uPoolCol * pool + uGlowCol * glow;

  // premultiplied: lighten toward the lamp, then darken under the shadow
  gl_FragColor = vec4(light * (1.0 - sh) + uShadowCol * sh, 1.0 - (1.0 - la) * (1.0 - sh));
}
`

type P3 = [number, number, number]

/** non-indexed copy (mergeGeometries wants all-or-none indexed) */
const ni = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g)

/** probe cable routes, BNC plug → probe tail */
const CABLES: { pts: P3[]; probe: { at: P3; dir: P3 }; ring: string }[] = [
  {
    // CH1: the outer loop, its probe resting in profile beside the flank
    pts: [
      [BNC[0].x, BNC[0].y, FACE_Z + 0.34],
      [BNC[0].x, BNC[0].y - 0.03, FACE_Z + 0.5],
      [BNC[0].x + 0.07, 0.2, FACE_Z + 0.64],
      [BNC[0].x + 0.3, 0.034, FACE_Z + 0.72],
      [BNC[0].x + 1.0, 0.03, FACE_Z + 0.86],
      [BNC[0].x + 1.62, 0.03, FACE_Z + 0.73],
      [BNC[0].x + 1.78, 0.03, FACE_Z + 0.41],
      [BNC[0].x + 1.7, 0.034, FACE_Z + 0.11],
      [BNC[0].x + 1.76, 0.04, FACE_Z - 0.05],
      [2.9, 0.042, 1.0],
    ],
    probe: { at: [2.9, 0.042, 1.0], dir: [0.7, 0, -0.7] },
    ring: '#e4694c',
  },
  {
    // CH2: the inner loop
    pts: [
      [BNC[1].x, BNC[1].y, FACE_Z + 0.34],
      [BNC[1].x + 0.01, BNC[1].y - 0.04, FACE_Z + 0.47],
      [BNC[1].x + 0.1, 0.2, FACE_Z + 0.57],
      [BNC[1].x + 0.33, 0.034, FACE_Z + 0.59],
      [BNC[1].x + 0.63, 0.03, FACE_Z + 0.49],
      [BNC[1].x + 0.71, 0.034, FACE_Z + 0.23],
      [2.45, 0.042, 1.2],
    ],
    probe: { at: [2.45, 0.042, 1.2], dir: [0.5, 0, -0.85] },
    ring: '#5cc392',
  },
]
const CABLE_R = 0.028
/** floor rect covered by the baked cable shadows: x0, z0, w, d */
const CABLE_RECT = [0.3, 0.1, 3.6, 3.0] as const

function rrShape<T extends THREE.Path>(p: T, x0: number, y0: number, x1: number, y1: number, r: number): T {
  r = Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2)
  p.moveTo(x0 + r, y0)
  p.lineTo(x1 - r, y0)
  p.absarc(x1 - r, y0 + r, r, -Math.PI / 2, 0, false)
  p.lineTo(x1, y1 - r)
  p.absarc(x1 - r, y1 - r, r, 0, Math.PI / 2, false)
  p.lineTo(x0 + r, y1)
  p.absarc(x0 + r, y1 - r, r, Math.PI / 2, Math.PI, false)
  p.lineTo(x0, y0 + r)
  p.absarc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5, false)
  return p
}

/** extrude a rounded rect (x/y) from z0 toward +z by depth, with a soft bevel and optional holes */
function plate(x0: number, y0: number, x1: number, y1: number, r: number, z0: number, depth: number, bevel: number, holes: THREE.Path[] = [], seg = 10) {
  const s = rrShape(new THREE.Shape(), x0 + bevel, y0 + bevel, x1 - bevel, y1 - bevel, r - bevel)
  s.holes.push(...holes)
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: Math.max(1e-4, depth - bevel * 2),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: bevel > 0 ? 3 : 0,
    curveSegments: seg,
  })
  geo.translate(0, 0, z0 + bevel)
  return geo
}

/** cylinder along +z from z = 0 */
function zCyl(r0: number, r1: number, h: number, seg: number) {
  const g = new THREE.CylinderGeometry(r1, r0, h, seg, 1)
  g.rotateX(Math.PI / 2)
  g.translate(0, 0, h / 2)
  return g
}

function bakeCableShadows(curves: THREE.Curve<THREE.Vector3>[], probes: { a: THREE.Vector3; b: THREE.Vector3 }[]) {
  const [x0, z0, w, d] = CABLE_RECT
  const ppu = 180
  const c = document.createElement('canvas')
  c.width = Math.round(w * ppu)
  c.height = Math.round(d * ppu)
  const g = c.getContext('2d')!
  g.fillStyle = '#000'
  g.fillRect(0, 0, c.width, c.height)
  g.globalCompositeOperation = 'lighter'
  g.lineCap = 'round'
  const X = (x: number) => (x - x0) * ppu
  const Z = (z: number) => (z - z0) * ppu
  const stroke = (ax: number, az: number, bx: number, bz: number, width: number, alpha: number) => {
    for (let k = 0; k < 4; k++) {
      g.lineWidth = width * ppu * (1 + k * 1.1)
      g.strokeStyle = `rgba(255,255,255,${(alpha / (1 + k * 1.6)) * 0.55})`
      g.beginPath()
      g.moveTo(X(ax), Z(az))
      g.lineTo(X(bx), Z(bz))
      g.stroke()
    }
  }
  for (const cv of curves) {
    const pts = cv.getSpacedPoints(140)
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1]
      const q = pts[i]
      const y = (p.y + q.y) / 2
      stroke(p.x, p.z, q.x, q.z, CABLE_R * 2.2 + y * 0.3, Math.exp(-y * 4.5))
    }
  }
  for (const p of probes) stroke(p.a.x, p.a.z, p.b.x, p.b.z, 0.1, 1)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.NoColorSpace
  // canvas rows run +z, exactly like the floor's (x, z) lookup
  tex.flipY = false
  return tex
}

export class Scope {
  object = new THREE.Group()
  screen: Screen
  knobs: Record<keyof typeof KNOBS, THREE.Group>
  floorUniforms = {
    uCables: { value: null as THREE.Texture | null },
    uCableRect: { value: new THREE.Vector4(...CABLE_RECT) },
    uShadowCol: { value: new THREE.Color('#1c1814') },
    uShadow: { value: 1 },
    uPoolCol: { value: new THREE.Color('#5e554a') },
    uPool: { value: 0 },
    uGlowCol: { value: new THREE.Color(0, 0.3, 0.12) },
    uGlow: { value: 0 },
  }
  key: THREE.DirectionalLight
  spill: THREE.PointLight
  leds: THREE.MeshBasicMaterial
  private ledOn = new THREE.Color('#00ff85').multiplyScalar(6)
  private ledOff = new THREE.Color('#10301f')

  constructor(renderer: THREE.WebGLRenderer, mobile: boolean, envMap: THREE.Texture) {
    const o = this.object

    // ---- materials
    const bone = new THREE.MeshPhysicalMaterial({ color: '#e8e2d6', roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.42 })
    const graphite = new THREE.MeshPhysicalMaterial({
      color: '#ffffff',
      map: faceTexture(renderer),
      roughness: 0.52,
      metalness: 0.12,
      clearcoat: 0.18,
      clearcoatRoughness: 0.5,
    })
    const soft = new THREE.MeshStandardMaterial({ color: '#151517', roughness: 0.64, metalness: 0 })
    const knurl = new THREE.MeshPhysicalMaterial({ color: '#141416', roughness: 0.4, clearcoat: 0.4, clearcoatRoughness: 0.35, flatShading: true })
    const alu = new THREE.MeshPhysicalMaterial({ color: '#aeb1b6', metalness: 1, roughness: 0.24 })
    const chrome = new THREE.MeshPhysicalMaterial({ color: '#eceef0', metalness: 1, roughness: 0.08 })
    const mark = new THREE.MeshStandardMaterial({ color: '#efe9dd', roughness: 0.5 })
    const keys = new THREE.MeshPhysicalMaterial({ color: '#cdc7bb', roughness: 0.58, clearcoat: 0.2, clearcoatRoughness: 0.5 })
    const cable = new THREE.MeshPhysicalMaterial({ color: '#1b1b1d', roughness: 0.42, clearcoat: 0.5, clearcoatRoughness: 0.3 })
    const probeBody = new THREE.MeshPhysicalMaterial({ color: '#2b2b2f', roughness: 0.38, clearcoat: 0.4, clearcoatRoughness: 0.3 })
    const vent = new THREE.MeshStandardMaterial({ color: '#2a2723', roughness: 0.9 })
    this.leds = new THREE.MeshBasicMaterial({ color: this.ledOn.clone() })

    // ---- sleeve + back
    const { w, h, d, r, wall, y0 } = SHELL
    const x0 = -w / 2
    const hole = rrShape(new THREE.Path(), x0 + wall, y0 + wall, -x0 - wall, y0 + h - wall, r - wall + 0.01)
    const sleeve = new THREE.Mesh(plate(x0, y0, -x0, y0 + h, r, -d / 2, d, 0.04, [hole], 16), bone)
    const back = new THREE.Mesh(plate(x0 + wall, y0 + wall, -x0 - wall, y0 + h - wall, r - wall, -d / 2 + 0.04, 0.06, 0), soft)
    o.add(sleeve, back)

    // side vents: a column of slots on each flank, toward the rear
    const slots: THREE.BufferGeometry[] = []
    for (const sx of [-1, 1])
      for (let i = 0; i < 8; i++) {
        const g = new RoundedBoxGeometry(0.03, 0.04, 1.0, 2, 0.015)
        g.translate(sx * (w / 2 - 0.008), 1.02 + i * 0.13, -0.42)
        slots.push(g)
      }
    o.add(new THREE.Mesh(mergeGeometries(slots), vent))

    // chrome carry handle wrapping over the top, pivots on the flanks
    const hz = -0.32
    const hx = w / 2 + 0.07
    const top = y0 + h + 0.07
    const hr = r + 0.07
    const hp: THREE.Vector3[] = []
    hp.push(new THREE.Vector3(-hx, 1.72, hz))
    for (let i = 0; i <= 8; i++) {
      const a = Math.PI - (Math.PI / 2) * (i / 8)
      hp.push(new THREE.Vector3(-hx + hr + Math.cos(a) * hr, top - hr + Math.sin(a) * hr, hz))
    }
    for (let i = 0; i <= 8; i++) {
      const a = Math.PI / 2 - (Math.PI / 2) * (i / 8)
      hp.push(new THREE.Vector3(hx - hr + Math.cos(a) * hr, top - hr + Math.sin(a) * hr, hz))
    }
    hp.push(new THREE.Vector3(hx, 1.72, hz))
    const handle = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(hp, false, 'centripetal'), 120, 0.042, 12)
    const pivots: THREE.BufferGeometry[] = [handle]
    for (const sx of [-1, 1]) {
      const pv = new THREE.CylinderGeometry(0.1, 0.1, 0.06, 28)
      pv.rotateZ(Math.PI / 2)
      pv.translate(sx * (w / 2 + 0.035), 1.72, hz)
      pivots.push(pv)
    }
    o.add(new THREE.Mesh(mergeGeometries(pivots.map(ni)), chrome))

    // feet
    const feet: THREE.BufferGeometry[] = []
    for (const fx of [-1, 1])
      for (const fz of [-1, 1]) {
        const f = new THREE.CylinderGeometry(0.12, 0.13, y0 + 0.02, 24)
        f.translate(fx * 1.72, (y0 + 0.02) / 2, fz * 0.92)
        feet.push(f)
      }
    o.add(new THREE.Mesh(mergeGeometries(feet), soft))

    // ---- faceplate (recessed inside the sleeve lip)
    const fp = new THREE.Mesh(plate(FACE.x0, FACE.y0, FACE.x0 + FACE.w, FACE.y0 + FACE.h, FACE.r, FACE_Z - 0.05, 0.05, 0.008, [], 12), graphite)
    o.add(fp)

    // bezel around the CRT
    const b = SCREEN.bezel
    const sx0 = SCREEN.x0
    const sy0 = SCREEN.y0
    const bezelHole = rrShape(new THREE.Path(), sx0, sy0, sx0 + SCREEN.w, sy0 + SCREEN.h, 0.07)
    const bezel = new THREE.Mesh(plate(sx0 - b, sy0 - b, sx0 + SCREEN.w + b, sy0 + SCREEN.h + b, 0.13, FACE_Z - 0.02, 0.085, 0.014, [bezelHole], 12), soft)
    o.add(bezel)

    // the CRT itself, just behind the bezel lip
    this.screen = new Screen({ samples: mobile ? 360 : 560, overlay: overlayTexture(), envMap })
    this.screen.object.position.set(SCREEN.cx, SCREEN.cy, FACE_Z + 0.004)
    o.add(this.screen.object)

    // ---- knobs: glossy knurled body on a skirt, machined cap, index line
    const skirtG = zCyl(1.2, 1.16, 0.18, 48)
    const bodyG = zCyl(1.0, 0.92, 0.72, 30)
    bodyG.translate(0, 0, 0.18)
    const blackG = mergeGeometries([skirtG, bodyG])
    const capG = zCyl(0.8, 0.8, 0.07, 48)
    capG.translate(0, 0, 0.9)
    const idxG = new THREE.BoxGeometry(0.09, 0.62, 0.03)
    idxG.translate(0, 0.42, 0.985)
    const knobs = {} as Record<keyof typeof KNOBS, THREE.Group>
    for (const [name, k] of Object.entries(KNOBS) as [keyof typeof KNOBS, (typeof KNOBS)[keyof typeof KNOBS]][]) {
      const g = new THREE.Group()
      g.add(new THREE.Mesh(blackG, knurl), new THREE.Mesh(capG, alu), new THREE.Mesh(idxG, mark))
      g.scale.setScalar(k.r)
      g.position.set(k.x, k.y, FACE_Z)
      o.add(g)
      knobs[name] = g
    }
    this.knobs = knobs

    // ---- keys: soft keys, run/autoset, power
    const keyGeos: THREE.BufferGeometry[] = []
    for (const k of SOFTKEYS) {
      const g = new RoundedBoxGeometry(k.w, k.h, 0.06, 2, 0.022)
      g.translate(k.x, k.y, FACE_Z + 0.01)
      keyGeos.push(g)
    }
    for (const k of BUTTONS) {
      const g = new RoundedBoxGeometry(k.w, k.h, 0.07, 2, 0.026)
      g.translate(k.x, k.y, FACE_Z + 0.015)
      keyGeos.push(g)
    }
    const pw = zCyl(POWER.r, POWER.r * 0.94, 0.05, 28)
    pw.translate(POWER.x, POWER.y, FACE_Z)
    keyGeos.push(pw)
    o.add(new THREE.Mesh(mergeGeometries(keyGeos.map(ni)), keys))
    // LEDs: RUN (on the run/stop key) and power
    const led1 = new THREE.SphereGeometry(0.018, 12, 8)
    led1.scale(1, 1, 0.5)
    led1.translate(BUTTONS[0].x - BUTTONS[0].w / 2 + 0.05, BUTTONS[0].y, FACE_Z + 0.052)
    const led2 = new THREE.SphereGeometry(0.014, 12, 8)
    led2.scale(1, 1, 0.5)
    led2.translate(POWER.x, POWER.y + 0.09, FACE_Z + 0.004)
    o.add(new THREE.Mesh(mergeGeometries([led1, led2]), this.leds))

    // ---- BNC inputs with probe plugs + strain reliefs
    const chromeG: THREE.BufferGeometry[] = []
    const reliefG: THREE.BufferGeometry[] = []
    for (const c of BNC) {
      const nut = zCyl(0.078, 0.078, 0.03, 6)
      const barrel = zCyl(0.048, 0.048, 0.1, 24)
      barrel.translate(0, 0, 0.03)
      const plug = zCyl(0.062, 0.062, 0.1, 24)
      plug.translate(0, 0, 0.1)
      for (const g of [nut, barrel, plug]) {
        g.translate(c.x, c.y, FACE_Z)
        chromeG.push(g)
      }
      const relief = zCyl(0.046, 0.03, 0.16, 20)
      relief.translate(c.x, c.y, FACE_Z + 0.19)
      reliefG.push(relief)
    }
    o.add(new THREE.Mesh(mergeGeometries(chromeG), chrome))

    // ---- cables + probes
    const curves: THREE.CatmullRomCurve3[] = []
    const cableGeos: THREE.BufferGeometry[] = []
    const probeGeos: THREE.BufferGeometry[] = []
    const tipGeos: THREE.BufferGeometry[] = []
    const probeSegs: { a: THREE.Vector3; b: THREE.Vector3 }[] = []
    const up = new THREE.Vector3(0, 1, 0)
    const q = new THREE.Quaternion()
    for (const cb of CABLES) {
      const curve = new THREE.CatmullRomCurve3(
        cb.pts.map(p => new THREE.Vector3(...p)),
        false,
        'centripetal',
      )
      curves.push(curve)
      cableGeos.push(new THREE.TubeGeometry(curve, mobile ? 120 : 200, CABLE_R, 10))
      // probe lies on the bench along dir, tail at `at`
      const dir = new THREE.Vector3(...cb.probe.dir).normalize()
      q.setFromUnitVectors(up, dir)
      const place = (g: THREE.BufferGeometry) => {
        g.applyQuaternion(q)
        g.translate(...cb.probe.at)
        return g
      }
      // profile along +y from the tail: relief, body, grip, nose
      const parts: [number, number, number, number][] = [
        // r0, r1, length, start
        [0.03, 0.04, 0.09, 0],
        [0.042, 0.042, 0.3, 0.09],
        [0.046, 0.046, 0.025, 0.2],
        [0.046, 0.046, 0.025, 0.25],
        [0.042, 0.016, 0.08, 0.39],
      ]
      for (const [r0, r1, len, start] of parts) {
        const g = new THREE.CylinderGeometry(r1, r0, len, 22)
        g.translate(0, start + len / 2, 0)
        probeGeos.push(place(g))
      }
      const tip = new THREE.CylinderGeometry(0.003, 0.006, 0.08, 10)
      tip.translate(0, 0.47 + 0.04, 0)
      tipGeos.push(place(tip))
      const ring = new THREE.CylinderGeometry(0.0435, 0.0435, 0.03, 22)
      ring.translate(0, 0.33, 0)
      o.add(new THREE.Mesh(place(ring), new THREE.MeshPhysicalMaterial({ color: cb.ring, roughness: 0.4, clearcoat: 0.4 })))
      const a = new THREE.Vector3(...cb.probe.at)
      probeSegs.push({ a, b: a.clone().addScaledVector(dir, 0.5) })
    }
    o.add(new THREE.Mesh(mergeGeometries([...cableGeos, ...reliefG].map(ni)), cable))
    o.add(new THREE.Mesh(mergeGeometries(probeGeos), probeBody))
    o.add(new THREE.Mesh(mergeGeometries(tipGeos), chrome))

    // ---- bench: contact shadows, lamp pool, CRT spill
    this.floorUniforms.uCables.value = bakeCableShadows(curves, probeSegs)
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(26, 26),
      new THREE.ShaderMaterial({
        uniforms: this.floorUniforms,
        vertexShader: FLOOR_VERT,
        fragmentShader: FLOOR_FRAG,
        transparent: true,
        premultipliedAlpha: true,
        depthWrite: false,
      }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.set(0, 0.0005, 2)
    floor.renderOrder = -1
    o.add(floor)

    // ---- lights: a warm bench lamp (key) + the CRT's own glow on the knobs and bench
    this.key = new THREE.DirectionalLight('#fff1dc', 1.2)
    this.key.position.set(-3.6, 6.2, 5.2)
    this.key.target.position.set(0.2, 1.0, 0.6)
    this.spill = new THREE.PointLight('#1fff8f', 0, 0, 2)
    this.spill.position.set(SCREEN.cx, SCREEN.cy - 0.2, FACE_Z + 0.9)
    o.add(this.key, this.key.target, this.spill)
  }

  /** RUN / power LEDs, 0 dark .. 1 lit */
  setLed(level: number) {
    this.leds.color.copy(this.ledOff).lerp(this.ledOn, level)
  }
}
