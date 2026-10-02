// Design notes: the D1 principles, the D2 tokens, live contrast tables, the font comparison, app icon
// drafts, a component sheet and a glass check board. Numbers on these pages are computed here from the
// same token data the CSS is generated from (tools/tokens.mjs), not typed in by hand.

import { over, parse, ratio } from '../../tools/color.mjs'
import {
  ACCENT_ON,
  accents,
  code,
  fontStacks,
  glass,
  neutral,
  radius,
  space,
  springEasing,
  springs,
  status,
  type,
  wallpaper,
} from '../../tools/tokens.mjs'
import { appIcon, ICON_VARIANTS } from './brand.js'
import { bus, setPref, state, ui } from './core.js'
import { $, $$, h, icon } from './dom.js'
import { openDialog, openMenu, toast } from './overlays.js'
import {
  avatar,
  badge,
  banner,
  botBadge,
  button,
  emptyState,
  iconButton,
  seg,
  switchEl,
} from './widgets.js'

export const NOTE_PAGES = [
  { id: 'principles', label: '设计原则', icon: 'lightbulb', hint: 'D1' },
  { id: 'tokens', label: '设计令牌', icon: 'palette', hint: 'D2' },
  { id: 'contrast', label: '对比度', icon: 'contrast', hint: 'AT-21' },
  { id: 'glass', label: '玻璃对照板', icon: 'layers', hint: 'AT-21' },
  { id: 'fonts', label: '字体对比', icon: 'type', hint: 'D1' },
  { id: 'icon', label: '应用图标', icon: 'app-window', hint: '选 A' },
  { id: 'components', label: '组件', icon: 'sliders-horizontal', hint: 'D5' },
]

const THEMES = [
  ['light', '浅色', 0],
  ['dark', '深色', 1],
]
const fmt = (n) => n.toFixed(2)

function sw(color, label, surface) {
  return h(
    'span.n-sw',
    h('i', { style: { '--c': color, '--bg': surface ?? 'transparent' } }),
    h('code', label ?? color),
  )
}

function table(headers, rows) {
  return h(
    'div.n-table-wrap',
    h(
      'table.n-table',
      h(
        'thead',
        h(
          'tr',
          headers.map((x) => h('th', x)),
        ),
      ),
      h(
        'tbody',
        rows.map((r) =>
          h(
            'tr',
            r.map((c) => h('td', c)),
          ),
        ),
      ),
    ),
  )
}

function verdict(value, min) {
  const pass = value >= min
  return h(
    `span.${pass ? 'n-pass' : 'n-fail'}`,
    icon(pass ? 'check' : 'x', 14),
    `${fmt(value)} : 1`,
    h('span.sr-only', pass ? '，达标' : '，不达标'),
  )
}

const flat = (fg, bg) => ratio(over(parse(fg), parse(bg)), parse(bg))

function section(title, ...children) {
  return h('section.n-section', h('h2', title), ...children)
}

function pageHead(title, lead) {
  return h(
    'header',
    { style: { display: 'grid', gap: '10px' } },
    h('h1.t-large-title', title),
    h('p.n-lead', lead),
  )
}

// ---- Pages ----

function principles() {
  const legend = [
    ['glass', '导航层', '玻璃：侧栏、工具栏、输入栏、弹层、命令面板'],
    ['content', '内容层', '实底：消息、气泡、长文本、Inspector'],
    ['wall', '壁纸层', '渐变和色块，让玻璃有东西可透'],
  ]
  const layers = h(
    'div.n-layers-wrap',
    h(
      'ul.n-legend',
      legend.map(([key, title, text]) =>
        h(
          'li',
          h('i', { class: `n-legend__dot n-legend__dot--${key}` }),
          h('div', h('b', title), h('span', text)),
        ),
      ),
    ),
    h(
      'div.n-layers',
      { role: 'img', 'aria-label': '三层结构：壁纸层在最下，内容层在中间，导航层在最上' },
      h('div.n-layer.n-layer--wall'),
      h('div.n-layer.n-layer--content'),
      h('div.n-layer.n-layer--glass.glass-text'),
    ),
  )
  const counter = h('span.n-counter')
  const update = () => {
    const count = countBackdrops()
    counter.replaceChildren(
      icon('layers', 16),
      `当前视图的 backdrop-filter 层：${count} / ${glass.maxBackdropFilters}`,
      count <= glass.maxBackdropFilters
        ? h('span.n-pass', icon('check', 14), '未超限')
        : h('span.n-fail', '超限'),
    )
  }
  setTimeout(update, 50)
  return [
    pageHead(
      '设计原则与方向',
      '外观借鉴 Apple 的 Liquid Glass 设计语言（2026 年修正版）；布局和质感参考「信息」「邮件」「备忘录」。我们借鉴语言，不使用 Apple 的字体文件、SF Symbols、商标和界面素材。',
    ),
    section(
      '四条原则',
      h(
        'div.n-grid',
        [
          ['内容优先', '界面退后，让消息成为主角。消息列表、气泡和长文本全部使用实底。'],
          [
            '清晰',
            '层级明确，文字始终可读。正文 4.5:1，控件边界和焦点环 3:1，颜色不作为状态的唯一标记。',
          ],
          ['层次', '导航层浮在内容层之上：侧栏、工具栏、输入栏、弹层是玻璃，内容不是。'],
          [
            '可读性高于通透',
            '2026 年的修正：玻璃更善于化开背后的内容，边缘加深、高光更亮，工具栏回到统一的磨砂。',
          ],
        ].map(([t, d]) => h('div.n-card', h('h3', t), h('p', d))),
      ),
    ),
    section(
      '三层结构',
      layers,
      table(
        ['层', '内容', '材质'],
        [
          [
            '导航层',
            '侧栏、顶部工具栏、底部输入栏、弹出菜单、弹层（sheet）、命令面板、分段控件',
            '玻璃（模糊 + 半透明 + 边缘高光）',
          ],
          ['内容层', '消息列表、气泡、附件、Inspector、卡片', '实底，不用玻璃'],
          ['壁纸层', '应用背景：淡渐变加几块强调色色块', '让侧栏的玻璃有东西可透'],
        ],
      ),
    ),
    section(
      '玻璃的使用规则',
      h(
        'p.n-lead',
        '同一屏最多 4 处 backdrop-filter。分段控件和审批卡片放在实底上，没有东西可模糊，所以用同样的半透明填充但不开模糊。',
      ),
      counter,
      table(
        ['材质', '用于', '不透明度', '为什么'],
        [
          [
            '.glass',
            '侧栏',
            '跟随透明度档位',
            '它只浮在壁纸上，背后的颜色是已知的，所以对比度能完整检查',
          ],
          [
            '.glass-text',
            '工具栏、输入栏、菜单、弹层、命令面板',
            `不低于 ${Math.round(glass.floor[0] * 100)}%（浅）/ ${Math.round(glass.floor[1] * 100)}%（深）`,
            '这些层承载文字，背后可能是任意内容（包括纯黑或纯白的图片）。按黑白两个极端反推出的最低值',
          ],
          [
            '.glass-lite',
            '审批卡片、悬浮的按钮底',
            '同上，不开模糊',
            '放在实底上，模糊没有意义，也省一个 backdrop-filter',
          ],
        ],
      ),
      banner('info', 'info', [
        h('b', 'D4 已确认（2026-10-02，D-109）：'),
        '规格里「清透 45%」放在工具栏和输入栏上，背后是纯黑图片时浅色玻璃上的次要文字只有 1.50:1，保证不了对比度。所以文字承载层不低于上面这个值，四档透明度只影响侧栏。想要更通透，要先放宽这个下限，代价是个别背景下的文字不达标。',
      ]),
    ),
  ]
}

function countBackdrops() {
  const root = ui.windowEl
  let n = 0
  for (const el of root.querySelectorAll('*')) {
    const cs = getComputedStyle(el)
    const f = cs.backdropFilter || cs.webkitBackdropFilter
    if (f && f !== 'none') n += 1
  }
  return n
}

function tokens() {
  const neutralRows = Object.entries(neutral).map(([name, [l, d]]) => [
    h('code', `--${name}`),
    sw(l),
    sw(d),
  ])
  const accentRows = Object.entries(accents).flatMap(([key, a]) =>
    THEMES.map(([theme, label, i]) => [
      theme === 'light' ? `${a.name}（${key}）` : '',
      label,
      sw(a.deco[i]),
      h(
        'span.n-sw',
        h('i', { style: { '--c': a.solid[i] } }),
        h('code', a.solid[i]),
        h('code', `/ ${ACCENT_ON[i]}`),
      ),
      sw(a.text[i]),
    ]),
  )
  const statusRows = Object.entries(status).flatMap(([key, a]) =>
    THEMES.map(([theme, label, i]) => [
      theme === 'light' ? `${a.name}（${key}）` : '',
      label,
      sw(a.deco[i]),
      sw(a.text[i]),
      sw(a.solid[i]),
    ]),
  )
  const play = (track) => {
    track.dataset.on = track.dataset.on === 'true' ? 'false' : 'true'
  }
  const springDemo = Object.entries(springs).map(([name, cfg]) => {
    const { duration, easing } = springEasing(cfg)
    const track = h(
      'div.n-track',
      {
        dataset: { on: 'false' },
        style: { '--d': `${duration}ms`, '--e': easing, '--dx': '200px' },
      },
      h('div.n-ball'),
    )
    return h(
      'div.n-card',
      h('h3', name),
      h(
        'div.n-spring',
        track,
        h('p', `stiffness ${cfg.stiffness} · damping ${cfg.damping} · ${duration} ms`),
      ),
      button({
        label: '播放',
        icon: 'play',
        kind: 'tinted',
        size: 'sm',
        onClick: () => play(track),
      }),
    )
  })
  return [
    pageHead(
      '设计令牌（D4 已确认）',
      '下面的值由 tools/tokens.mjs 生成，同一份数据驱动样式、对比度脚本和这些表格。规格里写死的值保持不变，规格没定的值用脚本算出并标注。',
    ),
    section('颜色：表面、文字、控件', table(['令牌', '浅色', '深色'], neutralRows)),
    section(
      '强调色（8 个）',
      h(
        'p.n-lead',
        '装饰色只用于渐变、色块和光晕，不用于文字。气泡和实底按钮用「实底 / 文字色」这一对。强调色文字（链接、tinted 按钮、焦点环）是 D2 新增：规格里的实底色直接当文字用，在深色下蓝色只有 3.1:1。',
      ),
      table(['强调色', '主题', '装饰色', '实底 / 实底上的字', '强调色文字'], accentRows),
    ),
    section(
      '状态色',
      table(['状态', '主题', '装饰（圆点、背景）', '文字', '实底（白字/黑字）'], statusRows),
    ),
    section(
      '玻璃',
      table(
        ['档位', '不透明度', '模糊', '饱和度', '强调色调'],
        Object.entries(glass.levels).map(([k, l]) => [
          `${l.name}（${k}）`,
          `${Math.round(l.alpha * 100)}%`,
          l.blur ? `${l.blur}px` : '无',
          String(l.saturate),
          l.tint ? `${Math.round(l.tint * 100)}%` : '无',
        ]),
      ),
      h(
        'p.t-callout.t-secondary',
        `玻璃底色：${glass.base[0]}（浅）/ ${glass.base[1]}（深）。壁纸色块的浓度不超过 ${wallpaper.maxTint[0] * 100}%（浅）/ ${wallpaper.maxTint[1] * 100}%（深）。`,
      ),
    ),
    section(
      '圆角与间距',
      h(
        'div.n-grid',
        Object.entries(radius).map(([k, v]) =>
          h(
            'div.n-radius',
            h('i', { style: { borderRadius: `${v}px` } }),
            h('code', `--radius-${k}`),
            h('span.t-sub.t-secondary', `${v}px`),
          ),
        ),
      ),
      h(
        'p.t-callout.t-secondary',
        '外层圆角 = 内层圆角 + 间距，保证同心。Chromium 上额外加 corner-shape: squircle，其他浏览器退回普通圆角。',
      ),
      h(
        'div',
        { style: { display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' } },
        space.map((v) =>
          h(
            'div',
            { style: { display: 'grid', gap: '4px', justifyItems: 'center' } },
            h('i', {
              style: {
                display: 'block',
                width: `${v}px`,
                height: `${v}px`,
                background: 'var(--accent-solid)',
                borderRadius: '2px',
              },
            }),
            h('code.t-foot', String(v)),
          ),
        ),
      ),
    ),
    section(
      '字号',
      h(
        'div',
        Object.entries(type).map(([k, [size, line, weight]]) =>
          h(
            'div.n-type',
            h(
              'div',
              { style: { fontSize: `${size}px`, lineHeight: `${line}px`, fontWeight: weight } },
              '今天先把侧栏和输入栏对一遍 Aa 0123',
            ),
            h('small', `${k} · ${size}/${line} · ${weight}`),
          ),
        ),
      ),
    ),
    section(
      '动效：三种弹簧',
      h(
        'p.n-lead',
        '弹簧参数来自规格，曲线是它们的精确解，导出成 CSS linear()，不需要 JavaScript 动画库。开启「减少动态效果」后，所有动画改成不超过 150 毫秒的淡入淡出。',
      ),
      h('div.n-grid', springDemo),
    ),
  ]
}

function contrast() {
  const surfaces = ['bg-content', 'bg-elevated', 'bg-app', 'bubble-in']
  const labels = ['label', 'label-secondary', 'label-tertiary']
  const surfaceTable = (i) =>
    table(
      ['文字', ...surfaces.map((s) => `--${s}`)],
      labels.map((k) => [
        h('code', `--${k}`),
        ...surfaces.map((s) => verdict(flat(neutral[k][i], neutral[s][i]), 4.5)),
      ]),
    )
  const accentRows = Object.entries(accents).map(([key, a]) => {
    const worst = (i) =>
      Math.min(
        ...surfaces.flatMap((s) => [
          ratio(parse(a.text[i]), parse(neutral[s][i])),
          ratio(parse(a.text[i]), over({ ...parse(a.solid[i]), a: 0.16 }, parse(neutral[s][i]))),
        ]),
      )
    return [
      `${a.name}（${key}）`,
      verdict(ratio(parse(ACCENT_ON[0]), parse(a.solid[0])), 4.5),
      verdict(worst(0), 4.5),
      verdict(ratio(parse(ACCENT_ON[1]), parse(a.solid[1])), 4.5),
      verdict(worst(1), 4.5),
    ]
  })
  const glassRows = THEMES.map(([, label, i]) => {
    const base = parse(glass.base[i])
    const comps = [
      ['黑', '#000000'],
      ['白', '#FFFFFF'],
    ].map(([, c]) => over({ ...base, a: glass.floor[i] }, parse(c)))
    const worst = Math.min(
      ...comps.flatMap((c) => labels.map((k) => ratio(over(parse(neutral[k][i]), c), c))),
    )
    return [label, `${Math.round(glass.floor[i] * 100)}%`, verdict(worst, 4.5)]
  })
  const codeRows = Object.keys(code)
    .filter((k) => k !== 'bg')
    .map((k) => [
      h('code', `code-${k}`),
      ...THEMES.map(([, , i]) => verdict(ratio(parse(code[k][i]), parse(code.bg[i])), 4.5)),
    ])
  const statusRows = Object.entries(status).map(([key, a]) => [
    `${a.name}（${key}）`,
    ...THEMES.map(([, , i]) =>
      verdict(Math.min(...surfaces.map((s) => ratio(parse(a.text[i]), parse(neutral[s][i])))), 4.5),
    ),
  ])
  return [
    pageHead(
      '对比度（AT-21）',
      '正文 4.5:1，控件边界和焦点环 3:1。下面是这个页面在你的浏览器里用同一份令牌现算的结果，没有手抄。完整的 3000 多组检查（含 8 个强调色 × 深浅 × 4 个透明度档位的玻璃）由 bun design/prototype/tools/contrast.mjs 运行。',
    ),
    section('文字与表面：浅色', surfaceTable(0)),
    section('文字与表面：深色', surfaceTable(1)),
    section(
      '强调色（4.5:1）',
      h(
        'p.t-callout.t-secondary',
        '「气泡文字」是 on-accent 对实底；「强调色文字」取最差的表面，含 16% 强调色调叠加后的表面。',
      ),
      table(['强调色', '气泡 浅', '强调色文字 浅', '气泡 深', '强调色文字 深'], accentRows),
    ),
    section('状态色文字（4.5:1，取最差表面）', table(['状态', '浅色', '深色'], statusRows)),
    section(
      '文字承载玻璃（黑、白两个极端背后的最差值）',
      table(['主题', '不透明度下限', '三种文字色的最差对比度'], glassRows),
    ),
    section('代码高亮', table(['token', '浅色', '深色'], codeRows)),
    banner(
      'info',
      'info',
      '静态计算只覆盖这里列出的不透明基础色。真实渲染里的玻璃、悬停和焦点状态，用「玻璃对照板」和像素采样检查。macOS Safari 的真机验收还没有做。',
    ),
  ]
}

function glassBoard() {
  const backdrops = [
    ['black', '纯黑'],
    ['white', '纯白'],
    ['photo', '高对比图案'],
  ]
  const counter = h('span.n-counter')
  setTimeout(
    () =>
      counter.replaceChildren(
        icon('layers', 16),
        `当前视图的 backdrop-filter 层：${countBackdrops()}（对照板有意超出 4 层的上限）`,
      ),
    80,
  )
  return [
    pageHead(
      '玻璃对照板',
      '同一块文字承载玻璃放在纯黑、纯白和高对比图案上。切换主题、强调色和透明度档位，文字应始终清晰。这也是对比度像素检查的采样对象。',
    ),
    counter,
    h(
      'div.n-grid',
      { style: { gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))' } },
      backdrops.map(([bg, name]) =>
        h(
          'div.n-backdrop',
          { dataset: { bg }, 'data-glass-board': bg },
          h(
            'span',
            {
              style: {
                color: bg === 'white' ? '#000' : '#fff',
                fontWeight: '600',
                fontSize: '12px',
              },
            },
            name,
          ),
          h(
            'div.n-glass-sample.glass-text',
            { 'data-sample': 'text' },
            h('b.t-headline', '项目组'),
            h(
              'span.t-sub',
              { style: { color: 'var(--label-secondary)' } },
              '128 位成员 · 版本评审、迁移和每周进度',
            ),
            h(
              'span',
              { style: { color: 'var(--placeholder)', fontSize: 'var(--fs-message)' } },
              '发消息到 # 项目组',
            ),
          ),
          h(
            'div.n-glass-sample.glass',
            { 'data-sample': 'sidebar' },
            h('b.t-headline', 'Alice Chen'),
            h(
              'span.t-sub',
              { style: { color: 'var(--label-secondary)' } },
              '第二个最好看，能做深色版吗',
            ),
          ),
        ),
      ),
    ),
    h(
      'p.t-callout.t-secondary',
      '上面一块是文字承载玻璃（不低于下限），下面一块是侧栏用的玻璃（跟随档位）。侧栏玻璃只会出现在壁纸上，所以它在纯黑和纯白上不一定达标，这是预期的。',
    ),
  ]
}

function fonts() {
  const sample = (stack, label, note) =>
    h(
      'div.n-font',
      { style: { '--f': stack } },
      h('div.t-sub.t-secondary', { style: { fontFamily: 'var(--font-sans)' } }, label),
      h('div.big', '今天先把侧栏和输入栏对一遍'),
      h('div.msg', '周五评审改到 15:00，议程见文档。Migration 0007 is done · 128 members · 10:42'),
      h('div.msg', 'The quick brown fox jumps over the lazy dog. 0123456789'),
      h('div.small', note),
    )
  const probe = (name) => {
    const c = document.createElement('canvas').getContext('2d')
    const text = 'mmmmmmmmmmlli 你好 0O'
    const widthWith = (font) => {
      c.font = `32px ${font}`
      return c.measureText(text).width
    }
    return (
      widthWith(`"${name}", monospace`) !== widthWith('monospace') ||
      widthWith(`"${name}", serif`) !== widthWith('serif')
    )
  }
  // Inter is embedded in the page, so it counts as available even before its first use decodes it.
  const found = (n) => {
    if (n === 'Inter') return '内嵌'
    return probe(n) ? '有' : ''
  }
  const names = [
    'SF Pro Text',
    'Segoe UI Variable Text',
    'Segoe UI',
    'PingFang SC',
    'Microsoft YaHei UI',
    'Noto Sans SC',
    'Inter',
    'Cascadia Code',
    'Menlo',
    'Consolas',
  ]
  return [
    pageHead(
      '字体对比（D1，D4 选 Inter）',
      'Windows 上没有 SF 字体。D1 比较了两种方案：系统字体栈（Windows 11 是 Segoe UI Variable），和 Inter（OFL 协议，只含拉丁字符；Apple 设备上仍然先用 SF）。D4（2026-10-02）选定 Inter，中文始终用系统字体。',
    ),
    h(
      'div.n-compare',
      sample(
        fontStacks.system,
        '方案 A：系统字体栈（原先的规格）',
        'system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI Variable Text", …',
      ),
      sample(
        `${fontStacks.inter}`,
        '方案 B：Inter 在前（D4 选定）',
        '-apple-system, BlinkMacSystemFont, "Inter", system-ui, "PingFang SC", …（Inter 已内嵌，不需要联网）',
      ),
    ),
    section(
      '这台设备上可以用的字体',
      h(
        'div.n-grid',
        names.map((n) =>
          h(
            'div.n-card',
            { style: { padding: '10px 14px' } },
            h(
              'div',
              { style: { display: 'flex', justifyContent: 'space-between', gap: '8px' } },
              h('span.t-callout', n),
              found(n) ? h('span.n-pass', icon('check', 14), found(n)) : h('span.n-fail', '没有'),
            ),
          ),
        ),
      ),
      h(
        'p.t-sub.t-secondary',
        '检测方式是比较渲染宽度。Inter 是内嵌的拉丁子集，不需要联网；整个界面默认使用它，下面的开关切到「系统字体」后就不再用到。',
      ),
    ),
    h(
      'div',
      { style: { display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' } },
      h('span.t-callout', '整个界面使用：'),
      seg({
        label: '西文字体',
        value: state.prefs.font,
        items: [
          { value: 'system', label: '系统字体' },
          { value: 'inter', label: 'Inter' },
        ],
        onChange: (v) => setPref('font', v),
      }),
    ),
    banner(
      'info',
      'info',
      'D4 已选定 Inter（2026-10-02，D-113）：拉丁字母和数字用 Inter，中文用系统字体，Apple 设备上仍然先用 SF。上面的开关留着方便对比。',
    ),
  ]
}

function iconPage() {
  const sizes = [180, 120, 64, 32, 16]
  const stage = h('div.n-icon-set')
  let safe = false
  const draw = () => {
    stage.replaceChildren(
      ...Object.entries(ICON_VARIANTS).map(([key, v]) =>
        h(
          'div.n-icon-tile',
          h('div.n-icon-stage', appIcon(key, 160, v.name), safe ? h('i.n-safe') : null),
          h('b', v.name),
          v.chosen ? h('span.n-pass', icon('check', 14), 'D4 选定') : null,
          h(
            'div',
            { style: { display: 'flex', gap: '10px', alignItems: 'flex-end' } },
            sizes.slice(2).map((s) => appIcon(key, s, `${v.name} ${s}px`)),
          ),
        ),
      ),
    )
  }
  draw()
  return [
    pageHead(
      '应用图标（D4 选 A）',
      'D4（2026-10-02）暂定 A，B 和 C 留作对比。三个方向都是原创图形，没有用 Apple 的图标或 SF Symbols。导出 192、512、maskable 和 favicon 在 M6 的 PWA 里做，到时还可以调整。',
    ),
    h(
      'div',
      { style: { display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' } },
      h(
        'label.check',
        h('input', { type: 'checkbox', onchange: (e) => ((safe = e.target.checked), draw()) }),
        '显示 maskable 安全区（圆形，直径 80%）',
      ),
    ),
    stage,
    section(
      '在浅色和深色背景上',
      h(
        'div',
        {
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))',
            gap: '12px',
          },
        },
        [
          ['#F2F2F7', '#1c1c1e'],
          ['#101014', '#f2f2f7'],
        ].map(([bg, fg]) =>
          h(
            'div',
            {
              style: {
                display: 'flex',
                gap: '14px',
                alignItems: 'center',
                padding: '18px',
                borderRadius: '16px',
                background: bg,
                color: fg,
              },
            },
            Object.keys(ICON_VARIANTS).map((k) => appIcon(k, 48)),
            h('span', { style: { fontWeight: '600' } }, 'ChatApp'),
          ),
        ),
      ),
    ),
    h(
      'p.t-callout.t-secondary',
      '图标里的四角星也是助手的标志（✦）。应用名是配置项，现在用 ChatApp 占位。',
    ),
  ]
}

function components() {
  const el = (...c) => h('div.n-card', ...c)
  const row = (...c) =>
    h(
      'div',
      { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } },
      ...c,
    )
  const field = (label, id, props = {}) =>
    h('div.field', h('label.field__label', { for: id }, label), h('input.input', { id, ...props }))
  return [
    pageHead(
      '组件',
      'M1b 起在 Storybook 里逐个实现，这里先看一眼状态。每个组件都要有：默认、悬停、按下、聚焦、禁用、加载、空、错误、长内容、深色模式。',
    ),
    section(
      '按钮',
      el(
        row(
          button({ label: 'Filled', kind: 'filled' }),
          button({ label: 'Tinted', kind: 'tinted' }),
          button({ label: 'Plain', kind: 'plain' }),
          button({ label: 'Glass', kind: 'glass' }),
          button({ label: '禁用', kind: 'filled', disabled: true }),
        ),
        row(
          button({ label: '危险', kind: 'filled', danger: true }),
          button({ label: '危险', kind: 'tinted', danger: true }),
          button({ label: '加载中', kind: 'filled', 'aria-busy': 'true', icon: 'loader' }),
          iconButton({ icon: 'settings', label: '设置' }),
          iconButton({ icon: 'send', label: '发送', cls: 'icon-btn--round icon-btn--filled' }),
        ),
      ),
    ),
    section(
      '输入',
      h(
        'div.n-grid',
        el(field('默认', 'c1', { placeholder: '占位文字' })),
        el(
          field('有错误', 'c2', { value: 'Bad_Name', 'aria-invalid': 'true' }),
          h(
            'div.field__error',
            icon('circle-alert', 16),
            '用户名要 3–20 位，只能用小写字母、数字和下划线。',
          ),
        ),
        el(field('禁用', 'c3', { value: '不能修改', disabled: true })),
      ),
    ),
    section(
      '开关与选择',
      el(
        row(
          switchEl({ checked: true, label: '开' }),
          switchEl({ checked: false, label: '关' }),
          h('label.check', h('input', { type: 'checkbox', checked: true }), '复选'),
          h('label.check', h('input', { type: 'radio', name: 'cr', checked: true }), '单选'),
        ),
        seg({
          label: '分段',
          value: 'b',
          items: [
            { value: 'a', label: '清透' },
            { value: 'b', label: '标准' },
            { value: 'c', label: '着色' },
          ],
        }),
        h('input.slider', {
          type: 'range',
          min: '0',
          max: '4',
          value: '2',
          'aria-label': '滑块',
          style: { '--p': '50%' },
          oninput: (e) => e.target.style.setProperty('--p', `${(e.target.value / 4) * 100}%`),
        }),
      ),
    ),
    section(
      '徽标、头像、状态',
      el(
        row(
          badge('3'),
          badge('99+'),
          badge('@'),
          badge('12', 'muted'),
          botBadge(),
          h('span.badge.badge--role', '群主'),
          h('span.chip', icon('sparkles', 16), '总结未读'),
        ),
        row(
          avatar('alice', { size: 44, presence: true }),
          avatar('bob', { size: 44, presence: true }),
          avatar('carol', { size: 44, presence: true }),
          avatar('bot', { size: 44 }),
          h('span.t-sub.t-secondary', '在线 · 离开 · 离线：用形状区分，不只靠颜色'),
        ),
      ),
    ),
    section(
      '提示与横幅',
      h(
        'div',
        { style: { display: 'grid', gap: '8px' } },
        banner('info', 'info', '提示：这条信息不需要你操作。'),
        banner('success', 'circle-check', '成功：邀请码已生成。'),
        banner('warning', 'triangle-alert', '警告：网络已断开，消息会在恢复后同步。'),
        banner('danger', 'circle-alert', '错误：key 无效或余额不足，没有保存。'),
      ),
    ),
    section(
      '菜单、对话框、Toast',
      el(
        row(
          button({
            label: '打开菜单',
            kind: 'tinted',
            onClick: (e) =>
              openMenu({
                anchor: e.currentTarget,
                focusFirst: e.detail === 0,
                items: [
                  { label: '回复', icon: 'reply', hint: 'R' },
                  { label: '复制', icon: 'copy' },
                  { type: 'separator' },
                  { label: '删除', icon: 'trash', danger: true },
                ],
              }),
          }),
          button({
            label: '打开对话框',
            kind: 'tinted',
            onClick: () =>
              openDialog({
                title: '删除这条消息？',
                body: '这只会从你的视图里移除，别人不受影响。',
                actions: [
                  { label: '取消', kind: 'plain', autofocus: true },
                  { label: '删除', kind: 'filled', danger: true },
                ],
              }),
          }),
          button({
            label: '弹出 Toast',
            kind: 'tinted',
            onClick: () => toast('已复制', { action: '撤销' }),
          }),
        ),
      ),
    ),
    section(
      '空状态与加载',
      h(
        'div.n-grid',
        el(
          emptyState({
            icon: 'bell',
            title: '没有通知',
            text: '@我、回复、助手等待批准和提醒到点都会出现在这里。',
          }),
        ),
        el(
          emptyState({
            icon: 'wifi-off',
            title: '加载失败',
            text: '检查网络后重试。',
            error: true,
            action: button({ label: '重试', kind: 'tinted' }),
          }),
        ),
        el(
          h(
            'div',
            { style: { display: 'grid', gap: '10px' } },
            h('span.skeleton', { style: { height: '14px', width: '70%' } }),
            h('span.skeleton', { style: { height: '14px', width: '95%' } }),
            h('span.skeleton', { style: { height: '14px', width: '55%' } }),
          ),
        ),
      ),
    ),
  ]
}

const BUILDERS = {
  principles,
  tokens,
  contrast,
  glass: glassBoard,
  fonts,
  icon: iconPage,
  components,
}

export function buildNotesView(page = state.notesPage) {
  const overlay = h('div.overlay')
  const body = h('main.notes__body.scroll#main', { tabindex: '-1' })
  const buttons = NOTE_PAGES.map((p) =>
    h(
      'button.sheet__tab',
      {
        type: 'button',
        role: 'tab',
        'aria-selected': 'false',
        dataset: { page: p.id },
        onclick: () => show(p.id),
      },
      icon(p.icon, 18),
      p.label,
      h('small', p.hint),
    ),
  )
  const nav = h(
    'nav.notes__nav.glass.squircle',
    { 'aria-label': '设计说明' },
    h('h2', '设计说明'),
    h('div', { role: 'tablist', 'aria-label': '页面', style: { display: 'contents' } }, buttons),
    h(
      'button.btn.btn--plain.btn--sm',
      {
        type: 'button',
        style: { marginTop: 'auto', justifyContent: 'flex-start' },
        onclick: () => bus.emit('view:set', 'app'),
      },
      icon('arrow-left', 16),
      '回到应用',
    ),
  )
  const wallpaper = h(
    'div.wallpaper',
    { 'aria-hidden': 'true' },
    h('div.orb.orb--a'),
    h('div.orb.orb--c'),
  )
  const root = h('div.notes', nav, body)
  const el = h('div', { style: { position: 'absolute', inset: '0' } }, wallpaper, root, overlay)
  function show(id) {
    state.notesPage = id
    for (const b of buttons) b.setAttribute('aria-selected', String(b.dataset.page === id))
    body.replaceChildren(h('div.notes__page', ...BUILDERS[id]()))
    body.scrollTop = 0
  }
  show(page)
  ui.notesEl = root
  return { el, overlay, show }
}

export { $, $$ }
