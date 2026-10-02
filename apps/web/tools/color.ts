/**
 * Colour maths for the design tokens (WCAG 2.2 contrast, sRGB).
 * Alpha is composited in gamma-encoded sRGB, which is what browsers do for plain `rgb()` layers.
 */

export type Rgba = { r: number; g: number; b: number; a: number }

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/** Parses `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(r g b / a)` and `rgba(r, g, b, a)`. */
export function parse(input: string): Rgba {
  const text = input.trim().toLowerCase()
  if (text.startsWith('#')) {
    let hex = text.slice(1)
    if (hex.length === 3 || hex.length === 4) {
      hex = [...hex].map((ch) => ch + ch).join('')
    }
    if (hex.length !== 6 && hex.length !== 8) throw new Error(`bad hex colour: ${input}`)
    const n = (i: number): number => Number.parseInt(hex.slice(i, i + 2), 16)
    return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 }
  }
  const match = text.match(/^rgba?\(([^)]+)\)$/)
  const body = match?.[1]
  if (!body) throw new Error(`unsupported colour: ${input}`)
  const parts = body
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number)
  const [r, g, b, a] = parts
  if (r === undefined || g === undefined || b === undefined || parts.some(Number.isNaN)) {
    throw new Error(`bad rgb colour: ${input}`)
  }
  return { r, g, b, a: a ?? 1 }
}

/** Composites `top` (any alpha) over an opaque `bottom`; the result is opaque. */
export function over(top: Rgba, bottom: Rgba): Rgba {
  const a = clamp(top.a, 0, 1)
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  }
}

/** Mixes two opaque colours in sRGB; `weight` is the share of `b`. */
export function mix(a: Rgba, b: Rgba, weight: number): Rgba {
  return {
    r: a.r * (1 - weight) + b.r * weight,
    g: a.g * (1 - weight) + b.g * weight,
    b: a.b * (1 - weight) + b.b * weight,
    a: 1,
  }
}

const channel = (value: number): number => {
  const s = value / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** Relative luminance of an opaque colour. */
export function luminance(color: Rgba): number {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

/** WCAG contrast ratio between two opaque colours. */
export function ratio(a: Rgba, b: Rgba): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

export function toHex(color: Rgba): string {
  const part = (v: number): string =>
    Math.round(clamp(v, 0, 255))
      .toString(16)
      .padStart(2, '0')
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`.toUpperCase()
}
