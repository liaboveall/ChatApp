// Applies the stored appearance before the first paint, so a dark or tinted setup never flashes light.
// Runs as an external, blocking script because the page's CSP forbids inline scripts (docs/07 SEC-06).
// Keep in step with applyToRoot() in src/lib/appearance.ts; a unit test compares the two.
;(() => {
  let a = {}
  try {
    const raw = localStorage.getItem('chatapp.appearance')
    const stored = raw ? JSON.parse(raw) : null
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) a = stored
  } catch {
    // Unreadable storage uses the light default, just like loadAppearance().
  }
  const root = document.documentElement
  const one = (v, list) => (list.includes(v) ? v : null)
  const theme = one(a.theme, ['system', 'light', 'dark']) || 'light'
  const accent = one(a.accent, [
    'purple',
    'pink',
    'red',
    'orange',
    'yellow',
    'green',
    'teal',
    'graphite',
  ])
  const glass = one(a.glass, ['clear', 'tinted', 'opaque'])
  const size = [-1, 1, 2, 3].includes(a.typeSize) ? String(a.typeSize) : null
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
  document
    .querySelector('meta[name="color-scheme"]')
    ?.setAttribute('content', theme === 'system' ? 'light dark' : theme)
  // The installed app's title bar follows the chosen theme, not the system's (tokens.ts `bg-content`).
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    const dark =
      theme === 'system' ? (meta.getAttribute('media') || '').includes('dark') : theme === 'dark'
    meta.setAttribute('content', dark ? '#0E0E10' : '#FAF7F1')
  }
  if (accent) root.setAttribute('data-accent', accent)
  if (glass) root.setAttribute('data-glass', glass)
  if (size) root.setAttribute('data-type-size', size)
  if (a.reduceMotion === true) root.setAttribute('data-reduce-motion', 'true')
})()
