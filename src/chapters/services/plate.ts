import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { PUCK } from './modes'
import { EXT } from './sand'

/*
 * The instrument: a brushed, dark-anodized aluminium plate on a centre post,
 * a chrome socket-head bolt at the drive point, an accelerometer puck with a
 * signal-green LED and its cable, a shaker body below, and a matte floor
 * with a lit pool and the plate's soft shadow (no shadow maps).
 *
 * The plate top is patched (onBeforeCompile) to take contact shadows and
 * occlusion from the sand density target, and to ripple its reflections
 * with the pressure wave / the standing wave of the current mode.
 */

export const THICK = 0.05
export const FLOOR_Y = -0.62
/** height of a settled line of sand, for its shadow length */
const PILE_H = 0.0084

export interface PlateUniforms {
  tDensity: THREE.IUniform<THREE.Texture | null>
  uExt: THREE.IUniform<number>
  /** full length of a grain pile's shadow on the plate, in density-texture uv */
  uShadowOff: THREE.IUniform<THREE.Vector2>
  uWave: THREE.IUniform<THREE.Vector4>
  uTap: THREE.IUniform<THREE.Vector4>
  uModeB: THREE.IUniform<THREE.Vector3>
  uShimmer: THREE.IUniform<number>
  uTime: THREE.IUniform<number>
}

export class Plate {
  group = new THREE.Group()
  uniforms: PlateUniforms
  led: THREE.MeshBasicMaterial
  ledPos = new THREE.Vector3(PUCK.x, 0.046, PUCK.z)
  floorU: { uPool: THREE.IUniform<number>; uShadowOff: THREE.IUniform<THREE.Vector2> }
  /** the post + shaker under the plate, with their resting look (dimmed while edge-on) */
  private under: { mat: THREE.MeshStandardMaterial; color: THREE.Color; env: number }[] = []
  private underLevel = 1

  constructor(light: THREE.Vector3, mobile: boolean) {
    this.uniforms = {
      tDensity: { value: null },
      uExt: { value: EXT },
      uShadowOff: { value: new THREE.Vector2() },
      uWave: { value: new THREE.Vector4(0, 0, 0.12, 0) },
      uTap: { value: new THREE.Vector4(0, 0, 0, 0) },
      uModeB: { value: new THREE.Vector3(1, 2, 1) },
      uShimmer: { value: 0 },
      uTime: { value: 0 },
    }

    /* ---------------- plate ---------------- */
    const plateGeo = new RoundedBoxGeometry(2, THICK, 2, 4, 0.014)
    const plateMat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#34363c'),
      metalness: 0.9,
      roughness: 0.4,
      anisotropy: 0.8,
      anisotropyRotation: 0,
      clearcoat: 0.28,
      clearcoatRoughness: 0.32,
      envMapIntensity: 1,
    })
    const u = this.uniforms
    plateMat.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, u)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
        .replace(
          '#include <fog_vertex>',
          '#include <fog_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNrm = normalize(mat3(modelMatrix) * objectNormal);',
        )
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
          varying vec3 vWPos;
          varying vec3 vWNrm;
          uniform sampler2D tDensity;
          uniform float uExt, uShimmer, uTime;
          uniform vec2 uShadowOff;
          uniform vec4 uWave;
          uniform vec4 uTap;
          uniform vec3 uModeB;
          float pHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
          float pNoise(vec2 p) {
            vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
            return mix(mix(pHash(i), pHash(i + vec2(1, 0)), f.x), mix(pHash(i + vec2(0, 1)), pHash(i + vec2(1, 1)), f.x), f.y);
          }
          // laser-etched scale along the front edge: the etch shows bright bare aluminium
          // fw = fwidth(q), taken by the caller in uniform control flow
          float etch(vec2 q, vec2 fw) {
            if (q.y < 0.915 || q.y > 0.985 || abs(q.x) > 0.905) return 0.0;
            float fx = fw.x, fy = fw.y;
            float d = abs(fract(q.x / 0.05 + 0.5) - 0.5) * 0.05;
            float dMaj = abs(fract(q.x / 0.25 + 0.5) - 0.5) * 0.25;
            float tick = 1.0 - smoothstep(0.0011, 0.0011 + fx, d);
            float major = 1.0 - smoothstep(0.0014, 0.0014 + fx, dMaj);
            float m = tick * step(0.95, q.y) + major * step(0.925, q.y);
            m *= step(q.y, 0.972);
            m += (1.0 - smoothstep(0.0007, 0.0007 + fy, abs(q.y - 0.972)));
            return clamp(m, 0.0, 1.0);
          }
          vec2 modeGrad(vec2 q) {
            float n = uModeB.x, m = uModeB.y, s = uModeB.z;
            float cnx = cos(n * PI * q.x), snx = sin(n * PI * q.x), cmy = cos(m * PI * q.y), smy = sin(m * PI * q.y);
            float cmx = cos(m * PI * q.x), smx = sin(m * PI * q.x), cny = cos(n * PI * q.y), sny = sin(n * PI * q.y);
            return vec2(-n * snx * cmy - s * m * smx * cny, -m * cnx * smy - s * n * cmx * sny);
          }`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          /* glsl */ `#include <roughnessmap_fragment>
          // handling marks: low-frequency roughness variation across the anodizing
          roughnessFactor *= 0.9 + 0.22 * pNoise(vWPos.xz * 5.3 + 4.0) * pNoise(vWPos.xz * vec2(3.0, 23.0) + 1.3) * 1.6;`,
        )
        .replace(
          '#include <normal_fragment_begin>',
          /* glsl */ `#include <normal_fragment_begin>
          if (vWNrm.y > 0.9) {
            vec2 q = vWPos.xz;
            float r = length(q);
            float wq = (r - uWave.x) / (uWave.z * 1.6);
            float env = exp(-wq * wq) * uWave.y;
            vec2 grad = (r > 1e-4 ? q / r : vec2(0.0)) * cos((r - uWave.x) * 46.0) * env * 0.16;
            grad += modeGrad(q) * uShimmer * sin(uTime * 23.0);
            vec2 tq = q - uTap.xy;
            float tr = length(tq);
            float tq2 = (tr - uTap.z) / 0.12;
            float tenv = exp(-tq2 * tq2) * uTap.w;
            grad += (tr > 1e-4 ? tq / tr : vec2(0.0)) * cos((tr - uTap.z) * 52.0) * tenv * 0.3;
            vec3 nW = normalize(vec3(-grad.x, 1.0, -grad.y));
            normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
          }`,
        )
        .replace(
          '#include <opaque_fragment>',
          /* glsl */ `vec2 etchW = fwidth(vWPos.xz);
          if (vWNrm.y > 0.9) {
            vec2 duv = vWPos.xz / uExt * 0.5 + 0.5;
            // grain piles shade the plate away from the key: march a few taps toward
            // the light, so a low raking key draws long, fading streaks
            float sh = 0.0;
            for (int i = 1; i <= 4; i++) {
              float f = float(i) * 0.25;
              float dS = textureLod(tDensity, duv + uShadowOff * f, 0.0).r;
              sh = max(sh, (1.0 - exp(-dS * 0.22)) * (1.12 - 0.4 * f));
            }
            float dNear = textureLod(tDensity, duv, 0.0).r;
            float dAo = textureLod(tDensity, duv, 2.2).r;
            float ao = 1.0 - exp(-(dAo * 0.12 + dNear * 0.1));
            outgoingLight *= (1.0 - 0.72 * min(sh, 1.0)) * (1.0 - 0.5 * ao);
            outgoingLight = mix(outgoingLight, outgoingLight * 1.8 + vec3(0.045, 0.046, 0.05), etch(vWPos.xz, etchW) * 0.75);
          }
          #include <opaque_fragment>`,
        )
    }
    const plate = new THREE.Mesh(plateGeo, plateMat)
    plate.position.y = -THICK / 2
    this.group.add(plate)

    /* ---------------- centre bolt ---------------- */
    const chrome = new THREE.MeshPhysicalMaterial({ color: '#ffffff', metalness: 1, roughness: 0.14, envMapIntensity: 0.75 })
    const satin = new THREE.MeshPhysicalMaterial({ color: '#9c9ca2', metalness: 1, roughness: 0.32, envMapIntensity: 0.6 })
    const black = new THREE.MeshStandardMaterial({ color: '#0d0d0e', metalness: 0.2, roughness: 0.55 })
    const seg = mobile ? 32 : 48
    // a low-profile socket-head screw at the drive point (the shaker's stud is below)
    const washer = new THREE.Mesh(new THREE.CylinderGeometry(0.041, 0.041, 0.003, seg), satin)
    washer.position.y = 0.0015
    const oxide = new THREE.MeshPhysicalMaterial({ color: '#232326', metalness: 1, roughness: 0.34, envMapIntensity: 0.8 })
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.031, 0.014, seg), oxide)
    head.position.y = 0.003 + 0.007
    const socket = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.003, 6), black)
    socket.position.y = 0.017 - 0.001
    this.group.add(washer, head, socket)

    /* ---------------- accelerometer puck + LED + cable ---------------- */
    const anod = new THREE.MeshPhysicalMaterial({ color: '#141417', metalness: 0.6, roughness: 0.4, clearcoat: 0.4 })
    const puck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.052, 0.034, seg), anod)
    puck.position.set(PUCK.x, 0.017, PUCK.z)
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.046, 0.0035, 8, seg), chrome)
    ring.rotation.x = Math.PI / 2
    ring.position.set(PUCK.x, 0.034, PUCK.z)
    this.led = new THREE.MeshBasicMaterial({ color: new THREE.Color('#00ff85').multiplyScalar(6), toneMapped: true })
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.0085, 16, 8), this.led)
    led.position.copy(this.ledPos)
    led.scale.y = 0.6
    // cable leaves the puck, drops off the right edge and runs away along the floor
    const cablePath = new THREE.CatmullRomCurve3([
      new THREE.Vector3(PUCK.x + 0.05, 0.016, PUCK.z + 0.01),
      new THREE.Vector3(PUCK.x + 0.12, 0.012, PUCK.z + 0.05),
      new THREE.Vector3(1.0, 0.008, PUCK.z + 0.12),
      new THREE.Vector3(1.05, -0.08, PUCK.z + 0.16),
      new THREE.Vector3(1.1, -0.45, PUCK.z + 0.24),
      new THREE.Vector3(1.24, FLOOR_Y + 0.01, PUCK.z + 0.4),
      new THREE.Vector3(1.55, FLOOR_Y + 0.008, 0.2),
      new THREE.Vector3(2.0, FLOOR_Y + 0.008, 1.3),
      new THREE.Vector3(2.4, FLOOR_Y + 0.008, 3.2),
    ])
    const cable = new THREE.Mesh(new THREE.TubeGeometry(cablePath, 96, 0.0075, 8, false), black)
    this.group.add(puck, ring, led, cable)

    /* ---------------- post + shaker below ---------------- */
    // own materials, so the hardware can sink into the dark while the plate reads as one line
    const postMat = new THREE.MeshPhysicalMaterial({ color: '#8e8e94', metalness: 1, roughness: 0.36, envMapIntensity: 0.5 })
    const bodyMat = new THREE.MeshStandardMaterial({ color: '#0d0d0e', metalness: 0.2, roughness: 0.55 })
    // satin rather than mirror chrome: a polished ring glares under the plate
    const trimMat = new THREE.MeshPhysicalMaterial({ color: '#6c6c72', metalness: 1, roughness: 0.42, envMapIntensity: 0.3 })
    for (const mat of [postMat, bodyMat, trimMat]) this.under.push({ mat, color: mat.color.clone(), env: mat.envMapIntensity })
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, -FLOOR_Y - 0.2, 24), postMat)
    post.position.y = (-THICK + FLOOR_Y + 0.2) / 2
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.38, 0.22, seg), bodyMat)
    body.position.y = FLOOR_Y + 0.11
    const trim = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.006, 8, seg), trimMat)
    trim.rotation.x = Math.PI / 2
    trim.position.y = FLOOR_Y + 0.22
    this.group.add(post, body, trim)

    /* ---------------- floor: lit pool + soft plate shadow ---------------- */
    this.floorU = {
      uPool: { value: 1 },
      uShadowOff: { value: new THREE.Vector2() },
    }
    const floorMat = new THREE.ShaderMaterial({
      uniforms: this.floorU,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec3 vW;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uPool;
        uniform vec2 uShadowOff;
        varying vec3 vW;
        float sdBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
        void main() {
          vec2 p = vW.xz;
          float r = length(p - vec2(-0.3, -0.6));
          float pool = exp(-r * r / 4.0) * uPool;
          vec3 col = mix(vec3(0.0045, 0.0045, 0.005), vec3(0.085, 0.084, 0.088), pool);
          // plate shadow (penumbra widens away from the plate) + tight contact under the shaker
          float d = sdBox(p - uShadowOff * 0.55, vec2(0.98), 0.06);
          float sh = 1.0 - smoothstep(-0.35, 0.55, d);
          float c = 1.0 - smoothstep(0.3, 0.62, length(p));
          col *= (1.0 - 0.82 * sh) * (1.0 - 0.6 * c);
          float a = 1.0 - smoothstep(2.2, 5.5, length(p));
          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    })
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), floorMat)
    floor.rotation.x = -Math.PI / 2
    floor.position.y = FLOOR_Y
    floor.renderOrder = -1
    this.group.add(floor)
    this.setLight(light)
  }

  /** 0..1 how much the post and shaker under the plate are lit (0 = lost in the dark). */
  setUnder(v: number) {
    if (Math.abs(v - this.underLevel) < 1e-3) return
    this.underLevel = v
    for (const u of this.under) {
      u.mat.color.copy(u.color).multiplyScalar(v)
      u.mat.envMapIntensity = u.env * v
    }
  }

  /** Re-aim the contact shadows for a key light direction (unit, pointing at the light). */
  setLight(light: THREE.Vector3) {
    const y = Math.max(0.06, light.y)
    const h = Math.hypot(light.x, light.z) || 1
    // a grain pile ~8mm tall throws a shadow 8mm / tan(elevation) long (~1.8cm at 25°)
    const len = Math.min(0.07, (PILE_H * h) / y)
    this.uniforms.uShadowOff.value.set(light.x / h, light.z / h).multiplyScalar(len / (2 * EXT))
    this.floorU.uShadowOff.value.set(-light.x, -light.z).multiplyScalar(-FLOOR_Y / Math.max(0.2, light.y))
  }
}
