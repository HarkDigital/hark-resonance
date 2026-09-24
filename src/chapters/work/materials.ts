import * as THREE from 'three'
import { CRATE, LABEL_R } from './geometry'

/*
 * Materials for THE CRATE. Everything stays MeshStandard (so the studio PMREM
 * gives product-shot reflections) and is extended with onBeforeCompile:
 *
 *  - sleeves: laminated 12" board. Front | back halves of one canvas, the
 *    screenshot "printed" into the image window (multiplied into the paper),
 *    paper grain + fibres, ring wear, scuffed edges, crate occlusion and the
 *    soft shadow of the record lifted above.
 *  - vinyl: lathed record with concentric-groove anisotropic highlights
 *    (Kajiya–Kay against two studio lights — the highlight stays put while the
 *    label turns), track gaps, glossy dead wax, a printed paper label, and a
 *    rotational smear of the label at speed.
 *  - crate: black anodized aluminium; the diamond-cut chamfers are bright
 *    polished metal (per-vertex flag), interior occlusion toward the floor.
 */

const NOISE_GLSL = /* glsl */ `
float wkH(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float wkN(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wkH(i), wkH(i + vec2(1.0, 0.0)), f.x), mix(wkH(i + vec2(0.0, 1.0)), wkH(i + vec2(1.0, 1.0)), f.x), f.y);
}
`

export interface SleeveUniforms {
  uShot: { value: THREE.Texture }
  uShotMix: { value: number }
  uImg: { value: THREE.Vector4 }
  uInk: { value: number }
  uPaper: { value: THREE.Color }
  uEdge: { value: THREE.Color }
  uSeed: { value: number }
  uHole: { value: number }
  uLift: { value: THREE.Vector4 }
  uLiftY: { value: number }
  uCrate: { value: THREE.Vector4 }
  uRim: { value: THREE.Vector2 }
  uBackCell: { value: number }
}

let blank: THREE.DataTexture | null = null
export function blankTexture() {
  if (!blank) {
    blank = new THREE.DataTexture(new Uint8Array([200, 196, 188, 255]), 1, 1)
    blank.needsUpdate = true
  }
  return blank
}

/** Shared (per-frame) uniforms every sleeve reads. */
export const sharedSleeve = {
  uLift: { value: new THREE.Vector4(0, 0, 1, 0) },
  uLiftY: { value: 10 },
  uCrate: { value: new THREE.Vector4(CRATE.inner, CRATE.zBack + CRATE.wall, CRATE.zFront - CRATE.wall, CRATE.y0) },
  uRim: { value: new THREE.Vector2(CRATE.backH, CRATE.frontH) },
}

/**
 * kind: 'featured' (front|back canvas + printed screenshot), 'atlas'
 * (instanced; 4x4 cells, per-instance aCell/aInk), 'plain' (front|back canvas).
 */
export function sleeveMaterial(
  kind: 'featured' | 'atlas' | 'plain',
  map: THREE.Texture,
  opts: { ink?: boolean; paper?: string; seed?: number; hole?: number; img?: THREE.Vector4 } = {},
) {
  const paper = new THREE.Color(opts.paper ?? '#ede9e0')
  const u: SleeveUniforms = {
    uShot: { value: blankTexture() },
    uShotMix: { value: 0 },
    uImg: { value: opts.img ?? new THREE.Vector4(0, 0, 1, 1) },
    uInk: { value: opts.ink ? 1 : 0 },
    uPaper: { value: paper },
    uEdge: { value: opts.ink ? new THREE.Color('#2a2a2d') : paper.clone().multiplyScalar(0.8) },
    uSeed: { value: opts.seed ?? 0 },
    uHole: { value: opts.hole ?? 0 },
    uLift: sharedSleeve.uLift,
    uLiftY: sharedSleeve.uLiftY,
    uCrate: sharedSleeve.uCrate,
    uRim: sharedSleeve.uRim,
    uBackCell: { value: 9 },
  }
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, map, roughness: 0.5, metalness: 0 })
  m.defines = { WK_SLEEVE: '' }
  if (kind === 'featured') m.defines.WK_SHOT = ''
  if (kind === 'atlas') m.defines.WK_ATLAS = ''
  m.customProgramCacheKey = () => `wk-sleeve-${kind}`
  m.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, u)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vSLocal;
        varying vec3 vSNormal;
        varying vec3 vSWorld;
        #ifdef WK_ATLAS
          attribute float aCell;
          attribute float aInk;
          varying float vCell;
          varying float vInk;
        #endif`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        vSLocal = position;
        vSNormal = normal;
        #ifdef USE_INSTANCING
          vSWorld = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
        #else
          vSWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        #endif
        #ifdef WK_ATLAS
          vCell = aCell;
          vInk = aInk;
        #endif`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        ${NOISE_GLSL}
        varying vec3 vSLocal;
        varying vec3 vSNormal;
        varying vec3 vSWorld;
        uniform sampler2D uShot;
        uniform float uShotMix, uInk, uSeed, uHole, uLiftY, uBackCell;
        uniform vec4 uImg, uLift, uCrate;
        uniform vec2 uRim;
        uniform vec3 uPaper, uEdge;
        #ifdef WK_ATLAS
          varying float vCell;
          varying float vInk;
        #endif
        float wkFace = 0.0;`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        vec2 fuv = vec2(vSLocal.x + 0.5, vSLocal.y);
        wkFace = vSNormal.z;
        float ink = uInk;
        float seed = uSeed;
        vec3 edgeCol = uEdge;
        #ifdef WK_ATLAS
          ink = vInk;
          seed = vCell * 7.13;
          edgeCol = mix(vec3(0.62, 0.6, 0.56), vec3(0.03), vInk);
        #endif
        if (uHole > 0.0 && abs(wkFace) > 0.5 && length(fuv - 0.5) < uHole) discard;
        vec3 col;
        if (wkFace > 0.5) {
          #ifdef WK_ATLAS
            vec2 cell = vec2(mod(vCell, 4.0), floor(vCell / 4.0 + 0.001));
            col = texture2D(map, (vec2(cell.x, 3.0 - cell.y) + fuv) / 4.0).rgb;
          #else
            col = texture2D(map, vec2(fuv.x * 0.5, fuv.y)).rgb;
          #endif
          #ifdef WK_SHOT
            vec2 iuv = (fuv - uImg.xy) / uImg.zw;
            if (uShotMix > 0.001 && iuv.x >= 0.0 && iuv.y >= 0.0 && iuv.x <= 1.0 && iuv.y <= 1.0) {
              vec3 img = texture2D(uShot, iuv).rgb;
              float l = dot(img, vec3(0.2126, 0.7152, 0.0722));
              img = mix(vec3(l), img, 0.9) * 0.94 + 0.012;
              // ink on paper: whites take the stock's tone; on black board it's a tipped-on print
              vec3 printed = mix(img * (uPaper * 1.04), img, ink);
              col = mix(col, printed, uShotMix);
            }
          #endif
        } else if (wkFace < -0.5) {
          #ifdef WK_ATLAS
            vec2 cellB = vec2(mod(uBackCell, 4.0), floor(uBackCell / 4.0 + 0.001));
            col = texture2D(map, (vec2(cellB.x, 3.0 - cellB.y) + vec2(1.0 - fuv.x, fuv.y)) / 4.0).rgb;
          #else
            col = texture2D(map, vec2(0.5 + (1.0 - fuv.x) * 0.5, fuv.y)).rgb;
          #endif
        } else {
          col = edgeCol * (0.92 + 0.08 * wkN(vSLocal.xy * vec2(600.0, 600.0)));
        }
        if (abs(wkFace) > 0.5) {
          // board grain + fibres, faded out before they alias
          float fw = fwidth(fuv.x * 520.0) + fwidth(fuv.y * 520.0);
          float grain = (wkN(fuv * 520.0 + seed) - 0.5) * (1.0 - smoothstep(0.5, 1.4, fw));
          float fib = wkN(fuv * vec2(46.0, 380.0) + seed * 3.1) - 0.5;
          col *= 1.0 + grain * 0.075 + fib * 0.035 * (1.0 - smoothstep(0.8, 2.0, fw));
          // ring wear from the record inside
          vec2 q = fuv - 0.5;
          float rr = length(q);
          float ang = atan(q.y, q.x);
          float band = smoothstep(0.418, 0.438, rr) * (1.0 - smoothstep(0.462, 0.48, rr));
          float wear = band * smoothstep(0.3, 0.85, wkN(vec2(ang * 4.0, rr * 24.0) + seed));
          col = mix(col, mix(col * 0.9, col * 1.12 + 0.05, ink), wear * 0.6);
          // scuffed edges
          float ed = min(min(fuv.x, 1.0 - fuv.x), min(fuv.y, 1.0 - fuv.y));
          float scuff = (1.0 - smoothstep(0.0, 0.007, ed)) * (0.35 + 0.65 * wkN(fuv * 90.0 + seed));
          col = mix(col, mix(col * 0.86, vec3(0.34), ink), scuff * 0.7);
        }
        // occlusion inside the crate (rim height follows the sloped sides)
        float inX = 1.0 - smoothstep(uCrate.x - 0.03, uCrate.x + 0.03, abs(vSWorld.x));
        float inZ = step(uCrate.y - 0.01, vSWorld.z) * (1.0 - smoothstep(uCrate.z - 0.02, uCrate.z + 0.02, vSWorld.z));
        float rim = mix(uRim.x, uRim.y, clamp((vSWorld.z - uCrate.y) / (uCrate.z - uCrate.y), 0.0, 1.0));
        float occ = mix(1.0, mix(0.34, 1.0, smoothstep(uCrate.w, rim + 0.22, vSWorld.y)), inX * inZ);
        // the record held above throws a soft shadow down into the crate
        float dl = length((vSWorld.xz - uLift.xy) * vec2(1.0, 1.25));
        occ *= 1.0 - uLift.w * 0.7 * (1.0 - smoothstep(uLift.z * 0.3, uLift.z, dl)) * (1.0 - smoothstep(uLiftY - 0.25, uLiftY, vSWorld.y));
        diffuseColor.rgb = col * occ;
        `,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
        roughnessFactor = wkFace > 0.5 ? 0.44 : (wkFace < -0.5 ? 0.58 : 0.9);`,
      )
  }
  return { material: m, uniforms: u }
}

export interface RecordUniforms {
  uLabel: { value: THREE.Texture }
  uBlur: { value: number }
  uL1: { value: THREE.Vector3 }
  uL2: { value: THREE.Vector3 }
  uSpec: { value: number }
  uSeed: { value: number }
}

/** Two studio lights (world) the groove highlights answer to. */
export const RECORD_LIGHTS = {
  key: new THREE.Vector3(-0.55, 0.62, 0.56).normalize(),
  rim: new THREE.Vector3(0.75, 0.25, 0.3).normalize(),
}

export function recordMaterial(label: THREE.Texture, seed = 0) {
  const u: RecordUniforms = {
    uLabel: { value: label },
    uBlur: { value: 0 },
    uL1: { value: new THREE.Vector3(0, 0, 1) },
    uL2: { value: new THREE.Vector3(0, 0, 1) },
    uSpec: { value: 1 },
    uSeed: { value: seed },
  }
  const m = new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.34, metalness: 0 })
  m.customProgramCacheKey = () => 'wk-record'
  m.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, u)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec2 vRec;
        varying vec3 vRadV;
        varying float vFaceZ;`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        vRec = position.xy;
        vRadV = (modelViewMatrix * vec4(position.xy, 0.0, 0.0)).xyz;
        vFaceZ = normal.z;`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        ${NOISE_GLSL}
        varying vec2 vRec;
        varying vec3 vRadV;
        varying float vFaceZ;
        uniform sampler2D uLabel;
        uniform float uBlur, uSpec, uSeed;
        uniform vec3 uL1, uL2;
        float wkAniso = 0.0;
        float wkRough = 0.34;
        float wkGap = 0.0;
        float wkBand = 1.0;`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        float r = length(vRec);
        float face = step(0.55, abs(vFaceZ));
        vec3 base = vec3(0.0085);
        if (face > 0.5 && r < ${LABEL_R.toFixed(4)}) {
          vec2 luv = vRec / ${(2 * LABEL_R).toFixed(4)};
          if (vFaceZ < 0.0) luv.x = -luv.x;
          vec3 lab = vec3(0.0);
          if (uBlur > 0.02) {
            for (int k = 0; k < 7; k++) {
              float a = (float(k) / 6.0 - 0.5) * uBlur;
              float c = cos(a), s = sin(a);
              lab += texture2D(uLabel, mat2(c, s, -s, c) * luv + 0.5).rgb;
            }
            lab /= 7.0;
          } else lab = texture2D(uLabel, luv + 0.5).rgb;
          // paper label: faint fibre, a hair of emboss at the rim
          lab *= 0.96 + 0.06 * wkN(vRec * 900.0);
          lab *= 1.0 - 0.25 * smoothstep(${(LABEL_R - 0.006).toFixed(4)}, ${LABEL_R.toFixed(4)}, r);
          base = lab;
          wkRough = 0.7;
          wkAniso = 0.0;
        } else if (face > 0.5 && r < ${(LABEL_R + 0.032).toFixed(4)}) {
          // dead wax: mirror-smooth, a faint etched run-out
          wkRough = 0.1;
          wkAniso = 0.3;
        } else if (face > 0.5 && r < 0.452) {
          // the programme: loud/quiet bands, four track gaps
          float x = (r - 0.19) / 0.262;
          wkBand = 0.6 + 0.4 * wkN(vec2(x * 46.0 + uSeed * 11.0, uSeed));
          wkBand *= 0.8 + 0.2 * wkN(vec2(x * 190.0, uSeed + 3.0));
          for (int k = 1; k <= 4; k++) {
            float g = float(k) / 5.0 + (wkH(vec2(float(k), uSeed)) - 0.5) * 0.09;
            wkGap = max(wkGap, 1.0 - smoothstep(0.0, 0.0042, abs(x - g)));
          }
          wkRough = mix(0.3, 0.09, wkGap);
          wkAniso = mix(1.0, 0.25, wkGap);
        } else {
          wkRough = 0.2;
          wkAniso = face > 0.5 ? 0.55 : 0.2;
        }
        diffuseColor.rgb = base;
        `,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
        roughnessFactor = wkRough;`,
      )
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `
        if (wkAniso > 0.0) {
          vec3 Nv = normalize(normal);
          vec3 Rv = vRadV - Nv * dot(vRadV, Nv);
          Rv = Rv / max(length(Rv), 1e-5);
          vec3 Tv = cross(Nv, Rv);
          vec3 V = normalize(vViewPosition);
          vec3 H1 = normalize(uL1 + V);
          vec3 H2 = normalize(uL2 + V);
          float t1 = dot(Tv, H1);
          float t2 = dot(Tv, H2);
          float s1 = max(1.0 - t1 * t1, 0.0);
          float s2 = max(1.0 - t2 * t2, 0.0);
          float k1 = pow(s1, 36.0) * 0.16 + pow(s1, 320.0) * 1.35;
          float k2 = pow(s2, 30.0) * 0.1 + pow(s2, 260.0) * 0.7;
          float lit1 = smoothstep(-0.1, 0.4, dot(Nv, uL1));
          float lit2 = smoothstep(-0.1, 0.4, dot(Nv, uL2));
          // fine grooves shimmer until they get too fine to resolve
          float fg = r * 2400.0;
          float aa = 1.0 - smoothstep(0.6, 1.6, fwidth(fg));
          float fine = 1.0 + 0.28 * sin(fg) * aa;
          outgoingLight += vec3(1.0, 0.985, 0.96) * (k1 * lit1 + k2 * lit2) * wkAniso * wkBand * fine * uSpec;
        }
        #include <opaque_fragment>`,
      )
  }
  return { material: m, uniforms: u }
}

export function crateMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.46, metalness: 0.55 })
  m.customProgramCacheKey = () => 'wk-crate'
  const u = { uCrate: sharedSleeve.uCrate }
  m.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, u)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        attribute float aChamfer;
        varying float vCh;
        varying vec3 vCPos;`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        vCh = aChamfer;
        vCPos = position;`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        ${NOISE_GLSL}
        varying float vCh;
        varying vec3 vCPos;
        uniform vec4 uCrate;`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        // interior faces darken toward the floor and the corners
        float inside = step(abs(vCPos.x), uCrate.x + 0.002) * step(uCrate.y - 0.002, vCPos.z) * step(vCPos.z, uCrate.z + 0.002);
        float ao = mix(1.0, mix(0.45, 1.0, smoothstep(uCrate.w, uCrate.w + 0.4, vCPos.y)), inside);
        diffuseColor.rgb *= ao * (0.94 + 0.06 * wkN(vCPos.xz * 140.0 + vCPos.y * 90.0));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.8, 0.8, 0.82), vCh);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.14, vCh);`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        /* glsl */ `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 1.0, vCh);`,
      )
  }
  return m
}

/**
 * Contact shadow for a rounded rectangle footprint: tight contact line, soft
 * ambient falloff, and a cast lobe pushed away from the key light.
 */
export function shadowMaterial(half: THREE.Vector2, radius: number) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    uniforms: {
      uHalf: { value: half },
      uR: { value: radius },
      uOff: { value: new THREE.Vector2(0.16, -0.12) },
      uStrength: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() {
        vP = (modelMatrix * vec4(position, 1.0)).xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec2 uHalf, uOff;
      uniform float uR, uStrength;
      varying vec2 vP;
      float sdRB(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
      void main() {
        float d = sdRB(vP, uHalf, uR);
        float contact = 1.0 - smoothstep(-0.02, 0.03, d);
        float ao = 1.0 - smoothstep(-0.08, 0.34, d);
        float castS = 1.0 - smoothstep(-0.2, 0.62, sdRB(vP - uOff, uHalf * 1.04, uR + 0.12));
        float a = contact * 0.62 + ao * ao * 0.36 + castS * 0.24;
        gl_FragColor = vec4(vec3(0.1, 0.085, 0.07), clamp(a, 0.0, 0.9) * uStrength);
      }
    `,
  })
}
