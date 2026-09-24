import * as THREE from 'three'
import './work.css'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { SECTIONS, WORK, workImage, type WorkItem } from '../../content'
import { clamp, ease, lerp, segment, smoothstep } from '../../core/math'
import { Callout, el, rise, setRise } from '../../core/dom'
import { CRATE, LABEL_R, RECORD_R, crateGeometry, recordGeometry, shadowQuad, sleeveGeometry } from './geometry'
import { BONE, IMG, drawBack, drawFront, drawInner, drawLabel, drawPlate, loadFonts, type SleeveSpec } from './art'
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
 *   0.856–0.958 "Nine more, all live.": a fast riffle, the nine sleeves tip
 *              forward one after another as their names light up in the list
 *   0.912–1.00 out-beat: the house pressing rises, its record slides up out of
 *              the inner sleeve and spins up to a blur as the camera pushes into
 *              the label (the ripple cut emanates from the spindle)
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
const MORE = [0.856, 0.958] as const
const RIFFLE = [0.866, 0.912] as const
const FIN = {
  rise: [0.912, 0.952] as const,
  out: [0.936, 0.968] as const,
  spin: [0.945, 1] as const,
  cam: [0.905, 0.952] as const,
  push: [0.946, 0.996] as const,
}

// ---- crate layout
const Y0 = CRATE.y0
const zUp = (i: number) => 0.02 - i * 0.034
const zStack = (i: number) => 0.16 - i * 0.024
const TH0 = Math.atan((CRATE.zFront - CRATE.wall - 0.16) / (CRATE.frontH - Y0)) - 0.016
const thStack = (i: number) => Math.atan(Math.tan(TH0) + i * 0.045)

// ---- presentation
const PRESENT = new THREE.Vector3(0, 1.88, 0.78)
const HOUSE_AT = new THREE.Vector3(0, 1.62, 0.1)
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

  private ctx!: ChapterContext
  private compact = false

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
    crate: pose(),
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
  private D = new THREE.Vector3()
  private e = new THREE.Euler()
  private one = new THREE.Vector3(1, 1, 1)
  private presented = { k: -1, center: new THREE.Vector3(), q: new THREE.Quaternion(), slide: 0 }
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
    const soft = new THREE.PointLight(0xfff6ea, 3.2, 0, 2)
    soft.position.copy(PRESENT).add(new THREE.Vector3(-1.6, 1.2, 1.7))
    this.group.add(soft)

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
    this.houseLabel = mkLabel(BONE)

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
        side: 'SIDE B',
        ink: false,
        paper: BONE,
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
        cat: 'HRK · SIDE B',
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

    let regProj: Region
    let regIntro: Region
    let regRiffle: Region
    let regFin: Region
    if (this.compact) {
      regProj = { x0: gutter, x1: W - gutter, y0: head.b + 10, y1: cardTop - 12 }
      regIntro = { x0: gutter, x1: W - gutter, y0: intro.b + 6, y1: H - safeB }
      regRiffle = { x0: gutter, x1: W - gutter, y0: head.b + 6, y1: more.t - 8 }
      regFin = { x0: gutter, x1: W - gutter, y0: head.b + 10, y1: H - safeB }
    } else {
      const x0 = Math.max(cardRight, more.r) + Math.max(28, W * 0.03)
      regProj = { x0, x1: W - gutter, y0: head.b + 16, y1: H - safeB }
      regIntro = { x0: Math.max(intro.r - W * 0.06, W * 0.4), x1: W - gutter * 0.5, y0: head.b, y1: H - safeB * 0.6 }
      regRiffle = { x0, x1: W - gutter, y0: head.b + 10, y1: H - safeB }
      regFin = { x0, x1: W - gutter, y0: head.b + 10, y1: H - safeB }
    }

    const S = this.stations
    // crate-digger's three-quarter view
    dirOf(24, 33, this.D)
    frameTo(S.intro, this.v.set(0.02, 0.5, 0.12), this.D, 1.66, 1.62, regIntro, W, H, fov)
    S.introFar.pos.copy(S.intro.pos).addScaledVector(this.D, -1.3).add(this.v.set(0, 0.55, 0))
    S.introFar.tgt.copy(S.intro.tgt).add(this.v.set(0, 0.12, 0))
    S.introFar.fov = fov
    // presentations: the sleeve + the record out to its right
    S.proj = FEATURED.map((_, k) => {
      const p = pose()
      dirOf(YAW[k], PITCH, this.D)
      _r.crossVectors(this.D, UP).normalize()
      const C = this.v.copy(PRESENT).addScaledVector(_r, (SLIDE + RECORD_R - 0.5) / 2)
      frameTo(p, C, this.D, 0.5 + SLIDE + RECORD_R + (this.compact ? 0.16 : 0.05), 1.06, regProj, W, H, fov)
      return p
    })
    // down into the crate (between records)
    dirOf(0, 38, this.D)
    frameTo(S.crate, this.v.set(0, 0.62, 0.15), this.D, 1.6, 1.4, regProj, W, H, fov)
    // the riffle: steep, over the stack
    dirOf(-12, 44, this.D)
    frameTo(S.riffle, this.v.set(0, 0.46, 0.22), this.D, 1.95, 2.15, regRiffle, W, H, fov)
    // the house pressing, record up out of its sleeve
    dirOf(0, 10, this.D)
    frameTo(S.fin, this.v.copy(HOUSE_AT).add(this.v2.set(0, SLIDE * 0.5, 0)), this.D, 1.25, 1.2 + SLIDE, regFin, W, H, fov)
    // push: the label fills the frame, spindle dead centre (the ripple rises from it)
    const recC = this.v.copy(HOUSE_AT).add(this.v2.set(0, SLIDE, 0))
    frameTo(S.push, recC, this.D, LABEL_R * 2.2, LABEL_R * 2.2, { x0: 0, x1: W, y0: 0, y1: H }, W, H, fov)
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

    ctx.studio.params.tone = 0
    ctx.studio.params.warmth = 0.42
    ctx.studio.params.spot = 0.55
    ctx.studio.params.envIntensity = 1.05
    ctx.post.params.vignette = 0.26
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
      if (i === k && lift > 0.0005) this.presentMatrix(i, lift, YAW[i], PITCH, PRESENT, mesh.matrix, this.presented)
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
    const hLift = outBack(segment(l, FIN.rise[0], FIN.rise[1]), 0.8)
    if (hLift > 0.0005) this.presentMatrix(HOUSE, hLift, 0, 10, HOUSE_AT, this.house.matrix, this.houseState)
    else {
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
      H.recCenter.copy(H.center).add(this.v.set(0, SLIDE * 1.02 * hs, 0).applyQuaternion(H.q))
      this.houseRec.position.copy(H.recCenter)
      const spinUp = ease.inCubic(segment(l, FIN.spin[0], FIN.spin[1]))
      const omega = (ctx.reducedMotion ? 0.4 : 1) * (hs * RPM33 * 1.2 + spinUp * 46)
      this.houseSpin -= omega * f.dt
      this.qSpin.setFromAxisAngle(this.v.set(0, 0, 1), this.houseSpin)
      this.houseRec.quaternion.copy(H.q).multiply(this.qSpin)
      this.houseRecU.uBlur.value = ctx.reducedMotion ? 0 : Math.min(2.6, omega * 0.045)
      this.houseRecU.uSpec.value = 1 + spinUp * 0.6
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
    for (let j = 0; j < NR; j++) tgt[NF + j] = l > RIFFLE[0] + (j / (NR - 1)) * (RIFFLE[1] - RIFFLE[0]) ? 1 : 0
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
        A.pos.y += 0.55 * nod
        A.tgt.y -= 1.05 * nod
        A.tgt.z += 0.2 * nod
        res = A
      }
    } else if (l < FIN.cam[0]) {
      const t = ease.inOutCubic(segment(l, leave5, 0.872))
      blend(this.projPose(NF - 1, segment(l, slotStart(NF - 1) + FW * PH.camIn, leave5), B), S.riffle, t, A)
      // follow the riffle back through the crate
      const drift = segment(l, 0.87, FIN.cam[0])
      A.tgt.z -= drift * 0.16
      A.pos.z -= drift * 0.12
      res = A
    } else if (l < FIN.push[0]) {
      const t = ease.inOutCubic(segment(l, FIN.cam[0], FIN.cam[1]))
      B.pos.copy(S.riffle.pos).add(this.v.set(0, 0, -0.12))
      B.tgt.copy(S.riffle.tgt).add(this.v.set(0, 0, -0.16))
      B.fov = S.riffle.fov
      res = blend(B, S.fin, t, A)
    } else {
      const t = ease.inOutQuad(segment(l, FIN.push[0], FIN.push[1]))
      res = blend(S.fin, S.push, t, A)
      // the push homes in on wherever the record really is
      this.v.copy(this.houseState.recCenter).sub(S.push.tgt)
      res.pos.addScaledVector(this.v, t)
      res.tgt.addScaledVector(this.v, t)
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
    // the riffle lights each name as its sleeve goes over
    let hot = -1
    if (moreOn) for (let j = 0; j < NR; j++) if (this.flip[NF + j] > 0.5 || (j === 0 && l > RIFFLE[0] - 0.004)) hot = j
    if (moreOn && hot < 0) hot = 0
    if (hot !== st.hot) {
      st.hot = hot
      this.more.classList.toggle('is-riffling', hot >= 0 && hot < NR - 1)
      this.moreItems.forEach((li, j) => {
        li.classList.toggle('is-hot', j === hot)
        li.classList.toggle('is-done', hot >= 0 && j < hot)
      })
    }
    // meter: flipped = done, in hand / riffling = lit
    let cur = cardOn
    if (moreOn) cur = NF + Math.max(0, hot)
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
