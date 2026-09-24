import * as THREE from 'three'
import { logoGeometry, logoParts } from '../../logo/logo'
import { FIXTURES_Z, FIXTURE_Y, MARK_POS } from './shared'

/*
 * The Hark mark in liquid chrome, floating in the chamber, with its centre
 * diamond as a separate green LED. The chrome reflects its own chamber-like
 * environment (foam-grey room, ceiling light banks, two tall softboxes behind
 * the camera, dark cable floor) so it reads as polished metal on a pale set.
 * Pressure rings run across its surface from the LED: vertex displacement for
 * the silhouette, and an analytic per-pixel normal perturbation for the
 * reflections (the extruded faces carry no interior vertices).
 */

const MARK_GLSL = /* glsl */ `
uniform float uMPhase;
uniform float uMAmp;
uniform float uMIdle;
uniform float uMTime;
uniform vec2 uMCenter;
const float M_LAMBDA = 0.42;
float mWave(float x) { return x <= 0.0 ? 0.0 : exp(-3.2 * x) * sin(10.053 * x) * 1.7; }
float mWaveD(float x) { return x <= 0.0 ? 0.0 : 1.7 * exp(-3.2 * x) * (10.053 * cos(10.053 * x) - 3.2 * sin(10.053 * x)); }
float markH(vec2 p) {
  float r = length(p - uMCenter);
  float h = uMAmp * mWave(fract(uMPhase - r / M_LAMBDA));
  float t = uMTime;
  h += uMIdle * (sin(p.x * 4.5 + t * 0.8) * sin(p.y * 3.8 - t * 0.6) + 0.45 * sin(p.x * 9.0 - p.y * 8.0 + t * 1.1));
  return h;
}
vec2 markGrad(vec2 p) {
  vec2 d = p - uMCenter;
  float r = length(d);
  float x = fract(uMPhase - r / M_LAMBDA);
  vec2 g = uMAmp * mWaveD(x) * (-1.0 / M_LAMBDA) * d / max(r, 1e-4) * smoothstep(0.0, 0.06, r);
  float t = uMTime;
  float a = p.x * 4.5 + t * 0.8;
  float b = p.y * 3.8 - t * 0.6;
  float c = p.x * 9.0 - p.y * 8.0 + t * 1.1;
  g += uMIdle * vec2(4.5 * cos(a) * sin(b) + 4.05 * cos(c), 3.8 * sin(a) * cos(b) - 3.6 * cos(c));
  return g;
}
`

function buildChromeEnv(renderer: THREE.WebGLRenderer, mobile: boolean) {
  const env = new THREE.Scene()
  const room = new THREE.Mesh(
    new THREE.SphereGeometry(20, 64, 32),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float az = atan(d.x, d.z);
          // foam walls: a sawtooth of lit and shaded wedge faces
          float tri = abs(fract(az * 5.5) - 0.5) * 2.0;
          float row = abs(fract(d.y * 7.0) - 0.5) * 2.0;
          float foam = mix(0.05, 0.42, tri * 0.6 + row * 0.4);
          vec3 c = vec3(foam) * vec3(1.0, 0.97, 0.93);
          // black flags left and right and a dark stage behind the camera
          c *= mix(1.0, 0.25, smoothstep(0.55, 0.9, abs(d.x)));
          c *= mix(1.0, 0.12, smoothstep(0.2, 0.7, d.z));
          // pale ceiling, dark cable floor with the crevices beneath (a crisp horizon)
          c = mix(c, vec3(0.6, 0.58, 0.55), smoothstep(0.5, 0.85, d.y));
          c = mix(c, vec3(0.018), smoothstep(-0.005, -0.03, d.y));
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    }),
  )
  env.add(room)
  const bright = (w: number, h: number, intensity: number, pos: [number, number, number], color = '#ffffff') => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }),
    )
    m.position.set(...pos)
    m.lookAt(0, pos[1], 0)
    env.add(m)
    return m
  }
  // the ceiling banks as the chrome sees them (relative to the mark)
  for (const z of FIXTURES_Z) {
    const b = bright(11, 0.24, 7, [0, FIXTURE_Y - MARK_POS.y, z - MARK_POS.z])
    b.lookAt(0, 0, z - MARK_POS.z)
  }
  // behind the camera: a dark stage with two tall softbox strips, so the faces
  // read as black mirror with crisp white bars (chrome on a pale set needs dark)
  bright(0.8, 8, 2.1, [-4.3, 1.8, 8.4])
  bright(0.4, 8, 1.9, [3.6, 1.8, 8.6])
  bright(6, 0.35, 2.2, [0, -0.35, 8.8])
  // a thin top-rim strip behind the mark
  bright(12, 0.4, 5, [0, 4, -9])
  const pmrem = new THREE.PMREMGenerator(renderer)
  const rt = pmrem.fromScene(env, 0, 0.1, 100, { size: mobile ? 128 : 256 })
  pmrem.dispose()
  env.traverse(o => {
    const m = o as THREE.Mesh
    if (m.isMesh) {
      m.geometry.dispose()
      ;(m.material as THREE.Material).dispose()
    }
  })
  return rt.texture
}

/** Evenly re-space a shape's outline (and holes) by arc length. */
function resample(shape: THREE.Shape, outer: number, hole: number) {
  const out = new THREE.Shape(dedupe(shape.getSpacedPoints(outer)))
  for (const h of shape.holes) out.holes.push(new THREE.Path(dedupe(h.getSpacedPoints(hole))))
  return out
}
function dedupe(pts: THREE.Vector2[]) {
  // getSpacedPoints closes the loop by repeating the first point
  if (pts.length > 1 && pts[0].distanceToSquared(pts[pts.length - 1]) < 1e-10) pts.pop()
  return pts
}

/**
 * ExtrudeGeometry is non-indexed, so its walls come out flat-shaded. Smooth
 * the walls + bevel (group 1) across neighbouring faces within ~50°, keeping
 * the flat caps (group 0) and genuinely sharp corners crisp — the difference
 * between faceted plastic and poured chrome.
 */
function smoothSides(geo: THREE.BufferGeometry) {
  const side = geo.groups.find(g => g.materialIndex === 1)
  if (!side) return
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute
  const buckets = new Map<string, number[]>()
  const q = (v: number) => Math.round(v * 1e5)
  const end = side.start + side.count
  for (let i = side.start; i < end; i++) {
    const k = `${q(pos.getX(i))},${q(pos.getY(i))},${q(pos.getZ(i))}`
    const b = buckets.get(k)
    if (b) b.push(i)
    else buckets.set(k, [i])
  }
  const face = new Float32Array(nrm.array as Float32Array)
  const cos = Math.cos((50 * Math.PI) / 180)
  for (const b of buckets.values()) {
    for (const i of b) {
      let x = 0,
        y = 0,
        z = 0
      const ax = face[i * 3],
        ay = face[i * 3 + 1],
        az = face[i * 3 + 2]
      for (const j of b) {
        const bx = face[j * 3],
          by = face[j * 3 + 1],
          bz = face[j * 3 + 2]
        if (ax * bx + ay * by + az * bz >= cos) {
          x += bx
          y += by
          z += bz
        }
      }
      const l = Math.hypot(x, y, z) || 1
      nrm.setXYZ(i, x / l, y / l, z / l)
    }
  }
  nrm.needsUpdate = true
}

export class Mark {
  root = new THREE.Group()
  chrome: THREE.Mesh
  led: THREE.Mesh
  bezel: THREE.Mesh
  ledMat: THREE.MeshBasicMaterial
  chromeMat: THREE.MeshPhysicalMaterial
  /** LED centre in mark space */
  center = new THREE.Vector2()
  uniforms = {
    uMPhase: { value: 0 },
    uMAmp: { value: 0 },
    uMIdle: { value: 0.004 },
    uMTime: { value: 0 },
    uMCenter: { value: new THREE.Vector2() },
    uLed: { value: 1 },
  }

  constructor(mobile: boolean) {
    const parts = logoParts()
    // the SVG outlines arrive densely sampled; an even arc-length resample keeps
    // the curves smooth at a fraction of the vertices (init runs under the loader)
    const n = mobile ? 150 : 210
    const chromeGeo = logoGeometry({
      shapes: [...parts.loopA, ...parts.loopB].map(sh => resample(sh, n, Math.round(n * 0.42))),
      depth: 0.2,
      bevelSize: 0.014,
      bevelThickness: 0.022,
      curveSegments: 1,
    })
    smoothSides(chromeGeo)
    const ledShapes = parts.diamond.map(sh => resample(sh, 24, 12))
    const ledGeo = logoGeometry({ shapes: ledShapes, depth: 0.25, bevelSize: 0.006, bevelThickness: 0.008, curveSegments: 1 })
    ledGeo.computeBoundingBox()
    const bc = ledGeo.boundingBox!.getCenter(new THREE.Vector3())
    this.center.set(bc.x, bc.y)
    // a black anodised bezel around the LED so the diamond reads crisp against the chrome
    const bezelGeo = logoGeometry({ shapes: ledShapes, depth: 0.215, bevelSize: 0.01, bevelThickness: 0.01, curveSegments: 1 })
    bezelGeo.translate(-bc.x, -bc.y, 0)
    bezelGeo.scale(1.34, 1.34, 1)
    bezelGeo.translate(bc.x, bc.y, 0)
    this.bezel = new THREE.Mesh(bezelGeo, new THREE.MeshStandardMaterial({ color: '#0c0c0d', metalness: 0.2, roughness: 0.32 }))
    this.root.add(this.bezel)
    this.uniforms.uMCenter.value.copy(this.center)

    this.chromeMat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#cfd1d4'),
      metalness: 1,
      roughness: 0.06,
      envMapIntensity: 1,
    })
    const u = this.uniforms
    this.chromeMat.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, u)
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          ${MARK_GLSL}
          varying vec3 vObjPos;
          varying float vObjNz;
          varying vec3 vAxX;
          varying vec3 vAxY;`,
        )
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
          vObjNz = objectNormal.z;
          vAxX = normalize(normalMatrix * vec3(1.0, 0.0, 0.0));
          vAxY = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vObjPos = position;
          transformed.z += markH(position.xy);`,
        )
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          ${MARK_GLSL}
          uniform float uLed;
          varying vec3 vObjPos;
          varying float vObjNz;
          varying vec3 vAxX;
          varying vec3 vAxY;`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          {
            vec2 mg = markGrad(vObjPos.xy);
            normal = normalize(normal - vObjNz * (mg.x * vAxX + mg.y * vAxY));
          }`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          {
            float rr = length(vObjPos.xy - uMCenter);
            totalEmissiveRadiance += vec3(0.0, 1.0, 0.235) * uLed * 0.03 * exp(-rr * 13.0);
          }`,
        )
    }
    this.chrome = new THREE.Mesh(chromeGeo, this.chromeMat)
    this.root.add(this.chrome)

    this.ledMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0, 1, 0.235) })
    this.led = new THREE.Mesh(ledGeo, this.ledMat)
    this.root.add(this.led)
  }

  /** Bake the chrome's own reflection environment (a separate step so init can yield between). */
  attachEnv(renderer: THREE.WebGLRenderer, mobile: boolean) {
    this.chromeMat.envMap = buildChromeEnv(renderer, mobile)
    this.chromeMat.needsUpdate = true
  }

  /** led: HDR multiplier; lit: 0..1 how much the chamber lights reflect */
  set(led: number, lit: number, pop: number) {
    this.ledMat.color.setRGB(0.0, 1, 0.235).multiplyScalar(led)
    this.uniforms.uLed.value = led
    this.chromeMat.envMapIntensity = 0.1 + 0.95 * lit
    this.led.position.z = pop
  }
}
