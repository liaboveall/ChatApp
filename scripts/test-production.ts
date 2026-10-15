/** Isolated local production composition. Local TLS/Garage represents the offsite services; never a disaster-recovery claim. */
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { privateJson, runPrivate, sha256 } from '../apps/server/src/runtime/operations-files.ts'
import {
  backupInventoryReceiptSchema,
  releaseManifestSchema,
  restoreDownloadReceiptSchema,
} from '../packages/contracts/src/operations.ts'
import { installStorageCredentials, prepareProduction, readRawEnvironment } from './production.ts'
import { K6_IMAGE } from './production-load.ts'

async function main() {
  const file = process.argv[2]
  if (!file) throw new Error('source-bound image metadata required')
  const harnessHash = sha256(await readFile(import.meta.path))
  const manifest = await privateJson(
    file,
    releaseManifestSchema
      .pick({
        images: true,
        APPLICATION_SHA: true,
        APPLICATION_SOURCE_HASH: true,
      })
      .strip(),
    32 * 1024 * 1024,
  )
  const root = resolve('.test-runs/production', crypto.randomUUID())
  await mkdir(root, { recursive: true, mode: 0o700 })
  const config = join(root, 'private')
  await prepareProduction(config, 'https://closed.chatapp.invalid:9444')
  const fields = async (name: string) =>
    readRawEnvironment(await readFile(join(config, name), 'utf8'))
  const replace = async (name: string, change: Record<string, string>) => {
    await writeFile(
      join(config, name),
      Object.entries({ ...(await fields(name)), ...change })
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n',
      { mode: 0o600 },
    )
  }
  const compose = await fields('compose.env')
  const project = compose.CHATAPP_PROJECT!,
    owner = compose.CHATAPP_OWNER!
  await replace('compose.env', {
    SERVER_IMAGE: manifest.images.server!,
    MEDIA_IMAGE: manifest.images.media!,
    OPS_IMAGE: manifest.images.ops!,
    POSTGRES_IMAGE: manifest.images.postgres!,
    VALKEY_IMAGE: manifest.images.valkey!,
    GARAGE_IMAGE: manifest.images.garage!,
    APPLICATION_SOURCE_HASH: manifest.APPLICATION_SOURCE_HASH,
    CHATAPP_API_PORT: '25190',
    CHATAPP_NETWORK_CIDR: '172.29.77.0/24',
  })
  await replace('app.env', {
    TRUSTED_PROXIES: '127.0.0.1,::1,172.29.77.1',
    SMTP_HOST: 'smtp.invalid',
    MAIL_FROM: 'closed@chatapp.invalid',
    SOCLAAS_API_KEY: crypto.randomUUID(),
  })
  const override = join(root, 'compose.local.yml')
  await writeFile(
    join(config, 'runtime/offsite.ts'),
    `Bun.serve({hostname:'0.0.0.0',port:9443,maxRequestBodySize:128*1024*1024,tls:{cert:Bun.file('/fixture/cert.pem'),key:Bun.file('/fixture/key.pem')},async fetch(req){const u=new URL(req.url); if(u.pathname==='/local-fixture-health')return new Response('ok'); const body=['GET','HEAD'].includes(req.method)?undefined:await req.arrayBuffer();const r=await fetch('http://garage:3900'+u.pathname+u.search,{method:req.method,headers:req.headers,body,redirect:'manual'});return new Response(r.body,{status:r.status,headers:r.headers})}})\n`,
    { mode: 0o600 },
  )
  await runPrivate([
    'openssl',
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(config, 'runtime/key.pem'),
    '-out',
    join(config, 'runtime/cert.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=offsite',
    '-addext',
    'subjectAltName=DNS:offsite,DNS:closed.chatapp.invalid',
  ])
  await chmod(join(config, 'runtime/key.pem'), 0o600)
  await chmod(join(config, 'runtime/cert.pem'), 0o644)
  const trust = `\n      NODE_EXTRA_CA_CERTS: /fixture/cert.pem\n      BACKUP_CA_FILE: /fixture/cert.pem`
  const caMount = `\n      - type: bind\n        source: ${config}/runtime/cert.pem\n        target: /fixture/cert.pem\n        read_only: true`
  await writeFile(
    override,
    `services:\n  api:\n    environment:${trust}\n    volumes:${caMount}\n  worker:\n    environment:${trust}\n    volumes:${caMount}\n  tools:\n    environment:${trust}\n    volumes:${caMount}\n  initialize:\n    volumes:\n      - ${config}/runtime:/fixture\n    command: [bun, --no-env-file, -e, 'import{mkdir,chown,chmod,readdir}from"node:fs/promises";for(const path of ["/run/chatapp-media","/run/chatapp-embedding","/var/lib/chatapp/models","/var/lib/garage/meta","/var/lib/garage/data","/var/lib/chatapp/backup","/var/lib/chatapp/restore"]){await mkdir(path,{recursive:true,mode:0o700});await chown(path,10001,10001);await chmod(path,0o700)}await chown("/fixture",10001,10001);for(const name of await readdir("/fixture"))await chown("/fixture/"+name,10001,10001)']\n  garage:\n    ports: ['127.0.0.1:25191:3903']\n  offsite:\n    image: ${manifest.images.server}\n    user: '10001:10001'\n    read_only: true\n    cap_drop: [ALL]\n    security_opt: ['no-new-privileges:true']\n    networks: [application]\n    labels:\n      chatapp.production.owner: ${owner}\n      chatapp.production.release: ${manifest.APPLICATION_SOURCE_HASH}\n    command: [bun, --no-env-file, /fixture/offsite.ts]\n    volumes:\n      - ${config}/runtime:/fixture:ro\n`,
    { mode: 0o600 },
  )
  // Exercise the real site configuration and TLS/WebSocket proxy with a private, non-root gateway.
  const fixture = join(config, 'runtime')
  await writeFile(
    join(fixture, 'site.conf'),
    (await readFile('infra/nginx/chatapp.conf', 'utf8'))
      .replaceAll('listen 443 ssl;', 'listen 9444 ssl;')
      .replaceAll('listen [::]:443 ssl;', 'listen [::]:9444 ssl;')
      .replaceAll('listen 80;', 'listen 9080;')
      .replaceAll('listen [::]:80;', 'listen [::]:9080;')
      .replaceAll('/var/log/nginx/chatapp-access.log', '/dev/null'),
    { mode: 0o600 },
  )
  for (const name of ['security-headers.conf', 'transport-security.conf', 'proxy-api.conf'])
    await writeFile(join(fixture, name), await readFile(join('infra/nginx', name)), {
      mode: 0o600,
    })
  await writeFile(join(fixture, 'env-http.conf'), 'upstream chatapp_api { server api:3100; }\n', {
    mode: 0o600,
  })
  await writeFile(
    join(fixture, 'env-server.conf'),
    'server_name closed.chatapp.invalid; ssl_certificate /etc/nginx/chatapp/cert.pem; ssl_certificate_key /etc/nginx/chatapp/key.pem;\n',
    { mode: 0o600 },
  )
  await writeFile(join(fixture, 'access.conf'), 'allow 172.29.77.0/24; deny all;\n', {
    mode: 0o600,
  })
  await writeFile(
    join(fixture, 'nginx.conf'),
    'pid /tmp/nginx.pid; error_log /dev/null; events { worker_connections 1024; } http { client_body_temp_path /tmp/body; proxy_temp_path /tmp/proxy; fastcgi_temp_path /tmp/fastcgi; uwsgi_temp_path /tmp/uwsgi; scgi_temp_path /tmp/scgi; include /etc/nginx/mime.types; include /etc/nginx/chatapp/site.conf; }\n',
    { mode: 0o600 },
  )
  const loadCompose = join(root, 'compose.load.yml')
  await writeFile(
    loadCompose,
    `services:
  initialize:
    volumes:
      - load-fixture:/run/chatapp-load
    command: [bun, --no-env-file, -e, 'import{mkdir,chown,chmod,readdir}from"node:fs/promises";for(const path of ["/run/chatapp-media","/run/chatapp-embedding","/var/lib/chatapp/models","/var/lib/garage/meta","/var/lib/garage/data","/var/lib/chatapp/backup","/var/lib/chatapp/restore","/run/chatapp-load"]){await mkdir(path,{recursive:true,mode:0o700});await chown(path,10001,10001);await chmod(path,0o700)}await chown("/fixture",10001,10001);for(const name of await readdir("/fixture"))await chown("/fixture/"+name,10001,10001)']
  tools:
    volumes:
      - load-fixture:/run/chatapp-load
      - ${resolve('infra/load/chat.js')}:/fixture/load-script.js:ro
  gateway:
    image: ${manifest.images.nginx}
    user: '10001:10001'
    read_only: true
    cap_drop: [ALL]
    security_opt: ['no-new-privileges:true']
    tmpfs: ['/tmp:size=67108864,mode=1777,nosuid,nodev,noexec']
    mem_limit: 128m
    cpus: 0.25
    pids_limit: 32
    entrypoint: [nginx]
    command: [-c, /etc/nginx/chatapp/nginx.conf, -g, 'daemon off;']
    volumes:
      - ${fixture}:/etc/nginx/chatapp:ro
    networks:
      application:
        aliases: [closed.chatapp.invalid]
    labels:
      chatapp.production.owner: ${owner}
      chatapp.production.release: ${manifest.APPLICATION_SOURCE_HASH}
  load:
    image: ${K6_IMAGE}
    user: '10001:10001'
    read_only: true
    cap_drop: [ALL]
    security_opt: ['no-new-privileges:true']
    tmpfs: ['/tmp:size=67108864,mode=1777,nosuid,nodev,noexec']
    mem_limit: 512m
    cpus: 0.5
    pids_limit: 128
    networks: [application]
    environment:
      SSL_CERT_FILE: /fixture/cert.pem
      CHATAPP_LOAD_PROFILE: smoke
    volumes:
      - load-fixture:/run/chatapp-load:ro
      - load-fixture:/result
      - ${fixture}/cert.pem:/fixture/cert.pem:ro
    command: [run, --no-usage-report, --log-output, none, /run/chatapp-load/chat.js]
    labels:
      chatapp.production.owner: ${owner}
      chatapp.production.release: ${manifest.APPLICATION_SOURCE_HASH}
volumes:
  load-fixture:
    labels:
      chatapp.production.owner: ${owner}
      chatapp.production.release: ${manifest.APPLICATION_SOURCE_HASH}
`,
    { mode: 0o600 },
  )
  const base = [
    'docker',
    'compose',
    '--env-file',
    join(config, 'compose.env'),
    '-f',
    'infra/compose.prod.yml',
    '-f',
    override,
    '-f',
    loadCompose,
    '--profile',
    'operations',
  ]
  let phase = 'initialize',
    created = false
  const receipt: Record<string, unknown> = {
    format: 1,
    scope: 'isolated-local-production-with-TLS-Garage-offsite-emulation',
    project,
    owner,
    sourceHash: manifest.APPLICATION_SOURCE_HASH,
    applicationSha: manifest.APPLICATION_SHA,
    harnessHash,
    architecture: process.arch,
    phases: [],
  }
  const execute = async (name: string, args: string[], input?: string) => {
    phase = name
    const process = Bun.spawn(args, {
      stdin: input ? 'pipe' : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (input && process.stdin) {
      process.stdin.write(input)
      process.stdin.end()
    }
    const [out, error, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])
    await writeFile(join(root, `${name}.log`), out + '\n' + error, { mode: 0o600 })
    if (code !== 0) {
      for (const line of error.split('\n')) {
        try {
          const diagnostic = JSON.parse(line) as Record<string, unknown>
          if (
            diagnostic.stage === 'garage-preparation' &&
            typeof diagnostic.phase === 'string' &&
            /^(configuration|staging-directory|staging-lock|existing-credentials|key-phase|bucket-phase|save-credentials|GetClusterLayout|GetClusterStatus|UpdateClusterLayout|ApplyClusterLayout|CreateKey|CreateBucket|AllowBucketKey)$/.test(
              diagnostic.phase,
            ) &&
            ['invalid_structure', 'filesystem_access', 'precondition_failed'].includes(
              String(diagnostic.reason),
            )
          ) {
            receipt.operatorFailure = {
              stage: diagnostic.stage,
              phase: diagnostic.phase,
              reason: diagnostic.reason,
            }
            console.error(JSON.stringify(receipt.operatorFailure))
          }
          if (
            diagnostic.stage === 'garage-initialization' &&
            typeof diagnostic.operation === 'string' &&
            /^(GetClusterLayout|GetClusterStatus|UpdateClusterLayout|ApplyClusterLayout|CreateKey|CreateBucket|AllowBucketKey)$/.test(
              diagnostic.operation,
            ) &&
            ['network_or_timeout', 'http_status', 'invalid_json'].includes(
              String(diagnostic.reason),
            )
          ) {
            receipt.operatorFailure = {
              stage: diagnostic.stage,
              operation: diagnostic.operation,
              reason: diagnostic.reason,
              statusCode: Number.isInteger(diagnostic.statusCode) ? diagnostic.statusCode : null,
            }
            console.error(JSON.stringify(receipt.operatorFailure))
          }
        } catch {
          // Raw operator output stays in the private evidence directory.
        }
      }
      if (name !== 'cleanup') {
        const secretValues = (
          await Promise.all(
            ['app.env', 'db.env', 'owner.env', 'valkey.env', 'backup.env'].map(fields),
          )
        ).flatMap((values) =>
          Object.entries(values)
            .filter(
              ([key, value]) => /SECRET|PASSWORD|TOKEN|KEY|URL/.test(key) && value.length >= 8,
            )
            .map(([, value]) => value),
        )
        for (const id of await ownContainers()) {
          const service = (
            await runPrivate([
              'docker',
              'inspect',
              '--format',
              '{{index .Config.Labels "com.docker.compose.service"}}',
              id,
            ])
          ).trim()
          if (!/^[a-z-]+$/.test(service)) throw new Error('diagnostic service rejected')
          const child = Bun.spawn(['docker', 'logs', '--tail', '100', id], {
            stdout: 'pipe',
            stderr: 'pipe',
          })
          const output = (
            await Promise.all([
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ])
          ).join('\n')
          await child.exited
          await writeFile(
            join(root, `diagnostic-${name}-${service}.log`),
            secretValues.reduce(
              (text, value) => text.replaceAll(value, '[redacted-synthetic-secret]'),
              output,
            ),
            { mode: 0o600 },
          )
          const state = await runPrivate(['docker', 'inspect', '--format', '{{json .State}}', id])
          await writeFile(
            join(root, `diagnostic-${name}-${service}-state.json`),
            secretValues.reduce(
              (text, value) => text.replaceAll(value, '[redacted-synthetic-secret]'),
              state,
            ),
            { mode: 0o600 },
          )
        }
      }
      throw new Error(`local production phase failed: ${name}`)
    }
    ;(receipt.phases as string[]).push(name)
    console.log(JSON.stringify({ phase: name, status: 'passed' }))
    return out
  }
  const ownContainers = async () => {
    const ids = (
      await runPrivate([
        'docker',
        'ps',
        '-aq',
        '--filter',
        `label=com.docker.compose.project=${project}`,
      ])
    )
      .trim()
      .split('\n')
      .filter(Boolean)
    for (const id of ids) {
      const label = (
        await runPrivate([
          'docker',
          'inspect',
          '--format',
          '{{index .Config.Labels "chatapp.production.owner"}}',
          id,
        ])
      ).trim()
      if (label !== owner) throw new Error('foreign container; cleanup refused')
    }
    return ids
  }
  try {
    created = true
    await execute('initialize', [...base, 'run', '--rm', '--no-deps', 'initialize'])
    await execute('dependencies', [
      ...base,
      'up',
      '--detach',
      '--wait',
      '--wait-timeout',
      '120',
      'postgres',
      'valkey',
      'garage',
      'media',
    ])
    await execute('offsite', [...base, 'up', '--detach', 'offsite'])
    await execute('offsite-health', [
      ...base,
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'bun',
      'tools',
      '--no-env-file',
      '-e',
      "const r=await fetch('https://offsite:9443/local-fixture-health');if(!r.ok)throw Error('fixture health'); console.log('TLS_fixture_ready')",
    ])
    await execute('private-staging-permissions', [
      ...base,
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '--entrypoint',
      'bun',
      'tools',
      '--no-env-file',
      '-e',
      "import{lstat}from'node:fs/promises';for(const path of ['/var/lib/chatapp/backup','/var/lib/chatapp/restore','/var/lib/chatapp/models']){const s=await lstat(path);if(!s.isDirectory()||(s.mode&0o777)!==0o700||s.uid!==10001||s.gid!==10001)throw Error('private staging ownership or mode changed')}console.log('private_staging_permissions_verified')",
    ])
    const setup = `${project}-storage-setup`
    await execute('storage-initialize', [
      ...base,
      'run',
      '--name',
      setup,
      '--no-deps',
      'tools',
      'storage:init',
    ])
    await execute('storage-copy', [
      'docker',
      'cp',
      `${setup}:/var/lib/chatapp/backup/storage-initialized.json`,
      join(config, 'storage.json'),
    ])
    await chmod(join(config, 'storage.json'), 0o600)
    await installStorageCredentials(config, join(config, 'storage.json'))
    const backup = await fields('backup.env')
    const admin = async (operation: string, input: unknown) => {
      const response = await fetch(`http://127.0.0.1:25191/v2/${operation}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${backup.GARAGE_ADMIN_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error('local offsite fixture creation failed')
      return (await response.json()) as Record<string, string>
    }
    for (const group of ['DELETION_JOURNAL', 'BACKUP']) {
      const key = await admin('CreateKey', { name: `${project}-${group}`, neverExpires: true })
      const bucket = `${group === 'BACKUP' ? 'backups' : 'journal'}-${owner.slice(0, 8)}`
      const createdBucket = await admin('CreateBucket', { globalAlias: bucket })
      await admin('AllowBucketKey', {
        bucketId: createdBucket.id,
        accessKeyId: key.accessKeyId,
        permissions: { read: true, write: true, owner: false },
      })
      await replace(group === 'BACKUP' ? 'backup.env' : 'app.env', {
        [`${group}_S3_ENDPOINT`]: 'https://offsite:9443',
        [`${group}_S3_REGION`]: 'garage',
        [`${group}_S3_BUCKET`]: bucket,
        [`${group}_S3_ACCESS_KEY_ID`]: key.accessKeyId!,
        [`${group}_S3_SECRET_ACCESS_KEY`]: key.secretAccessKey!,
      })
    }
    const ops = ['run', '--rm', '--no-deps', 'tools']
    await execute('migrate', [...base, ...ops, 'migrate'])
    await execute('journal-initialize', [...base, ...ops, 'journal:init'])
    await execute('bootstrap', [
      ...base,
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'bun',
      'tools',
      '--no-env-file',
      '/app/apps/server/src/cli.ts',
      'db:bootstrap',
    ])
    await execute('application', [
      ...base,
      'up',
      '--detach',
      '--wait',
      '--wait-timeout',
      '120',
      'api',
      'worker',
    ])
    phase = 'application-permissions'
    const inspect = await runPrivate(['docker', 'inspect', ...(await ownContainers())])
    const containers = JSON.parse(inspect) as {
      Name: string
      Config: { Env: string[]; User: string; Labels: Record<string, string> }
      HostConfig: {
        ReadonlyRootfs: boolean
        CapDrop: string[]
        NetworkMode: string
        PortBindings: Record<string, { HostIp: string }[]>
      }
      State: { Health?: { Status: string } }
    }[]
    for (const item of containers.filter((c) =>
      ['api', 'worker'].includes(c.Config.Labels['com.docker.compose.service']!),
    )) {
      assert.equal(item.Config.User, '10001:10001')
      assert.equal(item.HostConfig.ReadonlyRootfs, true)
      assert.ok(item.HostConfig.CapDrop.includes('ALL'))
      assert.equal(item.State.Health?.Status, 'healthy')
      assert.ok(
        !item.Config.Env.some((e) =>
          /^(DATABASE_OWNER_URL|BACKUP_S3_|GARAGE_ADMIN_TOKEN|GARAGE_RPC_SECRET|RESTIC_PASSWORD_FILE)=/.test(
            e,
          ),
        ),
      )
      assert.ok(item.Config.Env.includes('DELETION_JOURNAL_ENABLED=true'))
    }
    const media = containers.find((c) => c.Config.Labels['com.docker.compose.service'] === 'media')!
    assert.equal(media.HostConfig.NetworkMode, 'none')
    assert.ok(
      !media.Config.Env.some((e) =>
        /^(S3_|DELETION_JOURNAL_|VAPID_|AI_KEY_|SOCLAAS_|DATABASE_|VALKEY_)/.test(e),
      ),
    )
    assert.equal((await fetch('http://127.0.0.1:25190/api/readyz')).status, 200)
    receipt.applicationIsolation = true
    const privilege = await execute('role-isolation', [
      ...base,
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'bun',
      'tools',
      '--no-env-file',
      '-e',
      "const db=new Bun.SQL(process.env.DATABASE_URL);const [r]=await db`select rolsuper,rolcreaterole,rolcreatedb from pg_roles where rolname=current_user`; if(r.rolsuper||r.rolcreaterole||r.rolcreatedb)throw Error('privileged app'); try{await db`create table unauthorized_probe(i int)`;throw Error('DDL unexpectedly allowed')}catch(e){if(e.errno!=='42501')throw e} await db.close();console.log('least_privilege_passed')",
    ])
    assert.ok(privilege.includes('least_privilege_passed'))
    await execute('backup-initialize', [...base, ...ops, 'backup:init'])
    const benchmarkId = crypto.randomUUID()
    await execute('seed-small-sample', [
      ...base,
      'run',
      '--rm',
      '--no-deps',
      '-e',
      'BENCHMARK_ENABLED=true',
      'tools',
      'benchmark:seed',
      'smoke',
      benchmarkId,
    ])
    await execute('load-fixture', [
      ...base,
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'bun',
      'tools',
      '--no-env-file',
      '-e',
      `import{copyFile,chmod}from'node:fs/promises';await copyFile('/var/lib/chatapp/backup/benchmark-${benchmarkId}/fixture.json','/run/chatapp-load/fixture.json');await copyFile('/fixture/load-script.js','/run/chatapp-load/chat.js');for(const file of ['fixture.json','chat.js'])await chmod('/run/chatapp-load/'+file,0o600);console.log('private_load_fixture_prepared')`,
    ])
    await execute('gateway', [...base, 'up', '--detach', 'gateway'])
    await execute('gateway-readiness', [
      ...base,
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '--entrypoint',
      'bun',
      'tools',
      '--no-env-file',
      '-e',
      "let ready=false;for(let attempt=0;attempt<100;attempt++){try{const r=await fetch('https://closed.chatapp.invalid:9444/api/readyz',{redirect:'error',signal:AbortSignal.timeout(1000)});await r.body?.cancel();if(r.status===200){ready=true;break}}catch{}await Bun.sleep(100)}if(!ready)throw Error('TLS gateway not ready');console.log('TLS_gateway_ready')",
    ])
    const loadName = `${project}-load-smoke`
    let loadFailure: unknown,
      loadFailed = false
    try {
      await execute('load-smoke', [...base, 'run', '--name', loadName, '--no-deps', 'load'])
    } catch (error) {
      loadFailed = true
      loadFailure = error
    }
    // Preserve the fixed-field summary even when k6 rejects a threshold; cleanup must not erase its evidence.
    await ownContainers()
    const loadLabels = JSON.parse(
      await runPrivate(['docker', 'inspect', '--format', '{{json .Config.Labels}}', loadName]),
    ) as Record<string, string>
    if (
      loadLabels['chatapp.production.owner'] !== owner ||
      loadLabels['com.docker.compose.project'] !== project ||
      loadLabels['com.docker.compose.service'] !== 'load' ||
      loadLabels['chatapp.production.release'] !== manifest.APPLICATION_SOURCE_HASH
    )
      throw new Error('load result container ownership mismatch')
    const saved = Bun.spawn(
      ['docker', 'cp', `${loadName}:/result/summary.json`, join(root, 'load-summary.json')],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    await Promise.all([new Response(saved.stdout).text(), new Response(saved.stderr).text()])
    const loadSummarySaved = (await saved.exited) === 0
    receipt.loadSummaryPreserved = loadSummarySaved
    if (loadSummarySaved) await chmod(join(root, 'load-summary.json'), 0o600)
    if (loadFailed) throw loadFailure
    if (!loadSummarySaved) throw new Error('load summary unavailable')
    await ownContainers()
    receipt.loadScope = 'smoke-chat-HTTPS-through-production-Nginx-config-only'
    await execute('fixture-admin', [
      ...base,
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'bun',
      'tools',
      '--no-env-file',
      '-e',
      "const db=new Bun.SQL(process.env.DATABASE_OWNER_URL);await db`update users set role='admin' where id=(select id from users where not is_bot order by id limit 1)`;await db.close();console.log('fixture_administrator_prepared')",
    ])
    await execute('backup-run', [...base, ...ops, 'backup:run'])
    const inventoryLog = await execute('backup-verify', [...base, ...ops, 'backup:verify'])
    const inventory = inventoryLog
      .split('\n')
      .map((line) => {
        try {
          return backupInventoryReceiptSchema.safeParse(JSON.parse(line))
        } catch {
          return null
        }
      })
      .find((item) => item?.success)
    if (
      !inventory?.success ||
      inventory.data.snapshots !== 1 ||
      inventory.data.inventory[0]?.objectCount !== 3
    )
      throw new Error('complete sample inventory required')
    const snapshot = inventory.data.inventory[0].snapshotId
    await execute('backup-maintain', [...base, ...ops, 'backup:maintain'])
    // Redeploy the identical immutable API image; check migrations/bootstrap and the persisted backup again.
    await execute('redeploy', [
      ...base,
      'up',
      '--detach',
      '--force-recreate',
      '--wait',
      '--wait-timeout',
      '120',
      '--no-deps',
      'api',
    ])
    await execute('repeat-migrate', [...base, ...ops, 'migrate'])
    await execute('repeat-bootstrap', [
      ...base,
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'bun',
      'tools',
      '--no-env-file',
      '/app/apps/server/src/cli.ts',
      'db:bootstrap',
    ])
    const rollbackFile = process.argv[3]
    if (rollbackFile) {
      const previous = await privateJson(rollbackFile, releaseManifestSchema, 32 * 1024 * 1024)
      const fullCurrent = await privateJson(file, releaseManifestSchema, 32 * 1024 * 1024)
      const migrationFiles = (source: typeof previous) =>
        source.sourceFiles.filter((item) => item.path.startsWith('packages/db/drizzle/'))
      assert.deepEqual(
        migrationFiles(previous),
        migrationFiles(fullCurrent),
        'rollback requires identical migration schemas',
      )
      if (
        previous.architecture !== process.arch ||
        previous.APPLICATION_SOURCE_HASH === manifest.APPLICATION_SOURCE_HASH
      )
        throw new Error('different, compatible native rollback candidate required')
      const deployBinding = async (
        images: Record<string, string>,
        sourceHash: string,
        name: string,
      ) => {
        const fields: Record<string, string> = { APPLICATION_SOURCE_HASH: sourceHash }
        for (const service of ['server', 'media', 'ops', 'postgres', 'valkey', 'garage']) {
          const image = images[service]
          if (!image) throw new Error('complete rollback images required')
          fields[`${service.toUpperCase()}_IMAGE`] = image
        }
        await ownContainers()
        await replace('compose.env', fields)
        // --no-deps avoids rerunning volume initialization; wait for backing services before applications.
        await execute(`${name}-dependencies`, [
          ...base,
          'up',
          '--detach',
          '--force-recreate',
          '--wait',
          '--wait-timeout',
          '150',
          '--no-deps',
          'postgres',
          'valkey',
          'garage',
          'media',
        ])
        await execute(name, [
          ...base,
          'up',
          '--detach',
          '--force-recreate',
          '--wait',
          '--wait-timeout',
          '150',
          '--no-deps',
          'api',
          'worker',
        ])
        assert.equal((await fetch('http://127.0.0.1:25190/api/readyz')).status, 200)
        await execute(`${name}-verify-data`, [...base, ...ops, 'backup:verify'])
        await execute(`${name}-verify-live-data`, [
          ...base,
          'run',
          '--rm',
          '--no-deps',
          '--entrypoint',
          'bun',
          'tools',
          '--no-env-file',
          '-e',
          "const db=new Bun.SQL(process.env.DATABASE_OWNER_URL);const[r]=await db`select (select count(*) from users where not is_bot) as people,(select count(*) from attachment_objects where status='live') as objects`;if(Number(r.people)!==8||Number(r.objects)!==3)throw Error('rollback lost live data');await db.close();console.log('live_data_retained')",
        ])
      }
      await deployBinding(
        previous.images,
        previous.APPLICATION_SOURCE_HASH,
        'rollback-compatible-candidate',
      )
      await deployBinding(
        manifest.images,
        manifest.APPLICATION_SOURCE_HASH,
        'forward-current-candidate',
      )
      receipt.rollback = {
        previousSourceHash: previous.APPLICATION_SOURCE_HASH,
        forwardSourceHash: manifest.APPLICATION_SOURCE_HASH,
        scope: 'compatible candidates with the same migration schema; data retained',
      }
    }
    await execute('verify-after-redeploy', [...base, ...ops, 'backup:verify'])
    // A new database and bucket in this owned local fixture exercise native import/replay, without claiming device independence.
    const restoreEpoch = crypto.randomUUID(),
      nextWriter = crypto.randomUUID(),
      source = await fields('app.env')
    const ownerFields = await fields('owner.env')
    const restoreOwner = new URL(ownerFields.DATABASE_OWNER_URL ?? '')
    restoreOwner.pathname = '/chatapp_recovered'
    const restoreApp = new URL(source.DATABASE_URL ?? '')
    restoreApp.pathname = '/chatapp_recovered'
    restoreApp.username = 'chatapp_recovered_app'
    restoreApp.password = crypto.randomUUID()
    const bucket = await admin('CreateBucket', { globalAlias: `restore-${owner.slice(0, 8)}` }),
      credentials = await admin('CreateKey', { name: `${project}-restore`, neverExpires: true })
    await admin('AllowBucketKey', {
      bucketId: bucket.id,
      accessKeyId: credentials.accessKeyId,
      permissions: { read: true, write: true, owner: false },
    })
    await writeFile(
      join(config, 'restore.env'),
      Object.entries({
        DATABASE_OWNER_URL: restoreOwner.toString(),
        DATABASE_URL: restoreApp.toString(),
        RESTORE_EPOCH: restoreEpoch,
        DELETION_JOURNAL_WRITER_EPOCH: nextWriter,
        RESTORE_PREVIOUS_WRITER_EPOCH: source.DELETION_JOURNAL_WRITER_EPOCH ?? '',
        RESTORE_MODE: 'isolated',
        S3_BUCKET: `restore-${owner.slice(0, 8)}`,
        S3_ACCESS_KEY_ID: credentials.accessKeyId ?? '',
        S3_SECRET_ACCESS_KEY: credentials.secretAccessKey ?? '',
      })
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n',
      { mode: 0o600 },
    )
    const restoreOverride = join(root, 'compose.restore.yml')
    await writeFile(
      restoreOverride,
      `services:\n  tools:\n    env_file:\n      - path: ${config}/restore.env\n        format: raw\n`,
      { mode: 0o600 },
    )
    const restoreBase = [...base, '-f', restoreOverride]
    await execute('restore-database-create', [
      ...base,
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'bun',
      'tools',
      '--no-env-file',
      '-e',
      "const db=new Bun.SQL(process.env.DATABASE_OWNER_URL);await db`create database chatapp_recovered`;await db.close();console.log('empty_target_prepared')",
    ])
    const download = await execute('restore-download', [
      ...restoreBase,
      ...ops,
      'restore:download',
      snapshot,
    ])
    const parsed = download
      .split('\n')
      .map((line) => {
        try {
          return restoreDownloadReceiptSchema.safeParse(JSON.parse(line))
        } catch {
          return null
        }
      })
      .find((item) => item?.success)
    if (!parsed?.success) throw new Error('verified download receipt required')
    await execute('restore-import', [
      ...restoreBase,
      ...ops,
      'restore:import',
      parsed.data.payload,
      restoreEpoch,
    ])
    await execute('restore-replay', [
      ...restoreBase,
      ...ops,
      'restore:replay',
      parsed.data.payload,
      restoreEpoch,
    ])
    await execute('restore-isolation-proof', [
      ...restoreBase,
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'bun',
      'tools',
      '--no-env-file',
      '-e',
      "const db=new Bun.SQL(process.env.DATABASE_OWNER_URL);const [r]=await db`select (select count(*) from users where not is_bot) as people,(select count(*) from attachment_objects where status='live') as objects,(select count(*) from accounts where password is not null) as passwords,(select count(*) from app_settings where key='restore_state') as fence`; if(Number(r.people)!==8||Number(r.objects)!==3||Number(r.passwords)!==0||Number(r.fence)!==1)throw Error('restore evidence incomplete');await db.close();console.log('isolated_snapshot_and_objects_verified')",
    ])
    const permissionFile = '/var/lib/chatapp/restore/permission-inventory.json',
      approvedFile = '/var/lib/chatapp/restore/permission-approved.json'
    await execute('restore-permissions', [
      ...restoreBase,
      ...ops,
      'restore:permissions',
      restoreEpoch,
      permissionFile,
    ])
    await execute('restore-review-fixture', [
      ...restoreBase,
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'bun',
      'tools',
      '--no-env-file',
      '-e',
      `import {readFile,writeFile}from'node:fs/promises';import{permissionReviewSchema}from'/app/packages/contracts/src/recovery.ts';const db=new Bun.SQL(process.env.DATABASE_OWNER_URL);const [a]=await db\`select id from users where role='admin' and not is_bot\`;if(!a)throw Error('fixture administrator missing');const x=JSON.parse(await readFile('${permissionFile}','utf8'));const review=permissionReviewSchema.parse({...x.review,reviewedBy:'local-fixture',accounts:x.review.accounts.map(row=>({...row,confirmed:row.userId===a.id}))});await writeFile('${approvedFile}',JSON.stringify(review),{mode:0o600,flag:'wx'});await db.close();console.log('fixture_review_prepared')`,
    ])
    await execute('restore-confirm', [...restoreBase, ...ops, 'restore:confirm', approvedFile])
    await execute('restore-fresh-credential-fixture', [
      ...restoreBase,
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'bun',
      'tools',
      '--no-env-file',
      '-e',
      `import{createDatabase}from'/app/packages/db/src/client.ts';import{issueRecoveryCredential}from'/app/apps/server/src/domain/recovery-permissions.ts';import{sdkPasswords}from'/app/apps/server/src/auth/passwords.ts';import{loadConfig}from'/app/apps/server/src/config/index.ts';const config=loadConfig(process.env);const database=createDatabase(config.databaseOwnerUrl);const q=new Bun.SQL(config.databaseOwnerUrl);const [a]=await q\`select id from users where role='admin' and not is_bot\`;await q.close();const deps={db:database.db,clock:{now:()=>new Date()},newId:()=>crypto.randomUUID(),passwords:sdkPasswords,log:{info(){},warn(){},error(){},debug(){}},config:{origin:config.origin,timezone:config.timezone,auth:config.auth,product:config.product}};await issueRecoveryCredential(deps,'${restoreEpoch}',a.id,'Zq9-'+crypto.randomUUID()+crypto.randomUUID());await database.close();console.log('fresh_fixture_credential_issued')`,
    ])
    await execute('restore-unlock', [
      ...restoreBase,
      ...ops,
      'restore:unlock',
      restoreEpoch,
      source.DELETION_JOURNAL_WRITER_EPOCH ?? '',
      nextWriter,
    ])
    await execute('restored-app-role', [
      ...restoreBase,
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'bun',
      'tools',
      '--no-env-file',
      '-e',
      "const db=new Bun.SQL(process.env.DATABASE_URL);const [r]=await db`select (select count(*) from app_settings where key='restore_state') as fence,(select count(*) from users where not is_bot and banned) as denied,(select count(*) from accounts where password is not null) as passwords`;if(Number(r.fence)!==0||Number(r.denied)!==7||Number(r.passwords)!==1)throw Error('permission or role evidence incomplete');await db.close();console.log('restored_app_role_verified')",
    ])
    receipt.nativeRecovery = {
      databaseTarget: 'fresh',
      objects: 3,
      bytes: 12288,
      permissions: 'one confirmed administrator, seven denied',
      deviceIndependence: false,
    }
    assert.equal(
      sha256(await readFile(import.meta.path)),
      harnessHash,
      'test harness changed during execution',
    )
    receipt.harnessUnchanged = true
    receipt.status = 'passed'
  } catch (error) {
    receipt.status = 'failed'
    receipt.failedPhase = phase
    throw error
  } finally {
    const cleanup = async () => {
      if (created) {
        await ownContainers()
        const volumes = (
          await runPrivate([
            'docker',
            'volume',
            'ls',
            '-q',
            '--filter',
            `label=com.docker.compose.project=${project}`,
          ])
        )
          .trim()
          .split('\n')
          .filter(Boolean)
        for (const volume of volumes) {
          const label = (
            await runPrivate([
              'docker',
              'volume',
              'inspect',
              '--format',
              '{{index .Labels "chatapp.production.owner"}}',
              volume,
            ])
          ).trim()
          assert.equal(label, owner)
        }
        if (volumes.some((name) => !name.startsWith(`${project}_`)))
          throw new Error('foreign volume; cleanup refused')
        await execute('cleanup', [...base, 'down', '--volumes', '--remove-orphans'])
        receipt.cleaned =
          (await ownContainers()).length === 0 &&
          !(
            await runPrivate([
              'docker',
              'volume',
              'ls',
              '-q',
              '--filter',
              `label=com.docker.compose.project=${project}`,
            ])
          ).trim()
      }
    }
    await cleanup()
    await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {
      mode: 0o600,
    })
    console.log(
      JSON.stringify({
        status: receipt.status,
        failedPhase: receipt.failedPhase,
        evidence: join(root, 'receipt.json'),
        cleaned: receipt.cleaned,
      }),
    )
  }
}
if (import.meta.main)
  main().catch(() => {
    console.error('isolated production composition failed; inspect its private evidence directory')
    process.exitCode = 1
  })
