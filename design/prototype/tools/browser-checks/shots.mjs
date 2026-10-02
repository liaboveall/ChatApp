// Captures a list of scenes to PNG files in one Edge session.
//   node shots.mjs <prefix> "scene[:params[:WxH]]" ...      e.g. dark "channel:theme=dark" "w320::320x700"
import { launch, PROTO_URL } from './cdp.mjs'

const [prefix, ...specs] = process.argv.slice(2)
const page = await launch({ width: 1440, height: 900 })
let nav = 0
try {
  for (const spec of specs) {
    const [scene, params = '', size = '1440x900'] = spec.split(':')
    const [w, h] = size.split('x').map(Number)
    await page.viewport(w, h)
    const hash = `scene=${scene}&fresh=1&nostore=1&static=1&quiet=1&width=fit${params ? `&${params}` : ''}`
    await page.goto(`${PROTO_URL}?n=${++nav}#${hash}`)
    // The two replay scenes need time to reach the state they show.
    const wait = /wait=(\d+)/.exec(params)
    if (wait) await page.sleep(Number(wait[1]))
    else if (scene === 'agent-stream') await page.sleep(2600)
    else if (scene === 'waiting') await page.sleep(5200)
    else await page.sleep(500)
    await page.shot(`${prefix}-${scene}${params ? `-${params.replace(/[=&]/g, '_')}` : ''}`)
  }
  if (page.consoleLog.length) console.log('console:', page.consoleLog.slice(0, 5).join(' | '))
  console.log(`captured ${specs.length} screenshots`)
} finally {
  await page.close()
}
