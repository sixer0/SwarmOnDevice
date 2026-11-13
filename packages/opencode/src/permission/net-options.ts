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

// 1.2.8 row 27 (R-2, N8-201): httpie's and xh's options that take a value, ONE table for the outward reader and the own-API
// reader, as curl's and wget's are. Before the merge the own-API copy lacked `--bearer` and the outward copy lacked the
// session, certificate, proxy and format options; each option either copy knew takes a value here. `--proxy` is
// `scheme:url`. The outward reader still opens only the options it knows the meaning of (`HTTPIE_VALUES` there).
/** httpie's and xh's short options that take a value. */
const HTTPIE_VALUE_SHORT: ReadonlySet<string> = new Set("paAso".split(""))
/** httpie's and xh's long options that take a value. */
const HTTPIE_VALUE_LONG: ReadonlySet<string> = new Set([
  "--auth", "--auth-type", "--bearer", "--session", "--session-read-only", "--output", "--verify", "--cert", "--cert-key",
  "--proxy", "--timeout", "--print", "--style", "--pretty", "--format-options", "--boundary", "--max-redirects", "--raw",
])
export const HTTPIE: ValueTable = { short: HTTPIE_VALUE_SHORT, long: HTTPIE_VALUE_LONG }

/**
 * 1.2.8 row 28 (H-U10, N8-388, SR8-02, C13): the only options an own-server call may carry to be class A `own_api_read`
 * under consent. A positive list on purpose: every option not here (one that writes a file, sends a body, changes the
 * method or the target, adds a second request) keeps the call's 1.2.7 verdict, so a new option is never let through by
 * default. curl: `flags` take no value (`-G` is only ever "GET" here, since no data option is on the list), `values` take
 * one (`-H` a header, checked again for a method override, a header file and the directory headers). httpie/xh: no option
 * at all, an optional method of `methods`, one URL, and items of the two forms in `items` (`a==b` query, `a:b` header).
 * The list may shrink in review; it never grows without a security re-review (01_specs §3.3 rule 1).
 */
export const OWN_API_READ_OPTIONS = {
  curl: {
    flags: ["-s", "-S", "-f", "-i", "-I", "-v", "-G", "--compressed"],
    values: ["-m", "--max-time", "--connect-timeout", "-H"],
  },
  httpie: { methods: ["GET", "HEAD"], items: ["a==b", "a:b"] },
} as const

/** Whether `option` (`-X` or `--name`) takes a value in `table`. */
export function takesValue(table: ValueTable, option: string) {
  if (option.startsWith("--")) return table.long.has(option)
  return option.length === 2 && option.startsWith("-") && table.short.has(option[1]!)
}

export * as NetOptions from "./net-options"
