/**
 * Colour maths for the design tokens (WCAG 2.2 contrast, sRGB).
 * Alpha is composited in gamma-encoded sRGB, which is what browsers do for plain `rgb()` layers.
 */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

/** @typedef {{ r: number, g: number, b: number, a: number }} Rgba */

/**
 * Parses `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(r g b / a)` and `rgba(r, g, b, a)`.
 * @param {string} input
 * @returns {Rgba}
 */
export function parse(input) {
  const text = input.trim().toLowerCase()
  if (text.startsWith('#')) {
    let hex = text.slice(1)
    if (hex.length === 3 || hex.length === 4) {
      hex = [...hex].map((ch) => ch + ch).join('')
    }
    if (hex.length !== 6 && hex.length !== 8) throw new Error(`bad hex colour: ${input}`)
    const n = (i) => Number.parseInt(hex.slice(i, i + 2), 16)
    return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 }
  }
  const match = text.match(/^rgba?\(([^)]+)\)$/)
  if (!match) throw new Error(`unsupported colour: ${input}`)
  const parts = match[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number)
  if (parts.length < 3 || parts.some(Number.isNaN)) throw new Error(`bad rgb colour: ${input}`)
  return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 }
}

/** Composites `top` (any alpha) over an opaque `bottom`; the result is opaque. */
export function over(top, bottom) {
  const a = clamp(top.a, 0, 1)
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  }
}

/** Mixes two opaque colours in sRGB; `weight` is the share of `b`. */
export function mix(a, b, weight) {
  return {
    r: a.r * (1 - weight) + b.r * weight,
    g: a.g * (1 - weight) + b.g * weight,
    b: a.b * (1 - weight) + b.b * weight,
    a: 1,
  }
}

const channel = (value) => {
  const s = value / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** Relative luminance of an opaque colour. */
export function luminance(color) {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

/** WCAG contrast ratio between two opaque colours. */
export function ratio(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

export function toHex(color) {
  const part = (v) =>
    Math.round(clamp(v, 0, 255))
      .toString(16)
      .padStart(2, '0')
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`.toUpperCase()
}

const encode = (linear) => {
  const c = clamp(linear, 0, 1)
  return (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255
}

/**
 * OKLCH to sRGB. Returns `{ r, g, b, a, inGamut }`; out-of-gamut values are clamped.
 * @param {number} l lightness 0..1
 * @param {number} c chroma
 * @param {number} h hue in degrees
 */
export function fromOklch(l, c, h) {
  const a = c * Math.cos((h * Math.PI) / 180)
  const b = c * Math.sin((h * Math.PI) / 180)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ]
  const eps = 1e-4
  return {
    r: encode(lin[0]),
    g: encode(lin[1]),
    b: encode(lin[2]),
    a: 1,
    inGamut: lin.every((v) => v >= -eps && v <= 1 + eps),
  }
}

/** sRGB (opaque) to OKLCH `{ l, c, h }`. */
export function toOklch(color) {
  const lin = [color.r, color.g, color.b].map(channel)
  const l = Math.cbrt(0.4122214708 * lin[0] + 0.5363325363 * lin[1] + 0.0514459929 * lin[2])
  const m = Math.cbrt(0.2119034982 * lin[0] + 0.6806995451 * lin[1] + 0.1073969566 * lin[2])
  const s = Math.cbrt(0.0883024619 * lin[0] + 0.2817188376 * lin[1] + 0.6299787005 * lin[2])
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const h = (Math.atan2(B, A) * 180) / Math.PI
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h }
}
