import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

/*
 * The analyser's bench: printed frequency ruler on the floor, a matte-black
 * anodised rail along the front edge with an aluminium fader cap that pushes
 * the anti-phase front across the field, and one soft contact-shadow pass
 * (field + rail + fader) so nothing floats on the bone floor.
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
uniform vec2 uField;
uniform vec3 uRail;
uniform vec3 uFader;
uniform float uOpacity;
uniform vec3 uCol;
varying vec2 vP;

float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

void main() {
  // the field: a crisp contact line at the fins' feet plus a wide soft skirt
  // (inside the footprint only a light wash: fins cover most of it, and where
  // the waves dip low the floor must not read as holes)
  float sd = sdBox(vP - vec2(0.0, -0.06), uField);
  float sf = max(sd, 0.0);
  float a = sd > 0.0 ? 0.36 * exp(-sf * 7.0) + 0.16 * exp(-sf * 1.1) : mix(0.52, 0.16, smoothstep(0.0, 0.3, -sd));
  // the rail and the fader
  float sr = max(sdBox(vP - vec2(0.0, uRail.y), vec2(uRail.x, 0.09)), 0.0);
  a = 1.0 - (1.0 - a) * (1.0 - (0.55 * exp(-sr * 22.0) + 0.14 * exp(-sr * 4.0)) * uRail.z);
  float sc = max(sdBox(vP - uFader.xy, vec2(0.2, 0.13)), 0.0);
  a = 1.0 - (1.0 - a) * (1.0 - 0.35 * exp(-sc * 9.0) * uFader.z);
  gl_FragColor = vec4(uCol, clamp(a, 0.0, 0.85) * uOpacity);
}
`

/** log-frequency position 0..1 across the audible band */
const fx = (f: number) => (Math.log10(f) - Math.log10(20)) / 3

function drawRuler(c: HTMLCanvasElement) {
  const W = c.width
  const g = c.getContext('2d')!
  g.clearRect(0, 0, W, c.height)
  g.fillStyle = '#0e0e0f'
  g.strokeStyle = '#0e0e0f'
  const pad = 6
  const X = (f: number) => pad + fx(f) * (W - pad * 2)
  // baseline
  g.fillRect(pad, 14, W - pad * 2, 3)
  // minor ticks every 1..9 per decade, majors labelled
  const majors = new Set([20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000])
  for (let dec = 10; dec <= 10000; dec *= 10)
    for (let m = 1; m <= 9; m++) {
      const f = dec * m
      if (f < 20 || f > 20000) continue
      const x = X(f)
      const major = majors.has(f)
      g.fillRect(Math.round(x - (major ? 2 : 1)), 14, major ? 4 : 2, major ? 46 : 24)
    }
  g.fillRect(Math.round(X(20000) - 2), 14, 4, 46)
  g.font = '500 38px "IBM Plex Mono", ui-monospace, monospace'
  g.textBaseline = 'top'
  const label = (f: number) => (f >= 1000 ? `${f / 1000}k` : `${f}`)
  for (const f of majors) {
    const x = X(f)
    const t = label(f)
    const w = g.measureText(t).width
    g.textAlign = 'left'
    g.fillText(t, Math.min(W - pad - w, Math.max(pad, x - w / 2)), 76)
  }
  g.font = '500 30px "IBM Plex Mono", ui-monospace, monospace'
  g.globalAlpha = 0.7
  g.fillText('HZ', pad, 128)
  const tag = 'ANTI-PHASE ANALYSER · CH 04'
  g.fillText(tag, W - pad - g.measureText(tag).width, 128)
  g.globalAlpha = 1
}

/**
 * The printed frequency scale. Drawn at once with whatever mono face is
 * available, then redrawn when Plex Mono arrives (never blocks init).
 */
function rulerTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 2048
  c.height = 176
  drawRuler(c)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  const font = '500 38px "IBM Plex Mono"'
  if (document.fonts && !document.fonts.check(font)) {
    document.fonts
      .load(font)
      .then(() => {
        drawRuler(c)
        tex.needsUpdate = true
      })
      .catch(() => {})
  }
  return tex
}

export class Bench {
  object = new THREE.Group()
  floorUniforms = {
    uField: { value: new THREE.Vector2(5, 3) },
    uRail: { value: new THREE.Vector3(5.3, 4, 1) },
    uFader: { value: new THREE.Vector3(0, 4, 1) },
    uOpacity: { value: 1 },
    uCol: { value: new THREE.Color('#2a2520') },
  }
  ruler: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  rail = new THREE.Group()
  railBody: THREE.Mesh
  fader = new THREE.Group()
  cap = new THREE.Group()
  led: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
  ledColor = new THREE.Color()
  private green = new THREE.Color('#00ff85').multiplyScalar(7)
  private red = new THREE.Color('#ff4a2e').multiplyScalar(5)
  private dim = new THREE.Color('#3a3a3c')
  private fadeables: THREE.Material[] = []
  private faded = -1

  constructor(renderer: THREE.WebGLRenderer) {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.ShaderMaterial({
        uniforms: this.floorUniforms,
        vertexShader: FLOOR_VERT,
        fragmentShader: FLOOR_FRAG,
        transparent: true,
        depthWrite: false,
      }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.renderOrder = -1
    this.object.add(floor)

    this.ruler = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: rulerTexture(renderer),
        transparent: true,
        depthWrite: false,
        opacity: 0.82,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      }),
    )
    this.ruler.rotation.x = -Math.PI / 2
    this.ruler.position.y = 0.002
    this.ruler.renderOrder = 0
    this.object.add(this.ruler)

    // rail: black anodised extrusion with a slot
    const anodised = new THREE.MeshPhysicalMaterial({
      color: 0x1a1a1c,
      metalness: 0.6,
      roughness: 0.36,
      clearcoat: 0.5,
      clearcoatRoughness: 0.25,
    })
    this.railBody = new THREE.Mesh(new RoundedBoxGeometry(1, 0.08, 0.2, 2, 0.03), anodised)
    this.railBody.position.y = 0.04
    const slot = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.004, 0.028),
      new THREE.MeshBasicMaterial({ color: 0x050505 }),
    )
    slot.position.y = 0.081
    slot.name = 'slot'
    this.rail.add(this.railBody, slot)
    this.object.add(this.rail)

    // fader cap: brushed aluminium, a black index groove, one LED
    const alu = new THREE.MeshPhysicalMaterial({ color: 0xd4d5d8, metalness: 1, roughness: 0.26 })
    const body = new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.18, 0.3, 3, 0.045), alu)
    body.position.y = 0.09
    const stem = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.03), anodised)
    stem.position.y = -0.01
    const groove = new THREE.Mesh(
      new THREE.BoxGeometry(0.43, 0.012, 0.03),
      new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.6, metalness: 0.2 }),
    )
    groove.position.set(0, 0.176, 0)
    this.led = new THREE.Mesh(new THREE.SphereGeometry(0.024, 16, 10), new THREE.MeshBasicMaterial({ color: 0xffffff }))
    this.led.position.set(0.13, 0.182, 0.085)
    this.led.scale.y = 0.55
    this.cap.add(body, groove, this.led)
    this.cap.position.y = 0.085
    this.fader.add(stem, this.cap)
    this.object.add(this.fader)
    // always in the transparent pass (opacity 1 until the out-beat) so fading
    // never flips a material's program
    this.fadeables = [anodised, slot.material, alu, groove.material, this.led.material]
    for (const m of this.fadeables) m.transparent = true
  }

  /** out-beat: the hardware dissolves so only the gathered waveform remains */
  fade(opacity: number) {
    const o = Math.round(opacity * 200) / 200
    if (o === this.faded) return
    this.faded = o
    for (const m of this.fadeables) {
      m.opacity = o
      m.depthWrite = o > 0.5
    }
    this.ruler.material.opacity = 0.82 * o
    this.rail.visible = this.fader.visible = this.ruler.visible = o > 0.002
  }

  /**
   * Lay the bench out for the current field size.
   * @param halfW field half width   @param halfD field half depth
   * @param faderU fader position along the rail, -1..1 of the field width
   * @param press 0..1 the cap dipping under a click
   * @param ledState 0 dim, 1 alert (red), 2 anti-phase (green)
   * @param ledLevel 0..1 LED brightness (blink / breathe)
   */
  layout(halfW: number, halfD: number, faderU: number, press: number, ledState: number, ledLevel: number) {
    const railZ = halfD + 1.0
    const railHalf = halfW + 0.3
    this.railBody.scale.x = railHalf * 2
    this.rail.getObjectByName('slot')!.scale.x = railHalf * 2 - 0.12
    this.rail.position.set(0, 0, railZ)
    this.ruler.scale.set(halfW * 2, halfW * 2 * (176 / 2048), 1)
    this.ruler.position.set(0, 0.002, halfD + 0.2 + (halfW * 2 * (176 / 2048)) / 2)
    const x = THREE.MathUtils.clamp(faderU, -1, 1) * halfW
    this.fader.position.set(x, 0.0, railZ)
    this.cap.position.y = 0.085 - press * 0.03
    const u = this.floorUniforms
    u.uField.value.set(halfW, halfD)
    u.uRail.value.set(railHalf, railZ, 1)
    u.uFader.value.set(x, railZ, 1)
    const c = ledState >= 2 ? this.green : ledState >= 1 ? this.red : this.dim
    this.ledColor.copy(this.dim).lerp(c, ledLevel)
    this.led.material.color.copy(this.ledColor)
  }

  /** world position of the fader LED (callout anchor) */
  ledWorld(out: THREE.Vector3) {
    return this.led.getWorldPosition(out)
  }
}
