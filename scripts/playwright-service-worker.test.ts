import { expect, test } from 'bun:test'
import main from '../apps/web/playwright.config.ts'
import media from '../apps/web/playwright.media.config.ts'

// D-206: the app registers a service worker on every page. In WebKit and Firefox Playwright cannot route what a page the worker
// controls asks for, so every test that holds an answer back with `route` waits until its time limit there. Those two engines
// block the worker in every browser configuration; only the files about the worker itself allow it again with `test.use`.
// A new configuration with WebKit or Firefox projects belongs in this list (the edge and visual ones have neither).
const configurations = { 'playwright.config.ts': main, 'playwright.media.config.ts': media }

test('every WebKit and Firefox project of the browser test configurations blocks the service worker', () => {
  const engines = new Set<string>()
  const allowed: string[] = []
  for (const [file, configuration] of Object.entries(configurations)) {
    for (const project of configuration.projects ?? []) {
      const engine = project.use?.browserName ?? project.use?.defaultBrowserType
      if (engine !== 'webkit' && engine !== 'firefox') continue
      engines.add(engine)
      if (project.use?.serviceWorkers !== 'block') allowed.push(`${file}: ${project.name}`)
    }
  }
  expect(allowed).toEqual([])
  // The rule has something to apply to; a renamed or emptied project list must not turn this into a vacuous check.
  expect([...engines].sort()).toEqual(['firefox', 'webkit'])
})
