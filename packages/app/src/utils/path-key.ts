export type PathKey = string & { _brand: "PathKey" }

const isDrive = (value: string) => {
  if (value.length !== 2) return false
  const code = value.charCodeAt(0)
  return value[1] === ":" && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122))
}

const trimTrailingSlashes = (value: string) => {
  for (let i = value.length - 1; i >= 0; i--) {
    if (value[i] !== "/") return value.slice(0, i + 1)
  }
  return ""
}

const isWindowsPath = (value: string) => value[1] === ":" || value.startsWith("\\\\")

export const pathKey = (path: string) => {
  const value = isWindowsPath(path) ? path.replaceAll("\\", "/") : path
  const trimmed = trimTrailingSlashes(value)
  if (!trimmed && value.startsWith("/")) return "/" as PathKey
  if (isDrive(trimmed)) return `${trimmed}/` as PathKey
  return trimmed as PathKey
}

// macOS serves /etc, /var and /tmp as symlinks into /private, so the server's realpath'd
// spelling ("/private/var/…") and a client-stored short spelling ("/var/…") name one
// directory yet produce two different pathKeys. Equality comparisons between a client-stored
// path and a server-reported path must fold both spellings onto one canonical key first
// (proven causal by the row-161 experiment on $TMPDIR paths).
//
// This is deliberately a separate export, not a change to pathKey itself: pathKey also
// mints persisted localStorage storage names (utils/persist.ts) and query-cache keys, where
// silently changing the output would orphan existing user data. Folding is lexical and
// scoped to the three system links — it cannot see user-made symlinks (no filesystem
// access in the browser), and "/private/<other>" is left untouched so two genuinely
// distinct directories are never merged.
const privateSystemLinks = ["/etc", "/var", "/tmp"] as const

export const canonicalPathKey = (path: string): PathKey => {
  const key = pathKey(path)
  if (!key.startsWith("/private/")) return key
  const target = privateSystemLinks.find(
    (link) => key === `/private${link}` || key.startsWith(`/private${link}/`),
  )
  if (!target) return key
  return `${target}${key.slice(`/private${target}`.length)}` as PathKey
}
