import type { Frame } from '../core/types'
import type { EngineState } from '../core/Engine'

/*
 * Studio ambience — WebAudio only, no files. Warm, close and quiet: a room
 * with a Rhodes in it, not a space drone.
 *
 *   pad      5 FM voices (sine carrier, 1:1 modulator whose index breathes)
 *            plus a detuned triangle for body → lowpass → soft tape
 *            saturation → small-room reverb. The chord changes per chapter.
 *   keys     sparse electric-piano strikes from the current chord (FM with a
 *            decaying index + a short tine partial), panned around the room
 *   tape     one shared pitch bus (cents) feeds every oscillator's detune:
 *            gentle wow & flutter always, deeper while scrolling, and the
 *            tape-stop pitch-down on every chapter cut
 *   hiss     faint band-limited noise, like a good deck on a quiet track
 *   crackle  vinyl crackle, only while "The Crate" (work) is playing
 *   tone     a pure sine a chapter can ask for ('hark:tone' events), e.g.
 *            the cymatics plate's frequency
 *   cut()    tape-stop pitch-down + a soft felt thump
 *   blip()   a tiny tactile click for nav hover
 *
 * Off by default. The loader asks first-time visitors ("Play with sound" /
 * "Enter quietly", dispatched here as a 'hark:audio' event from that click),
 * and the answer is remembered. Audio only ever starts from a user gesture: a
 * remembered "on" waits for the first real activation (a pointer press or tap,
 * or Enter / Space on a control; never Tab, Shift or scrolling keys).
 * Faded out and suspended while the tab is hidden.
 */

export const STORE_KEY = 'hark-resonance:audio'

/** The remembered choice: true (on), false (off), or null when never asked. */
export function storedAudio(): boolean | null {
  try {
    const v = localStorage.getItem(STORE_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

/** keys that activate a focused control; everything else (Tab, Shift, arrows, PageDown…) is navigation */
const ACTIVATE_KEYS = new Set(['Enter', ' ', 'Spacebar'])
const CONTROL = 'a[href], button, [role="button"], [role="switch"], summary, input, select, textarea'
const MASTER_LEVEL = 0.5
const TONE_MAX = 0.1
/** a chapter that stops sending 'hark:tone' without a level 0 gets released after this */
const TONE_STALE_MS = 280

const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12)
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Five-voice chords (MIDI, low → high) per chapter id. F major world, warm and unhurried. */
const CHORDS: Record<string, number[]> = {
  hero: [41, 53, 57, 60, 64], // Fmaj7
  work: [38, 50, 53, 57, 60], // Dm7 (crate digging)
  services: [36, 48, 52, 55, 59], // Cmaj7 (the plate sings over it)
  shield: [33, 45, 48, 52, 55], // Am7, low and dark
  voices: [34, 46, 50, 53, 57], // Bbmaj7
  process: [43, 50, 53, 57, 58], // Gm(add9)
  contact: [41, 53, 57, 60, 67], // Fadd9, home
}
const DEFAULT_CHORD = CHORDS.hero
/** lowpass colour per chapter (the room gets darker for security, opens for contact) */
const BRIGHT: Record<string, number> = { shield: 620, voices: 980, contact: 1500 }
const VOICE_GAIN = [0.07, 0.05, 0.04, 0.034, 0.028]
const VOICE_INDEX = [0.9, 0.75, 0.6, 0.5, 0.42]

interface PadVoice {
  car: OscillatorNode
  body: OscillatorNode
  mod: OscillatorNode
  modGain: GainNode
  breathe: GainNode
  index: number
}

function noiseBuffer(ctx: AudioContext, seconds: number) {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
    const fade = Math.min(2048, len >> 3)
    for (let i = 0; i < fade; i++) {
      const t = i / fade
      d[i] = d[i] * t + d[len - fade + i] * (1 - t)
    }
  }
  return buf
}

/** Sparse vinyl crackle: tiny decaying ticks at random, the odd louder pop. */
function crackleBuffer(ctx: AudioContext, seconds: number) {
  const sr = ctx.sampleRate
  const len = Math.floor(sr * seconds)
  const buf = ctx.createBuffer(2, len, sr)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    const ticks = Math.floor(seconds * 26)
    for (let k = 0; k < ticks; k++) {
      const at = Math.floor(Math.random() * (len - 400))
      const big = Math.random() < 0.05
      const amp = (big ? 0.6 + Math.random() * 0.35 : Math.pow(Math.random(), 2.4) * 0.45) * (Math.random() < 0.5 ? -1 : 1)
      const n = big ? 90 + Math.floor(Math.random() * 120) : 6 + Math.floor(Math.random() * 22)
      for (let i = 0; i < n; i++) {
        const e = Math.exp(-i / (n * 0.28))
        d[at + i] += amp * e * (i % 2 ? -0.6 : 1) * (0.6 + Math.random() * 0.4)
      }
    }
  }
  return buf
}

/** Procedural small-room impulse response: darkened, exponentially decaying noise. */
function impulse(ctx: AudioContext, seconds: number, decay: number) {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    let lp = 0
    for (let i = 0; i < len; i++) {
      const t = i / len
      const k = 0.25 + 0.65 * t
      lp += (Math.random() * 2 - 1 - lp) * (1 - k)
      d[i] = lp * Math.pow(1 - t, decay) * (i < 96 ? i / 96 : 1)
    }
  }
  return buf
}

function saturation(k: number) {
  const n = 1024
  const curve = new Float32Array(n)
  const norm = Math.tanh(k)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    curve[i] = Math.tanh(k * x) / norm
  }
  return curve
}

/**
 * iOS routes Web Audio through the "ambient" session, which the ring/silent
 * switch mutes. Safari 16.4+ lets a page opt into "playback"; hand it back to
 * "auto" when muted. Feature-detected; a no-op elsewhere.
 */
function setAudioSession(type: 'playback' | 'auto') {
  try {
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession
    if (session && session.type !== type) session.type = type
  } catch {
    /* unsupported */
  }
}

export class Sound {
  enabled = false
  onChange: ((enabled: boolean) => void)[] = []

  private ctx: AudioContext | null = null
  private master!: GainNode
  private analyser!: AnalyserNode
  private scope: Float32Array<ArrayBuffer> = new Float32Array(512)
  private pitch!: ConstantSourceNode
  private wowDepth!: GainNode
  private tapeLP!: BiquadFilterNode
  private padLP!: BiquadFilterNode
  private padOut!: GainNode
  private keysBus!: GainNode
  private reverbIn!: GainNode
  private crackleGain!: GainNode
  private toneOsc!: OscillatorNode
  private toneGain!: GainNode
  private white!: AudioBuffer
  private voices: PadVoice[] = []

  private chordId = ''
  private lastCut = 0
  private lastBlip = 0
  private keysTimer = 0
  private suspendTimer = 0
  private hidden = typeof document !== 'undefined' && document.hidden
  private mobile = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
  /** a remembered "on" preference waiting for the first user gesture */
  private armed = false
  private gestureBound = false

  // requested pure tone (kept even while muted so it applies the moment sound starts)
  private toneHz = 432
  private toneLevel = 0
  private toneAt = 0
  private toneSent = { hz: 0, level: -1 }

  constructor() {
    try {
      this.armed = localStorage.getItem(STORE_KEY) === '1'
    } catch {
      /* storage blocked: stay off */
    }
    if (this.armed) this.waitForGesture()
    document.addEventListener('visibilitychange', () => {
      this.hidden = document.hidden
      this.applyRunning()
    })
    // the loader's sound gate: an explicit choice, made with a click
    window.addEventListener('hark:audio', e => {
      const d = (e as CustomEvent<{ on?: boolean }>).detail
      if (d && typeof d.on === 'boolean') this.set(d.on)
    })
    window.addEventListener('hark:tone', e => {
      const d = (e as CustomEvent<{ hz?: number; level?: number }>).detail
      if (d && typeof d.hz === 'number') this.tone(d.hz, d.level ?? 0)
    })
  }

  /** Flip sound on/off. Call from a user gesture (click / key). */
  toggle() {
    this.armed = false
    this.setEnabled(!this.enabled)
  }

  /** Set sound on/off and remember the choice (even when it is unchanged). */
  set(on: boolean) {
    this.armed = false
    this.setEnabled(on)
    this.persist(on)
  }

  /** Release any requested tone at once (e.g. while the scene is covered and chapters stop updating). */
  hush() {
    if (this.toneLevel === 0) return
    this.toneLevel = 0
    this.applyTone()
  }

  /** Current output level 0..1 (for the chrome's LED ladder). 0 while muted. */
  meter() {
    if (!this.live()) return 0
    this.analyser.getFloatTimeDomainData(this.scope)
    let s = 0
    for (let i = 0; i < this.scope.length; i++) s += this.scope[i] * this.scope[i]
    const rms = Math.sqrt(s / this.scope.length)
    const db = 20 * Math.log10(rms + 1e-9)
    return clamp01((db + 52) / 40)
  }

  /** A tiny tactile click (nav hover). No-op while sound is off. */
  blip(pitch = 0) {
    const ctx = this.live()
    if (!ctx) return
    const now = ctx.currentTime
    if (now - this.lastBlip < 0.05) return
    this.lastBlip = now
    const src = ctx.createBufferSource()
    src.buffer = this.white
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = [2600, 3100, 3500, 2300, 4000][Math.abs(pitch) % 5]
    bp.Q.value = 2.2
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, now)
    g.gain.linearRampToValueAtTime(0.12, now + 0.0015)
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.028)
    src.connect(bp)
    bp.connect(g)
    g.connect(this.master)
    src.start(now, Math.random() * 2)
    src.stop(now + 0.04)
    // the faintest pitched body under the click, like a good switch
    const o = ctx.createOscillator()
    const og = ctx.createGain()
    o.frequency.value = 1760 + (Math.abs(pitch) % 5) * 110
    og.gain.setValueAtTime(0.012, now)
    og.gain.exponentialRampToValueAtTime(0.0001, now + 0.05)
    o.connect(og)
    og.connect(this.master)
    o.start(now)
    o.stop(now + 0.06)
  }

  /** A chapter may request a pure tone (e.g. cymatics); level 0..1, 0 releases it. */
  tone(hzIn: number, level: number) {
    if (!Number.isFinite(hzIn) || !Number.isFinite(level)) return
    this.toneHz = Math.min(6000, Math.max(20, hzIn))
    this.toneLevel = clamp01(level)
    this.toneAt = performance.now()
    this.applyTone()
  }

  /** called every frame */
  update(frame: Frame, state: EngineState) {
    // a chapter that went quiet without saying so gets released
    if (this.toneLevel > 0 && performance.now() - this.toneAt > TONE_STALE_MS) {
      this.toneLevel = 0
      this.applyTone()
    }
    const ctx = this.live()
    if (!ctx) return
    const now = ctx.currentTime
    const slot = state.slots[state.index]
    const id = slot?.def.id ?? 'hero'
    if (id !== this.chordId) this.setChord(id)

    const v = Math.min(1, Math.abs(frame.velocity) / 3)
    // tape wow deepens a little with scroll speed
    this.wowDepth.gain.setTargetAtTime(3 + v * 10, now, 0.15)
    // the room brightens gently through the story
    const base = BRIGHT[id] ?? 1100
    this.padLP.frequency.setTargetAtTime(base + frame.progress * 320 + v * 260, now, 0.5)
    // the crate crackles
    this.crackleGain.gain.setTargetAtTime(id === 'work' ? 0.22 : 0, now, 0.5)
    // make room for a requested tone
    this.padOut.gain.setTargetAtTime(0.85 * (1 - 0.5 * this.toneLevel), now, 0.3)
  }

  /** called when the story cuts from chapter `from` to `to`: tape-stop + thump */
  cut(from: number, to: number) {
    const ctx = this.live()
    if (!ctx) return
    const now = ctx.currentTime
    const since = now - this.lastCut
    if (since < 0.25) return
    this.lastCut = now
    const level = since < 1.2 ? 0.55 : 1
    void from
    void to

    // tape stop: every oscillator sags an octave and the top end closes, then spins back up
    const p = this.pitch.offset
    p.cancelScheduledValues(now)
    p.setValueAtTime(p.value, now)
    p.setTargetAtTime(-1100, now, 0.11)
    p.setTargetAtTime(0, now + 0.3, 0.07)
    const f = this.tapeLP.frequency
    f.cancelScheduledValues(now)
    f.setValueAtTime(f.value, now)
    f.setTargetAtTime(520, now, 0.08)
    f.setTargetAtTime(9000, now + 0.3, 0.12)

    // soft felt thump
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.frequency.setValueAtTime(78, now + 0.02)
    o.frequency.exponentialRampToValueAtTime(38, now + 0.3)
    g.gain.setValueAtTime(0, now)
    g.gain.linearRampToValueAtTime(0.3 * level, now + 0.03)
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.55)
    o.connect(g)
    g.connect(this.master)
    o.start(now)
    o.stop(now + 0.6)
    const n = ctx.createBufferSource()
    n.buffer = this.white
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 380
    const ng = ctx.createGain()
    ng.gain.setValueAtTime(0, now)
    ng.gain.linearRampToValueAtTime(0.1 * level, now + 0.01)
    ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.12)
    n.connect(lp)
    lp.connect(ng)
    ng.connect(this.master)
    n.start(now, Math.random() * 2)
    n.stop(now + 0.15)
  }

  // ------------------------------------------------------------------ internals

  /** The running context, or null when sound is off / suspended / hidden. */
  private live() {
    const ctx = this.ctx
    if (!ctx || !this.enabled || this.hidden || ctx.state !== 'running') return null
    return ctx
  }

  private applyTone() {
    const ctx = this.live()
    if (!ctx) return
    const lv = this.toneLevel * TONE_MAX
    const s = this.toneSent
    if (Math.abs(s.hz - this.toneHz) < 0.05 && Math.abs(s.level - lv) < 0.0005) return
    const now = ctx.currentTime
    // gentle attack, slower release: never a click
    this.toneOsc.frequency.setTargetAtTime(this.toneHz, now, 0.035)
    this.toneGain.gain.setTargetAtTime(lv, now, lv > s.level ? 0.07 : 0.16)
    s.hz = this.toneHz
    s.level = lv
  }

  private setEnabled(on: boolean) {
    if (on === this.enabled) return
    this.enabled = on
    this.persist(on)
    setAudioSession(on ? 'playback' : 'auto')
    if (on) this.ensureGraph()
    this.applyRunning()
    for (const fn of this.onChange) fn(on)
  }

  private persist(on: boolean) {
    try {
      localStorage.setItem(STORE_KEY, on ? '1' : '0')
    } catch {
      /* ignore */
    }
  }

  /** Resume + fade in, or fade out + suspend, based on enabled/hidden. */
  private applyRunning() {
    const ctx = this.ctx
    if (!ctx) return
    clearTimeout(this.suspendTimer)
    const now = ctx.currentTime
    if (this.enabled && !this.hidden) {
      ctx
        .resume()
        .then(() => {
          if (!this.enabled || this.hidden) return
          if (ctx.state !== 'running') return this.waitForGesture()
          const t = ctx.currentTime
          this.master.gain.cancelScheduledValues(t)
          this.master.gain.setValueAtTime(this.master.gain.value, t)
          this.master.gain.setTargetAtTime(MASTER_LEVEL, t, 0.7)
          this.toneSent.level = -1
          this.applyTone()
          this.scheduleKeys(1.4)
        })
        .catch(() => this.waitForGesture())
    } else {
      this.master.gain.cancelScheduledValues(now)
      this.master.gain.setValueAtTime(this.master.gain.value, now)
      this.master.gain.setTargetAtTime(0, now, this.hidden ? 0.06 : 0.25)
      window.clearTimeout(this.keysTimer)
      this.suspendTimer = window.setTimeout(
        () => {
          if (!this.enabled || this.hidden) ctx.suspend().catch(() => {})
        },
        this.hidden ? 350 : 1500,
      )
    }
  }

  /** Start audio on the first real gesture (remembered preference / blocked resume). */
  private waitForGesture() {
    if (this.gestureBound) return
    this.gestureBound = true
    const events = ['pointerdown', 'click', 'touchend', 'keydown'] as const
    const handler = (e: Event) => {
      // keyboard: only Enter / Space aimed at a control counts as "play"; Tab,
      // Shift+Tab, arrows, PageDown and Space-to-scroll are just moving around
      if (e instanceof KeyboardEvent) {
        if (!ACTIVATE_KEYS.has(e.key) || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
        if (!(e.target as Element | null)?.closest?.(CONTROL)) return
      }
      for (const ev of events) window.removeEventListener(ev, handler, true)
      this.gestureBound = false
      const onToggle = (e.target as Element | null)?.closest?.('[data-sound-toggle]')
      if (this.armed) {
        this.armed = false
        // the toggle's own click will switch it on
        if (!onToggle) this.setEnabled(true)
      } else if (this.enabled) this.applyRunning()
    }
    for (const ev of events) window.addEventListener(ev, handler, true)
  }

  private ensureGraph() {
    if (this.ctx) return
    const AC =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const ctx = new AC({ latencyHint: 'playback' })
    this.ctx = ctx
    const now = ctx.currentTime
    this.white = noiseBuffer(ctx, 3)

    // master → glue compression → analyser → out
    this.master = ctx.createGain()
    this.master.gain.value = 0
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 30
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -18
    comp.knee.value = 16
    comp.ratio.value = 2.5
    comp.attack.value = 0.02
    comp.release.value = 0.35
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 512
    this.master.connect(hp)
    hp.connect(comp)
    comp.connect(this.analyser)
    this.analyser.connect(ctx.destination)

    // the tape: a lowpass the cut can close + a shared pitch bus with wow & flutter
    const tape = ctx.createGain()
    this.tapeLP = ctx.createBiquadFilter()
    this.tapeLP.type = 'lowpass'
    this.tapeLP.frequency.value = 9000
    this.tapeLP.Q.value = 0.4
    tape.connect(this.tapeLP)
    this.tapeLP.connect(this.master)

    this.pitch = ctx.createConstantSource()
    this.pitch.offset.value = 0
    this.pitch.start(now)
    const wow = ctx.createOscillator()
    wow.frequency.value = 0.55
    this.wowDepth = ctx.createGain()
    this.wowDepth.gain.value = 3
    wow.connect(this.wowDepth)
    this.wowDepth.connect(this.pitch.offset)
    wow.start(now)
    const flutter = ctx.createOscillator()
    flutter.frequency.value = 6.3
    const flutterDepth = ctx.createGain()
    flutterDepth.gain.value = 1.2
    flutter.connect(flutterDepth)
    flutterDepth.connect(this.pitch.offset)
    flutter.start(now)

    // small warm room
    const verb = ctx.createConvolver()
    verb.buffer = impulse(ctx, this.mobile ? 1.8 : 2.6, 3.2)
    this.reverbIn = ctx.createGain()
    const verbOut = ctx.createGain()
    verbOut.gain.value = 0.55
    this.reverbIn.connect(verb)
    verb.connect(verbOut)
    verbOut.connect(tape)

    // pad: FM voices → lowpass → saturation → out (+ room)
    const padBus = ctx.createGain()
    this.padLP = ctx.createBiquadFilter()
    this.padLP.type = 'lowpass'
    this.padLP.frequency.value = 1100
    this.padLP.Q.value = 0.5
    const sat = ctx.createWaveShaper()
    sat.curve = saturation(1.6)
    sat.oversample = '2x'
    this.padOut = ctx.createGain()
    this.padOut.gain.value = 0.85
    padBus.connect(this.padLP)
    this.padLP.connect(sat)
    sat.connect(this.padOut)
    this.padOut.connect(tape)
    const padSend = ctx.createGain()
    padSend.gain.value = 0.6
    this.padOut.connect(padSend)
    padSend.connect(this.reverbIn)

    // one slow shared "breath" on the FM index: the pad opens and closes like a sigh
    const breath = ctx.createOscillator()
    breath.frequency.value = 0.065
    breath.start(now)

    DEFAULT_CHORD.forEach((m, i) => {
      const f = hz(m)
      const car = ctx.createOscillator()
      const body = ctx.createOscillator()
      const mod = ctx.createOscillator()
      car.type = 'sine'
      body.type = 'triangle'
      mod.type = 'sine'
      car.frequency.value = body.frequency.value = mod.frequency.value = f
      body.detune.value = 5 + i
      car.detune.value = -2 - i * 0.5
      const index = VOICE_INDEX[i]
      const modGain = ctx.createGain()
      modGain.gain.value = f * index
      const breathe = ctx.createGain()
      breathe.gain.value = f * index * 0.45
      breath.connect(breathe)
      breathe.connect(modGain.gain)
      mod.connect(modGain)
      modGain.connect(car.frequency)
      for (const o of [car, body, mod]) this.pitch.connect(o.detune)

      const gain = ctx.createGain()
      gain.gain.value = VOICE_GAIN[i]
      const bodyGain = ctx.createGain()
      bodyGain.gain.value = 0.35
      const pan = ctx.createStereoPanner()
      pan.pan.value = (i % 2 ? 1 : -1) * (0.08 + i * 0.1)
      car.connect(gain)
      body.connect(bodyGain)
      bodyGain.connect(gain)
      gain.connect(pan)
      pan.connect(padBus)
      car.start(now)
      body.start(now)
      mod.start(now)
      this.voices.push({ car, body, mod, modGain, breathe, index })
    })
    this.chordId = 'hero'

    // keys bus (electric-piano strikes)
    this.keysBus = ctx.createGain()
    this.keysBus.gain.value = 1
    const keysLP = ctx.createBiquadFilter()
    keysLP.type = 'lowpass'
    keysLP.frequency.value = 3400
    this.keysBus.connect(keysLP)
    keysLP.connect(tape)
    const keysSend = ctx.createGain()
    keysSend.gain.value = 0.7
    keysLP.connect(keysSend)
    keysSend.connect(this.reverbIn)

    // tape hiss
    const hiss = ctx.createBufferSource()
    hiss.buffer = this.white
    hiss.loop = true
    const hissHP = ctx.createBiquadFilter()
    hissHP.type = 'highpass'
    hissHP.frequency.value = 3200
    const hissLP = ctx.createBiquadFilter()
    hissLP.type = 'lowpass'
    hissLP.frequency.value = 11000
    const hissGain = ctx.createGain()
    hissGain.gain.value = 0.0075
    hiss.connect(hissHP)
    hissHP.connect(hissLP)
    hissLP.connect(hissGain)
    hissGain.connect(this.master)
    hiss.start(now)

    // vinyl crackle (work only)
    const crackle = ctx.createBufferSource()
    crackle.buffer = crackleBuffer(ctx, 7)
    crackle.loop = true
    const crackleHP = ctx.createBiquadFilter()
    crackleHP.type = 'highpass'
    crackleHP.frequency.value = 900
    const crackleLP = ctx.createBiquadFilter()
    crackleLP.type = 'lowpass'
    crackleLP.frequency.value = 7000
    this.crackleGain = ctx.createGain()
    this.crackleGain.gain.value = 0
    crackle.connect(crackleHP)
    crackleHP.connect(crackleLP)
    crackleLP.connect(this.crackleGain)
    this.crackleGain.connect(this.master)
    crackle.start(now)

    // requested pure tone: clean, a touch of room
    this.toneOsc = ctx.createOscillator()
    this.toneOsc.type = 'sine'
    this.toneOsc.frequency.value = this.toneHz
    this.toneGain = ctx.createGain()
    this.toneGain.gain.value = 0
    this.toneOsc.connect(this.toneGain)
    this.toneGain.connect(this.master)
    const toneSend = ctx.createGain()
    toneSend.gain.value = 0.18
    this.toneGain.connect(toneSend)
    toneSend.connect(this.reverbIn)
    this.toneOsc.start(now)
  }

  private setChord(id: string) {
    const ctx = this.ctx
    if (!ctx) return
    this.chordId = id
    const chord = CHORDS[id] ?? DEFAULT_CHORD
    const now = ctx.currentTime
    this.voices.forEach((v, i) => {
      const f = hz(chord[i % chord.length])
      // stagger from the bass up so the change blooms instead of snapping
      const t = now + 0.12 + i * 0.09
      const tc = 0.35
      v.car.frequency.setTargetAtTime(f, t, tc)
      v.body.frequency.setTargetAtTime(f, t, tc)
      v.mod.frequency.setTargetAtTime(f, t, tc)
      v.modGain.gain.setTargetAtTime(f * v.index, t, tc)
      v.breathe.gain.setTargetAtTime(f * v.index * 0.45, t, tc)
    })
    this.scheduleKeys(0.9)
  }

  /** Sparse electric-piano strikes from the current chord. */
  private scheduleKeys(firstIn: number) {
    window.clearTimeout(this.keysTimer)
    const next = () => {
      const ctx = this.live()
      if (!ctx) return
      const chord = CHORDS[this.chordId] ?? DEFAULT_CHORD
      // one note, sometimes a soft dyad
      const pick = 1 + ((Math.random() * (chord.length - 1)) | 0)
      this.strike(ctx, chord[pick] + 12, 0.75 + Math.random() * 0.25)
      if (Math.random() < 0.35) this.strike(ctx, chord[Math.max(1, pick - 1)] + 12, 0.5, 0.09)
      this.keysTimer = window.setTimeout(next, 3200 + Math.random() * 4200)
    }
    this.keysTimer = window.setTimeout(next, firstIn * 1000)
  }

  private strike(ctx: AudioContext, midi: number, vel: number, delay = 0) {
    const now = ctx.currentTime + delay
    const f = hz(midi)
    const car = ctx.createOscillator()
    const mod = ctx.createOscillator()
    const tine = ctx.createOscillator()
    car.frequency.value = mod.frequency.value = f
    tine.frequency.value = f * 7.02
    this.pitch.connect(car.detune)
    this.pitch.connect(mod.detune)
    this.pitch.connect(tine.detune)
    const idx = ctx.createGain()
    idx.gain.setValueAtTime(f * 2.4 * vel, now)
    idx.gain.exponentialRampToValueAtTime(f * 0.18, now + 1.6)
    mod.connect(idx)
    idx.connect(car.frequency)
    const amp = ctx.createGain()
    const peak = 0.05 * vel
    amp.gain.setValueAtTime(0, now)
    amp.gain.linearRampToValueAtTime(peak, now + 0.006)
    amp.gain.exponentialRampToValueAtTime(peak * 0.35, now + 0.5)
    amp.gain.exponentialRampToValueAtTime(0.0001, now + 4.2)
    const tg = ctx.createGain()
    tg.gain.setValueAtTime(0, now)
    tg.gain.linearRampToValueAtTime(0.012 * vel, now + 0.003)
    tg.gain.exponentialRampToValueAtTime(0.0001, now + 0.12)
    const pan = ctx.createStereoPanner()
    pan.pan.value = Math.random() * 0.9 - 0.45
    car.connect(amp)
    tine.connect(tg)
    tg.connect(pan)
    amp.connect(pan)
    pan.connect(this.keysBus)
    for (const o of [car, mod, tine]) {
      o.start(now)
      o.stop(now + 4.3)
    }
    car.onended = () => {
      try {
        this.pitch.disconnect(car.detune)
        this.pitch.disconnect(mod.detune)
        this.pitch.disconnect(tine.detune)
      } catch {
        /* already gone */
      }
      pan.disconnect()
    }
  }
}
