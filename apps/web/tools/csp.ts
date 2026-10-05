/**
 * The page's Content Security Policy and companion headers (docs/07 SEC-06, SEC-22). The production Nginx site
 * (`infra/nginx/security-headers.conf`, compared with this file by a unit test) sends the same values; `vite preview` sends them during end-to-end tests, so the app is exercised under the real
 * policy. Nothing here is a development convenience: if a feature needs a looser policy, the feature changes.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  // Trusted Types (D-146): every string-to-HTML sink refuses plain strings, and no policy may be created, so a bug that
  // would write user text as markup throws instead of running. The one dependency that wrote entities through
  // that dependency is replaced at build time (see `entitiesTable` in vite.config.ts).
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ')

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
}
