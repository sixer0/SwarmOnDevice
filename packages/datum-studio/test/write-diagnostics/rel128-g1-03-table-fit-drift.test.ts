// Swarm 1.2.8 row 34d (G1-03): the write-time overflow estimate (write-content.ts) shares its constants with
// the renderers' table-fit instead of keeping hand copies. CHAR/VERIFY: pass at BASE too is NOT expected for the
// import checks (BASE had literals); the value pins pass at both.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { COLUMN_GAP_MM, TABLE_NUMERALS_PT_DEFAULT, TEXT_PT } from "../../vendor/src/lib/studio/engine/table-fit"
import { NUMERAL_CELL } from "../../vendor/scripts/studio/mcp/write-content"

const MCP = path.resolve(import.meta.dir, "..", "..", "vendor", "scripts", "studio", "mcp")
const src = (f: string) => readFileSync(path.join(MCP, f), "utf8")

describe("G1-03 table-fit constants are shared, not copied", () => {
  test("table-fit values (a change here is a deliberate change of the estimate too)", () => {
    expect(TEXT_PT).toBe(7.5)
    expect(COLUMN_GAP_MM).toBe(2.5)
    expect(TABLE_NUMERALS_PT_DEFAULT).toBe(7.8)
  })
  test("write-content takes the three constants from table-fit, no numeric literal copy", () => {
    const c = src("write-content.ts")
    expect(/const LIKELY_TEXT_PT = TEXT_PT;/.test(c)).toBe(true)
    expect(/const LIKELY_MONO_PT = TABLE_NUMERALS_PT_DEFAULT;/.test(c)).toBe(true)
    expect(/const LIKELY_GAP_MM = COLUMN_GAP_MM;/.test(c)).toBe(true)
  })
  test("write-client NUMERAL is the same regex object as write-content's", () => {
    expect(/const NUMERAL = NUMERAL_CELL;/.test(src("write-client.ts"))).toBe(true)
    expect(NUMERAL_CELL.test("1.234,5 %")).toBe(true)
    expect(NUMERAL_CELL.test("abc")).toBe(false)
  })
})
