// A dependency-free static file server for the built Storybook: `node visual/serve-static.mjs <dir> <port>`.
// The visual tests run inside the Playwright container, which has Node but none of the project's tools.
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'

const [, , dir = 'storybook-static', port = '6007'] = process.argv
const root = resolve(dir)
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const path = normalize(join(root, decodeURIComponent(url.pathname)))
  if (!path.startsWith(root) || !existsSync(path) || !statSync(path).isFile()) {
    response.writeHead(404).end('not found')
    return
  }
  response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' })
  createReadStream(path).pipe(response)
}).listen(Number(port), '127.0.0.1', () => console.log(`serving ${root} on ${port}`))
