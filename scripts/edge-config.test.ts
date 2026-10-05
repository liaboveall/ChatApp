/**
 * The gateway's configuration against the rest of the repository (docs/10 section 5, D-147). It needs no Docker: the
 * page policy and its companion headers that Nginx sends are the ones the application's build sends to `vite preview`
 * (word for word), every HTTPS location carries HSTS, and nothing in the site file uses what the 1.28 line cannot be trusted
 * with (a regex `map`, `rewrite` with an unnamed capture, the `charset` filter): the edge runs 1.30 (D-169), but the shared
 * server is on 1.28 until M8 and the same file has to be safe there. CI runs this file and the container's own `nginx -t`
 * on the pinned image; the edge test suite runs only on a developer's machine.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SECURITY_HEADERS } from '../apps/web/tools/csp.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

/** `add_header Name "value" always;` lines of an include file, as a map. */
function addedHeaders(file: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const line of file.split('\n')) {
    const match = /^\s*add_header\s+(\S+)\s+"((?:[^"\\]|\\.)*)"\s+always;\s*$/.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) found[match[1]] = match[2]
  }
  return found
}

describe('security headers', () => {
  test("the page policy and its companions are the application's, word for word", () => {
    expect(addedHeaders(read('infra/nginx/security-headers.conf'))).toEqual(SECURITY_HEADERS)
  })

  test('every location that answers over HTTPS includes the transport security header', () => {
    const site = read('infra/nginx/chatapp.conf')
    const server = site.slice(site.indexOf('server {'), site.indexOf('# Plain HTTP'))
    const blocks = server.split(/\n {4}location /).slice(1)
    expect(blocks.length).toBeGreaterThanOrEqual(8)
    for (const block of blocks) {
      expect(block).toContain('include /etc/nginx/chatapp/transport-security.conf;')
    }
    expect(addedHeaders(read('infra/nginx/transport-security.conf'))).toEqual({
      'Strict-Transport-Security': 'max-age=31536000',
    })
  })

  test('the server itself carries it too, for what is answered before a location is chosen (an unparseable request)', () => {
    const site = read('infra/nginx/chatapp.conf')
    const server = site.slice(site.indexOf('server {'), site.indexOf('# Plain HTTP'))
    const outsideLocations = server.slice(0, server.indexOf('\n    location '))
    expect(outsideLocations).toContain('include /etc/nginx/chatapp/transport-security.conf;')
  })

  test('static locations also carry the page policy; the API and the socket leave it to the application', () => {
    const site = read('infra/nginx/chatapp.conf')
    const blocks = Object.fromEntries(
      site
        .slice(site.indexOf('server {'), site.indexOf('# Plain HTTP'))
        .split(/\n {4}location /)
        .slice(1)
        .map((block) => [block.slice(0, block.indexOf('{')).trim(), block]),
    )
    for (const name of ['= /index.html', '/assets/', '/']) {
      expect(blocks[name]).toContain('security-headers.conf')
    }
    for (const [name, block] of Object.entries(blocks)) {
      if (
        name.startsWith('/api') ||
        name.startsWith('~') ||
        name === '= /api/invites/check' ||
        name === '= /ws' ||
        name === '= /api/monitoring'
      ) {
        expect(block).not.toContain('security-headers.conf')
      }
    }
  })
})

describe('what the 1.28 line (the server until M8) must not be given', () => {
  const files = [
    'infra/nginx/chatapp.conf',
    'infra/nginx/proxy-api.conf',
    'infra/nginx/security-headers.conf',
    'infra/nginx/transport-security.conf',
    'infra/nginx/env/local-http.conf',
    'infra/nginx/env/local-server.conf',
  ]
  const text = files.map(read).join('\n')
  // Comments are for people; only directives count.
  const directives = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')

  test('no regex `map`, no `rewrite`, no `charset`', () => {
    expect(directives).not.toMatch(/^\s*map\s/m)
    expect(directives).not.toMatch(/^\s*rewrite\s/m)
    expect(directives).not.toMatch(/^\s*charset\s/m)
  })

  test('the access log has no path, query, referer, user agent, cookie or location', () => {
    const formats = directives.split('\n').filter((line) => line.includes('log_format'))
    expect(formats.length).toBeGreaterThan(5)
    for (const line of formats) {
      for (const forbidden of [
        '$uri',
        '$request_uri',
        '$request ',
        '$args',
        '$query_string',
        '$http_',
        '$sent_http_location',
        '$cookie_',
      ]) {
        expect(line).not.toContain(forbidden)
      }
    }
  })

  test('small bodies by default, the one upload location raises it, and the server does not announce itself', () => {
    expect(directives).toContain('client_max_body_size 128k;')
    expect(directives).toContain('server_tokens off;')
    expect(directives).toContain('error_log /dev/null;')
  })
})

describe('the compose file', () => {
  const compose = read('infra/compose.edge.yml')
  test('binds to loopback only, pins the image by digest, and has a fixed project name', () => {
    expect(compose).toMatch(/127\.0\.0\.1:8443:443/)
    // The 1.30 series (D-169), an exact version and the digest of the index (1.28 has had no security fixes since April).
    expect(compose).toMatch(/image: nginx:1\.30\.\d+-alpine@sha256:[0-9a-f]{64}/)
    expect(compose).toMatch(/^name: chatapp-edge$/m)
    expect(compose).not.toMatch(/container_name/)
  })
})
