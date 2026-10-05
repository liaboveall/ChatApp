#!/usr/bin/env bun
/**
 * The local edge gateway (docs/09, docs/10, D-147): Nginx in a container with the production site configuration, serving
 * the production build at https://chat.localhost:8443.
 *
 *   bun scripts/edge.ts up [--no-build]   build, make the web root and the certificate, start Nginx, check its config
 *   bun scripts/edge.ts down              remove the `chatapp-edge` containers and network (nothing else, nothing pruned)
 *   bun scripts/edge.ts status
 *   bun scripts/edge.ts configtest        only check that the configuration loads in the pinned image (what CI does)
 *
 * It manages the gateway only. The API behind it is the test-environment stack of `scripts/e2e-stack.ts` on port 3104
 * (`E2E_APP_ORIGIN=https://chat.localhost:8443 E2E_API_PORT=3104`), which owns the test database: do not run it together
 * with `test:e2e` or `test:integration`. The certificate is made with openssl for `chat.localhost` under
 * `.test-runs/edge/certs/` (keys mode 600, never printed, never put into a trust store; browser tests ignore HTTPS errors).
 */
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { $ } from 'bun'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const EDGE = join(ROOT, '.test-runs', 'edge')
const CERTS = join(EDGE, 'certs')
const WEBROOT = join(EDGE, 'webroot')
const DIST = join(ROOT, 'apps', 'web', 'dist')
const COMPOSE = join(ROOT, 'infra', 'compose.edge.yml')
const compose = ['docker', 'compose', '-p', 'chatapp-edge', '-f', COMPOSE]

async function certificate(): Promise<void> {
  const crt = join(CERTS, 'chat.localhost.crt')
  const key = join(CERTS, 'chat.localhost.key')
  if (existsSync(crt) && existsSync(key)) return
  mkdirSync(CERTS, { recursive: true, mode: 0o700 })
  const ext = join(CERTS, 'leaf.ext')
  writeFileSync(
    ext,
    [
      'subjectAltName=DNS:chat.localhost',
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature',
      'extendedKeyUsage=serverAuth',
    ].join('\n'),
  )
  const subject = (name: string): string => `/CN=${name}`
  await $`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ${join(CERTS, 'ca.key')} -out ${join(CERTS, 'ca.crt')} -days 30 -subj ${subject('ChatApp local edge CA (not trusted anywhere)')} -addext ${'basicConstraints=critical,CA:TRUE,pathlen:0'} -addext ${'keyUsage=critical,keyCertSign,cRLSign'}`.quiet()
  await $`openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ${key} -out ${join(CERTS, 'leaf.csr')} -subj ${subject('chat.localhost')}`.quiet()
  await $`openssl x509 -req -in ${join(CERTS, 'leaf.csr')} -CA ${join(CERTS, 'ca.crt')} -CAkey ${join(CERTS, 'ca.key')} -CAcreateserial -out ${join(CERTS, 'leaf.crt')} -days 30 -extfile ${ext}`.quiet()
  // The server sends the leaf followed by the (untrusted) CA.
  const chain =
    (await Bun.file(join(CERTS, 'leaf.crt')).text()) +
    (await Bun.file(join(CERTS, 'ca.crt')).text())
  writeFileSync(crt, chain)
  for (const file of ['ca.key', 'chat.localhost.key']) chmodSync(join(CERTS, file), 0o600)
  for (const file of ['leaf.csr', 'leaf.ext']) rmSync(join(CERTS, file), { force: true })
}

/** The release directory without its hashed assets, and the shared assets directory (docs/10), without Vite's own files. */
function webroot(): void {
  if (!existsSync(join(DIST, 'index.html')))
    throw new Error('no build in apps/web/dist: run without --no-build')
  rmSync(WEBROOT, { recursive: true, force: true })
  mkdirSync(join(WEBROOT, 'current'), { recursive: true })
  cpSync(DIST, join(WEBROOT, 'current'), {
    recursive: true,
    filter: (source) =>
      !source.startsWith(join(DIST, 'assets')) && !source.startsWith(join(DIST, '.vite')),
  })
  cpSync(join(DIST, 'assets'), join(WEBROOT, 'assets'), { recursive: true })
  // The workers of Nginx run as an unprivileged user inside the container; build output is public.
  Bun.spawnSync(['chmod', '-R', 'a+rX', WEBROOT])
}

const [command, ...flags] = process.argv.slice(2)
switch (command) {
  case 'up': {
    if (!flags.includes('--no-build'))
      await $`bun run --cwd ${join(ROOT, 'apps', 'web')} build`.quiet()
    await certificate()
    webroot()
    await $`${compose} up -d --wait --force-recreate`.quiet()
    await $`${compose} exec -T nginx nginx -t`.quiet()
    console.log(
      'edge: https://chat.localhost:8443 (the API behind it: E2E_API_PORT=3104, see scripts/e2e-stack.ts)',
    )
    break
  }
  case 'down':
    await $`${compose} down`.quiet()
    console.log('edge: down')
    break
  case 'status':
    await $`${compose} ps`
    break
  case 'configtest': {
    // Nothing is started: a certificate, empty web root directories (the mounts need to exist) and `nginx -t` in the image.
    await certificate()
    mkdirSync(join(WEBROOT, 'current'), { recursive: true })
    mkdirSync(join(WEBROOT, 'assets'), { recursive: true })
    await $`${compose} config --quiet`
    await $`${compose} run --rm --no-deps nginx nginx -t`
    console.log('edge: the configuration loads')
    break
  }
  default:
    console.error('usage: bun scripts/edge.ts up [--no-build] | down | status | configtest')
    process.exit(2)
}
