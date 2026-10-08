/** A metadata-only, process-safe budget for synthetic paid experiments. Never stores prompts, responses or keys. */
import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  AiBudgetError,
  type AiPrice,
  type AiUsage,
  type PaidAttempt,
  type PaidCallLedger,
  reserveCost,
  usageCost,
} from '../domain/ai-budget.ts'

type AttemptRow = {
  id: string
  status: 'reserved' | 'started' | 'settled' | 'unknown' | 'released'
  reserved_cost: number
  input_bound: number
  output_bound: number
  price: string
  usage: string | null
}
type AccountRow = { limit_micro: number; halted: number }

export class ExperimentLedger implements PaidCallLedger {
  private readonly db: Database
  constructor(path: string, limitMicroUsd: number) {
    if (!Number.isSafeInteger(limitMicroUsd) || limitMicroUsd < 0)
      throw new AiBudgetError('INVALID_AMOUNT')
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new Database(path, { create: true, strict: true })
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK(id=1), limit_micro INTEGER NOT NULL, halted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, label TEXT NOT NULL, model TEXT NOT NULL, price TEXT NOT NULL, input_bound INTEGER NOT NULL, output_bound INTEGER NOT NULL, reserved_cost INTEGER NOT NULL, actual_cost INTEGER, usage TEXT, status TEXT NOT NULL CHECK(status IN ('reserved','started','settled','unknown','released')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    `)
    this.db.query('INSERT OR IGNORE INTO account(id,limit_micro) VALUES (1,?)').run(limitMicroUsd)
    // Raising/changing a prior authorization is explicit; rerunning cannot reset the account or its unknowns.
    if (this.account().limit_micro !== limitMicroUsd) {
      this.db.close()
      throw new AiBudgetError('ATTEMPT_CONFLICT')
    }
  }
  private account(): AccountRow {
    return this.db
      .query<AccountRow, []>('SELECT limit_micro,halted FROM account WHERE id=1')
      .get() as AccountRow
  }
  private row(id: string): AttemptRow {
    const row = this.db.query<AttemptRow, [string]>('SELECT * FROM attempts WHERE id=?').get(id)
    if (!row) throw new AiBudgetError('ATTEMPT_CONFLICT')
    return row
  }
  reserve(attempt: PaidAttempt): void {
    const cost = reserveCost(attempt.price, attempt.inputTokenBound, attempt.maxOutputTokens)
    this.db
      .transaction(() => {
        const account = this.account()
        if (account.halted) throw new AiBudgetError('BUDGET_HALTED')
        const used = this.snapshot().occupiedMicroUsd
        if (cost > account.limit_micro - used) throw new AiBudgetError('BUDGET_EXHAUSTED')
        if (this.db.query('SELECT id FROM attempts WHERE id=?').get(attempt.id))
          throw new AiBudgetError('ATTEMPT_CONFLICT')
        this.db
          .query(
            "INSERT INTO attempts(id,label,model,price,input_bound,output_bound,reserved_cost,status) VALUES (?,?,?,?,?,?,?,'reserved')",
          )
          .run(
            attempt.id,
            attempt.label,
            attempt.model,
            JSON.stringify(attempt.price),
            attempt.inputTokenBound,
            attempt.maxOutputTokens,
            cost,
          )
      })
      .immediate()
  }
  start(id: string): void {
    const result = this.db
      .query("UPDATE attempts SET status='started' WHERE id=? AND status='reserved'")
      .run(id)
    if (result.changes !== 1) throw new AiBudgetError('ATTEMPT_CONFLICT')
  }
  settle(id: string, usage: AiUsage): void {
    this.db
      .transaction(() => {
        const row = this.row(id)
        const text = JSON.stringify(usage)
        if (row.status === 'settled' && row.usage === text) return
        if (row.status !== 'started' && row.status !== 'unknown')
          throw new AiBudgetError('ATTEMPT_CONFLICT')
        const actual = usageCost(JSON.parse(row.price) as AiPrice, usage)
        this.db
          .query("UPDATE attempts SET status='settled', actual_cost=?, usage=? WHERE id=?")
          .run(actual, text, id)
        if (
          actual > row.reserved_cost ||
          usage.inputTokens > row.input_bound ||
          usage.outputTokens > row.output_bound
        )
          this.db.query('UPDATE account SET halted=1 WHERE id=1').run()
      })
      .immediate()
  }
  unknown(id: string): void {
    const row = this.row(id)
    if (row.status === 'settled' || row.status === 'unknown') return
    if (row.status !== 'started') throw new AiBudgetError('ATTEMPT_CONFLICT')
    this.db.query("UPDATE attempts SET status='unknown' WHERE id=? AND status='started'").run(id)
  }
  release(id: string): void {
    const row = this.row(id)
    if (row.status === 'released') return
    if (row.status !== 'reserved' && row.status !== 'started')
      throw new AiBudgetError('ATTEMPT_CONFLICT')
    this.db
      .query(
        "UPDATE attempts SET status='released' WHERE id=? AND status IN ('reserved','started')",
      )
      .run(id)
  }
  snapshot(): {
    limitMicroUsd: number
    settledMicroUsd: number
    reservedMicroUsd: number
    unknownMicroUsd: number
    occupiedMicroUsd: number
    availableMicroUsd: number
    halted: boolean
    attempts: number
  } {
    const rows = this.db
      .query<{ status: string; cost: number; count: number }, []>(
        "SELECT status, SUM(CASE WHEN status='settled' THEN actual_cost WHEN status='released' THEN 0 ELSE reserved_cost END) AS cost, COUNT(*) AS count FROM attempts GROUP BY status",
      )
      .all()
    const cost = (status: string) => rows.find((row) => row.status === status)?.cost ?? 0
    const settledMicroUsd = cost('settled')
    const reservedMicroUsd = cost('reserved') + cost('started')
    const unknownMicroUsd = cost('unknown')
    const occupiedMicroUsd = settledMicroUsd + reservedMicroUsd + unknownMicroUsd
    const account = this.account()
    return {
      limitMicroUsd: account.limit_micro,
      settledMicroUsd,
      reservedMicroUsd,
      unknownMicroUsd,
      occupiedMicroUsd,
      availableMicroUsd: Math.max(0, account.limit_micro - occupiedMicroUsd),
      halted: Boolean(account.halted),
      attempts: rows.reduce((sum, row) => sum + row.count, 0),
    }
  }
  close(): void {
    this.db.close()
  }
}
