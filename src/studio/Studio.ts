import * as THREE from 'three'
import type { Frame } from '../core/types'

/*
 * The shared "acoustic lab" backdrop — replaces a skybox.
 *
 *  - object: a camera-centred backdrop dome with a soft vertical studio
 *    gradient that blends between a bone-white cyclorama (tone 0) and a
 *    graphite room (tone 1).
 *  - envMap: a PMREM of a procedural photo studio (strip lights + one big
 *    overhead softbox + warm bounce card) assigned to scene.environment so
 *    every Standard/Physical material — chrome, vinyl, metal plate — gets
 *    product-shot reflections for free.
 *
 * Chapters set `studio.params` every frame they care (the engine resets them
 * to defaults first); values are damped so cuts never pop.
 */

export interface StudioParams {
  /** 0 = bone-white cyclorama, 1 = graphite room */
  tone: number
  /** scene.environmentIntensity — how strongly chrome/metal reflect the studio */
  envIntensity: number
  /** 0..1 warm amber tint in the backdrop (tape / tube-amp mood) */
  warmth: number
  /** 0..1 radial spotlight falloff on the backdrop (0 = flat cyc) */
  spot: number
}

export const STUDIO_DEFAULTS: StudioParams = { tone: 0, envIntensity: 1, warmth: 0, spot: 0.35 }

const LIGHT = { top: new THREE.Color('#f4f2ed'), mid: new THREE.Color('#ebe7df'), low: new THREE.Color('#d8d3c9') }
const DARK = { top: new THREE.Color('#1c1c1f'), mid: new THREE.Color('#111113'), low: new THREE.Color('#070708') }
const WARM = new THREE.Color('#f2dcc0')

export class Studio {
  object = new THREE.Group()
  envMap: THREE.Texture
  params: StudioParams = { ...STUDIO_DEFAULTS }
  private current: StudioParams = { ...STUDIO_DEFAULTS }
  private uniforms = {
    uTop: { value: new THREE.Color() },
    uMid: { value: new THREE.Color() },
    uLow: { value: new THREE.Color() },
    uSpot: { value: 0.35 },
    uTime: { value: 0 },
  }

  constructor(
    renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    mobile: boolean,
  ) {
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(900, 48, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        toneMapped: false,
        uniforms: this.uniforms,
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          varying vec4 vClip;
          void main() {
            vDir = normalize(position);
            vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            vClip = p;
            gl_Position = p;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uTop, uMid, uLow;
          uniform float uSpot, uTime;
          varying vec3 vDir;
          varying vec4 vClip;
          float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
          void main() {
            float y = vDir.y;
            vec3 c = mix(uMid, uTop, smoothstep(0.0, 0.75, y));
            c = mix(c, uLow, smoothstep(0.0, -0.6, y));
            // soft key-light pool behind the subject, in screen space
            vec2 ndc = vClip.xy / vClip.w;
            float pool = 1.0 - smoothstep(0.0, 1.35, length(ndc * vec2(0.8, 1.0)));
            c *= mix(1.0 - uSpot * 0.35, 1.0 + uSpot * 0.08, pool);
            // dither to kill banding in the long gradients
            c += (hash(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) / 255.0;
            gl_FragColor = vec4(c, 1.0);
          }
        `,
      }),
    )
    dome.frustumCulled = false
    dome.renderOrder = -10
    this.object.add(dome)

    this.envMap = buildStudioEnv(renderer, mobile)
    scene.environment = this.envMap
  }

  /** current (damped) tone, 0 light .. 1 dark — the chrome UI flips on this */
  get tone() {
    return this.current.tone
  }

  resetParams() {
    Object.assign(this.params, STUDIO_DEFAULTS)
  }

  update(frame: Frame, camera: THREE.Camera) {
    const k = 1 - Math.exp(-4 * frame.dt)
    const c = this.current
    for (const key of Object.keys(this.params) as (keyof StudioParams)[]) c[key] += (this.params[key] - c[key]) * k
    const u = this.uniforms
    u.uTop.value.copy(LIGHT.top).lerp(DARK.top, c.tone)
    u.uMid.value.copy(LIGHT.mid).lerp(DARK.mid, c.tone)
    u.uLow.value.copy(LIGHT.low).lerp(DARK.low, c.tone)
    if (c.warmth > 0.001) {
      u.uTop.value.lerp(WARM, c.warmth * 0.25 * (1 - c.tone))
      u.uMid.value.lerp(WARM, c.warmth * 0.35 * (1 - c.tone))
    }
    u.uSpot.value = c.spot
    u.uTime.value = frame.time
    this.scene.environmentIntensity = c.envIntensity
    this.object.position.copy(camera.position)
  }
}

/** Procedural photo studio → PMREM: strip lights, overhead softbox, warm bounce, dark floor. */
function buildStudioEnv(renderer: THREE.WebGLRenderer, mobile: boolean): THREE.Texture {
  const env = new THREE.Scene()
  const room = new THREE.Mesh(
    new THREE.SphereGeometry(20, 32, 16),
    new THREE.MeshBasicMaterial({ color: new THREE.Color('#6e6b66'), side: THREE.BackSide }),
  )
  env.add(room)
  const floor = new THREE.Mesh(new THREE.CircleGeometry(19, 48), new THREE.MeshBasicMaterial({ color: '#1e1d1b' }))
  floor.rotation.x = -Math.PI / 2
  floor.position.y = -6
  env.add(floor)

  const light = (w: number, h: number, intensity: number, color: string, pos: [number, number, number], look = new THREE.Vector3()) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }),
    )
    m.position.set(...pos)
    m.lookAt(look)
    env.add(m)
  }
  // overhead softbox
  light(14, 8, 3.2, '#ffffff', [0, 12, 0])
  // tall strip lights left/right (the long highlights on chrome)
  light(1.2, 16, 6, '#ffffff', [-11, 2, 4])
  light(1.2, 16, 6, '#ffffff', [11, 2, 4])
  // rim strip behind
  light(18, 0.8, 5, '#ffffff', [0, 5, -13])
  // warm bounce card front-low
  light(10, 4, 1.4, '#f3d9b8', [0, -2, 14])
  // a touch of signal green from one side — the studio's LED
  light(3, 3, 1.2, '#00ff85', [-14, -3, -6])

  const pmrem = new THREE.PMREMGenerator(renderer)
  const rt = pmrem.fromScene(env, 0.02, 0.1, 100, { size: mobile ? 128 : 256 })
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
