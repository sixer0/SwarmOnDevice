import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  HANDOFF_RESULT_FILE_NAME,
  HANDOFF_RESULT_MAX_BYTES,
  PATCH_EXIT_CODES,
  PATCH_EXIT_NAMES,
  PATCH_S11_MAX_CHARS,
  PATCH_S11_NAMED,
} from "./patch-codes"
import { PATCH_SEMVER, PATCH_STATE_ID } from "./patch-common"
import * as handoff from "./swarm-patch-handoff"
import * as result from "./swarm-patch-result"

// Review row 31 M5 (C27): one copy of the shared names, tied to the applier text. The applier is only read as text
// (it stays byte-identical, C16); nothing here runs it.
const APPLIER = readFileSync(join(import.meta.dir, "..", "..", "resources", "swarm-patch", "swarm-patch"), "utf8")

// `typeset -gA SP_CODE` then `SP_CODE=( NAME code NAME code ... )` over one or more lines (applier :25-29).
function applierCodes(text: string) {
  const block = /^SP_CODE=\(([^)]*)\)$/m.exec(text)
  if (!block) throw new Error("SP_CODE table not found in the applier")
  const words = block[1]!.trim().split(/\s+/)
  if (words.length % 2 !== 0) throw new Error("SP_CODE table has an odd number of words")
  const table: Record<number, string> = {}
  for (let i = 0; i < words.length; i += 2) {
    const [name, code] = [words[i]!, words[i + 1]!]
    if (!/^E_[A-Z]+$/.test(name) || !/^(0|[1-9][0-9]{0,2})$/.test(code)) throw new Error(`bad SP_CODE pair ${name} ${code}`)
    if (Number(code) in table) throw new Error(`SP_CODE code ${code} given twice`)
    table[Number(code)] = name
  }
  return table
}

function applierConstant(text: string, name: string) {
  const m = new RegExp(`^typeset -r ${name}='([^']*)'$`, "m").exec(text)
  if (!m) throw new Error(`${name} not found in the applier`)
  return m[1]!
}

describe("patch-codes against the applier", () => {
  test("PATCH_EXIT_NAMES equals the applier SP_CODE table", () => {
    const table = applierCodes(APPLIER)
    expect(Object.keys(table).length).toBeGreaterThanOrEqual(16)
    expect({ ...PATCH_EXIT_NAMES }).toEqual(table)
  })

  test("PATCH_EXIT_CODES is the same table by name", () => {
    for (const [code, name] of Object.entries(PATCH_EXIT_NAMES)) expect(PATCH_EXIT_CODES[name]).toBe(Number(code))
    expect(Object.keys(PATCH_EXIT_CODES).length).toBe(Object.keys(PATCH_EXIT_NAMES).length)
  })

  test("every name the applier passes to sp_die is in the table", () => {
    const used = new Set([...APPLIER.matchAll(/\bsp_die (E_[A-Z]+)\b/g)].map((m) => m[1]!))
    expect(used.size).toBeGreaterThan(0)
    for (const name of used) expect(PATCH_EXIT_CODES[name]).toBeNumber()
  })

  test("state id and semver rule equal the applier constants", () => {
    expect(PATCH_STATE_ID).toBe(applierConstant(APPLIER, "SP_STATE_ID"))
    expect(PATCH_SEMVER.source).toBe(applierConstant(APPLIER, "SP_RE_SEMVER"))
  })

  test("the parser rejects a malformed table", () => {
    expect(() => applierCodes("SP_CODE=(\n  E_OK 0 E_USAGE\n)\n")).toThrow()
    expect(() => applierCodes("SP_CODE=(\n  E_OK 0 E_X 0\n)\n")).toThrow()
    expect(() => applierCodes("nothing here\n")).toThrow()
  })
})

describe("one copy only", () => {
  test("patch-common and patch-update-flow take the table from patch-codes", () => {
    for (const file of ["patch-common.ts", "patch-update-flow.ts"]) {
      const text = readFileSync(join(import.meta.dir, file), "utf8")
      expect({ file, defines: /PATCH_EXIT_NAMES *[:=]/.test(text.replace(/^import[\s\S]*?from .*$/gm, "")) }).toEqual({ file, defines: false })
    }
  })

  test("handoff and result re-export the shared constants", () => {
    expect(handoff.HANDOFF_RESULT_MAX_BYTES).toBe(HANDOFF_RESULT_MAX_BYTES)
    expect(result.HANDOFF_RESULT_MAX_BYTES).toBe(HANDOFF_RESULT_MAX_BYTES)
    expect(result.HANDOFF_RESULT_FILE_NAME).toBe(HANDOFF_RESULT_FILE_NAME)
    expect(handoff.handoffResultFile("/u")).toBe(`/u/${HANDOFF_RESULT_FILE_NAME}`)
    expect(HANDOFF_RESULT_FILE_NAME).toBe("swarm-patch-result") // BN-64
    expect(HANDOFF_RESULT_MAX_BYTES).toBe(16384) // BN-65
  })

  test("no owned module defines its own copy", () => {
    for (const file of ["swarm-patch-handoff.ts", "swarm-patch-result.ts"]) {
      const text = readFileSync(join(import.meta.dir, file), "utf8")
      expect({ file, hits: text.match(/"E_RECOVER"|= 16384|"swarm-patch-result"|"id\.co\.gsp\.swarm\.patch"/g) }).toEqual({
        file,
        hits: null,
      })
    }
  })

  test("S11 rule: captured name, printable ASCII, at most PATCH_S11_MAX_CHARS", () => {
    expect(PATCH_S11_NAMED.exec("swarm-patch: E_HASH: x")?.[1]).toBe("E_HASH")
    expect(PATCH_S11_NAMED.test(`swarm-patch: E_HASH: ${"x".repeat(PATCH_S11_MAX_CHARS)}`)).toBe(true)
    expect(PATCH_S11_NAMED.test(`swarm-patch: E_HASH: ${"x".repeat(PATCH_S11_MAX_CHARS + 1)}`)).toBe(false)
    expect(PATCH_S11_NAMED.test("swarm-patch: E_HASH: ü")).toBe(false)
  })
})
