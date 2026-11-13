// Swarm 1.2.8 row 27 (AC-R2, R-2, N8-311, N8-201): the outward-consent reader and the own-API reader (F-4) read httpie and
// xh with ONE value-option table, `NetOptions.HTTPIE`, as 1.2.7 row 47f made them read curl and wget. Pinned by identity:
// a second copy makes these fail. Pure: nothing runs, no file is touched.
import { describe, expect, test } from "bun:test"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { NetOptions } from "../../src/permission/net-options"
import { OutwardConsent } from "../../src/permission/outward-consent"

// Every value-taking option of the two copies before the merge: the own-API copy (`HTTPIE_VALUE`, autonomy-table.ts:1156
// at BASE) and the outward copy (`HTTPIE_VALUES`/`HTTPIE_TAKES`, outward-consent.ts:443-448 at BASE).
const OWN_API_COPY = [
  "-a", "--auth", "-A", "--auth-type", "--session", "--session-read-only", "-o", "--output", "--verify", "--cert",
  "--cert-key", "--proxy", "--timeout", "-p", "--print", "-s", "--style", "--pretty", "--format-options", "--boundary",
  "--max-redirects", "--raw",
]
const OUTWARD_COPY = [
  "-p", "--print", "-a", "--auth", "-A", "--auth-type", "--timeout", "--pretty", "-s", "--style", "--verify",
  "--max-redirects", "--bearer", "-o", "--output",
]

describe("R-2: one httpie/xh option table", () => {
  test("the outward reader and the own-API reader use the same table object", () => {
    expect(NetOptions.HTTPIE).toBeDefined()
    expect(OutwardConsent.netOptions.httpie).toBe(NetOptions.HTTPIE)
    expect(AutonomyTable.netOptions.httpie).toBe(NetOptions.HTTPIE)
  })

  test("every option either copy knew takes a value in the shared table", () => {
    for (const option of [...OWN_API_COPY, ...OUTWARD_COPY])
      expect({ option, takes: NetOptions.takesValue(NetOptions.HTTPIE, option) }).toEqual({ option, takes: true })
  })

  test("flags still take no value", () => {
    for (const option of ["-v", "--verbose", "-h", "--headers", "-b", "--body", "-f", "--form", "-j", "--json", "-F", "--follow", "-I", "--ignore-stdin", "-q", "--check-status", "--offline", "--download", "-d"])
      expect({ option, takes: NetOptions.takesValue(NetOptions.HTTPIE, option) }).toEqual({ option, takes: false })
  })

  test("the curl and wget tables are unchanged objects beside it", () => {
    expect(OutwardConsent.netOptions.curl).toBe(NetOptions.CURL)
    expect(AutonomyTable.netOptions.wget).toBe(NetOptions.WGET)
  })
})
