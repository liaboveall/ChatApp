// Applies the stored appearance before the first paint, so a dark or tinted setup never flashes light.
// Runs as an external, blocking script because the page's CSP forbids inline scripts (docs/07 SEC-06).
// Keep in step with applyToRoot() in src/lib/appearance.ts; a unit test compares the two.
;(() => {
  try {
    const raw = localStorage.getItem('chatapp.appearance')
    if (!raw) return
    const a = JSON.parse(raw)
    const root = document.documentElement
    const one = (v, list) => (list.includes(v) ? v : null)
    const theme = one(a.theme, ['light', 'dark'])
    const accent = one(a.accent, ['purple', 'pink', 'red', 'orange', 'yellow', 'green', 'graphite'])
    const glass = one(a.glass, ['clear', 'tinted', 'opaque'])
    const size = [-1, 1, 2, 3].includes(a.typeSize) ? String(a.typeSize) : null
    if (theme) root.setAttribute('data-theme', theme)
    if (accent) root.setAttribute('data-accent', accent)
    if (glass) root.setAttribute('data-glass', glass)
    if (size) root.setAttribute('data-type-size', size)
    if (a.reduceMotion === true) root.setAttribute('data-reduce-motion', 'true')
  } catch {
    // Unreadable storage: the CSS defaults apply.
  }
})()
