import * as THREE from 'three'
import './work.css'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { SECTIONS, WORK, workImage, type WorkItem } from '../../content'
import { clamp, ease, lerp, segment, smoothstep } from '../../core/math'
import { Callout, el, rise, setRise } from '../../core/dom'
import { CRATE, LABEL_R, RECORD_R, crateGeometry, recordGeometry, shadowQuad, sleeveGeometry } from './geometry'
import { IMG, drawBack, drawFront, drawInner, drawLabel, drawPlate, loadFonts, type SleeveSpec } from './art'
import {
  RECORD_LIGHTS,
  crateMaterial,
  recordMaterial,
  shadowMaterial,
  sharedSleeve,
  sleeveMaterial,
  type RecordUniforms,
  type SleeveUniforms,
} from './materials'

/*
 * WORK — "The Crate".
 *
 * A record-shop browser bin in black anodized aluminium on the bone cyc. Every
 * project is a 12" sleeve in a house series (HRK–001…): the six featured
 * sleeves up front, the nine more behind them, a white-sleeved house pressing
 * at the very back.
 *
 *   0.00–0.05  in-beat: the pressure wave from the cut runs through the crate
 *              (every sleeve jostles, front to back) as the camera cranes down
 *   0.00–0.074 "Selected work / Built to be heard." over a crate-digger's view
 *   0.06–0.845 six featured projects, 0.13 each: the sleeve lifts out and
 *              turns to camera, the record slides out and spins at 33⅓ (the
 *              groove highlights hold still while the label turns), the credits
 *              rise; then the record slides home, the sleeve drops back and
 *              flips forward on its bottom edge onto the stack (it falls,
 *              bounces, the stack beneath recoils)
 *   0.848–0.93 "Nine more, all live.": a fast riffle. Each name lights while
 *              its sleeve stands face-out at the front of the bin, then the
 *              sleeve tips forward and the next name lights
 *   0.92–1.00  out-beat, into LINER NOTES (graphite): the white-sleeved house
 *              pressing rises, its black-label record slides up out of the inner
 *              sleeve and spins up to a blur while the camera pushes onto the
 *              grooves and label and the room drops to graphite, so the ripple
 *              (centred on the spindle) lands on a dark frame
 *
 * Side A of the story is tracks 01–04 (this is 02), so every print here says
 * SIDE A. Keyboard focus on a project lands on its sleeve (Chapter.anchors).
 *
 * Scroll decides where every sleeve SHOULD be; the flips themselves are
 * real-time physics (gravity, bounce, stack recoil) that always settle, so any
 * jump lands on a resolved crate.
 */

const FEATURED = WORK.filter(w => w.featured).slice(0, 6)
const REST = WORK.filter(w => !w.featured).slice(0, 9)
const NF = FEATURED.length
const NR = REST.length
const HOUSE = NF + NR
const NS = HOUSE + 1

// ---- timeline (local progress)
const F0 = 0.09
const F1 = 0.845
const FW = (F1 - F0) / NF
const slotStart = (k: number) => F0 + FW * k
/** phases inside one featured slot (0..1) */
const PH = {
  rise: [0, 0.22] as const,
  out: [0.12, 0.3] as const,
  hudOn: 0.18,
  hudOff: 0.78,
  home: [0.66, 0.79] as const,
  fall: [0.8, 0.915] as const,
  flip: 0.905,
  camIn: 0.22,
  camOut: 0.8,
}
const INTRO_OFF = 0.088
const MORE = [0.848, 0.93] as const
/** the nine: name j is up front (its sleeve standing, face out) from R0 + j·RSTEP until it goes over */
const R0 = 0.852
const RSTEP = 0.0072
const flipAt = (j: number) => R0 + (j + 1) * RSTEP
/** the camera is over the riffle by here */
const RIFFLE_CAM = 0.852
const FIN = {
  cam: [0.918, 0.948] as const,
  rise: [0.92, 0.954] as const,
  out: [0.932, 0.962] as const,
  /** the empty inner sleeve falls away beneath the record */
  drop: [0.956, 0.978] as const,
  spin: [0.94, 1] as const,
  push: [0.948, 0.978] as const,
  /** the room goes to graphite for Liner Notes, ahead of the ripple */
  dark: [0.934, 0.976] as const,
}
/** how far the house record slides up out of its inner sleeve (fully clear) */
const HOUSE_SLIDE = 1.0
const HOUSE_LABEL = '#1b1b1e'

// ---- crate layout
const Y0 = CRATE.y0
const zUp = (i: number) => 0.02 - i * 0.034
const zStack = (i: number) => 0.16 - i * 0.024
const TH0 = Math.atan((CRATE.zFront - CRATE.wall - 0.16) / (CRATE.frontH - Y0)) - 0.016
const thStack = (i: number) => Math.atan(Math.tan(TH0) + i * 0.045)

// ---- presentation
const PRESENT = new THREE.Vector3(0, 1.88, 0.78)
const HOUSE_AT = new THREE.Vector3(0, 2.0, 0.1)
const SLIDE = 0.56
const YAW = [9, -6, 8, -8, 6, -4]
const PITCH = 16
const DEG = Math.PI / 180
const UP = new THREE.Vector3(0, 1, 0)
const RPM33 = (33.333 / 60) * Math.PI * 2

const PAPER_F = ['#eeeae1', '#141416', '#e8e2d5', '#f1eee8', '#161619', '#ebe5d9']
const INK_F = [false, true, false, false, true, false]
const PAPER_R = ['#efebe3', '#e6e1d6', '#161618', '#f0ede6', '#e9e3d7', '#eeeae2', '#151517', '#ebe7de', '#e7e2d8']
const INK_R = [false, false, true, false, false, false, true, false, false]

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
const catOf = (i: number) => `HRK–${pad(i + 1, 3)}`
const isPreview = (url: string) => {
  try {
    return /(^|\.)harktest\.com$/i.test(new URL(url).hostname)
  } catch {
    return false
  }
}
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
const srcOf = (item: WorkItem) => (isPreview(item.url) ? 'Preview build' : hostOf(item.url))
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
/** "City Line Capital" -> "City Line <em>Capital</em>" */
const emLast = (name: string) => {
  const parts = name.split(' ')
  if (parts.length < 2) return `<em>${escapeHtml(name)}</em>`
  const last = parts.pop()!
  return `${escapeHtml(parts.join(' '))} <em>${escapeHtml(last)}</em>`
}
const outBack = (t: number, s = 1.2) => {
  const c3 = s + 1
  return 1 + c3 * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2)
}
const dirOf = (yaw: number, pitch: number, out: THREE.Vector3) =>
  out.set(-Math.sin(yaw * DEG) * Math.cos(pitch * DEG), -Math.sin(pitch * DEG), -Math.cos(yaw * DEG) * Math.cos(pitch * DEG))

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      if (typeof img.decode === 'function') img.decode().then(() => resolve(img), () => resolve(img))
      else resolve(img)
    }
    img.onerror = () => reject(new Error(`failed to load ${url}`))
    img.src = url
  })
}

interface Pose {
  pos: THREE.Vector3
  tgt: THREE.Vector3
  fov: number
}
const pose = (): Pose => ({ pos: new THREE.Vector3(), tgt: new THREE.Vector3(), fov: 26 })
function blend(a: Pose, b: Pose, t: number, out: Pose) {
  out.pos.lerpVectors(a.pos, b.pos, t)
  out.tgt.lerpVectors(a.tgt, b.tgt, t)
  out.fov = lerp(a.fov, b.fov, t)
  return out
}

/** A screen region in px. */
interface Region {
  x0: number
  x1: number
  y0: number
  y1: number
}

const _r = new THREE.Vector3()
const _u = new THREE.Vector3()
/** Place the camera looking along D so a subject (span w×h in the view plane) fills `reg`. */
function frameTo(out: Pose, C: THREE.Vector3, D: THREE.Vector3, w: number, h: number, reg: Region, W: number, H: number, fov: number) {
  const aspect = W / H
  const tanH = Math.tan((fov * DEG) / 2)
  const fw = Math.max(0.05, (reg.x1 - reg.x0) / W)
  const fh = Math.max(0.05, (reg.y1 - reg.y0) / H)
  const cx = ((reg.x0 + reg.x1) / 2 / W) * 2 - 1
  const cy = 1 - ((reg.y0 + reg.y1) / 2 / H) * 2
  const dist = Math.max(w / 2 / (fw * tanH * aspect), h / 2 / (fh * tanH))
  const hh = dist * tanH
  const hw = hh * aspect
  _r.crossVectors(D, UP).normalize()
  _u.crossVectors(_r, D).normalize()
  out.pos.copy(C).addScaledVector(D, -dist).addScaledVector(_r, -cx * hw).addScaledVector(_u, -cy * hh)
  out.tgt.copy(out.pos).addScaledVector(D, dist)
  out.fov = fov
  return out
}

interface Card {
  root: HTMLElement
  name: HTMLElement
  on: boolean
}

interface Kick {
  i: number
  at: number
  v: number
}

type Job = () => void

class Work implements Chapter {
  id = 'work'
  group = new THREE.Group()
  /**
   * Where each project in WORK order is fully shown: a featured sleeve out of
   * the crate with its record spinning and credits up, or one of the nine
   * standing face-out mid-riffle with its name lit.
   */
  anchors = WORK.map(w => {
    const k = FEATURED.indexOf(w)
    if (k >= 0) return F0 + FW * (k + 0.45)
    const j = REST.indexOf(w)
    return j >= 0 ? R0 + (j + 0.5) * RSTEP : MORE[0] + 0.01
  })

  private ctx!: ChapterContext
  private compact = false
  /** presentation point per featured sleeve (slid sideways / lowered per layout to keep the crate clear of the chrome) */
  private presentAt = FEATURED.map(() => PRESENT.clone())
  private present = PRESENT.clone()
  private soft!: THREE.PointLight
  private box = { l: 0, r: 0, t: 0, b: 0, sl: 0, sr: 0 }
  private boxPts = new Float32Array(24)

  // scene
  private sleeves: THREE.Mesh[] = []
  private sleeveU: SleeveUniforms[] = []
  private coverTex: THREE.CanvasTexture[] = []
  private coverCanvas: HTMLCanvasElement[] = []
  private restMesh!: THREE.InstancedMesh
  private restTex!: THREE.CanvasTexture
  private restCanvas!: HTMLCanvasElement
  private restImgs: (HTMLImageElement | null)[] = []
  private record!: THREE.Mesh
  private recU!: RecordUniforms
  private house!: THREE.Mesh
  private houseRec!: THREE.Mesh
  private houseRecU!: RecordUniforms
  private houseTex!: THREE.CanvasTexture
  private labels: THREE.CanvasTexture[] = []
  private houseLabel!: THREE.CanvasTexture
  private led!: THREE.Mesh
  private ledMat!: THREE.MeshBasicMaterial
  private plateTex!: THREE.CanvasTexture
  private specs: SleeveSpec[] = []
  private restSpecs: SleeveSpec[] = []

  // physics (per sleeve, front to back)
  private flip = new Float32Array(NS)
  private flipV = new Float32Array(NS)
  private wob = new Float32Array(NS)
  private wobV = new Float32Array(NS)
  private jx = new Float32Array(NS)
  private lean = new Float32Array(NS)
  private kicks: Kick[] = []
  private ledFlash = 0
  private spin = 0
  private spinBoost = 0
  private ray = new THREE.Raycaster()
  private houseSpin = 0
  private toneOn = false
  private time = 0
  private wavePending = false
  private tgt = new Uint8Array(NS)

  // images
  private shotReady: number[] = []
  private streaming = false
  private loading = 0
  private queueF: number[] = []
  private queueR: number[] = []
  private jobs: Job[] = []
  private pumping = false
  private atlasDirty = false

  // camera
  private stations = {
    intro: pose(),
    introFar: pose(),
    proj: [] as Pose[],
    riffle: pose(),
    fin: pose(),
    push: pose(),
  }
  private tmpA = pose()
  private tmpB = pose()
  private tmpC = pose()
  private layKey = ''
  private projCam = new THREE.PerspectiveCamera()

  // DOM
  private head!: HTMLElement
  private meterTicks: HTMLElement[] = []
  private count!: HTMLElement
  private intro!: HTMLElement
  private introTitle!: HTMLElement
  private cardsWrap!: HTMLElement
  private cards: Card[] = []
  private more!: HTMLElement
  private moreTitle!: HTMLElement
  private moreItems: HTMLElement[] = []
  private callout!: Callout
  private domState = { card: -1, more: false, intro: false, head: false, meter: '', count: '', hot: -1 }

  // scratch
  private m4 = new THREE.Matrix4()
  private m4b = new THREE.Matrix4()
  private pivotDown = new THREE.Matrix4().makeTranslation(0, -0.5, 0)
  private q = new THREE.Quaternion()
  private q2 = new THREE.Quaternion()
  private qSpin = new THREE.Quaternion()
  private v = new THREE.Vector3()
  private v2 = new THREE.Vector3()
  private v3 = new THREE.Vector3()
  private pv = new THREE.Vector3()
  private D = new THREE.Vector3()
  private e = new THREE.Euler()
  private one = new THREE.Vector3(1, 1, 1)
  private presented = { k: -1, center: new THREE.Vector3(), q: new THREE.Quaternion(), slide: 0 }
  /** the house pressing's raised pose (the record rides on this) */
  private houseState = { center: new THREE.Vector3(), q: new THREE.Quaternion(), slide: 0, recCenter: new THREE.Vector3() }
  private recCenter = new THREE.Vector3()

  // ------------------------------------------------------------------ init

  init(ctx: ChapterContext) {
    this.ctx = ctx
    const mobile = ctx.mobile
    const aniso = Math.min(8, ctx.renderer.capabilities.getMaxAnisotropy())

    // light: one crisp key from the upper left; the studio PMREM does the rest
    const key = new THREE.DirectionalLight(0xffffff, 1.05)
    key.position.set(-2.4, 3.6, 2.8)
    this.group.add(key)
    // a near softbox up-left of the presentation point: real falloff across a held sleeve
    this.soft = new THREE.PointLight(0xfff6ea, 3.2, 0, 2)
    this.soft.position.copy(PRESENT).add(new THREE.Vector3(-1.6, 1.2, 1.7))
    this.group.add(this.soft)

    // crate
    const crate = new THREE.Mesh(crateGeometry(), crateMaterial())
    this.group.add(crate)
    const outer = CRATE.inner + CRATE.wall
    const shadow = new THREE.Mesh(shadowQuad(), shadowMaterial(new THREE.Vector2(outer, (CRATE.zFront - CRATE.zBack) / 2), 0.03))
    shadow.scale.set(3.4, 1, 3.4)
    shadow.position.y = 0.0005
    shadow.renderOrder = -1
    this.group.add(shadow)

    // front-panel legend + the LED
    const plateCanvas = document.createElement('canvas')
    plateCanvas.width = 1024
    plateCanvas.height = 96
    this.plateTex = new THREE.CanvasTexture(plateCanvas)
    this.plateTex.colorSpace = THREE.SRGBColorSpace
    this.plateTex.anisotropy = aniso
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(0.86, 0.086),
      new THREE.MeshBasicMaterial({ map: this.plateTex, transparent: true, depthWrite: false }),
    )
    plate.position.set(-0.03, 0.172, CRATE.zFront + 0.0008)
    this.group.add(plate)
    this.ledMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0, 1, 0.52).multiplyScalar(5) })
    this.led = new THREE.Mesh(new THREE.CylinderGeometry(0.0085, 0.0085, 0.006, 16), this.ledMat)
    this.led.rotation.x = Math.PI / 2
    this.led.position.set(0.455, 0.172, CRATE.zFront + 0.002)
    this.group.add(this.led)

    // specs
    this.specs = FEATURED.map((item, k) => ({ index: k, item, cat: catOf(k), src: srcOf(item), ink: INK_F[k], paper: PAPER_F[k] }))
    this.restSpecs = REST.map((item, j) => ({
      index: NF + j,
      item,
      cat: catOf(NF + j),
      src: srcOf(item),
      ink: INK_R[j],
      paper: PAPER_R[j],
    }))

    // per-sleeve jitter (stable)
    for (let i = 0; i < NS; i++) {
      const h = Math.sin(i * 91.7 + 3.1) * 43758.5453
      const r = h - Math.floor(h)
      const h2 = Math.sin(i * 37.3 + 1.7) * 23421.631
      const r2 = h2 - Math.floor(h2)
      this.jx[i] = (r - 0.5) * 0.018
      this.lean[i] = -0.03 + (r2 - 0.5) * 0.024
    }

    // featured sleeves: one canvas each (front | back)
    const F = mobile ? 512 : 1024
    const geo = sleeveGeometry()
    const img = new THREE.Vector4(IMG.x / 1000, 1 - (IMG.y + IMG.h) / 1000, IMG.w / 1000, IMG.h / 1000)
    for (let k = 0; k < NF; k++) {
      const c = document.createElement('canvas')
      c.width = F * 2
      c.height = F
      const g = c.getContext('2d')!
      g.fillStyle = PAPER_F[k]
      g.fillRect(0, 0, F * 2, F)
      const tex = new THREE.CanvasTexture(c)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = aniso
      const { material, uniforms } = sleeveMaterial('featured', tex, { ink: INK_F[k], paper: PAPER_F[k], seed: k * 3.7, img })
      const mesh = new THREE.Mesh(geo, material)
      mesh.matrixAutoUpdate = false
      this.group.add(mesh)
      this.sleeves.push(mesh)
      this.sleeveU.push(uniforms)
      this.coverTex.push(tex)
      this.coverCanvas.push(c)
      this.shotReady.push(-1)
    }

    // the nine: one instanced mesh over a 4x4 atlas (cells 0-8 fronts, 9 = shared back)
    const A = mobile ? 1024 : 2048
    this.restCanvas = document.createElement('canvas')
    this.restCanvas.width = A
    this.restCanvas.height = A
    {
      const g = this.restCanvas.getContext('2d')!
      const cell = A / 4
      for (let j = 0; j < 10; j++) {
        g.fillStyle = j < NR ? PAPER_R[j] : '#ebe7df'
        g.fillRect((j % 4) * cell, Math.floor(j / 4) * cell, cell, cell)
      }
    }
    this.restTex = new THREE.CanvasTexture(this.restCanvas)
    this.restTex.colorSpace = THREE.SRGBColorSpace
    this.restTex.anisotropy = aniso
    {
      const { material } = sleeveMaterial('atlas', this.restTex)
      const g = sleeveGeometry()
      const cells = new Float32Array(NR)
      const inks = new Float32Array(NR)
      for (let j = 0; j < NR; j++) {
        cells[j] = j
        inks[j] = INK_R[j] ? 1 : 0
      }
      g.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 1))
      g.setAttribute('aInk', new THREE.InstancedBufferAttribute(inks, 1))
      this.restMesh = new THREE.InstancedMesh(g, material, NR)
      this.restMesh.frustumCulled = false
      this.group.add(this.restMesh)
      this.restImgs = REST.map(() => null)
    }

    // house pressing: white inner sleeve with a die-cut hole
    {
      const c = document.createElement('canvas')
      c.width = 1024
      c.height = 512
      const g = c.getContext('2d')!
      g.fillStyle = '#f7f5f0'
      g.fillRect(0, 0, 1024, 512)
      this.houseTex = new THREE.CanvasTexture(c)
      this.houseTex.colorSpace = THREE.SRGBColorSpace
      const { material } = sleeveMaterial('plain', this.houseTex, { paper: '#f7f5f0', hole: 0.175, seed: 11 })
      this.house = new THREE.Mesh(sleeveGeometry(0.01), material)
      this.house.matrixAutoUpdate = false
      this.group.add(this.house)
    }

    // labels
    const L = mobile ? 384 : 512
    const mkLabel = (paper: string) => {
      const c = document.createElement('canvas')
      c.width = L
      c.height = L
      const g = c.getContext('2d')!
      g.fillStyle = paper
      g.fillRect(0, 0, L, L)
      const t = new THREE.CanvasTexture(c)
      t.colorSpace = THREE.SRGBColorSpace
      t.anisotropy = aniso
      return t
    }
    for (let k = 0; k < NF; k++) this.labels.push(mkLabel(this.labelPaper(k)))
    this.houseLabel = mkLabel(HOUSE_LABEL)

    // records
    const rgeo = recordGeometry(mobile ? 96 : 160)
    {
      const { material, uniforms } = recordMaterial(this.labels[0], 1)
      this.record = new THREE.Mesh(rgeo, material)
      this.recU = uniforms
      this.record.visible = false
      this.group.add(this.record)
    }
    {
      const { material, uniforms } = recordMaterial(this.houseLabel, 7)
      this.houseRec = new THREE.Mesh(rgeo, material)
      this.houseRecU = uniforms
      this.group.add(this.houseRec)
    }

    this.buildDom(ctx.stage)

    // print everything once the faces are in
    loadFonts().then(() => this.redrawAll())

    // screenshots: the first sleeve now (work follows the hero), the rest after the reveal
    this.queueF = FEATURED.map((_, k) => k)
    this.queueR = REST.map((_, j) => j)
    this.fetchFeatured(this.queueF.shift()!)
    const go = () => this.startStreaming()
    if (document.documentElement.dataset.ready === '1') go()
    else {
      window.addEventListener('hark:reveal', go, { once: true })
      window.setTimeout(go, 12000)
    }
  }

  private labelPaper(k: number) {
    return INK_F[k] ? '#1b1b1e' : PAPER_F[k]
  }

  // ------------------------------------------------------------------ DOM

  private buildDom(stage: HTMLElement) {
    // head: eyebrow + a sequencer-style meter of the crate
    this.head = el('div', 'wk-head', undefined, stage)
    el('p', 'hud-eyebrow', SECTIONS.work.eyebrow, this.head)
    const meter = el('div', 'wk-meter', undefined, this.head)
    meter.setAttribute('aria-hidden', 'true')
    for (let i = 0; i < NF + NR; i++) {
      const t = el('i', i < NF ? 'is-feat' : '', undefined, meter)
      this.meterTicks.push(t)
    }
    this.count = el('span', 'hud-label wk-count', '', this.head)

    // intro
    this.intro = el('div', 'wk-intro', undefined, stage)
    const [a, b] = SECTIONS.work.title.split(/ (?=\S+$)/)
    this.introTitle = rise(el('h2', 'hud-title', undefined, this.intro), `${escapeHtml(a)} <em>${escapeHtml(b)}</em>`)
    el('p', 'hud-label wk-intro-note', `${pad(NF)} featured · ${pad(NR)} more · 33⅓ RPM`, this.intro)

    // project cards
    this.cardsWrap = el('div', 'wk-cards', undefined, stage)
    FEATURED.forEach((item, k) => {
      const root = el('article', 'wk-card', undefined, this.cardsWrap)
      const cat = el('div', 'wk-cat wk-fade', undefined, root)
      cat.style.setProperty('--d', '0')
      const num = el('span', 'hud-label wk-num', undefined, cat)
      num.innerHTML = `${catOf(k)} <span>/ ${pad(NF)}</span>`
      el('span', 'hud-label wk-src', isPreview(item.url) ? 'Preview build' : 'Side A', cat)
      const name = rise(el('h3', 'hud-h2 wk-name', undefined, root), emLast(item.name))
      const ind = el('p', 'hud-label wk-ind wk-fade', item.industry, root)
      ind.style.setProperty('--d', '1')
      const blurb = el('p', 'hud-body wk-blurb wk-fade', item.blurb, root)
      blurb.style.setProperty('--d', '2')
      const tags = el('ul', 'hud-tags wk-tags wk-fade', undefined, root)
      tags.style.setProperty('--d', '3')
      for (const t of item.tags) el('li', 'hud-tag', t, tags)
      const a = el('a', 'hud-btn wk-visit wk-fade', isPreview(item.url) ? 'Preview site ↗' : 'Visit site ↗', root)
      a.href = item.url
      a.target = '_blank'
      a.rel = 'noopener'
      a.style.setProperty('--d', '4')
      this.cards.push({ root, name, on: false })
    })

    // the nine
    this.more = el('div', 'wk-more', undefined, stage)
    const eb = el('p', 'hud-label wk-more-eb wk-fade', `${catOf(NF)} – ${catOf(NF + NR - 1)}`, this.more)
    eb.style.setProperty('--d', '0')
    this.moreTitle = rise(el('h2', 'hud-h2', undefined, this.more), 'Nine more, all <em>live.</em>')
    const list = el('ol', 'wk-list', undefined, this.more)
    REST.forEach((item, j) => {
      const li = el('li', 'wk-fade', undefined, list)
      li.style.setProperty('--d', String(1 + j * 0.5))
      const a = el('a', '', undefined, li)
      a.href = item.url
      a.target = '_blank'
      a.rel = 'noopener'
      el('span', 'wk-li-n', pad(NF + j + 1), a)
      const txt = el('span', 'wk-li-t', undefined, a)
      el('span', 'wk-li-name', item.name, txt)
      el('span', 'wk-li-ind', item.industry, txt)
      this.moreItems.push(li)
    })
    const hello = el('button', 'hud-btn wk-hello wk-fade', 'Say hello', this.more)
    hello.type = 'button'
    hello.style.setProperty('--d', '6')
    hello.addEventListener('click', () => window.__hark?.land('contact'))

    this.callout = new Callout(stage, { side: 'left', offset: { x: 40, y: -46 } })
    this.callout.root.classList.add('wk-callout')

    // re-measure when the card copy reflows (fonts, resize)
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        this.layKey = ''
      })
      for (const c of this.cards) ro.observe(c.root)
      ro.observe(this.more)
      ro.observe(this.intro)
    }
    document.fonts?.ready.then(() => {
      this.layKey = ''
    })
  }

  // ------------------------------------------------------------------ art

  private redrawAll() {
    const push = (job: Job) => this.jobs.push(job)
    for (let k = 0; k < NF; k++) {
      push(() => {
        const c = this.coverCanvas[k]
        const g = c.getContext('2d')!
        const F = c.height
        drawFront(g, 0, 0, F, this.specs[k])
        drawBack(g, F, 0, F, this.specs[k])
        this.upload(this.coverTex[k])
      })
    }
    push(() => {
      const c = this.labels[0].image as HTMLCanvasElement
      const L = c.width
      FEATURED.forEach((item, k) => {
        const lc = this.labels[k].image as HTMLCanvasElement
        drawLabel(lc.getContext('2d')!, L, {
          name: item.name,
          line2: item.industry,
          cat: `${catOf(k)} · STEREO`,
          side: 'SIDE A',
          ink: INK_F[k],
          paper: this.labelPaper(k),
        })
        this.labels[k].needsUpdate = true
      })
      const hc = this.houseLabel.image as HTMLCanvasElement
      drawLabel(hc.getContext('2d')!, hc.width, {
        name: 'Hark Digital Design',
        line2: 'Make the internet listen.',
        cat: 'HRK–000 · HOUSE PRESSING',
        side: 'SIDE A',
        ink: true,
        paper: HOUSE_LABEL,
        big: true,
      })
      this.houseLabel.needsUpdate = true
    })
    push(() => {
      for (let j = 0; j < NR; j++) this.drawRestCell(j)
      const cell = this.restCanvas.width / 4
      const g = this.restCanvas.getContext('2d')!
      drawBack(g, (9 % 4) * cell, Math.floor(9 / 4) * cell, cell, {
        index: 99,
        item: {
          id: 'house',
          name: 'Hark Digital Design',
          url: '',
          industry: 'Selected work',
          blurb: 'Nine more sites, every one of them live, from dentists to global manufacturers.',
          tags: ['Web Design', 'SEO', 'Software'],
          featured: false,
        },
        cat: `${catOf(NF)}/${pad(NF + NR, 3)}`,
        src: 'hark.digital',
        ink: false,
        paper: '#ebe7df',
      })
      this.upload(this.restTex)
    })
    push(() => {
      const c = this.houseTex.image as HTMLCanvasElement
      drawInner(c.getContext('2d')!, c.width, c.height)
      this.houseTex.needsUpdate = true
      const p = this.plateTex.image as HTMLCanvasElement
      drawPlate(p.getContext('2d')!, p.width, p.height)
      this.plateTex.needsUpdate = true
    })
    this.pump()
  }

  private drawRestCell(j: number) {
    const cell = this.restCanvas.width / 4
    const g = this.restCanvas.getContext('2d')!
    drawFront(g, (j % 4) * cell, Math.floor(j / 4) * cell, cell, this.restSpecs[j], this.restImgs[j])
  }

  private upload(tex: THREE.Texture) {
    tex.needsUpdate = true
    try {
      this.ctx.renderer.initTexture(tex)
    } catch {
      /* uploads on first use instead */
    }
  }

  /** One heavy job per animation frame so the scroll never hitches. */
  private pump() {
    if (this.pumping) return
    this.pumping = true
    const step = () => {
      const job = this.jobs.shift()
      try {
        job?.()
      } catch (err) {
        console.warn('[work] art job failed', err)
      }
      if (this.atlasDirty && !this.jobs.length) {
        this.atlasDirty = false
        this.upload(this.restTex)
      }
      if (this.jobs.length || this.atlasDirty) next()
      else this.pumping = false
    }
    const next = () => {
      if (document.hidden) setTimeout(step, 30)
      else requestAnimationFrame(step)
    }
    next()
  }

  // ------------------------------------------------------------------ images

  private startStreaming() {
    if (this.streaming) return
    this.streaming = true
    this.pumpLoads()
  }

  private pumpLoads() {
    while (this.loading < 2) {
      if (this.queueF.length) this.fetchFeatured(this.queueF.shift()!)
      else if (this.queueR.length) this.fetchRest(this.queueR.shift()!)
      else return
    }
  }

  private fetchFeatured(k: number) {
    this.loading++
    loadImage(workImage(FEATURED[k].id))
      .then(img => {
        const tex = new THREE.Texture(img)
        tex.colorSpace = THREE.SRGBColorSpace
        tex.anisotropy = Math.min(8, this.ctx.renderer.capabilities.getMaxAnisotropy())
        tex.needsUpdate = true
        this.jobs.push(() => {
          this.upload(tex)
          this.sleeveU[k].uShot.value = tex
          this.shotReady[k] = performance.now()
        })
        this.pump()
      })
      .catch(err => console.warn(`[work] missing screenshot for ${FEATURED[k].id}`, err))
      .finally(() => {
        this.loading--
        if (this.streaming) this.pumpLoads()
      })
  }

  private fetchRest(j: number) {
    this.loading++
    loadImage(workImage(REST[j].id))
      .then(img => {
        this.restImgs[j] = img
        this.jobs.push(() => {
          this.drawRestCell(j)
          this.atlasDirty = true
        })
        this.pump()
      })
      .catch(err => console.warn(`[work] missing screenshot for ${REST[j].id}`, err))
      .finally(() => {
        this.loading--
        if (this.streaming) this.pumpLoads()
      })
  }

  // ------------------------------------------------------------------ layout

  private ensureLayout(f: Frame) {
    const key = `${f.width}x${f.height}`
    if (key === this.layKey) return
    this.layKey = key
    const W = f.width
    const H = f.height
    this.compact = W / H < 0.85 || W < 700
    this.ctx.stage.classList.toggle('is-compact', this.compact)

    const stageRect = this.ctx.stage.getBoundingClientRect()
    const rel = (r: DOMRect) => ({ l: r.left - stageRect.left, t: r.top - stageRect.top, r: r.right - stageRect.left, b: r.bottom - stageRect.top })
    const head = rel(this.head.getBoundingClientRect())
    const intro = rel(this.intro.getBoundingClientRect())
    let cardTop = H
    let cardRight = 0
    for (const c of this.cards) {
      const r = rel(c.root.getBoundingClientRect())
      cardTop = Math.min(cardTop, r.t)
      cardRight = Math.max(cardRight, r.r)
    }
    const more = rel(this.more.getBoundingClientRect())
    const gutter = head.l
    const safeB = H - Math.max(...this.cards.map(c => rel(c.root.getBoundingClientRect()).b))
    const fov = this.compact ? 30 : 25

    // the bottom chrome (audio switch left, tape deck right): the crate stays out from under it
    const deckEl = document.querySelector<HTMLElement>('.ch-deck')
    const audioEl = document.querySelector<HTMLElement>('.ch-audio')
    const deck = deckEl && deckEl.offsetWidth ? rel(deckEl.getBoundingClientRect()) : null
    const audio = audioEl && audioEl.offsetWidth ? rel(audioEl.getBoundingClientRect()) : null
    const band = Math.max(this.compact ? 52 : 60, H - Math.min(deck?.t ?? H, audio?.t ?? H) + 12)
    const deckL = (deck ? deck.l : W - gutter - Math.min(400, Math.max(320, W * 0.28))) - 18

    let regProj: Region
    let regIntro: Region
    let regRiffle: Region
    let regFin: Region
    if (this.compact) {
      regProj = { x0: gutter, x1: W - gutter, y0: head.b + 10, y1: cardTop - 12 }
      regIntro = { x0: gutter, x1: W - gutter, y0: intro.b + 6, y1: Math.min(H - safeB, H - band - 8) }
      regRiffle = { x0: gutter, x1: W - gutter, y0: head.b + 6, y1: more.t - 8 }
      regFin = { x0: gutter, x1: W - gutter, y0: head.b + 10, y1: H - safeB }
    } else {
      const x0 = Math.max(cardRight, more.r) + Math.max(28, W * 0.03)
      regProj = { x0, x1: W - gutter, y0: head.b + 16, y1: H - safeB }
      regIntro = {
        x0: Math.max(intro.r - W * 0.06, W * 0.4),
        x1: W - gutter * 0.5,
        y0: head.b,
        y1: Math.min(H - safeB * 0.6, H - band - 10),
      }
      regRiffle = { x0, x1: W - gutter, y0: head.b + 10, y1: Math.min(H - safeB, H - band - 8) }
      // the cards are gone by the finale: the house pressing takes the centre
      regFin = { x0: gutter * 2, x1: W - gutter * 2, y0: head.b + 10, y1: H - safeB }
    }

    const S = this.stations
    // crate-digger's three-quarter view
    dirOf(24, 33, this.D)
    frameTo(S.intro, this.v.set(0.02, 0.5, 0.12), this.D, 1.66, 1.62, regIntro, W, H, fov)
    S.introFar.pos.copy(S.intro.pos).addScaledVector(this.D, -1.3).add(this.v.set(0, 0.55, 0))
    S.introFar.tgt.copy(S.intro.tgt).add(this.v.set(0, 0.12, 0))
    S.introFar.fov = fov

    // presentations: the sleeve + the record out to its right
    const frameOne = (k: number) => {
      const p = S.proj[k] ?? pose()
      dirOf(YAW[k], PITCH, this.D)
      _r.crossVectors(this.D, UP).normalize()
      const C = this.v.copy(this.presentAt[k]).addScaledVector(_r, (SLIDE + RECORD_R - 0.5) / 2)
      frameTo(p, C, this.D, 0.5 + SLIDE + RECORD_R + (this.compact ? 0.16 : 0.05), 1.06, regProj, W, H, fov)
      S.proj[k] = p
    }
    for (let k = 0; k < NF; k++) {
      this.presentAt[k].copy(PRESENT)
      frameOne(k)
    }
    // Keep the crate below each presentation out from under the bottom chrome
    // (before and after the hold's dolly). Where it would reach the tape deck
    // on a landscape screen (4:3), the sleeve is held higher so the crate drops
    // right out of the bottom of the frame (the nod between records still
    // looks down into it); phones and portrait tablets hold the sleeve a little
    // lower instead, so the whole crate stays above the band.
    const crateC = this.v2.set(0, 0.4, 0)
    const bandTop = H - band
    const audioR = (audio ? audio.r : gutter + 170) + 16
    const gapR = deckL + 8
    /** how far (px) the crate under presentation k reaches into the chrome, before and after the dolly */
    const intrusion = (k: number) => {
      let over = 0
      for (const creep of [0, 1]) {
        const bx = this.crateBox(this.projPose(k, creep, this.tmpA), W, H, bandTop)
        if (bx.sl > bx.sr) continue
        if (this.compact) over = Math.max(over, Math.min(bx.b, H) - bandTop)
        else over = Math.max(over, bx.sr - gapR, audioR - bx.sl)
      }
      return over
    }
    /** the crate's top edge on screen (px), before and after the dolly */
    const crateTop = (k: number) =>
      Math.min(this.crateBox(this.projPose(k, 0, this.tmpA), W, H).t, this.crateBox(this.projPose(k, 1, this.tmpA), W, H).t)
    for (let k = 0; k < NF; k++) {
      const P = this.presentAt[k]
      if (this.compact) {
        for (let it = 0; it < 8; it++) {
          const over = intrusion(k)
          if (over <= 0.5) break
          const ppw = this.pxPerWorld(S.proj[k], crateC, H)
          const y = Math.max(PRESENT.y - 0.42, P.y - (over / ppw) * 1.08)
          if (y === P.y) break
          P.y = y
          frameOne(k)
        }
      } else if (intrusion(k) > 0.5) {
        // hold it high enough that the crate drops clean out of the frame (no slivers)
        for (let it = 0; it < 24 && crateTop(k) < H + 2; it++) {
          const y = Math.min(PRESENT.y + 1.6, P.y + 0.08)
          if (y === P.y) break
          P.y = y
          frameOne(k)
        }
      }
    }
    this.present.set(0, 0, 0)
    for (const P of this.presentAt) this.present.addScaledVector(P, 1 / NF)
    this.soft.position.copy(this.present).add(this.v.set(-1.6, 1.2, 1.7))

    // the riffle: steep, over the stack
    dirOf(-12, 44, this.D)
    frameTo(S.riffle, this.v.set(0, 0.46, 0.22), this.D, 1.95, 2.15, regRiffle, W, H, fov)
    // the house pressing up out of the crate, its record sliding up out of the inner sleeve
    // (framed on the sleeve with its record half out; the push then follows the record up)
    dirOf(0, 10, this.D)
    frameTo(S.fin, this.v.copy(HOUSE_AT).add(this.v2.set(0, 0.2, 0)), this.D, 1.25, 1.4, regFin, W, H, fov)
    // ...with the crate dropped out of the bottom of the frame (never under the chrome)
    _r.crossVectors(this.D, UP).normalize()
    _u.crossVectors(_r, this.D).normalize()
    for (let it = 0; it < 4; it++) {
      const b = this.crateBox(S.fin, W, H)
      if (b.t >= H + 2 || b.b <= H - band) break
      const dy = (H + 6 - b.t) / this.pxPerWorld(S.fin, crateC.set(0, 0.6, -0.3), H)
      S.fin.pos.addScaledVector(_u, dy)
      S.fin.tgt.addScaledVector(_u, dy)
    }
    // push: onto the grooves and the black label, spindle dead centre (the ripple rises from it),
    // a touch off-axis so the groove highlights sweep across the frame
    dirOf(-7, 7, this.D)
    const recC = this.v.copy(HOUSE_AT).add(this.v2.set(0, HOUSE_SLIDE, 0))
    frameTo(S.push, recC, this.D, LABEL_R * 4.4, LABEL_R * 4.4, { x0: 0, x1: W, y0: 0, y1: H }, W, H, fov)
  }

  /**
   * Screen-space bounds (px) of the crate (bin + the sleeves standing in it)
   * under a pose, plus its horizontal extent (sl..sr, on screen) inside the
   * bottom band of rows from `bandTop` down (sl > sr when it doesn't reach it).
   */
  private crateBox(p: Pose, W: number, H: number, bandTop = H) {
    const cam = this.projCam
    cam.fov = p.fov
    cam.aspect = W / H
    cam.position.copy(p.pos)
    cam.lookAt(p.tgt)
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()
    const b = this.box
    b.l = b.t = b.sl = Infinity
    b.r = b.b = b.sr = -Infinity
    const X = CRATE.inner + CRATE.wall
    const P = this.boxPts
    // the eight corners of the bin, then the tops of the sleeves standing in it
    for (let c = 0; c < 12; c++) {
      const back = c & 2
      if (c < 8) {
        const z = back ? CRATE.zBack - CRATE.wall : CRATE.zFront + CRATE.wall
        const y = c & 4 ? (back ? CRATE.backH : CRATE.frontH) : 0
        this.v3.set(c & 1 ? X : -X, y, z)
      } else this.v3.set(c & 1 ? 0.5 : -0.5, Y0 + 1, back ? zUp(HOUSE) : zUp(0))
      this.v3.project(cam)
      const sx = ((this.v3.x + 1) / 2) * W
      const sy = ((1 - this.v3.y) / 2) * H
      P[c * 2] = sx
      P[c * 2 + 1] = sy
      b.l = Math.min(b.l, sx)
      b.r = Math.max(b.r, sx)
      b.t = Math.min(b.t, sy)
      b.b = Math.max(b.b, sy)
    }
    // the hull's extent inside the band = the extent of every point-to-point
    // segment clipped to the band's rows (and to the screen)
    const y0 = bandTop
    const y1 = H
    for (let i = 0; i < 12; i++) {
      for (let j = i; j < 12; j++) {
        const ax = P[i * 2]
        const ay = P[i * 2 + 1]
        const bx = P[j * 2]
        const by = P[j * 2 + 1]
        const lo = Math.max(y0, Math.min(ay, by))
        const hi = Math.min(y1, Math.max(ay, by))
        if (lo > hi) continue
        const dy = by - ay
        for (const y of [lo, hi]) {
          const x = Math.abs(dy) < 1e-6 ? ax : ax + ((bx - ax) * (y - ay)) / dy
          const xs = clamp(x, 0, W)
          b.sl = Math.min(b.sl, xs)
          b.sr = Math.max(b.sr, xs)
        }
        if (Math.abs(dy) < 1e-6) {
          b.sl = Math.min(b.sl, clamp(bx, 0, W))
          b.sr = Math.max(b.sr, clamp(bx, 0, W))
        }
      }
    }
    return b
  }

  /** Screen pixels per world unit at point `at` under a pose. */
  private pxPerWorld(p: Pose, at: THREE.Vector3, H: number) {
    this.v3.subVectors(p.tgt, p.pos).normalize()
    const d = Math.max(0.05, this.pv.subVectors(at, p.pos).dot(this.v3))
    return H / 2 / Math.tan((p.fov * DEG) / 2) / d
  }

  // ------------------------------------------------------------------ per frame

  update(l: number, f: Frame, ctx: ChapterContext) {
    this.ensureLayout(f)
    const now = performance.now()
    this.time = f.time
    if (this.wavePending) {
      this.wavePending = false
      // the pressure wave from the cut runs through the crate, front to back
      for (let i = 0; i < NS; i++)
        this.kicks.push({ i, at: f.time + 0.05 + i * 0.026, v: (1.5 - i * 0.05) * (this.flip[i] > 0.5 ? 0.35 : 1) })
      this.ledFlash = 1
    }

    // bone cyc for the crate; the out-beat drops the room to graphite for Liner Notes
    const dark = ease.inOutQuad(segment(l, FIN.dark[0], FIN.dark[1]))
    ctx.studio.params.tone = dark
    ctx.studio.params.warmth = 0.42 * (1 - dark)
    ctx.studio.params.spot = lerp(0.55, 0.6, dark)
    ctx.studio.params.envIntensity = lerp(1.05, 0.42, dark)
    ctx.post.params.vignette = lerp(0.26, 0.34, dark)
    ctx.post.params.bloomStrength = 0.5
    ctx.post.params.bloomRadius = 0.4

    // -- which featured sleeve is in hand
    let k = -1
    let s = 0
    if (l >= F0 && l < F1) {
      k = Math.min(NF - 1, Math.floor((l - F0) / FW))
      s = (l - slotStart(k)) / FW
    }
    const pUp = k >= 0 ? outBack(segment(s, PH.rise[0], PH.rise[1]), 0.9) : 0
    const pDown = k >= 0 ? ease.inOutCubic(segment(s, PH.fall[0], PH.fall[1])) : 0
    const lift = k >= 0 ? (s < PH.fall[0] ? pUp : 1 - pDown) : 0
    const slide =
      k >= 0 ? outBack(segment(s, PH.out[0], PH.out[1]), 1.1) * (1 - ease.inOutCubic(segment(s, PH.home[0], PH.home[1]))) : 0

    // -- physics targets
    this.stepPhysics(l, k, lift, f)

    // -- featured sleeves
    for (let i = 0; i < NF; i++) {
      const mesh = this.sleeves[i]
      if (i === k && lift > 0.0005) this.presentMatrix(i, lift, YAW[i], PITCH, this.presentAt[i], mesh.matrix, this.presented)
      else this.crateMatrix(i, mesh.matrix)
      mesh.matrixWorldNeedsUpdate = true
      // screenshot fade-in
      const t0 = this.shotReady[i]
      this.sleeveU[i].uShotMix.value = t0 < 0 ? 0 : ease.inOutQuad(clamp((now - t0) / 450))
    }
    // -- the nine
    for (let j = 0; j < NR; j++) {
      this.crateMatrix(NF + j, this.m4)
      this.restMesh.setMatrixAt(j, this.m4)
    }
    this.restMesh.instanceMatrix.needsUpdate = true

    // -- house pressing
    // lifted from rest (the camera rides along with it), a small overshoot as it tops out
    const hu = segment(l, FIN.rise[0], FIN.rise[1])
    const hLift = ease.inOutCubic(hu) + 0.04 * Math.sin(Math.PI * clamp((hu - 0.5) / 0.5))
    const drop = ease.inQuad(segment(l, FIN.drop[0], FIN.drop[1]))
    if (hLift > 0.0005) {
      this.presentMatrix(HOUSE, hLift, 0, 10, HOUSE_AT, this.house.matrix, this.houseState)
      // once the record is clear, the empty sleeve drops away beneath it (straight down, like it was let go)
      if (drop > 0) {
        this.house.matrix.elements[13] -= drop * 2.4
        this.house.matrix.elements[14] -= drop * 0.3
      }
    } else {
      this.crateMatrix(HOUSE, this.house.matrix)
      this.houseState.center.setFromMatrixPosition(this.house.matrix)
      this.houseState.center.add(this.v.set(0, 0.5, 0).applyQuaternion(this.q.setFromRotationMatrix(this.house.matrix)))
      this.houseState.q.setFromRotationMatrix(this.house.matrix)
    }
    this.house.matrixWorldNeedsUpdate = true

    // -- the record in hand
    this.presented.slide = slide
    const rec = this.record
    rec.visible = k >= 0 && slide > 0.002 && lift > 0.5
    if (rec.visible) {
      if (this.recU.uLabel.value !== this.labels[k]) this.recU.uLabel.value = this.labels[k]
      this.recU.uSeed.value = k * 1.37 + 0.5
      const P = this.presented
      this.recCenter.copy(P.center).add(this.v.set(SLIDE * slide, 0, 0).applyQuaternion(P.q))
      rec.position.copy(this.recCenter)
      const speed = ctx.reducedMotion ? RPM33 * 0.5 : RPM33
      this.spinBoost *= Math.exp(-f.dt * 1.6)
      const omega = speed * smoothstep(0.15, 0.85, slide) + f.velocity * 5 + this.spinBoost
      this.spin -= omega * f.dt
      this.qSpin.setFromAxisAngle(this.v.set(0, 0, 1), this.spin)
      rec.quaternion.copy(P.q).multiply(this.qSpin)
      this.recU.uBlur.value = 0
      this.lightUniforms(this.recU)
    }
    // shadow of whatever is held above the crate
    const held = rec.visible || lift > 0.05 ? lift : hLift
    const heldC = rec.visible || lift > 0.05 ? this.presented.center : this.houseState.center
    sharedSleeve.uLift.value.set(heldC.x * 0.5, heldC.z - 0.72, 1.05, clamp(held * 1.2))
    sharedSleeve.uLiftY.value = heldC.y - 0.35

    // -- house record: inside its sleeve (label through the hole), then up and out
    {
      const hs = ease.inOutCubic(segment(l, FIN.out[0], FIN.out[1]))
      const H = this.houseState
      this.houseRec.visible = l > 0.8
      H.recCenter.copy(H.center).add(this.v.set(0, HOUSE_SLIDE * hs, 0).applyQuaternion(H.q))
      this.houseRec.position.copy(H.recCenter)
      const spinUp = ease.inCubic(segment(l, FIN.spin[0], FIN.spin[1]))
      const omega = (ctx.reducedMotion ? 0.4 : 1) * (hs * RPM33 * 1.2 + spinUp * 46)
      this.houseSpin -= omega * f.dt
      this.qSpin.setFromAxisAngle(this.v.set(0, 0, 1), this.houseSpin)
      this.houseRec.quaternion.copy(H.q).multiply(this.qSpin)
      this.houseRecU.uBlur.value = ctx.reducedMotion ? 0 : Math.min(2.6, omega * 0.045)
      // at speed the grooves keep only their sharp glints: the frame goes dark for Liner Notes
      this.houseRecU.uSpec.value = (1 + spinUp * 0.35) * (1 - 0.3 * dark)
      this.houseRecU.uSheen.value = 1 - 0.7 * dark
      this.lightUniforms(this.houseRecU)
      // a rising tone as it spins up (only heard if the visitor turned audio on)
      const want = spinUp > 0.01 && l < 0.999
      if (want || this.toneOn) {
        this.toneOn = want
        window.dispatchEvent(
          new CustomEvent('hark:tone', { detail: { hz: 55 * Math.pow(2, spinUp * 3), level: want ? 0.16 * Math.min(1, spinUp * 3) : 0 } }),
        )
      }
    }

    // -- LED: steady, flares when a sleeve lands, pulses with the in-beat
    this.ledFlash = Math.max(0, this.ledFlash - f.dt * 3)
    const inBeat = 1 - smoothstep(0, 0.05, l)
    const pulse = 0.75 + 0.25 * Math.sin(f.time * 2.2)
    this.ledMat.color.setRGB(0, 1, 0.52).multiplyScalar(3.2 * pulse + this.ledFlash * 6 + inBeat * 6)

    this.updateDom(l, k, s, f)
  }

  /** view-space light directions for the groove highlights */
  private lightUniforms(u: RecordUniforms) {
    const m = this.ctx.camera.matrixWorldInverse
    u.uL1.value.copy(RECORD_LIGHTS.key).transformDirection(m)
    u.uL2.value.copy(RECORD_LIGHTS.rim).transformDirection(m)
  }

  private stepPhysics(l: number, k: number, lift: number, f: Frame) {
    const n = NS
    const tgt = this.tgt
    for (let i = 0; i < NF; i++) tgt[i] = l > slotStart(i) + FW * PH.flip ? 1 : 0
    for (let j = 0; j < NR; j++) tgt[NF + j] = l > flipAt(j) ? 1 : 0
    tgt[HOUSE] = 0
    if (k >= 0 && lift > 0.01) tgt[k] = 0
    // physical order: a sleeve can't fall until the one in front is out of the way,
    // and can't stand back up while the one lying on it is still down
    // a backlog (a jump, a fast flick) riffles through faster
    let backlog = 0
    for (let i = 0; i < n; i++) if (tgt[i] !== (this.flip[i] > 0.5 ? 1 : 0)) backlog++
    const hurry = backlog > 2 ? 1 : 0
    const gate = hurry ? 0.3 : 0.5
    for (let i = 1; i < n; i++) if (tgt[i] && this.flip[i - 1] < gate) tgt[i] = 0
    for (let i = n - 2; i >= 0; i--) if (!tgt[i] && this.flip[i + 1] > 1 - gate) tgt[i] = 1
    const G = hurry ? 120 : 58

    const time = f.time
    for (let q = this.kicks.length - 1; q >= 0; q--) {
      const kk = this.kicks[q]
      if (time >= kk.at) {
        this.wobV[kk.i] += kk.v
        this.kicks.splice(q, 1)
      }
    }

    const dt = Math.min(f.dt, 1 / 20)
    const steps = Math.max(1, Math.ceil(dt / 0.006))
    const h = dt / steps
    const reduced = f.reducedMotion
    for (let st = 0; st < steps; st++) {
      for (let i = 0; i < n; i++) {
        let x = this.flip[i]
        let v = this.flipV[i]
        if (tgt[i]) {
          if (!reduced && x < 0.985 && v >= -0.05) {
            // released: a nudge, then gravity torque that grows as it leans
            if (x < 0.02 && v < 1.1) v = 1.1
            v += (G * (0.14 + x) - 1.2 * v) * h
          } else {
            const K = reduced ? 120 : 280
            v += (-K * (x - 1) - (reduced ? 22 : 13) * v) * h
          }
          x += v * h
          if (!reduced && x > 1.03 && v > 0) {
            const impact = v
            x = 1.03
            v = -v * 0.3
            // the stack beneath recoils, the LED flickers like a peak meter
            for (let j = i - 1, d = 0; j >= 0 && d < 5; j--, d++) if (this.flip[j] > 0.9) this.wobV[j] += impact * 0.05 * Math.pow(0.6, d)
            for (let j = i + 1; j < Math.min(n, i + 4); j++) if (this.flip[j] < 0.1) this.wobV[j] -= impact * 0.02
            this.ledFlash = Math.min(1, this.ledFlash + impact * 0.08)
          }
        } else {
          const K0 = hurry ? 320 : 150
          v += (-K0 * x - 2 * Math.sqrt(K0) * v) * h
          x += v * h
          if (x < 0) {
            x = 0
            v = 0
          }
        }
        this.flip[i] = x
        this.flipV[i] = v
        // wobble spring (jostles)
        let w = this.wob[i]
        let wv = this.wobV[i]
        wv += (-240 * w - 5.2 * wv) * h
        w += wv * h
        this.wob[i] = w
        this.wobV[i] = wv
      }
    }
  }

  /** In-crate transform: upright in its slot ↔ lying forward on the stack. */
  private crateMatrix(i: number, out: THREE.Matrix4) {
    const x = this.flip[i]
    const xs = clamp(x)
    const slide = xs * xs * (3 - 2 * xs)
    const z = lerp(zUp(i), zStack(i), slide)
    const a = lerp(this.lean[i], thStack(i), x) + this.wob[i] * (1 - 0.6 * xs)
    this.e.set(a, 0, (this.jx[i] * 2 - 0.004) * (1 - xs))
    this.q.setFromEuler(this.e)
    out.compose(this.v.set(this.jx[i], Y0, z), this.q, this.one)
  }

  /**
   * Out of the crate and into the hand: straight up out of the slot, then over
   * to the presentation point, turning to face the lens.
   */
  private presentMatrix(
    i: number,
    p: number,
    yaw: number,
    pitch: number,
    at: THREE.Vector3,
    out: THREE.Matrix4,
    state: { center: THREE.Vector3; q: THREE.Quaternion },
  ) {
    // slot pose (centre of the sleeve)
    const slot = this.v.set(this.jx[i], Y0 + 0.5, zUp(i))
    const ctrl = this.v2.set(slot.x, at.y - 0.12, slot.z)
    const t = Math.max(0, p)
    const u1 = 1 - t
    // quadratic bezier (p may overshoot slightly past 1: extrapolate along the end tangent)
    const c = state.center
    if (t <= 1) {
      c.copy(slot).multiplyScalar(u1 * u1).addScaledVector(ctrl, 2 * u1 * t).addScaledVector(at, t * t)
    } else {
      this.v3.copy(at).sub(ctrl).multiplyScalar(2 * (t - 1))
      c.copy(at).add(this.v3)
    }
    // idle float once presented
    c.y += Math.sin(this.time * 1.1 + i) * 0.006 * clamp(t)
    // orientation: upright in the slot -> facing the lens
    this.e.set(this.lean[i], 0, 0)
    this.q.setFromEuler(this.e)
    dirOf(yaw, pitch, this.D)
    this.m4b.lookAt(c, this.v3.copy(c).add(this.D), UP)
    this.q2.setFromRotationMatrix(this.m4b)
    const r = smoothstep(0.15, 1, t)
    state.q.copy(this.q).slerp(this.q2, r)
    // a little hand-held tilt on the way
    const tilt = Math.sin(clamp(t) * Math.PI) * 0.07
    this.q.setFromAxisAngle(this.v3.set(0, 0, 1), tilt * (i % 2 ? 1 : -1))
    state.q.multiply(this.q)
    out.compose(c, state.q, this.one).multiply(this.pivotDown)
  }

  // ------------------------------------------------------------------ camera

  /** The level view on the house pressing, riding along with it while it rises. */
  private finPose(out: Pose) {
    const S = this.stations
    this.v.copy(this.houseState.center).sub(HOUSE_AT).multiplyScalar(0.85)
    out.pos.copy(S.fin.pos).add(this.v)
    out.tgt.copy(S.fin.tgt).add(this.v)
    out.fov = S.fin.fov
    return out
  }

  /** Presentation pose k, dollied in by `creep` (0..1 of the hold). */
  private projPose(k: number, creep: number, out: Pose) {
    const P = this.stations.proj[k]
    out.pos.copy(P.pos)
    out.tgt.copy(P.tgt)
    out.fov = P.fov
    this.v.subVectors(P.tgt, P.pos).normalize()
    out.pos.addScaledVector(this.v, creep * 0.12)
    return out
  }

  camera(l: number, f: Frame, out: CameraPose) {
    this.ensureLayout(f)
    const S = this.stations
    const A = this.tmpA
    const B = this.tmpB
    const C = this.tmpC
    let res: Pose
    const arrive0 = slotStart(0) + FW * PH.camIn
    const c0 = 0.064
    const leave5 = slotStart(NF - 1) + FW * 0.68
    if (l < c0) {
      // in-beat: crane down onto the crate-digger's view, then a slow settle
      const t = ease.outCubic(segment(l, 0, 0.05))
      res = blend(S.introFar, S.intro, t, A)
      res.pos.y -= segment(l, 0.03, c0) * 0.05
    } else if (l < arrive0) {
      const t = ease.inOutCubic(segment(l, c0, arrive0))
      B.pos.copy(S.intro.pos).y -= 0.05
      B.tgt.copy(S.intro.tgt)
      B.fov = S.intro.fov
      res = blend(B, S.proj[0], t, A)
    } else if (l < leave5) {
      const k = Math.min(NF - 1, Math.floor((l - F0) / FW))
      const s = (l - slotStart(k)) / FW
      if (s >= PH.camIn && s < PH.camOut) {
        // hold, with a slow dolly in
        res = this.projPose(k, segment(s, PH.camIn, PH.camOut), A)
      } else {
        // between records: crane down toward the flip, then up to the next
        const from = s >= PH.camOut ? k : k - 1
        const span = 1 - PH.camOut + PH.camIn
        const t = clamp(s >= PH.camOut ? (s - PH.camOut) / span : (s + 1 - PH.camOut) / span)
        blend(this.projPose(from, 1, B), this.projPose(from + 1, 0, C), ease.inOutCubic(t), A)
        // nod down into the crate to watch the sleeve go home and tip over, then back up
        // peaks just as the sleeve lands and tips; back up before the next one clears the crate
        const nod = Math.sin(clamp(t / 0.6) * Math.PI)
        this.v.subVectors(A.tgt, A.pos).normalize()
        A.pos.addScaledVector(this.v, -0.3 * nod)
        // (deeper where the layout holds the sleeves higher above the crate, once the sleeve is down)
        const high = Math.max(0, lerp(this.presentAt[from].y, this.presentAt[from + 1].y, t) - PRESENT.y) * smoothstep(0.08, 0.3, t)
        A.pos.y += 0.55 * nod
        A.tgt.y -= (1.05 + high) * nod
        A.tgt.z += 0.2 * nod
        res = A
      }
    } else if (l < FIN.cam[0]) {
      const t = ease.inOutCubic(segment(l, leave5, RIFFLE_CAM))
      blend(this.projPose(NF - 1, segment(l, slotStart(NF - 1) + FW * PH.camIn, leave5), B), S.riffle, t, A)
      // follow the riffle back through the crate
      const drift = segment(l, RIFFLE_CAM, FIN.cam[0])
      A.tgt.z -= drift * 0.16
      A.pos.z -= drift * 0.12
      res = A
    } else if (l < FIN.push[0]) {
      // down to a level view that follows the house pressing up out of the crate
      const t = ease.inOutCubic(segment(l, FIN.cam[0], FIN.cam[1]))
      B.pos.copy(S.riffle.pos).add(this.v.set(0, 0, -0.12))
      B.tgt.copy(S.riffle.tgt).add(this.v.set(0, 0, -0.16))
      B.fov = S.riffle.fov
      res = blend(B, this.finPose(C), t, A)
    } else {
      // push onto the grooves and label; homes in on wherever the record really is
      const t = ease.inOutQuad(segment(l, FIN.push[0], FIN.push[1]))
      res = blend(this.finPose(B), S.push, t, A)
      this.v.copy(this.houseState.recCenter).sub(S.push.tgt)
      res.pos.addScaledVector(this.v, t)
      res.tgt.addScaledVector(this.v, t)
      // and keeps drifting in on the label under the ripple
      this.v.subVectors(res.tgt, res.pos).normalize()
      res.pos.addScaledVector(this.v, ease.inOutQuad(segment(l, 0.97, 1)) * 0.14)
    }
    out.position.copy(res.pos)
    out.target.copy(res.tgt)
    out.fov = res.fov
    out.roll = 0
    out.parallax = this.compact ? 0.02 : 0.05 * (1 - segment(l, 0.94, 1))

    // HUD callout on the record (projected with this frame's pose)
    const cam = this.projCam
    cam.fov = out.fov
    cam.aspect = f.width / f.height
    cam.position.copy(out.position)
    cam.lookAt(out.target)
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()
    const on = this.domState.card >= 0 && !this.compact && this.record.visible
    if (on) {
      const P = this.presented
      const a = 68 * DEG
      this.v.set(Math.cos(a) * RECORD_R * 0.97, Math.sin(a) * RECORD_R * 0.97, 0).applyQuaternion(P.q).add(this.recCenter)
      this.callout.update(this.v, cam, f.width, f.height, smoothstep(0.6, 0.95, this.presented.slide))
    } else this.callout.update(this.v.set(0, 0, 0), cam, f.width, f.height, 0)
  }

  // ------------------------------------------------------------------ DOM per frame

  private updateDom(l: number, k: number, s: number, f: Frame) {
    const st = this.domState
    const introOn = l < INTRO_OFF
    if (introOn !== st.intro) {
      st.intro = introOn
      this.intro.classList.toggle('is-in', introOn)
      setRise(this.introTitle, introOn)
    }
    const headOn = l < MORE[1]
    if (headOn !== st.head) {
      st.head = headOn
      this.head.classList.toggle('is-in', headOn)
    }
    const cardOn = k >= 0 && s > PH.hudOn && s < PH.hudOff ? k : -1
    if (cardOn !== st.card) {
      st.card = cardOn
      this.cards.forEach((c, i) => {
        const on = i === cardOn
        if (on === c.on) return
        c.on = on
        c.root.classList.toggle('is-in', on)
        setRise(c.name, on)
      })
      if (cardOn >= 0) this.callout.label.textContent = `${catOf(cardOn)} · Side A · 33⅓ rpm`
    }
    const moreOn = l > MORE[0] && l < MORE[1]
    if (moreOn !== st.more) {
      st.more = moreOn
      this.more.classList.toggle('is-in', moreOn)
      setRise(this.moreTitle, moreOn)
    }
    // the riffle lights the name whose sleeve stands face-out at the front of
    // the bin (what's on screen); it goes "done" as that sleeve tips over
    let hot = -1
    if (moreOn) {
      hot = NR
      for (let j = 0; j < NR; j++)
        if (this.flip[NF + j] < 0.5) {
          hot = j
          break
        }
    }
    if (hot !== st.hot) {
      st.hot = hot
      this.more.classList.toggle('is-riffling', hot >= 0 && hot < NR)
      this.moreItems.forEach((li, j) => {
        li.classList.toggle('is-hot', j === hot)
        li.classList.toggle('is-done', hot >= 0 && j < hot)
      })
    }
    // meter: flipped = done, in hand / riffling = lit
    let cur = cardOn
    if (moreOn) cur = hot < NR ? NF + hot : -1
    let meter = ''
    for (let i = 0; i < NF + NR; i++) meter += i === cur ? '2' : this.flip[i] > 0.5 ? '1' : '0'
    if (meter !== st.meter) {
      st.meter = meter
      this.meterTicks.forEach((t, i) => {
        t.classList.toggle('is-on', meter[i] === '2')
        t.classList.toggle('is-done', meter[i] === '1')
      })
    }
    const count = cur >= 0 ? `${catOf(cur)} / ${pad(cur < NF ? NF : NF + NR)}` : `${pad(NF + NR)} records`
    if (count !== st.count) {
      st.count = count
      this.count.textContent = count
    }
    void f
  }

  onEnter() {
    if (!this.ctx.reducedMotion) this.wavePending = true
  }

  /** A tap on the spinning record gives it a push, like a hand on the platter. */
  onPointerDown(f: Frame, ctx: ChapterContext) {
    if (!this.record.visible) return
    this.ray.setFromCamera(f.pointerRaw, ctx.camera)
    this.record.updateMatrixWorld()
    if (this.ray.intersectObject(this.record, false).length) this.spinBoost = Math.min(this.spinBoost + 14, 30)
  }

  onLeave() {
    if (this.toneOn) {
      this.toneOn = false
      window.dispatchEvent(new CustomEvent('hark:tone', { detail: { hz: 110, level: 0 } }))
    }
  }
}

export default function create(): Chapter {
  return new Work()
}
