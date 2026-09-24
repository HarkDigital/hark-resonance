import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'

/**
 * Final display-space pass for the acoustic lab: a pressure-wave RIPPLE at
 * chapter cuts (rings of lens displacement + a soft paper wash at the peak),
 * tape wow/flutter for `glitch`, gentle aberration, paper grain, light
 * vignette. Everything fades toward paper, never black.
 */
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    /** 0..1, peaks at a chapter cut (engine-driven) */
    uTransition: { value: 0 },
    /** 0..1 tape wow/flutter wobble a chapter can add */
    uGlitch: { value: 0 },
    /** baseline chromatic aberration (UV units at the corners) */
    uAberration: { value: 0.0012 },
    uGrain: { value: 0.035 },
    uVignette: { value: 0.22 },
    /** 0..1 wash to paper white */
    uFlash: { value: 0 },
    /** 0..1 fades the whole frame to paper (reduced-motion cuts) */
    uFade: { value: 0 },
    uPaper: { value: new THREE.Color('#eeebe4') },
    /** reduced-motion dip colour (paper in light rooms, graphite in dark ones) */
    uFadeColor: { value: new THREE.Color('#eeebe4') },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uTransition, uGlitch, uAberration, uGrain, uVignette, uFlash, uFade;
    uniform vec2 uResolution;
    uniform vec3 uPaper, uFadeColor;
    varying vec2 vUv;

    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    vec3 chroma(vec2 uv, vec2 ca) {
      return vec3(texture2D(tDiffuse, uv + ca).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - ca).b);
    }

    void main() {
      float aspect = uResolution.x / max(uResolution.y, 1.0);
      vec2 uv = vUv;
      float t = clamp(uTransition, 0.0, 1.0);

      // tape wow & flutter: slow sideways sway + fine per-line jitter
      float g = clamp(uGlitch, 0.0, 1.0);
      uv.x += g * (0.006 * sin(uv.y * 9.0 + uTime * 3.1) + 0.0025 * sin(uv.y * 210.0 + uTime * 40.0));

      // pressure-wave ripple: a travelling ring front plus concentric wavelets
      vec2 c = (uv - 0.5) * vec2(aspect, 1.0);
      float r = length(c);
      vec2 dir = c / max(r, 1e-4);
      float front = t * 1.25;
      float fq = (r - front) * 7.0;
      float ring = exp(-fq * fq);
      float wave = sin(r * 48.0 - uTime * 14.0) * (1.0 - smoothstep(front - 0.3, front + 0.2, r));
      vec2 disp = dir * (ring * 0.05 + wave * 0.006) * t;
      uv -= disp / vec2(aspect, 1.0);

      vec2 ca = dir / vec2(aspect, 1.0) * (uAberration * (0.3 + r * r * 1.5) + ring * 0.01 * t);
      vec3 col = chroma(uv, ca);

      // paper wash builds toward the cut; the ring itself glints
      col = mix(col, uFadeColor, smoothstep(0.55, 1.0, t) * 0.92);
      col += ring * t * 0.08;
      col = mix(col, uPaper, clamp(uFlash, 0.0, 1.0));

      // soft vignette (lighter on paper)
      vec2 q = vUv - 0.5;
      float v = 1.0 - smoothstep(0.2, 0.95, length(q * vec2(1.0, 0.85)));
      col *= mix(1.0, v, uVignette);

      // paper grain, strongest in the midtones
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      float n = hash(vUv * uResolution + fract(uTime * 7.13) * 91.0) - 0.5;
      col += n * uGrain * (0.4 + 0.6 * (1.0 - abs(lum - 0.5) * 2.0));

      col = mix(col, uFadeColor, clamp(uFade, 0.0, 1.0));
      gl_FragColor = vec4(col, 1.0);
    }
  `,
}

export type PostParams = {
  bloomStrength: number
  bloomRadius: number
  bloomThreshold: number
  aberration: number
  grain: number
  vignette: number
  glitch: number
  flash: number
  exposure: number
}

/**
 * Bright studio defaults: bloom only catches true HDR highlights (LEDs,
 * speculars > 1.0) — the bone-white backdrop must never bloom.
 */
export const POST_DEFAULTS: PostParams = {
  bloomStrength: 0.45,
  bloomRadius: 0.35,
  bloomThreshold: 1.05,
  aberration: 0.0012,
  grain: 0.035,
  vignette: 0.22,
  glitch: 0,
  flash: 0,
  exposure: 1,
}

/**
 * Scrubs NaN/Inf and clamps runaway HDR right after the scene render. A single
 * bad fragment would otherwise smear across the whole frame through the bloom
 * mip chain and black it out.
 */
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0);
      gl_FragColor = vec4(clamp(c.rgb, 0.0, 64.0), c.a);
    }
  `,
}

export class Post {
  composer: EffectComposer
  bloom: UnrealBloomPass
  final: ShaderPass
  /**
   * Chapters write targets here every frame (engine resets them to defaults
   * first); values are damped toward so nothing pops at a cut.
   */
  params: PostParams = { ...POST_DEFAULTS }
  private current: PostParams = { ...POST_DEFAULTS }
  transition = 0
  fade = 0

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    /** skip MSAA (retina / mobile: already supersampled, and MSAA half-float targets are huge) */
    noMsaa: boolean,
  ) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: noMsaa ? 0 : 4,
    })
    this.composer = new EffectComposer(renderer, rt)
    this.composer.addPass(new RenderPass(scene, camera))
    this.composer.addPass(new ShaderPass(SanitizeShader))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.45, 0.35, 1.05)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())
    this.final = new ShaderPass(FinalShader)
    this.composer.addPass(this.final)
  }

  private fadeLight = new THREE.Color('#eeebe4')
  private fadeDark = new THREE.Color('#111113')
  /** tone 0 = paper .. 1 = graphite */
  setFadeTone(tone: number) {
    ;(this.final.uniforms.uFadeColor.value as THREE.Color).copy(this.fadeLight).lerp(this.fadeDark, Math.min(1, Math.max(0, tone)))
  }

  resetParams() {
    Object.assign(this.params, POST_DEFAULTS)
  }

  setSize(w: number, h: number, dpr: number) {
    this.composer.setPixelRatio(dpr)
    this.composer.setSize(w, h)
    this.bloom.resolution.set((w * dpr) / 2, (h * dpr) / 2)
    this.final.uniforms.uResolution.value.set(w * dpr, h * dpr)
  }

  render(dt: number, time: number) {
    const k = 1 - Math.exp(-6 * dt)
    const c = this.current
    const p = this.params
    for (const key of Object.keys(p) as (keyof PostParams)[]) {
      // flash & glitch respond instantly so chapters can punch them
      c[key] = key === 'flash' || key === 'glitch' ? p[key] : c[key] + (p[key] - c[key]) * k
    }
    this.bloom.strength = c.bloomStrength
    this.bloom.radius = c.bloomRadius
    this.bloom.threshold = c.bloomThreshold
    this.renderer.toneMappingExposure = c.exposure
    const u = this.final.uniforms
    u.uTime.value = time
    u.uTransition.value = this.transition
    u.uGlitch.value = c.glitch
    u.uAberration.value = c.aberration
    u.uGrain.value = c.grain
    u.uVignette.value = c.vignette
    u.uFlash.value = c.flash
    u.uFade.value = this.fade
    this.composer.render(dt)
  }
}
