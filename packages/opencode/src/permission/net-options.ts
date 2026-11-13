// Swarm 1.2.7 row 47f (M1-08, decision C75): ONE table of the curl and wget options that take a value, read by both the
// outward-consent reader (`outward-consent.ts`, which opens only the options it also knows the meaning of) and the own-API
// address reader (F-4, `autonomy-table.ts`, which skips each value to find the addresses). Two copies had drifted: an
// option missing from one became a parse difference between the outward and the own_api verdicts.

/** curl's short options that take a value; `K` is a config file, `x` a proxy. */
const CURL_VALUE_SHORT: ReadonlySet<string> = new Set("AbcCdDeEFHKmoPQrtTuUwxXyYz".split(""))
/** curl's long options whose value is an address. */
const CURL_ADDRESS_LONG: ReadonlySet<string> = new Set([
  "--url", "--proxy", "--preproxy", "--doh-url", "--connect-to", "--resolve", "--socks4", "--socks4a", "--socks5",
  "--socks5-hostname",
])
/** curl's long options that take a value. */
const CURL_VALUE_LONG: ReadonlySet<string> = new Set([
  "--config", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json", "--header", "--proxy-header",
  "--user", "--user-agent", "--output", "--output-dir", "--request", "--cookie", "--cookie-jar", "--referer", "--form",
  "--form-string", "--write-out", "--max-time", "--connect-timeout", "--retry", "--retry-delay", "--retry-max-time", "--range",
  "--upload-file", "--cacert", "--capath", "--cert", "--key", "--cert-type", "--key-type", "--proxy-user", "--oauth2-bearer",
  "--limit-rate", "--max-filesize", "--dump-header", "--trace", "--trace-ascii", "--stderr", "--interface", "--dns-servers",
  "--unix-socket", "--abstract-unix-socket", "--aws-sigv4", "--variable", "--url-query", "--time-cond", "--continue-at",
  "--speed-limit", "--speed-time", "--local-port", "--keepalive-time", "--max-redirs", "--expect100-timeout", "--pass",
  "--ciphers", "--crlfile", "--pinnedpubkey", "--quote", "--telnet-option", "--create-file-mode", "--happy-eyeballs-timeout-ms",
  // 47f: in the outward reader's list only before the merge; each names a file curl writes.
  "--libcurl", "--etag-save",
  ...CURL_ADDRESS_LONG,
])
/** wget's short options that take a value; `i` is a URL list read at run time, `e` a `.wgetrc` command. */
const WGET_VALUE_SHORT: ReadonlySet<string> = new Set("OoaiBtTwePUQlARDXI".split(""))
/** wget's long options that take a value. */
const WGET_VALUE_LONG: ReadonlySet<string> = new Set([
  "--output-document", "--output-file", "--append-output", "--input-file", "--base", "--tries", "--timeout", "--wait",
  "--execute", "--directory-prefix", "--user-agent", "--quota", "--level", "--accept", "--reject", "--domains", "--header",
  "--user", "--password", "--http-user", "--http-password", "--post-data", "--post-file", "--body-data", "--body-file",
  "--method", "--config", "--load-cookies", "--save-cookies", "--referer", "--ca-certificate", "--certificate", "--private-key",
  "--limit-rate", "--bind-address", "--read-timeout", "--connect-timeout", "--dns-timeout", "--waitretry",
  // 47f: in the outward reader's list only before the merge.
  "--max-redirect",
])

/** One program's value-taking options: short letters and long names. */
export type ValueTable = { readonly short: ReadonlySet<string>; readonly long: ReadonlySet<string> }

export const CURL: ValueTable & { readonly address: ReadonlySet<string> } = {
  short: CURL_VALUE_SHORT,
  long: CURL_VALUE_LONG,
  address: CURL_ADDRESS_LONG,
}
export const WGET: ValueTable = { short: WGET_VALUE_SHORT, long: WGET_VALUE_LONG }

/** Whether `option` (`-X` or `--name`) takes a value in `table`. */
export function takesValue(table: ValueTable, option: string) {
  if (option.startsWith("--")) return table.long.has(option)
  return option.length === 2 && option.startsWith("-") && table.short.has(option[1]!)
}

export * as NetOptions from "./net-options"
