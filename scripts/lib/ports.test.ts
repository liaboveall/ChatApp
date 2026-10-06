import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_POSTGRES_PORT,
  DEFAULT_VALKEY_PORT,
  infraPorts,
  parseComposePs,
  parseDynamicRange,
  parseExcludedRanges,
  portOf,
  publishedProblems,
  reachable,
  reservedProblems,
  suggestPort,
  urlProblems,
  type WindowsPorts,
  waitReachable,
  withPort,
} from './ports.ts'

// What `netsh.exe` answered on the development machine (Chinese system), and the same lists as an English one prints them.
const EXCLUDED_ZH = `
协议 tcp 端口排除范围

开始端口    结束端口
----------    --------
      1145        1244
      3777        3876
      5433        5532
      8251        8350
     28385       28385
     50000       50059     *

* - 管理的端口排除。
`
const EXCLUDED_EN = `
Protocol tcp Port Exclusion Ranges

Start Port    End Port
----------    --------
      5433        5532

* - Administered port exclusions.
`
const DYNAMIC_ZH = `
协议 tcp 动态端口范围
---------------------------------
启动端口        : 1024
端口数          : 13977
`
const DYNAMIC_EN = `
Protocol tcp Dynamic Port Range
---------------------------------
Start Port      : 49152
Number of Ports : 16384
`

const windows = (): WindowsPorts => ({
  excluded: parseExcludedRanges(EXCLUDED_ZH),
  dynamic: parseDynamicRange(DYNAMIC_ZH),
})

describe('what Windows reserves', () => {
  test('the excluded ranges are read in either language, administered ones too', () => {
    expect(parseExcludedRanges(EXCLUDED_ZH)).toEqual([
      { start: 1145, end: 1244 },
      { start: 3777, end: 3876 },
      { start: 5433, end: 5532 },
      { start: 8251, end: 8350 },
      { start: 28385, end: 28385 },
      { start: 50000, end: 50059 },
    ])
    expect(parseExcludedRanges(EXCLUDED_EN)).toEqual([{ start: 5433, end: 5532 }])
    expect(parseExcludedRanges('')).toEqual([])
  })

  test('the dynamic range is a start and a count', () => {
    expect(parseDynamicRange(DYNAMIC_ZH)).toEqual({ start: 1024, end: 15000 })
    expect(parseDynamicRange(DYNAMIC_EN)).toEqual({ start: 49152, end: 65535 })
    expect(parseDynamicRange('nothing here')).toBeNull()
  })
})

describe('a port to move to', () => {
  test('is above the dynamic range and outside every excluded range, and none of the ports in use', () => {
    expect(suggestPort(25434, windows(), [])).toBe(25434)
    expect(suggestPort(5434, windows(), [])).toBe(15001)
    expect(suggestPort(28385, windows(), [])).toBe(28386)
    expect(suggestPort(25434, windows(), [25434, 25435])).toBe(25436)
  })

  test('is the first one asked for when nothing is known about Windows', () => {
    expect(suggestPort(25434, null, [])).toBe(25434)
    expect(suggestPort(25434, null, [25434])).toBe(25435)
  })
})

describe('the ports of the infrastructure', () => {
  test('come from .env.local, and a missing value has the compose default', () => {
    const plan = infraPorts(
      (key) => ({ SMTP_PORT: '12525', POSTGRES_PORT: '31000' })[key as 'SMTP_PORT'],
    )
    expect(plan.map((entry) => [entry.name, entry.port])).toEqual([
      ['POSTGRES_PORT', 31000],
      ['VALKEY_PORT', DEFAULT_VALKEY_PORT],
      ['Garage S3', 3900],
      ['Garage admin', 3903],
      ['SMTP_PORT', 12525],
      ['Mailpit web', 8025],
    ])
  })

  test('a value that is not a port is ignored', () => {
    expect(infraPorts(() => 'abc').find((entry) => entry.name === 'POSTGRES_PORT')?.port).toBe(
      DEFAULT_POSTGRES_PORT,
    )
  })

  test('the defaults of .env.example and of the compose file are the same', () => {
    const example = readFileSync('.env.example', 'utf8')
    const compose = readFileSync('infra/compose.dev.yml', 'utf8')
    expect(example).toContain(`POSTGRES_PORT=${DEFAULT_POSTGRES_PORT}`)
    expect(example).toContain(`VALKEY_PORT=${DEFAULT_VALKEY_PORT}`)
    expect(compose).toContain(`\${POSTGRES_PORT:-${DEFAULT_POSTGRES_PORT}}:5432`)
    expect(compose).toContain(`\${VALKEY_PORT:-${DEFAULT_VALKEY_PORT}}:6379`)
    // The Valkey URLs of the template carry the default too (the Postgres ones are generated from the variable).
    expect(example).toContain(`VALKEY_URL=redis://localhost:${DEFAULT_VALKEY_PORT}/0`)
    expect(example).toContain(`VALKEY_URL_TEST=redis://localhost:${DEFAULT_VALKEY_PORT}/1`)
  })
})

describe('a port Windows has reserved', () => {
  test('is named with the variable, the range, and a port to move to that nothing reserves', () => {
    const plan = infraPorts((key) => (key === 'POSTGRES_PORT' ? '5434' : undefined))
    const problems = reservedProblems(plan, windows())
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('host port 5434 (POSTGRES_PORT)')
    expect(problems[0]).toContain('5433-5532')
    expect(problems[0]).toContain('Set POSTGRES_PORT=25434 in .env.local')
    expect(problems[0]).toContain('bun run setup')
  })

  test('the advice skips a default that is reserved too', () => {
    const blocked: WindowsPorts = {
      excluded: [{ start: 25400, end: 25499 }],
      dynamic: windows().dynamic,
    }
    const problems = reservedProblems(
      infraPorts((key) => (key === 'POSTGRES_PORT' ? '25434' : undefined)),
      blocked,
    )
    expect(problems[0]).toContain('Set POSTGRES_PORT=25500 in .env.local')
  })

  test('one that .env.local cannot move says where it is fixed', () => {
    const only = { excluded: [{ start: 3877, end: 3976 }], dynamic: null }
    const problems = reservedProblems(
      infraPorts(() => undefined),
      { ...only, excluded: [{ start: 3900, end: 3999 }] },
    )
    expect(problems.join('\n')).toContain('Garage S3')
    expect(problems.join('\n')).toContain('infra/compose.dev.yml (and S3_ENDPOINT)')
  })

  test('is nothing to say when no range is known or none is hit', () => {
    const plan = infraPorts(() => undefined)
    expect(reservedProblems(plan, null)).toEqual([])
    expect(reservedProblems(plan, windows())).toEqual([])
  })
})

describe('the ports inside the connection URLs', () => {
  test('are read and replaced without touching the rest of the URL', () => {
    expect(portOf('postgres://chatapp_app:secret@localhost:5434/chatapp')).toBe(5434)
    expect(portOf('redis://localhost:6379/1')).toBe(6379)
    expect(portOf('not a url')).toBeUndefined()
    expect(withPort('postgres://chatapp_app:secret@localhost:5434/chatapp', 25434)).toBe(
      'postgres://chatapp_app:secret@localhost:25434/chatapp',
    )
    expect(withPort('redis://localhost:6379/1', 26379)).toBe('redis://localhost:26379/1')
  })

  test('the same port gives the same URL back', () => {
    for (const url of [
      'postgres://chatapp:0123456789abcdef@localhost:25434/chatapp_test',
      'redis://localhost:26379/0',
    ]) {
      expect(withPort(url, portOf(url) ?? 0)).toBe(url)
    }
  })

  test('one that disagrees with its variable is reported with what to run', () => {
    const values: Record<string, string> = {
      POSTGRES_PORT: '25434',
      VALKEY_PORT: '26379',
      DATABASE_URL: 'postgres://u:p@localhost:5434/chatapp',
      DATABASE_URL_TEST: 'postgres://u:p@localhost:25434/chatapp_test',
      VALKEY_URL: 'redis://localhost:6379/0',
    }
    const problems = urlProblems(
      (key) => values[key],
      infraPorts((key) => values[key]),
    )
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('DATABASE_URL uses port 5434 but POSTGRES_PORT is 25434')
    expect(problems[1]).toContain('VALKEY_URL uses port 6379 but VALKEY_PORT is 26379')
    expect(problems[0]).toContain('bun run setup')
  })

  test('the URLs of one variable that agree with each other are said once', () => {
    const values: Record<string, string> = {
      POSTGRES_PORT: '25434',
      DATABASE_OWNER_URL: 'postgres://u:p@localhost:5434/chatapp',
      DATABASE_OWNER_URL_TEST: 'postgres://u:p@localhost:5434/chatapp_test',
      DATABASE_URL: 'postgres://u:p@localhost:5434/chatapp',
      DATABASE_URL_TEST: 'postgres://u:p@localhost:5434/chatapp_test',
    }
    const problems = urlProblems(
      (key) => values[key],
      infraPorts((key) => values[key]),
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(
      'DATABASE_OWNER_URL, DATABASE_OWNER_URL_TEST, DATABASE_URL, DATABASE_URL_TEST use port 5434 but POSTGRES_PORT is 25434',
    )
  })
})

describe('what compose says is published', () => {
  const plan = infraPorts(() => undefined).filter((entry) => entry.service === 'postgres')
  const row = (publishers: unknown) => ({
    Service: 'postgres',
    State: 'running',
    Publishers: publishers,
  })

  test('rows come as a JSON array or as one object per line', () => {
    expect(
      parseComposePs('[{"Service":"a"},{"Service":"b"}]').map((entry) => entry.Service),
    ).toEqual(['a', 'b'])
    expect(
      parseComposePs('{"Service":"a"}\n{"Service":"b"}\n').map((entry) => entry.Service),
    ).toEqual(['a', 'b'])
    expect(parseComposePs('')).toEqual([])
  })

  test('a published port is fine', () => {
    const rows = [
      row([{ URL: '127.0.0.1', TargetPort: 5432, PublishedPort: DEFAULT_POSTGRES_PORT }]),
    ]
    expect(publishedProblems(rows as never, plan)).toEqual([])
  })

  test('a running service whose port is not there is reported, whichever way compose shows that', () => {
    for (const publishers of [[], null, [{ URL: '', TargetPort: 5432, PublishedPort: 0 }]]) {
      const problems = publishedProblems([row(publishers)] as never, plan)
      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain(
        `host port ${DEFAULT_POSTGRES_PORT} (POSTGRES_PORT) is not published`,
      )
      expect(problems[0]).toContain('excludedportrange')
    }
  })

  test('a port published elsewhere than the variable says is reported with what to run', () => {
    const problems = publishedProblems(
      [row([{ URL: '127.0.0.1', TargetPort: 5432, PublishedPort: 5434 }])] as never,
      plan,
    )
    expect(problems[0]).toContain('publishes host port 5434 but POSTGRES_PORT says 25434')
  })

  test('a service that is not running, or an engine that does not say, is not judged here', () => {
    expect(
      publishedProblems([{ Service: 'postgres', State: 'exited', Publishers: [] }] as never, plan),
    ).toEqual([])
    expect(publishedProblems([{ Service: 'postgres', State: 'running' }] as never, plan)).toEqual(
      [],
    )
    expect(publishedProblems([], plan)).toEqual([])
  })
})

describe('whether anything answers', () => {
  test('a listener does, and nothing does once it has stopped', async () => {
    const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    const port = listener.port
    expect(await reachable(port)).toBe(true)
    expect(await waitReachable(port, 500)).toBe(true)
    listener.stop(true)
    expect(await reachable(port, 500)).toBe(false)
    const started = Date.now()
    expect(await waitReachable(port, 700)).toBe(false)
    expect(Date.now() - started).toBeGreaterThanOrEqual(600)
  })
})
