import { z } from 'zod'

/**
 * Zod 4 normally compiles its parsers with `new Function`, after probing whether that is allowed. The page's CSP forbids
 * `unsafe-eval` (docs/07 SEC-06), and even the probe is reported as a violation, so the compiled mode is switched off
 * before the first parse. Validation here is small forms and short JSON; the interpreted parser is plenty fast.
 */
z.config({ jitless: true })
