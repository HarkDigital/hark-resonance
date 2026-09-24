import * as THREE from 'three'

/*
 * LED dot-matrix readouts for the desk's meter bridge.
 *
 * Each display is a grid of round LEDs drawn in one fragment shader, added
 * on top of a glossy black glass bezel (additive blending, so the real studio
 * reflections stay visible between the dots). Two modes:
 *   - spectrum: a dim little analyser, bars driven by the channel levels
 *   - text:     a 5x7 glyph mask (the stat), swept in column by column
 */

export const COLS = 44
export const ROWS = 9

// 5x7 glyphs, only what the stats need
const GLYPHS: Record<string, string[]> = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  $: ['..#..', '.####', '#.#..', '.###.', '..#.#', '####.', '..#..'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
}

/** Rasterize a short string into a COLS x ROWS mask (row 0 = top). */
function textMask(text: string): THREE.DataTexture {
  const data = new Uint8Array(COLS * ROWS)
  const chars = [...text.toUpperCase()]
  const width = chars.length * 6 - 1
  const x0 = Math.floor((COLS - width) / 2)
  const y0 = 1
  chars.forEach((ch, i) => {
    const g = GLYPHS[ch] ?? GLYPHS[' ']
    for (let r = 0; r < 7; r++)
      for (let c = 0; c < 5; c++) {
        if (g[r][c] !== '#') continue
        const x = x0 + i * 6 + c
        const y = y0 + r
        if (x < 0 || x >= COLS) continue
        // DataTexture rows run bottom-up
        data[(ROWS - 1 - y) * COLS + x] = 255
      }
  })
  const tex = new THREE.DataTexture(data, COLS, ROWS, THREE.RedFormat, THREE.UnsignedByteType)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return tex
}

export interface MatrixUniforms {
  [k: string]: THREE.IUniform
  uMask: THREE.IUniform<THREE.Texture>
  /** 0 = spectrum, 1 = text */
  uMode: THREE.IUniform<number>
  /** 0..1 column sweep for the text reveal */
  uReveal: THREE.IUniform<number>
  /** 0..1 all dots on (power-on test / master peak) */
  uFull: THREE.IUniform<number>
  /** overall LED brightness multiplier */
  uPower: THREE.IUniform<number>
  uTime: THREE.IUniform<number>
  /** four channel levels feeding the analyser */
  uLevels: THREE.IUniform<THREE.Vector4>
  uSeed: THREE.IUniform<number>
  /** 0..1 self-test scan bar position (0 = off) */
  uScan: THREE.IUniform<number>
}

export function matrixMaterial(text: string, seed: number): THREE.ShaderMaterial & { uniforms: MatrixUniforms } {
  const uniforms: MatrixUniforms = {
    uMask: { value: textMask(text) },
    uMode: { value: 0 },
    uReveal: { value: 0 },
    uFull: { value: 0 },
    uPower: { value: 1 },
    uTime: { value: 0 },
    uLevels: { value: new THREE.Vector4() },
    uSeed: { value: seed },
    uScan: { value: 0 },
  }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMask;
      uniform float uMode, uReveal, uFull, uPower, uTime, uSeed, uScan;
      uniform vec4 uLevels;
      varying vec2 vUv;
      const vec2 GRID = vec2(${COLS.toFixed(1)}, ${ROWS.toFixed(1)});

      float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }

      void main() {
        vec2 g = vUv * GRID;
        vec2 cell = floor(g);
        vec2 f = fract(g) - 0.5;
        float d = length(f);
        float aa = fwidth(d) * 1.2 + 1e-4;
        float dotMask = 1.0 - smoothstep(0.34 - aa, 0.34 + aa, d);
        float halo = exp(-d * d * 9.0) * 0.35;

        // ---- spectrum analyser: bar per column, fed by the channel levels
        float c = cell.x / (GRID.x - 1.0);
        float band = floor(c * 4.0);
        float lv = band < 0.5 ? uLevels.x : band < 1.5 ? uLevels.y : band < 2.5 ? uLevels.z : uLevels.w;
        float wob = 0.55 + 0.45 * sin(uTime * (2.3 + h11(cell.x + uSeed) * 3.0) + cell.x * 1.7 + uSeed * 4.0);
        float hgt = lv * (0.35 + 0.65 * wob) * (0.85 - 0.35 * abs(c - 0.45));
        float bar = step(cell.y + 0.5, hgt * GRID.y);

        // ---- text: glyph mask, swept in left to right with a bright leading edge
        float txt = texture2D(uMask, (cell + 0.5) / GRID).r;
        float col = cell.x / GRID.x;
        float edge = uReveal * 1.25 - 0.1;
        float shown = step(col, edge);
        // (col - edge) goes negative: square it by hand, never pow() a negative base
        float le = (col - edge) * 18.0;
        float lead = exp(-le * le) * step(0.001, uReveal) * step(uReveal, 0.999);
        float text = txt * shown + lead * (0.35 + 0.65 * txt);

        float lit = mix(bar * 0.42, text, uMode);
        lit = max(lit, uFull);
        // self-test scan bar with a fading tail
        float sc = uScan * 1.2 - 0.1;
        float tail = clamp(1.0 - (sc - col) * 5.0, 0.0, 1.0) * step(col, sc);
        lit = max(lit, tail * step(0.001, uScan) * step(uScan, 0.999));

        vec3 green = vec3(0.0, 1.0, 0.235);
        vec3 onCol = green * (2.5 * uPower);
        vec3 offCol = vec3(0.010, 0.016, 0.012);
        vec3 col3 = offCol * dotMask + onCol * lit * (dotMask + halo);
        gl_FragColor = vec4(col3, 1.0);
      }
    `,
  })
  return mat as THREE.ShaderMaterial & { uniforms: MatrixUniforms }
}
