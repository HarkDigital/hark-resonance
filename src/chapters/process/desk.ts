import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { LAYOUT as L } from './layout'
import { matrixMaterial } from './matrix'
import { panelTexture } from './panel'

/*
 * "The Desk": a four-channel console + master section, built like a product
 * render. Bead-blasted aluminium body and printed faceplate with real fader
 * slots, a matte black anodized meter bridge with three LED dot-matrix
 * readouts behind glass, matte black fader caps, aluminium knobs on rubber
 * skirts, LED meter ladders and analytic soft contact shadows (no shadow maps).
 *
 * ~16 draw calls; everything that moves is instanced.
 */

export const STRIPS = 5 // 4 channels + master
export const LADDERS = 6 // 4 channels + master L/R

export interface DeskState {
  /** fader positions 0..1 (index 4 = master) */
  fader: number[]
  /** knob angles in radians (-2.36..2.36), 9 knobs */
  knob: number[]
  /** meter level + peak-hold 0..1 per ladder */
  level: number[]
  peak: number[]
  /** channel LEDs 0..1 (index 4 = master, 5 = power) */
  led: number[]
}

// ---------------------------------------------------------------- shapes

/** Rounded rect in shape space (x, y); counter-clockwise. */
function rr<T extends THREE.Path>(p: T, x0: number, y0: number, x1: number, y1: number, r: number): T {
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

/**
 * Extrude a rounded rect lying on the desk (x, z) between heights y0..y1.
 * Shape space is (x, -z), extruded up +y.
 */
function slab(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  r: number,
  y0: number,
  y1: number,
  bevel: number,
  holes: THREE.Path[] = [],
  curveSegments = 12,
) {
  const s = rr(new THREE.Shape(), x0 + bevel, -z1 + bevel, x1 - bevel, -z0 - bevel, r - bevel)
  s.holes.push(...holes)
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: Math.max(1e-4, y1 - y0 - bevel * 2),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: bevel > 0 ? 4 : 0,
    curveSegments,
  })
  geo.rotateX(-Math.PI / 2)
  geo.translate(0, y0 + bevel, 0)
  return geo
}

function paint(geo: THREE.BufferGeometry, color: THREE.Color) {
  const n = geo.getAttribute('position').count
  const c = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) color.toArray(c, i * 3)
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3))
  return geo
}

/** Fine bead-blast grain for the metal's roughness (G channel), tiled. */
function grainTexture() {
  const n = 128
  const data = new Uint8Array(n * n * 4)
  let a = 1234567
  for (let i = 0; i < n * n; i++) {
    a = (a * 1664525 + 1013904223) >>> 0
    const v = 205 + ((a >>> 24) % 50)
    data[i * 4] = v
    data[i * 4 + 1] = v
    data[i * 4 + 2] = v
    data[i * 4 + 3] = 255
  }
  const tex = new THREE.DataTexture(data, n, n)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.repeat.set(9, 9)
  tex.needsUpdate = true
  return tex
}

// ---------------------------------------------------------------- shaders

const LED_GREEN = new THREE.Color(0, 1, 0.235)
const LED_WHITE = new THREE.Color(1, 0.96, 0.9)

function meterMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uLevel: { value: new Array(LADDERS).fill(0) },
      uPeak: { value: new Array(LADDERS).fill(0) },
      uGain: { value: 1 },
    },
    toneMapped: false,
    vertexShader: /* glsl */ `
      attribute vec2 aMeter;
      uniform float uLevel[${LADDERS}];
      uniform float uPeak[${LADDERS}];
      varying float vLit;
      varying float vWhite;
      varying vec3 vN;
      varying vec2 vUv;
      const float N = ${L.segments.toFixed(1)};
      void main() {
        int li = int(aMeter.x + 0.5);
        float lv = uLevel[li];
        float pk = uPeak[li];
        // fractional top segment → smooth ballistics
        float lit = clamp(lv * N - aMeter.y, 0.0, 1.0);
        float pkSeg = floor(clamp(pk, 0.0, 0.9999) * N);
        lit = max(lit, step(abs(aMeter.y - pkSeg), 0.1) * step(0.03, pk) * 0.9);
        vLit = lit;
        vWhite = step(N - 2.5, aMeter.y);
        vN = normal;
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uGain;
      varying float vLit;
      varying float vWhite;
      varying vec3 vN;
      varying vec2 vUv;
      void main() {
        vec3 on = mix(vec3(${LED_GREEN.r}, ${LED_GREEN.g}, ${LED_GREEN.b}) * 2.1,
                      vec3(${LED_WHITE.r}, ${LED_WHITE.g}, ${LED_WHITE.b}) * 1.7, vWhite);
        // lens: brighter core, soft edge
        vec2 q = abs(vUv - 0.5) * 2.0;
        float lens = 1.0 - 0.45 * max(q.x * q.x, q.y * q.y);
        float top = step(0.5, vN.y);
        vec3 off = mix(vec3(0.018, 0.02, 0.019), vec3(0.05, 0.052, 0.05), vWhite) * (0.6 + 0.4 * top);
        vec3 col = mix(off, on * lens * uGain, vLit);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  })
}

function blobMaterial(opacity: number) {
  return new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: opacity } },
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float a = pow(clamp(1.0 - r, 0.0, 1.0), 2.2);
        gl_FragColor = vec4(0.012, 0.011, 0.01, a * uOpacity);
      }
    `,
  })
}

/** Analytic soft contact shadow for the whole unit on the cyc floor. */
function floorShadow() {
  const size = new THREE.Vector2(L.W + 7, L.D + 7)
  const geo = new THREE.PlaneGeometry(size.x, size.y)
  geo.rotateX(-Math.PI / 2)
  const mat = new THREE.ShaderMaterial({
    uniforms: { uStrength: { value: 1 } },
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() { vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float uStrength;
      varying vec2 vP;
      float sdRR(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
      void main() {
        // body footprint (a hair inside the silhouette: the plinth is inset)
        float d = sdRR(vP, vec2(${(L.W / 2 - 0.05).toFixed(3)}, ${(L.D / 2 - 0.05).toFixed(3)}), ${L.corner.toFixed(3)});
        // the key light is overhead and a touch forward → the soft part leans back
        float dSoft = sdRR(vP - vec2(0.0, -0.18), vec2(${(L.W / 2 - 0.2).toFixed(3)}, ${(L.D / 2 - 0.1).toFixed(3)}), 0.5);
        float contact = 1.0 - smoothstep(-0.03, 0.05, d);
        float near = exp(-max(d, 0.0) * 9.0);
        float soft = exp(-max(dSoft, 0.0) * 1.6);
        float wide = exp(-max(dSoft, 0.0) * 0.55);
        float a = contact * 0.92 + near * 0.5 + soft * 0.3 + wide * 0.12;
        a = clamp(a, 0.0, 0.94) * uStrength;
        gl_FragColor = vec4(0.035, 0.032, 0.028, a);
      }
    `,
  })
  const m = new THREE.Mesh(geo, mat)
  m.position.y = 0.001
  m.renderOrder = -1
  return m
}

// ---------------------------------------------------------------- desk

export class Desk {
  group = new THREE.Group()
  displays: ReturnType<typeof matrixMaterial>[] = []
  private caps: THREE.InstancedMesh
  private capShadows: THREE.InstancedMesh
  private knobCaps: THREE.InstancedMesh
  private knobMarks: THREE.InstancedMesh
  private leds: THREE.InstancedMesh
  private meters: THREE.InstancedMesh
  meterMat: THREE.ShaderMaterial
  alu: THREE.MeshPhysicalMaterial
  plateMat: THREE.MeshPhysicalMaterial
  private knobPos: [number, number, number][] = []
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private v = new THREE.Vector3()
  private s = new THREE.Vector3()
  private c = new THREE.Color()
  private up = new THREE.Vector3(0, 1, 0)
  /** world-space anchors for HUD / camera */
  anchors = {
    display: [] as THREE.Vector3[],
    displayEdge: [] as THREE.Vector3[],
  }

  constructor(mobile: boolean) {
    const g = this.group

    // ---- materials
    const grain = grainTexture()
    this.alu = new THREE.MeshPhysicalMaterial({ color: '#c6c9cd', metalness: 1, roughness: 0.46, roughnessMap: grain })
    const { tex } = panelTexture(mobile)
    this.plateMat = new THREE.MeshPhysicalMaterial({
      color: '#dde0e4',
      metalness: 1,
      roughness: 0.55,
      roughnessMap: grain,
      map: tex,
      metalnessMap: tex,
    })
    const rubber = new THREE.MeshStandardMaterial({ color: '#0d0d0e', roughness: 0.82, metalness: 0 })
    const anodized = new THREE.MeshPhysicalMaterial({
      color: '#18191b',
      metalness: 0.55,
      roughness: 0.44,
      clearcoat: 0.25,
      clearcoatRoughness: 0.5,
    })
    const glass = new THREE.MeshPhysicalMaterial({
      color: '#020203',
      metalness: 0,
      roughness: 0.08,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
    })
    const bed = new THREE.MeshBasicMaterial({ color: '#050505' })

    // ---- body, plinth, faceplate
    g.add(new THREE.Mesh(slab(-L.W / 2 + 0.09, -L.D / 2 + 0.09, L.W / 2 - 0.09, L.D / 2 - 0.09, 0.1, 0, L.plinthH + 0.01, 0), rubber))
    g.add(
      new THREE.Mesh(
        slab(-L.W / 2, -L.D / 2, L.W / 2, L.D / 2, L.corner, L.plinthH, L.bodyTop, 0.032, [], 16),
        this.alu,
      ),
    )
    const slotXs = [...L.channels.map(cx => cx + L.slotDX), L.masterX]
    const pb = 0.004
    const holes = slotXs.map(sx =>
      rr(new THREE.Path(), sx - L.slotW / 2 - pb, -L.slotZ1 - pb, sx + L.slotW / 2 + pb, -L.slotZ0 + pb, L.slotW / 2),
    )
    const plate = new THREE.Mesh(
      slab(L.plateX0, L.plateZ0, L.plateX1, L.plateZ1, 0.1, L.bodyTop, L.plateTop, pb, holes, 10),
      [this.plateMat, this.alu],
    )
    g.add(plate)
    // black beds under the slots so they read as deep cuts
    const beds = slotXs.map(sx => {
      const p = new THREE.PlaneGeometry(L.slotW + 0.03, L.slotZ1 - L.slotZ0 + 0.03)
      p.rotateX(-Math.PI / 2)
      p.translate(sx, L.bodyTop + 0.002, (L.slotZ0 + L.slotZ1) / 2)
      return p
    })
    g.add(new THREE.Mesh(mergeGeometries(beds), bed))

    // ---- meter bridge: side profile extruded across the desk
    const rise = L.bridgeTop - L.bodyTop
    const zTopFront = L.bridgeZ0 - rise * Math.tan(L.bridgeTilt)
    const prof = new THREE.Shape()
    const f = 0.04 // fillet
    // shape space: (x = -z, y = y)
    // face runs from (bridgeZ0 at bodyTop) up at exactly bridgeTilt; start it a little below the body top
    const zBottom = L.bridgeZ0 + 0.03 * Math.tan(L.bridgeTilt)
    prof.moveTo(-zBottom, L.bodyTop - 0.03)
    const tx = Math.sin(L.bridgeTilt)
    const ty = Math.cos(L.bridgeTilt)
    prof.lineTo(-zTopFront - tx * f, L.bridgeTop - ty * f)
    prof.quadraticCurveTo(-zTopFront, L.bridgeTop, -zTopFront + f, L.bridgeTop)
    prof.lineTo(-L.bridgeZ1 - f, L.bridgeTop)
    prof.quadraticCurveTo(-L.bridgeZ1, L.bridgeTop, -L.bridgeZ1, L.bridgeTop - f)
    prof.lineTo(-L.bridgeZ1, L.bodyTop - 0.03)
    prof.lineTo(-zBottom, L.bodyTop - 0.03)
    const bb = 0.018
    const bw = L.plateW - 0.02
    const bridgeGeo = new THREE.ExtrudeGeometry(prof, {
      depth: bw - bb * 2,
      bevelEnabled: true,
      bevelThickness: bb,
      bevelSize: bb,
      bevelSegments: 4,
      curveSegments: 6,
    })
    bridgeGeo.rotateY(Math.PI / 2)
    bridgeGeo.translate(-(bw - bb * 2) / 2, 0, 0)
    g.add(new THREE.Mesh(bridgeGeo, anodized))

    // ---- displays on the tilted face, behind glass
    const n = new THREE.Vector3(0, Math.sin(L.bridgeTilt), Math.cos(L.bridgeTilt))
    const along = new THREE.Vector3(0, Math.cos(L.bridgeTilt), -Math.sin(L.bridgeTilt))
    const faceBase = new THREE.Vector3(0, L.bodyTop - 0.03, zBottom).addScaledVector(n, bb)
    const faceLen = (rise + 0.03) / Math.cos(L.bridgeTilt)
    const center = faceBase.clone().addScaledVector(along, faceLen * 0.52)
    const bezelGeo = new THREE.PlaneGeometry(L.displayW + 0.1, L.displayH + 0.1)
    const dispGeo = new THREE.PlaneGeometry(L.displayW, L.displayH)
    const texts = ['10 YRS', '$1M+', '15']
    L.displayX.forEach((x, i) => {
      const bezel = new THREE.Mesh(bezelGeo, glass)
      bezel.position.copy(center).setX(x).addScaledVector(n, 0.003)
      bezel.rotation.x = -L.bridgeTilt
      g.add(bezel)
      const mat = matrixMaterial(texts[i], i * 1.7 + 0.3)
      const d = new THREE.Mesh(dispGeo, mat)
      d.position.copy(center).setX(x).addScaledVector(n, 0.0055)
      d.rotation.x = -L.bridgeTilt
      d.renderOrder = 2
      g.add(d)
      this.displays.push(mat)
      this.anchors.display.push(d.position.clone())
      this.anchors.displayEdge.push(
        d.position.clone().addScaledVector(along, -L.displayH / 2 - 0.05),
        d.position.clone().setX(x - L.displayW / 2),
        d.position.clone().setX(x + L.displayW / 2),
      )
    })

    // ---- meter windows (black glass strips) + LED ladders
    const meterXs = [...L.channels.map(cx => cx + L.meterDX), ...L.masterMeters]
    const winGeo = new THREE.BoxGeometry(L.meterW + 0.034, 0.004, L.meterZ1 - L.meterZ0 + 0.04)
    const wins = new THREE.InstancedMesh(winGeo, glass, LADDERS)
    meterXs.forEach((x, i) => {
      this.m.makeTranslation(x, L.plateTop + 0.002, (L.meterZ0 + L.meterZ1) / 2)
      wins.setMatrixAt(i, this.m)
    })
    g.add(wins)

    const pitch = (L.meterZ1 - L.meterZ0) / L.segments
    const segGeo = new THREE.BoxGeometry(L.meterW, 0.004, pitch * 0.68)
    const count = LADDERS * L.segments
    const meterAttr = new Float32Array(count * 2)
    this.meterMat = meterMaterial()
    this.meters = new THREE.InstancedMesh(segGeo, this.meterMat, count)
    let k = 0
    meterXs.forEach((x, li) => {
      const w = li >= 4 ? 0.7 : 1
      for (let sgm = 0; sgm < L.segments; sgm++) {
        const z = L.meterZ1 - (sgm + 0.5) * pitch
        this.m.compose(this.v.set(x, L.plateTop + 0.0045, z), this.q.identity(), this.s.set(w, 1, 1))
        this.meters.setMatrixAt(k, this.m)
        meterAttr[k * 2] = li
        meterAttr[k * 2 + 1] = sgm
        k++
      }
    })
    segGeo.setAttribute('aMeter', new THREE.InstancedBufferAttribute(meterAttr, 2))
    g.add(this.meters)

    // ---- fader caps: matte black, a paper-white line across the top, a stem into the slot
    const capH = 0.085
    const capBody = paint(new RoundedBoxGeometry(0.2, capH, 0.13, 3, 0.026), new THREE.Color(0.032, 0.032, 0.034))
    capBody.deleteAttribute('uv')
    const line = paint(new THREE.BoxGeometry(0.16, 0.003, 0.011), new THREE.Color(0.9, 0.88, 0.84))
    line.translate(0, capH / 2 + 0.0008, 0)
    line.deleteAttribute('uv')
    const stem = paint(new THREE.BoxGeometry(0.014, 0.05, 0.04), new THREE.Color(0.06, 0.06, 0.065))
    stem.translate(0, -capH / 2 - 0.02, 0)
    stem.deleteAttribute('uv')
    const capGeo = mergeGeometries([capBody.index ? capBody.toNonIndexed() : capBody, line.toNonIndexed(), stem.toNonIndexed()])
    capGeo.translate(0, L.plateTop + 0.012 + capH / 2, 0)
    this.caps = new THREE.InstancedMesh(
      capGeo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0 }),
      STRIPS,
    )
    this.caps.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    g.add(this.caps)

    // ---- knobs: black rubber skirt + machined aluminium cap + indicator
    const skirt = new THREE.LatheGeometry(
      [new THREE.Vector2(0.0, 0.0), new THREE.Vector2(0.088, 0), new THREE.Vector2(0.09, 0.012), new THREE.Vector2(0.082, 0.02), new THREE.Vector2(0.0, 0.02)].map(
        v => v,
      ),
      40,
    )
    const capProfile = [
      new THREE.Vector2(0.0, 0.02),
      new THREE.Vector2(0.068, 0.02),
      new THREE.Vector2(0.068, 0.072),
      new THREE.Vector2(0.064, 0.079),
      new THREE.Vector2(0.056, 0.082),
      new THREE.Vector2(0.0, 0.083),
    ]
    const knobCapGeo = new THREE.LatheGeometry(capProfile, 40)
    const knobMarkGeo = new THREE.BoxGeometry(0.009, 0.003, 0.042)
    knobMarkGeo.translate(0, 0.0835, -0.026)
    L.channels.forEach(cx => L.knobZ.forEach(z => this.knobPos.push([cx, z, 1])))
    this.knobPos.push([L.levelKnob[0], L.levelKnob[1], L.levelKnobR / L.knobR])
    const nk = this.knobPos.length
    const skirts = new THREE.InstancedMesh(skirt, rubber, nk)
    this.knobCaps = new THREE.InstancedMesh(knobCapGeo, new THREE.MeshPhysicalMaterial({ color: '#c8cbcf', metalness: 1, roughness: 0.22 }), nk)
    this.knobMarks = new THREE.InstancedMesh(knobMarkGeo, rubber, nk)
    this.knobPos.forEach(([x, z, sc], i) => {
      this.m.compose(this.v.set(x, L.plateTop, z), this.q.identity(), this.s.setScalar(sc))
      skirts.setMatrixAt(i, this.m)
    })
    g.add(skirts, this.knobCaps, this.knobMarks)

    // ---- small status LEDs
    const ledGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.008, 16)
    ledGeo.translate(0, L.plateTop + 0.004, 0)
    this.leds = new THREE.InstancedMesh(ledGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), STRIPS + 1)
    const ledAt: [number, number][] = [
      ...L.channels.map(cx => [cx - L.stripW / 2 + 0.165, L.nameZ - 0.075] as [number, number]),
      [L.channels[3] + L.stripW / 2 + 0.2, L.nameZ - 0.075],
      [L.logoAt[0] + 0.66, L.logoAt[1] - 0.035],
    ]
    ledAt.forEach(([x, z], i) => {
      this.m.makeTranslation(x, 0, z)
      this.leds.setMatrixAt(i, this.m)
      this.leds.setColorAt(i, this.c.setRGB(0.02, 0.02, 0.02))
    })
    g.add(this.leds)

    // ---- screws on the faceplate corners
    const screwGeo = new THREE.CylinderGeometry(0.022, 0.024, 0.006, 20)
    screwGeo.translate(0, L.plateTop + 0.002, 0)
    const screwPts: [number, number][] = [
      [L.plateX0 + 0.08, L.plateZ0 + 0.08],
      [L.plateX1 - 0.08, L.plateZ0 + 0.08],
      [L.plateX0 + 0.08, L.plateZ1 - 0.08],
      [L.plateX1 - 0.08, L.plateZ1 - 0.08],
      [L.channels[3] + L.stripW / 2, L.plateZ0 + 0.08],
      [L.channels[3] + L.stripW / 2, L.plateZ1 - 0.08],
    ]
    const screws = new THREE.InstancedMesh(
      screwGeo,
      new THREE.MeshPhysicalMaterial({ color: '#3a3b3e', metalness: 1, roughness: 0.3 }),
      screwPts.length,
    )
    screwPts.forEach(([x, z], i) => {
      this.m.makeTranslation(x, 0, z)
      screws.setMatrixAt(i, this.m)
    })
    g.add(screws)

    // ---- contact shadows: whole unit on the floor, caps and knobs on the plate
    g.add(floorShadow())
    const blob = new THREE.PlaneGeometry(1, 1)
    blob.rotateX(-Math.PI / 2)
    this.capShadows = new THREE.InstancedMesh(blob, blobMaterial(0.55), STRIPS)
    this.capShadows.renderOrder = 1
    g.add(this.capShadows)
    const knobShadows = new THREE.InstancedMesh(blob, blobMaterial(0.45), nk)
    this.knobPos.forEach(([x, z, sc], i) => {
      this.m.compose(this.v.set(x, L.plateTop + 0.0012, z + 0.012), this.q.identity(), this.s.set(0.27 * sc, 1, 0.27 * sc))
      knobShadows.setMatrixAt(i, this.m)
    })
    knobShadows.renderOrder = 1
    g.add(knobShadows)
  }

  update(st: DeskState, time: number) {
    const faderXs = [...L.channels.map(cx => cx + L.slotDX), L.masterX]
    for (let i = 0; i < STRIPS; i++) {
      const z = L.travelZ(st.fader[i])
      const w = i === 4 ? 1.12 : 1
      this.m.compose(this.v.set(faderXs[i], 0, z), this.q.identity(), this.s.set(w, 1, 1))
      this.caps.setMatrixAt(i, this.m)
      this.m.compose(this.v.set(faderXs[i], L.plateTop + 0.0012, z + 0.018), this.q.identity(), this.s.set(0.34 * w, 1, 0.26))
      this.capShadows.setMatrixAt(i, this.m)
    }
    this.caps.instanceMatrix.needsUpdate = true
    this.capShadows.instanceMatrix.needsUpdate = true

    for (let i = 0; i < this.knobPos.length; i++) {
      const [x, z, sc] = this.knobPos[i]
      this.q.setFromAxisAngle(this.up, -st.knob[i])
      this.m.compose(this.v.set(x, L.plateTop, z), this.q, this.s.setScalar(sc))
      this.knobCaps.setMatrixAt(i, this.m)
      this.knobMarks.setMatrixAt(i, this.m)
    }
    this.knobCaps.instanceMatrix.needsUpdate = true
    this.knobMarks.instanceMatrix.needsUpdate = true

    const lv = this.meterMat.uniforms.uLevel.value as number[]
    const pk = this.meterMat.uniforms.uPeak.value as number[]
    for (let i = 0; i < LADDERS; i++) {
      lv[i] = st.level[i]
      pk[i] = st.peak[i]
    }

    for (let i = 0; i < STRIPS + 1; i++) {
      const on = st.led[i]
      // dark lens when off, HDR green when lit (blooms a little)
      this.c.setRGB(0.03 + LED_GREEN.r * on * 2.6, 0.03 + LED_GREEN.g * on * 2.6, 0.03 + LED_GREEN.b * on * 2.6)
      this.leds.setColorAt(i, this.c)
    }
    if (this.leds.instanceColor) this.leds.instanceColor.needsUpdate = true

    for (const d of this.displays) d.uniforms.uTime.value = time
  }
}
