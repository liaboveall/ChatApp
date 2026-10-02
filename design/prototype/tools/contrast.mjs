#!/usr/bin/env bun
/**
 * D2 contrast self-check for the design tokens (AT-21, WCAG 2.2).
 *
 *   bun design/prototype/tools/contrast.mjs          summary, failures only
 *   bun design/prototype/tools/contrast.mjs --all    every checked pair
 *   bun design/prototype/tools/contrast.mjs --md     markdown tables for docs/02
 *
 * Exit code 1 when any pair is below its threshold. Text needs 4.5:1, controls and focus 3:1.
 * Glass is checked against its worst backdrops, not against a flat colour: see `checkGlass`.
 */
import { mix, over, parse, ratio, toHex } from './color.mjs'
import {
  ACCENT_ON,
  accents,
  code,
  glass,
  neutral,
  SELECTED_TINT,
  status,
  wallpaper,
} from './tokens.mjs'

const TEXT = 4.5
const NON_TEXT = 3
/** The glass floor and accent text are derived with this margin so rounding cannot flip a result. */
const DERIVE_MARGIN = 4.6
const THEMES = ['light', 'dark']
const TINT = 0.16
/** Share of the content surface the sidebar search field puts between its placeholder and the glass. */
const SIDEBAR_PLATE = 0.72

const args = new Set(process.argv.slice(2))
const results = []

const color = (value) => parse(value)
const token = (table, key, i) => color(table[key][i])

/** Records one pair. `fg` may carry alpha and is flattened over `bg`. */
function check(group, name, theme, fg, bg, min) {
  const flat = over(fg, bg)
  const value = ratio(flat, bg)
  results.push({
    group,
    name,
    theme,
    value,
    min,
    pass: value >= min,
    fg: toHex(flat),
    bg: toHex(bg),
  })
  return value
}

function surfaces(i) {
  const content = token(neutral, 'bg-content', i)
  const elevated = token(neutral, 'bg-elevated', i)
  const fill = token(neutral, 'fill', i)
  return {
    content,
    elevated,
    app: token(neutral, 'bg-app', i),
    'bubble-in': token(neutral, 'bubble-in', i),
    'field on content': over(fill, content),
    'field on elevated': over(fill, elevated),
  }
}

for (const [i, theme] of THEMES.entries()) {
  const surf = surfaces(i)

  // Labels on every surface (spec 4.1 / D-092).
  for (const key of ['label', 'label-secondary', 'label-tertiary']) {
    for (const [name, bg] of Object.entries(surf)) {
      check('文字', `${key} / ${name}`, theme, token(neutral, key, i), bg, TEXT)
    }
  }

  // Tooltip and toast, segmented-control thumb, code highlighting.
  check(
    '组件',
    'toast-fg / toast-bg',
    theme,
    token(neutral, 'toast-fg', i),
    token(neutral, 'toast-bg', i),
    TEXT,
  )
  check(
    '组件',
    'label / seg-thumb',
    theme,
    token(neutral, 'label', i),
    token(neutral, 'seg-thumb', i),
    TEXT,
  )
  for (const key of Object.keys(code)) {
    if (key === 'bg') continue
    check(
      '代码高亮',
      `code-${key} / code-bg`,
      theme,
      token(code, key, i),
      token(code, 'bg', i),
      TEXT,
    )
  }

  // Control outlines, switch tracks.
  for (const [name, bg] of Object.entries(surf)) {
    check(
      '控件',
      `control-border / ${name}`,
      theme,
      token(neutral, 'control-border', i),
      bg,
      NON_TEXT,
    )
  }

  const on = color(ACCENT_ON[i])
  for (const [key, accent] of Object.entries(accents)) {
    const solid = color(accent.solid[i])
    const text = color(accent.text[i])
    // Bubble, filled button and badge text.
    check('气泡与实底', `${key}: on-accent / accent-solid`, theme, on, solid, TEXT)
    // Accent-coloured text, links and icons, plain and on a 16% tint of the accent.
    for (const [name, bg] of Object.entries(surf)) {
      check('强调色文字', `${key}: accent-text / ${name}`, theme, text, bg, TEXT)
      check(
        '强调色文字',
        `${key}: accent-text / ${name} + 16% tint`,
        theme,
        text,
        over({ ...solid, a: TINT }, bg),
        TEXT,
      )
      // Focus ring and active indicators.
      check('焦点环', `${key}: focus ring / ${name}`, theme, text, bg, NON_TEXT)
    }
    // Quote block inside an own bubble: an inset that moves the bubble colour away from the text colour.
    const insetColor = i === 0 ? { r: 0, g: 0, b: 0, a: 0.16 } : { r: 255, g: 255, b: 255, a: 0.16 }
    const inset = over(insetColor, solid)
    check('气泡与实底', `${key}: on-accent / quote inset`, theme, on, inset, TEXT)
  }

  // Status colours as text and as filled buttons.
  for (const [key, entry] of Object.entries(status)) {
    for (const [name, bg] of Object.entries(surf)) {
      check('状态色', `${key}: text / ${name}`, theme, color(entry.text[i]), bg, TEXT)
    }
    if (key !== 'info') {
      check('状态色', `${key}: filled button text / solid`, theme, on, color(entry.solid[i]), TEXT)
    }
  }
}

/** Lowest glass alpha at which all three label tokens reach `min` over both black and white. */
function glassFloor(i, baseColor) {
  const backdrops = [color('#000000'), color('#FFFFFF')]
  for (let alpha = 0.3; alpha <= 1.0001; alpha += 0.01) {
    const ok = backdrops.every((backdrop) => {
      const comp = over({ ...baseColor, a: alpha }, backdrop)
      return ['label', 'label-secondary', 'label-tertiary'].every(
        (key) => ratio(over(token(neutral, key, i), comp), comp) >= DERIVE_MARGIN,
      )
    })
    if (ok) return Math.round(alpha * 100) / 100
  }
  return 1
}

const derivedFloors = []
for (const [i, theme] of THEMES.entries()) {
  const plain = glassFloor(i, color(glass.base[i]))
  derivedFloors.push({ theme, plain })
  // The token must be at least the derived value.
  results.push({
    group: '玻璃下限',
    name: `floor token ≥ derived (${theme})`,
    theme,
    value: glass.floor[i],
    min: plain,
    pass: glass.floor[i] >= plain,
    fg: '',
    bg: '',
  })
}

/**
 * Glass that carries text over arbitrary content (toolbar, composer, menus, sheets): the floor alpha
 * over black and white backdrops. It never takes the accent tint, which is only for the sidebar.
 */
function checkFloorGlass(i, theme) {
  const base = color(glass.base[i])
  for (const [backdropName, backdrop] of [
    ['black', color('#000000')],
    ['white', color('#FFFFFF')],
  ]) {
    const comp = over({ ...base, a: glass.floor[i] }, backdrop)
    for (const key of ['label', 'label-secondary', 'label-tertiary']) {
      check(
        '文字承载玻璃',
        `${key} / floor glass over ${backdropName}`,
        theme,
        token(neutral, key, i),
        comp,
        TEXT,
      )
    }
    check(
      '文字承载玻璃',
      `accent-text(blue) / floor glass over ${backdropName}`,
      theme,
      color(accents.blue.text[i]),
      comp,
      TEXT,
    )
  }
}

/** The sidebar floats over the wallpaper only, so its glass is checked against the wallpaper extremes. */
function checkSidebar(i, theme) {
  const walls = wallpaper[theme]
  for (const [levelKey, level] of Object.entries(glass.levels)) {
    for (const [accentKey, accent] of Object.entries(accents)) {
      const base = level.tint
        ? mix(color(glass.base[i]), color(accent.solid[i]), level.tint)
        : color(glass.base[i])
      const blob = over({ ...color(accent.deco[i]), a: wallpaper.maxTint[i] }, color(walls[0]))
      const backdrops = [...walls.map(color), blob]
      for (const backdrop of backdrops) {
        const comp = over({ ...base, a: level.alpha }, backdrop)
        for (const key of ['label', 'label-secondary']) {
          check(
            '侧栏玻璃',
            `${key} / ${levelKey} ${accentKey} @${toHex(backdrop)}`,
            theme,
            token(neutral, key, i),
            comp,
            TEXT,
          )
        }
        // The placeholder lives in the search field, which sits on a plate of the content colour.
        check(
          '侧栏玻璃',
          `placeholder / search field ${levelKey} ${accentKey} @${toHex(backdrop)}`,
          theme,
          token(neutral, 'label-tertiary', i),
          over({ ...token(neutral, 'bg-content', i), a: SIDEBAR_PLATE }, comp),
          TEXT,
        )
        // A hovered row: 70% of the gray control fill on top of the glass (the .s-item:hover rule).
        const hoverFill = { ...token(neutral, 'fill', i), a: token(neutral, 'fill', i).a * 0.7 }
        for (const key of ['label', 'label-secondary']) {
          check(
            '侧栏玻璃',
            `${key} / hovered row ${levelKey} ${accentKey} @${toHex(backdrop)}`,
            theme,
            token(neutral, key, i),
            over(hoverFill, comp),
            TEXT,
          )
        }
        // The open conversation's row: the selected tint on top of the glass, with its secondary text (preview, time).
        for (const key of ['label', 'label-secondary']) {
          check(
            '侧栏玻璃',
            `${key} / selected row ${levelKey} ${accentKey} @${toHex(backdrop)}`,
            theme,
            token(neutral, key, i),
            over({ ...color(accent.solid[i]), a: SELECTED_TINT }, comp),
            TEXT,
          )
        }
        check(
          '侧栏玻璃',
          `accent-text / ${levelKey} ${accentKey} @${toHex(backdrop)}`,
          theme,
          color(accent.text[i]),
          comp,
          TEXT,
        )
      }
    }
  }
}

for (const [i, theme] of THEMES.entries()) {
  checkFloorGlass(i, theme)
  checkSidebar(i, theme)
}

// ---- report ----
const failures = results.filter((r) => !r.pass)
const byGroup = new Map()
for (const r of results) {
  const g = byGroup.get(r.group) ?? { total: 0, failed: 0, min: Number.POSITIVE_INFINITY, name: '' }
  g.total += 1
  if (!r.pass) g.failed += 1
  const margin = r.value - r.min
  if (margin < g.min) {
    g.min = margin
    g.name = `${r.name} (${r.theme}) ${r.value.toFixed(2)} vs ${r.min}`
  }
  byGroup.set(r.group, g)
}

if (args.has('--md')) {
  console.log('| 检查组 | 组合数 | 未通过 | 余量最小的一项 |\n|---|---|---|---|')
  for (const [group, g] of byGroup) {
    console.log(`| ${group} | ${g.total} | ${g.failed} | ${g.name} |`)
  }
  console.log('\n| 强调色 | 主题 | 气泡文字/实底 | 强调色文字(最差表面) |\n|---|---|---|---|')
  for (const [key, accent] of Object.entries(accents)) {
    for (const [i, theme] of THEMES.entries()) {
      const bubble = ratio(color(ACCENT_ON[i]), color(accent.solid[i]))
      const worst = Math.min(
        ...Object.values(surfaces(i)).flatMap((bg) => [
          ratio(color(accent.text[i]), bg),
          ratio(color(accent.text[i]), over({ ...color(accent.solid[i]), a: TINT }, bg)),
        ]),
      )
      console.log(
        `| ${accent.name}(${key}) | ${theme === 'light' ? '浅' : '深'} | ${bubble.toFixed(2)} | ${worst.toFixed(2)} |`,
      )
    }
  }
} else {
  console.log(`contrast: ${results.length} pairs checked, ${failures.length} below threshold\n`)
  for (const [group, g] of byGroup) {
    const status = g.failed === 0 ? 'ok  ' : 'FAIL'
    console.log(
      `${status} ${group.padEnd(10)} ${String(g.total).padStart(4)} pairs  tightest: ${g.name}`,
    )
  }
  console.log('\nglass floors (derived at 4.6:1 over black and white):')
  for (const f of derivedFloors) {
    console.log(`  ${f.theme}: derived ${f.plain}, token ${glass.floor[THEMES.indexOf(f.theme)]}`)
  }
}

if (args.has('--all')) {
  for (const r of results) {
    console.log(
      `${r.pass ? 'ok  ' : 'FAIL'} ${r.group} | ${r.name} | ${r.theme} | ${r.value.toFixed(2)} (min ${r.min}) ${r.fg} on ${r.bg}`,
    )
  }
} else if (failures.length > 0 && !args.has('--md')) {
  console.log('\nbelow threshold:')
  for (const r of failures.slice(0, 60)) {
    console.log(
      `  ${r.group} | ${r.name} | ${r.theme} | ${r.value.toFixed(2)} < ${r.min}  ${r.fg} on ${r.bg}`,
    )
  }
  if (failures.length > 60) console.log(`  … and ${failures.length - 60} more`)
}

process.exit(failures.length > 0 ? 1 : 0)
