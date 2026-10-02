/**
 * Design tokens for the prototype. Since M1b the single source of truth is `apps/web/src/design/tokens.ts` (docs/12
 * D-111, D-114); this file only re-exports it, so the prototype keeps building from the same data. Change a value in
 * the TypeScript file and run `bun run design:contrast`, never here.
 *
 * `fontStacks` keeps the shape the prototype's review bar expects: the product stack, and the pre-D4 system stack that
 * the font comparison switch can still put back.
 */
import { fontStacks as productStacks } from '../../../apps/web/src/design/tokens.ts'

export * from '../../../apps/web/src/design/tokens.ts'

export const fontStacks = {
  // The stack the spec had before D4. It stays only for the comparison switch (data-font="system").
  system:
    'system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Noto Sans SC", sans-serif',
  inter: productStacks.sans,
  mono: productStacks.mono,
}
