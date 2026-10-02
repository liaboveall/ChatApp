/**
 * Colour maths for the prototype's design notes page. The implementation lives in `apps/web/tools/color.ts`, next to the
 * contrast check that uses it (docs/12 D-111, D-114); this file only re-exports what the prototype needs.
 */
export { luminance, mix, over, parse, ratio, toHex } from '../../../apps/web/tools/color.ts'
