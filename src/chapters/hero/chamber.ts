import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { rng } from '../../core/math'
import { FIXTURES_Z, FIXTURE_HALF, FIXTURE_Y, LIGHT_GLSL, ROOM, WAVE_GLSL, type WaveUniforms } from './shared'

/*
 * The anechoic chamber: every surface lined with pyramidal foam wedges (one
 * instanced draw), a steel cable-net floor with a walkway, and five ceiling
 * light banks. Wedges deform in the vertex shader as pressure fronts pass:
 * they compress, tilt away from the source and spring back taller (a damped
 * spring with overshoot), with normals transformed analytically so the
 * lighting stays exact.
 */

/** Unit wedge: square base [-.5,.5]² at y = 0, hip-roof ridge along x at y = 1. Flat normals. */
function wedgeGeometry() {
  const r = 0.16
  const A: [number, number, number] = [-0.5, 0, 0.5]
  const B: [number, number, number] = [0.5, 0, 0.5]
  const C: [number, number, number] = [0.5, 0, -0.5]
  const D: [number, number, number] = [-0.5, 0, -0.5]
  const R0: [number, number, number] = [-r, 1, 0]
  const R1: [number, number, number] = [r, 1, 0]
  const tris = [
    // front (+z) trapezoid
    A, B, R1, A, R1, R0,
    // back (-z) trapezoid
    C, D, R0, C, R0, R1,
    // right (+x) triangle
    B, C, R1,
    // left (-x) triangle
    D, A, R0,
  ]
  const pos = new Float32Array(tris.length * 3)
  tris.forEach((v, i) => pos.set(v, i * 3))
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.computeVertexNormals()
  return g
}

const FOAM_VERT = /* glsl */ `
${WAVE_GLSL}
attribute vec3 iBase;
attribute vec3 iN;
attribute vec3 iT;
attribute vec3 iSize; // width, height, seed
varying vec3 vWorld;
varying vec3 vNormal;
varying float vH;
varying float vSeed;
varying float vPress;
void main() {
  vec3 Bt = cross(iT, iN); // keeps the instance frame right-handed (front faces stay front)
  vec3 rel = iBase - uSrc;
  float d = length(rel);
  float s = pressure(d);
  vec3 D = rel - iN * dot(rel, iN);
  D *= inversesqrt(max(dot(D, D), 1e-6));
  vec2 dl = vec2(dot(D, iT), dot(D, Bt));
  // the front lifts the wedge off its backing, squashes it and leans it away
  // from the source; the trough behind sinks it, stretches it and leans it
  // back — a damped spring with overshoot, straight from the wavelet
  float c = 1.0 - 0.3 * s;
  float sh = 0.8 * s;
  float lift = 0.72 * s;
  vec3 p = position;
  vec3 q = vec3(p.x + dl.x * sh * p.y, p.y * c, p.z + dl.y * sh * p.y);
  vec3 n = normal;
  vec3 nq = vec3(n.x, (n.y - sh * (dl.x * n.x + dl.y * n.z)) / c, n.z);
  nq = vec3(nq.x / iSize.x, nq.y / iSize.y, nq.z / iSize.x);
  vec3 W = iBase + iN * lift + iT * (q.x * iSize.x) + iN * (q.y * iSize.y) + Bt * (q.z * iSize.x);
  vec4 wp = modelMatrix * vec4(W, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * (iT * nq.x + iN * nq.y + Bt * nq.z));
  vH = p.y;
  vSeed = iSize.z;
  vPress = s;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

const FOAM_FRAG = /* glsl */ `
${LIGHT_GLSL}
uniform vec3 uFoam;
const vec3 KEY_DIR = vec3(-0.46, 0.72, 0.52);
varying vec3 vWorld;
varying vec3 vNormal;
varying float vH;
varying float vSeed;
varying float vPress;
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n = dot(i, vec3(1.0, 57.0, 113.0));
  vec4 a = fract(sin(vec4(n, n + 1.0, n + 57.0, n + 58.0)) * 43758.5453);
  vec4 b = fract(sin(vec4(n + 113.0, n + 114.0, n + 170.0, n + 171.0)) * 43758.5453);
  vec4 m = mix(a, b, f.z);
  vec2 k = mix(m.xy, m.zw, f.y);
  return mix(k.x, k.y, f.x);
}
void main() {
  vec3 N = normalize(vNormal);
  vec3 P = vWorld;
  // hemispheric bounce: pale room above, darker crevices below
  float hemi = 0.5 + 0.5 * N.y;
  float amb = uAmbient * mix(0.12, 0.3, hemi);
  // a big soft key from front-left: gives every wedge a lit and a shaded side
  float key = max(dot(N, KEY_DIR) * 0.85 + 0.15, 0.0) * 0.5 * uAmbient;
  float light = amb + key + bankLight(P, N) * 0.72;
  // crevice AO (baked by height up the wedge), opened up when a front lifts the foam
  float ao = mix(0.12, 1.0, smoothstep(0.0, 0.95, vH));
  ao = mix(ao, 1.0, clamp(vPress, 0.0, 1.0) * 0.25 * (1.0 - vH));
  // foam micro-texture: open-cell mottling, faded out with distance so it never shimmers
  float dist = length(P - cameraPosition);
  #ifdef MOBILE
  float tex = 1.0;
  #else
  float mottle = vnoise(P * 26.0) * 0.6 + vnoise(P * 61.0) * 0.4;
  float tex = 1.0 + (mottle - 0.5) * 0.16 * (1.0 - smoothstep(4.0, 14.0, dist));
  #endif
  float tint = 1.0 + (vSeed - 0.5) * 0.05;
  vec3 col = uFoam * light * ao * tex * tint;
  // a passing front opens the foam to the light; the trough behind closes it
  col *= 1.0 + 0.45 * clamp(vPress, -0.8, 0.75);
  // the mark's soft contact shadow on the floor foam
  if (P.y < 0.2) col *= markShadow(P, 2.6);
  // chamber haze
  float fog = 1.0 - exp(-max(dist - 9.0, 0.0) * 0.045);
  col = mix(col, uHaze * (0.35 + 0.65 * uAmbient), fog * 0.4);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const WALK_END = 8.3

const NET_VERT = /* glsl */ `
${WAVE_GLSL}
const float WALK_END = ${WALK_END.toFixed(2)};
varying vec3 vWorld;
varying float vWalk;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float walk = 1.0 - smoothstep(0.85, 1.25, abs(wp.x));
  walk *= smoothstep(0.6, 1.0, wp.z) * (1.0 - smoothstep(WALK_END, WALK_END + 0.05, wp.z));
  float d = length(wp.xyz - uSrc);
  wp.y += clamp(pressure(d), -0.6, 0.9) * 0.5 * (1.0 - walk * 0.92);
  vWorld = wp.xyz;
  vWalk = walk;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

const NET_FRAG = /* glsl */ `
${LIGHT_GLSL}
const float WALK_END = ${WALK_END.toFixed(2)};
varying vec3 vWorld;
varying float vWalk;
float gridLine(float x, float lw) {
  float fw = max(fwidth(x), 1e-4);
  float w = clamp(lw, fw, 0.5);
  float d = abs(fract(x + 0.5) - 0.5);
  float c = 1.0 - smoothstep(w * 0.5 - fw * 0.7, w * 0.5 + fw * 0.7, d);
  c *= lw / w;
  return mix(c, lw, smoothstep(0.22, 0.7, fw));
}
float grid(vec2 p, float lw) {
  float a = gridLine(p.x, lw);
  float b = gridLine(p.y, lw);
  return 1.0 - (1.0 - a) * (1.0 - b);
}
void main() {
  vec3 P = vWorld;
  // steel cable net: 40 cm cells of thin cable
  float cable = grid(P.xz / 0.4, 0.045);
  // walkway: perforated galvanised deck plate + dark kick plates at its edges
  vec2 hp = P.xz / 0.09;
  float hole = length(fract(hp) - 0.5);
  vec2 hw = fwidth(hp);
  float hfw = max(hw.x, hw.y);
  // perforations fade to their average before they can alias into moire
  float perf = mix(smoothstep(0.3 - hfw, 0.3 + hfw, hole), 0.72, smoothstep(0.07, 0.22, hfw));
  float deck = 0.2 + 0.8 * perf;
  float edge = 1.0 - smoothstep(0.022, 0.038, abs(abs(P.x) - 0.72));
  edge *= step(0.95, P.z) * step(P.z, WALK_END + 0.02);
  float onDeck = (1.0 - smoothstep(0.7, 0.735, abs(P.x))) * step(0.95, P.z) * step(P.z, WALK_END);
  float cov = mix(cable, deck, onDeck);
  cov = max(cov, edge);
  if (cov < 0.004) discard;
  float light = uAmbient * 0.3 + bankLight(P, vec3(0.0, 1.0, 0.0)) * 0.55;
  vec3 steel = vec3(0.13, 0.13, 0.135);
  steel = mix(steel, vec3(0.42, 0.42, 0.41), onDeck * (1.0 - edge));
  steel = mix(steel, vec3(0.05, 0.05, 0.055), edge);
  vec3 col = steel * (0.55 + light * 0.9);
  col *= markShadow(P, 1.2);
  float dist = length(P - cameraPosition);
  float fog = 1.0 - exp(-max(dist - 9.0, 0.0) * 0.045);
  col = mix(col, uHaze * (0.35 + 0.65 * uAmbient), fog * 0.4);
  gl_FragColor = vec4(col, cov * mix(0.9, 0.4, fog));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const FIX_VERT = /* glsl */ `
attribute float aBank;
attribute float aLens;
varying float vBank;
varying float vLens;
varying vec3 vN;
void main() {
  vBank = aBank;
  vLens = aLens;
  vN = normal;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`
const FIX_FRAG = /* glsl */ `
uniform float uLights[5];
varying float vBank;
varying float vLens;
varying vec3 vN;
void main() {
  float l = 0.0;
  int b = int(vBank + 0.5);
  for (int i = 0; i < 5; i++) if (i == b) l = uLights[i];
  vec3 housing = vec3(0.05, 0.05, 0.055) * (0.6 + 0.4 * max(vN.y, 0.0)) + vec3(0.04) * l;
  vec3 lens = mix(vec3(0.3, 0.3, 0.3), vec3(3.0, 2.95, 2.85), l);
  gl_FragColor = vec4(mix(housing, lens, vLens), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

export interface WedgeInfo {
  /** tip of the wedge at rest (world) */
  tip: THREE.Vector3
  base: THREE.Vector3
  normal: THREE.Vector3
  height: number
}

export class Chamber {
  group = new THREE.Group()
  private foamMat: THREE.ShaderMaterial
  private netMat: THREE.ShaderMaterial
  private fixMat: THREE.ShaderMaterial
  railMat: THREE.MeshStandardMaterial
  /** a few named wedges for callouts */
  anchors: WedgeInfo[] = []
  count = 0

  constructor(mobile: boolean, u: WaveUniforms) {
    const cell = mobile ? 0.82 : 0.6
    const rand = rng(11)

    // ---------------- foam ----------------
    const base: number[] = []
    const nrm: number[] = []
    const tan: number[] = []
    const size: number[] = []
    const surfaces: {
      o: THREE.Vector3
      u: THREE.Vector3
      v: THREE.Vector3
      lu: number
      lv: number
      n: THREE.Vector3
      h: number
      key: string
    }[] = [
      // floor (below the net), ceiling, walls, back wall
      { key: 'floor', o: new THREE.Vector3(-ROOM.x, ROOM.floor, ROOM.back), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 0, 1), lu: ROOM.x * 2, lv: ROOM.front - ROOM.back, n: new THREE.Vector3(0, 1, 0), h: 1.12 },
      { key: 'ceil', o: new THREE.Vector3(-ROOM.x, ROOM.ceil, ROOM.back), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 0, 1), lu: ROOM.x * 2, lv: ROOM.front - ROOM.back, n: new THREE.Vector3(0, -1, 0), h: 1.12 },
      { key: 'left', o: new THREE.Vector3(-ROOM.x, ROOM.floor, ROOM.back), u: new THREE.Vector3(0, 0, 1), v: new THREE.Vector3(0, 1, 0), lu: ROOM.front - ROOM.back, lv: ROOM.ceil - ROOM.floor, n: new THREE.Vector3(1, 0, 0), h: 1.12 },
      { key: 'right', o: new THREE.Vector3(ROOM.x, ROOM.floor, ROOM.back), u: new THREE.Vector3(0, 0, 1), v: new THREE.Vector3(0, 1, 0), lu: ROOM.front - ROOM.back, lv: ROOM.ceil - ROOM.floor, n: new THREE.Vector3(-1, 0, 0), h: 1.12 },
      { key: 'back', o: new THREE.Vector3(-ROOM.x, ROOM.floor, ROOM.back), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 1, 0), lu: ROOM.x * 2, lv: ROOM.ceil - ROOM.floor, n: new THREE.Vector3(0, 0, 1), h: 1.12 },
    ]
    const p = new THREE.Vector3()
    // callout anchors: (surface, u fraction, v fraction)
    const want: [string, number, number][] = [
      ['floor', 0.72, 0.5],
      ['left', 0.44, 0.34],
      ['back', 0.3, 0.62],
    ]
    for (const s of surfaces) {
      const nu = Math.max(1, Math.round(s.lu / cell))
      const nv = Math.max(1, Math.round(s.lv / cell))
      const cu = s.lu / nu
      const cv = s.lv / nv
      const w = Math.min(cu, cv)
      for (let i = 0; i < nu; i++) {
        for (let j = 0; j < nv; j++) {
          p.copy(s.o)
            .addScaledVector(s.u, (i + 0.5) * cu)
            .addScaledVector(s.v, (j + 0.5) * cv)
          base.push(p.x, p.y, p.z)
          nrm.push(s.n.x, s.n.y, s.n.z)
          const t = (i + j) % 2 ? s.u : s.v
          tan.push(t.x, t.y, t.z)
          const h = s.h * (0.96 + rand() * 0.08)
          size.push(w, h, rand())
          for (const [key, fu, fv] of want) {
            if (key === s.key && i === Math.floor(fu * nu) && j === Math.floor(fv * nv)) {
              this.anchors.push({
                base: p.clone(),
                normal: s.n.clone(),
                height: h,
                tip: p.clone().addScaledVector(s.n, h),
              })
            }
          }
        }
      }
    }
    this.count = base.length / 3
    const wedge = wedgeGeometry()
    const geo = new THREE.InstancedBufferGeometry()
    geo.setAttribute('position', wedge.getAttribute('position'))
    geo.setAttribute('normal', wedge.getAttribute('normal'))
    geo.setAttribute('iBase', new THREE.InstancedBufferAttribute(new Float32Array(base), 3))
    geo.setAttribute('iN', new THREE.InstancedBufferAttribute(new Float32Array(nrm), 3))
    geo.setAttribute('iT', new THREE.InstancedBufferAttribute(new Float32Array(tan), 3))
    geo.setAttribute('iSize', new THREE.InstancedBufferAttribute(new Float32Array(size), 3))
    geo.instanceCount = this.count

    this.foamMat = new THREE.ShaderMaterial({
      uniforms: { ...u, uFoam: { value: new THREE.Color('#dcd6ca') } },
      defines: mobile ? { MOBILE: 1 } : {},
      vertexShader: FOAM_VERT,
      fragmentShader: FOAM_FRAG,
    })
    const foam = new THREE.Mesh(geo, this.foamMat)
    foam.frustumCulled = false
    this.group.add(foam)

    // ---------------- cable net + walkway ----------------
    const nx = mobile ? 60 : 96
    const nz = mobile ? 96 : 150
    const netGeo = new THREE.PlaneGeometry(ROOM.x * 2 - 1.4, ROOM.front - ROOM.back - 1.2, nx, nz)
    netGeo.rotateX(-Math.PI / 2)
    netGeo.translate(0, ROOM.netY, (ROOM.front + ROOM.back) / 2)
    this.netMat = new THREE.ShaderMaterial({
      uniforms: { ...u },
      vertexShader: NET_VERT,
      fragmentShader: NET_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const net = new THREE.Mesh(netGeo, this.netMat)
    net.frustumCulled = false
    net.renderOrder = 2
    this.group.add(net)

    // walkway handrails (anodized black)
    const rails: THREE.BufferGeometry[] = []
    const z0 = 1.15
    const z1 = WALK_END
    for (const sx of [-0.72, 0.72]) {
      for (let z = z0; z <= z1 + 0.01; z += 1.55) {
        const post = new THREE.BoxGeometry(0.035, 1.05, 0.035)
        post.translate(sx, 0.525, z)
        rails.push(post)
      }
      for (const y of [1.05, 0.55]) {
        const r = new THREE.BoxGeometry(0.032, y > 1 ? 0.035 : 0.022, z1 - z0 + 0.1)
        r.translate(sx, y, (z0 + z1) / 2)
        rails.push(r)
      }
    }
    this.railMat = new THREE.MeshStandardMaterial({ color: '#161617', metalness: 0.15, roughness: 0.42 })
    const railMesh = new THREE.Mesh(mergeGeometries(rails), this.railMat)
    this.group.add(railMesh)

    // ---------------- ceiling light banks ----------------
    const fix: THREE.BufferGeometry[] = []
    FIXTURES_Z.forEach((z, i) => {
      const housing = new THREE.BoxGeometry(FIXTURE_HALF * 2 + 0.2, 0.09, 0.2)
      housing.translate(0, FIXTURE_Y + 0.06, z)
      const lens = new THREE.BoxGeometry(FIXTURE_HALF * 2, 0.03, 0.13)
      lens.translate(0, FIXTURE_Y, z)
      const tag = (g: THREE.BufferGeometry, isLens: number) => {
        const n = g.getAttribute('position').count
        g.setAttribute('aBank', new THREE.BufferAttribute(new Float32Array(n).fill(i), 1))
        g.setAttribute('aLens', new THREE.BufferAttribute(new Float32Array(n).fill(isLens), 1))
        g.deleteAttribute('uv')
        return g
      }
      fix.push(tag(housing, 0), tag(lens, 1))
      // hanger rods up into the ceiling wedges
      for (const x of [-FIXTURE_HALF * 0.7, FIXTURE_HALF * 0.7]) {
        const rod = new THREE.BoxGeometry(0.018, ROOM.ceil - FIXTURE_Y, 0.018)
        rod.translate(x, (ROOM.ceil + FIXTURE_Y) / 2, z)
        fix.push(tag(rod, 0))
      }
    })
    this.fixMat = new THREE.ShaderMaterial({
      uniforms: { uLights: u.uLights },
      vertexShader: FIX_VERT,
      fragmentShader: FIX_FRAG,
    })
    const fixMesh = new THREE.Mesh(mergeGeometries(fix), this.fixMat)
    this.group.add(fixMesh)
  }
}
