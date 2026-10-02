/**
 * The address to return to after signing in (`?redirect=`). Only paths inside this site are followed; anything that could
 * leave it (`//host`, `https://...`, backslashes) is dropped, so a crafted link cannot turn the sign-in page into an
 * open redirect.
 */
export function safeRedirect(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!/^\/(?!\/)[^\s\\]*$/.test(value)) return undefined
  return value
}
