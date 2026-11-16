import { describe, expect, test } from "bun:test"
import { EXCEL_NUMBER_PATTERN } from "../constants"
import {
  address,
  completeWrite,
  convertCell,
  isExactNumber,
  isFormulaLeading,
  isNumberCell,
  prepareWrite,
  replyToMatrix,
  valuesToTsv,
  valueToField,
  type Prepared,
  type WritePlan,
} from "./index"

function prepared(result: ReturnType<typeof prepareWrite>): Prepared {
  if (!result.ok) throw new Error(`expected a target, got ${result.refusal.code}`)
  return result
}

function plan(result: ReturnType<typeof completeWrite>): WritePlan {
  if (!result.ok) throw new Error(`expected a plan, got ${result.refusal.code}`)
  return result
}

const empty = (rows: number, columns: number) => Array.from({ length: rows }, () => Array<string>(columns).fill(""))

describe("U-XL-01 FR-10.1 value to string", () => {
  test("strings, numbers, booleans, errors, empty", () => {
    expect(valueToField("abc")).toBe("abc")
    expect(valueToField(42)).toBe("42")
    expect(valueToField(-12.5)).toBe("-12.5")
    expect(valueToField(0.1 + 0.2)).toBe("0.30000000000000004")
    expect(valueToField(1e21)).toBe("1e+21")
    expect(valueToField(45000)).toBe("45000")
    expect(valueToField(true)).toBe("TRUE")
    expect(valueToField(false)).toBe("FALSE")
    expect(valueToField("#N/A")).toBe("#N/A")
    expect(valueToField("#DIV/0!")).toBe("#DIV/0!")
    expect(valueToField("")).toBe("")
    expect(valueToField(null)).toBe("")
    expect(valueToField(undefined)).toBe("")
  })
})

describe("U-XL-02 FR-10.2 line breaks and tabs inside a cell", () => {
  test("each CRLF, CR, LF and tab becomes one space", () => {
    expect(valueToField("a\r\nb")).toBe("a b")
    expect(valueToField("a\rb")).toBe("a b")
    expect(valueToField("a\nb")).toBe("a b")
    expect(valueToField("a\tb")).toBe("a b")
    expect(valueToField("left\tright\nsecond line")).toBe("left right second line")
    expect(valueToField("a\r\n\r\nb")).toBe("a  b")
  })

  test("the TSV stays rectangular (AC-21 fixture)", () => {
    const tsv = valuesToTsv([
      ["num", "bool", "empty", "err", "mixed"],
      [42, true, "", "#DIV/0!", "left\tright\r\nsecond line"],
    ])
    expect(tsv).toBe("num\tbool\tempty\terr\tmixed\n42\tTRUE\t\t#DIV/0!\tleft right second line")
    expect(tsv.split("\n").map((line) => line.split("\t").length)).toEqual([5, 5])
  })
})

describe("U-XL-03 FR-10.3 joining", () => {
  test("1x1, 1xN, Nx1, no header, no trailing newline", () => {
    expect(valuesToTsv([["x"]])).toBe("x")
    expect(valuesToTsv([["a", 1, false]])).toBe("a\t1\tFALSE")
    expect(valuesToTsv([["a"], [1], [""]])).toBe("a\n1\n")
    expect(
      valuesToTsv([
        ["a", "b"],
        ["c", "d"],
      ]).endsWith("\n"),
    ).toBe(false)
  })

  test("ragged input is rejected as impossible", () => {
    expect(() => valuesToTsv([["a", "b"], ["c"]])).toThrow(RangeError)
  })
})

describe("U-XL-04 FR-12 empty", () => {
  test("all-empty matrix and empty-sheet used range give an empty context", () => {
    expect(valuesToTsv([[""]])).toBe("")
    expect(valuesToTsv(empty(3, 4))).toBe("")
    expect(valuesToTsv([])).toBe("")
  })

  test("one non-empty cell keeps the full rectangle", () => {
    expect(
      valuesToTsv([
        ["", ""],
        ["", 0],
      ]),
    ).toBe("\t\n\t0")
  })
})

describe("U-XL-05 FR-13 reply without a tab", () => {
  test("one cell, CRLF normalised, trailing newline removed, inner breaks kept", () => {
    expect(replyToMatrix("Summary line one.\r\nLine two.\r\n\r\n")).toEqual({
      rows: [["Summary line one.\nLine two."]],
      m: 1,
      n: 1,
    })
    expect(replyToMatrix("plain")).toEqual({ rows: [["plain"]], m: 1, n: 1 })
    expect(replyToMatrix("")).toEqual({ rows: [[""]], m: 1, n: 1 })
  })
})

describe("U-XL-06 FR-13 tab reply", () => {
  test("rows and cells split, short rows padded on the right, m and n reported", () => {
    expect(replyToMatrix("a\tb\tc\r\nd\ne\tf\n")).toEqual({
      rows: [
        ["a", "b", "c"],
        ["d", "", ""],
        ["e", "f", ""],
      ],
      m: 3,
      n: 3,
    })
  })

  test("TSV round trip of FR-10 output", () => {
    const tsv = valuesToTsv([
      ["Name", "Qty"],
      ["x", 3],
    ])
    expect(replyToMatrix(tsv).rows).toEqual([
      ["Name", "Qty"],
      ["x", "3"],
    ])
  })
})

describe("U-XL-07 FR-14.1 number pattern", () => {
  test("pins the regex exactly (C15 RM-01)", () => {
    expect(EXCEL_NUMBER_PATTERN.source).toBe("^-?\\d+(\\.\\d+)?$")
    expect(EXCEL_NUMBER_PATTERN.flags).toBe("")
  })

  test.each(["-1", "-12.5", "42", "0", "3.14159"])("%p is a number", (text) => {
    expect(isNumberCell(text)).toBe(true)
    expect(convertCell(text)).toEqual({ kind: "number", value: Number(text) })
  })

  test.each([
    "3e2",
    "1E-3",
    ".5",
    "-.5",
    "+7",
    "1.",
    "1,000",
    " 5",
    "5 ",
    "12abc",
    "",
    "0x10",
    "Infinity",
    "NaN",
    "TRUE",
    "١٢٣",
    "１２",
    "--1",
    "-",
    "1\n",
  ])("%p is not a number", (text) => {
    expect(isNumberCell(text)).toBe(false)
    expect(convertCell(text).kind).toBe("text")
  })
})

describe("U-XL-07a C66 exact-number rule (M8-01a, CP-M8 F-4)", () => {
  test.each(["0", "0.5", "-0.25", "-0", "0.000123", "123456789012345", "-123456789012345", "1234567.12345678", "100"])(
    "%p is a number",
    (text) => {
      expect(isExactNumber(text)).toBe(true)
      expect(convertCell(text)).toEqual({ kind: "number", value: Number(text) })
    },
  )

  test.each([
    ["Indonesian phone", "0812345678901"],
    ["leading zero code", "007"],
    ["leading zero with fraction", "01.5"],
    ["negative leading zero", "-0812"],
    ["zeros only, leading zero", "00"],
    ["16-digit NIK", "3171234567890001"],
    ["16 significant digits", "1234567890123456"],
    ["16 significant digits in a fraction", "0.1234567890123456"],
    ["15 digits plus a trailing zero", "1234567890123450"],
    ["overflow via a long digit string", "9".repeat(400)],
    ["underflow to zero", `0.${"0".repeat(400)}1`],
  ])("%s %p is text with numberFormat @", (_, text) => {
    expect(EXCEL_NUMBER_PATTERN.test(text)).toBe(true)
    expect(isExactNumber(text)).toBe(false)
    expect(convertCell(text)).toEqual({ kind: "text", value: text, formulaLeading: false })
    const result = plan(completeWrite(prepared(prepareWrite("replace", text, { rowCount: 1, columnCount: 1 }))))
    expect(result.assignments).toEqual([
      { property: "numberFormat", value: [["@"]] },
      { property: "values", value: [[text]] },
    ])
  })

  test("15 vs 16 significant digits", () => {
    expect(isNumberCell("123456789012345")).toBe(true)
    expect(isNumberCell("1234567890123456")).toBe(false)
  })

  test("a NIK and a phone in one row: both text, the amount a number", () => {
    const ready = prepared(
      prepareWrite("insert", "3171234567890001\t0812345678901\t250000", { rowCount: 1, columnCount: 1 }),
    )
    expect(plan(completeWrite(ready, empty(1, 3))).assignments).toEqual([
      { property: "numberFormat", value: [["@", "@", null]] },
      { property: "values", value: [["3171234567890001", "0812345678901", 250000]] },
    ])
  })
})

describe("U-XL-08 FR-14.2 text rule", () => {
  const formula = [
    "=SUM(A1:A2)",
    "+1+1",
    "@x",
    "-foo",
    '=HYPERLINK("https://x","y")',
    "+7",
    "\t=1+1",
    " =1+1",
    "\r=1+1",
    "＝1+1",
    "＋1",
    "－1",
    "＠x",
    " \t\r@SUM(A1)",
    "-1+1",
  ]
  const plain = ["3e2", ".5", "TRUE", "", "hello", "1,000", " 5"]

  // A reply containing a tab is split into cells by FR-13, so tab-leading strings are
  // checked at the cell level here and as a split reply below.
  test.each([...formula, ...plain])("%p converts to a text cell", (text) => {
    expect(convertCell(text)).toEqual({ kind: "text", value: text, formulaLeading: isFormulaLeading(text) })
  })

  test("a tab-leading reply splits into text cells, each guarded with @", () => {
    const ready = prepared(prepareWrite("insert", "\t=1+1", { rowCount: 1, columnCount: 1 }))
    const result = plan(completeWrite(ready, empty(1, 2)))
    expect(result.assignments).toEqual([
      { property: "numberFormat", value: [["@", "@"]] },
      { property: "values", value: [["", "=1+1"]] },
    ])
  })

  test.each([...formula, ...plain].filter((text) => !text.includes("\t")))(
    "%p is written as text with numberFormat @ before values",
    (text) => {
      const result = plan(completeWrite(prepared(prepareWrite("replace", text, { rowCount: 1, columnCount: 1 }))))
      expect(result.assignments.map((step) => step.property)).toEqual(["numberFormat", "values"])
      expect(result.assignments[0].value).toEqual([["@"]])
      expect(result.assignments[1].value).toEqual([[text.replace(/\n+$/, "")]])
      expect(typeof result.assignments[1].value[0][0]).toBe("string")
    },
  )

  test.each(formula)("%p is formula-leading (preview marker, C12)", (text) => {
    expect(isFormulaLeading(text)).toBe(true)
  })

  test.each(plain)("%p is text but not formula-leading", (text) => {
    expect(isFormulaLeading(text)).toBe(false)
  })

  test("a minus followed only by digits is a number, not a formula (C14, C15)", () => {
    expect(isFormulaLeading("-1")).toBe(false)
    expect(isFormulaLeading("-12.5")).toBe(false)
    expect(convertCell("-1")).toEqual({ kind: "number", value: -1 })
  })

  test("mixed row: numbers get null numberFormat, text cells get @, counts for the preview", () => {
    const ready = prepared(prepareWrite("insert", "42\t=1+1\thi\n-1\t＝2\t3e2", { rowCount: 1, columnCount: 1 }))
    expect(ready.formulaAsText).toBe(2)
    const result = plan(completeWrite(ready, empty(2, 3)))
    expect(result.assignments).toEqual([
      {
        property: "numberFormat",
        value: [
          [null, "@", "@"],
          [null, "@", "@"],
        ],
      },
      {
        property: "values",
        value: [
          [42, "=1+1", "hi"],
          [-1, "＝2", "3e2"],
        ],
      },
    ])
  })

  test("all-number reply needs no numberFormat assignment", () => {
    const result = plan(completeWrite(prepared(prepareWrite("replace", "1\t2", { rowCount: 1, columnCount: 2 }))))
    expect(result.assignments).toEqual([{ property: "values", value: [[1, 2]] }])
  })
})

describe("U-XL-09 FR-15 property test: no formulas, every text cell guarded", () => {
  // Deterministic PRNG (mulberry32) so a failure is reproducible from the seed.
  function rng(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0
      const t0 = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      const t1 = (t0 + Math.imul(t0 ^ (t0 >>> 7), 61 | t0)) ^ t0
      return ((t1 ^ (t1 >>> 14)) >>> 0) / 4294967296
    }
  }
  const atoms = [
    "=",
    "+",
    "-",
    "@",
    "\t",
    " ",
    "\r",
    "\n",
    "\r\n",
    "＝",
    "＋",
    "－",
    "＠",
    ".",
    ",",
    "e",
    "E",
    "0",
    "1",
    "9",
    "42",
    "-1",
    "3e2",
    "SUM(A1:A2)",
    'HYPERLINK("https://x","y")',
    "TRUE",
    "١",
    "x",
    "'",
    '"',
  ]

  test("1,000 generated replies", () => {
    const next = rng(20261116)
    const pick = () => atoms[Math.floor(next() * atoms.length)]
    const replies = Array.from({ length: 1000 }, () =>
      Array.from({ length: 1 + Math.floor(next() * 40) }, pick).join(""),
    )
    const outcomes = replies.map((reply) => {
      const action = next() < 0.5 ? "insert" : "replace"
      const matrix = replyToMatrix(reply)
      const ready = prepareWrite(action, reply, { rowCount: 1, columnCount: 1 })
      if (!ready.ok) throw new Error(`unexpected refusal ${ready.refusal.code} for ${JSON.stringify(reply)}`)
      const result = plan(completeWrite(ready, empty(ready.target.rows, ready.target.columns)))
      const properties = result.assignments.map((step) => step.property)
      expect(JSON.stringify(result)).not.toMatch(/formulas/)
      expect(properties.every((property) => property === "numberFormat" || property === "values")).toBe(true)
      expect(properties.at(-1)).toBe("values")
      const values = result.assignments.find((step) => step.property === "values")!.value
      const format = result.assignments.find((step) => step.property === "numberFormat")?.value
      values.forEach((row, r) =>
        row.forEach((value, c) => {
          const source = matrix.rows[r][c]
          if (typeof value === "number") {
            expect(EXCEL_NUMBER_PATTERN.test(source)).toBe(true)
            expect(isExactNumber(source)).toBe(true)
            expect(String(value)).toBe(String(Number(source)))
            expect(format?.[r][c] ?? null).toBeNull()
            return
          }
          expect(value).toBe(source)
          expect(isNumberCell(source)).toBe(false)
          expect(format?.[r][c]).toBe("@")
          expect(properties.indexOf("numberFormat")).toBeLessThan(properties.indexOf("values"))
        }),
      )
      return values.flat().some((value) => typeof value === "number")
    })
    expect(outcomes).toHaveLength(1000)
    // The generator must exercise both branches.
    expect(outcomes.some(Boolean)).toBe(true)
    expect(outcomes.some((value) => !value)).toBe(true)
  })
})

describe("U-XL-10 FR-16 cell length", () => {
  test("32,767 characters is allowed", () => {
    expect(prepareWrite("replace", "x".repeat(32_767), { rowCount: 1, columnCount: 1 }).ok).toBe(true)
  })

  test("32,768 characters in any cell refuses the whole write, zero assignments", () => {
    const result = prepareWrite("insert", `ok\t${"y".repeat(32_768)}\n=1+1\t2`, { rowCount: 1, columnCount: 1 })
    expect(result).toEqual({
      ok: false,
      refusal: { code: "office.error.writeFailed", reason: "cellTooLong", row: 0, column: 1, length: 32_768 },
    })
    expect("assignments" in result).toBe(false)
  })
})

describe("U-XL-11 6.3 Insert", () => {
  test("anchor below the last row, first column; target m x n; must be empty", () => {
    const ready = prepared(
      prepareWrite("insert", "a\tb\nc\td", { rowCount: 3, columnCount: 4, rowIndex: 1, columnIndex: 2 }),
    )
    expect(ready.target).toEqual({
      anchor: "below",
      rows: 2,
      columns: 2,
      check: "all",
      rowIndex: 4,
      columnIndex: 2,
      address: "C5:D6",
    })
    expect(plan(completeWrite(ready, empty(2, 2))).target.address).toBe("C5:D6")
  })

  test("any non-empty target cell refuses with targetNotEmpty, nothing planned", () => {
    const ready = prepared(prepareWrite("insert", "a\tb\nc\td", { rowCount: 1, columnCount: 1 }))
    expect(
      completeWrite(ready, [
        ["", ""],
        ["", 0],
      ]),
    ).toEqual({
      ok: false,
      refusal: { code: "office.error.targetNotEmpty", row: 1, column: 1 },
    })
    expect(
      completeWrite(ready, [
        ["x", ""],
        ["", ""],
      ]),
    ).toEqual({
      ok: false,
      refusal: { code: "office.error.targetNotEmpty", row: 0, column: 0 },
    })
  })

  test("prose reply inserts one cell below a multi-cell selection (SP-S3 X4 shape)", () => {
    const ready = prepared(
      prepareWrite("insert", "Summary.\nMore.", { rowCount: 1, columnCount: 2, rowIndex: 2, columnIndex: 7 }),
    )
    expect(ready.target.address).toBe("H4")
  })

  test("insert shape equal to the selection still goes below and must be empty", () => {
    const ready = prepared(prepareWrite("insert", "1\t2", { rowCount: 1, columnCount: 2 }))
    expect(ready.target.anchor).toBe("below")
    expect(ready.target.check).toBe("all")
  })

  test("a target past the sheet grid is refused before writing", () => {
    expect(prepareWrite("insert", "x", { rowCount: 1, columnCount: 1, rowIndex: 1_048_575, columnIndex: 0 })).toEqual({
      ok: false,
      refusal: { code: "office.error.writeFailed", reason: "outsideGrid" },
    })
  })

  test("target values of the wrong shape are a caller bug", () => {
    const ready = prepared(prepareWrite("insert", "a\tb", { rowCount: 1, columnCount: 1 }))
    expect(() => completeWrite(ready, [[""]])).toThrow(RangeError)
    expect(() => completeWrite(ready)).toThrow(RangeError)
  })
})

describe("U-XL-12 6.3 Replace, same shape", () => {
  test("target is the selection; overwrite allowed without loading values", () => {
    const ready = prepared(
      prepareWrite("replace", "a\tb\n1\t2", { rowCount: 2, columnCount: 2, rowIndex: 0, columnIndex: 0 }),
    )
    expect(ready.target).toEqual({
      anchor: "topLeft",
      rows: 2,
      columns: 2,
      check: "none",
      rowIndex: 0,
      columnIndex: 0,
      address: "A1:B2",
    })
    const result = plan(completeWrite(ready))
    expect(result.assignments.at(-1)).toEqual({
      property: "values",
      value: [
        ["a", "b"],
        [1, 2],
      ],
    })
  })

  test("1x1 selection and a 1x1 reply replaces the cell", () => {
    const ready = prepared(prepareWrite("replace", "new", { rowCount: 1, columnCount: 1, rowIndex: 0, columnIndex: 7 }))
    expect(ready.target.check).toBe("none")
    expect(ready.target.address).toBe("H1")
  })
})

describe("U-XL-13 6.3 Replace, 1x1 selection and a larger matrix", () => {
  const ready = prepared(
    prepareWrite("replace", "a\tb\tc", { rowCount: 1, columnCount: 1, rowIndex: 0, columnIndex: 7 }),
  )

  test("anchored at a, every target cell except a must be empty", () => {
    expect(ready.target).toMatchObject({
      anchor: "topLeft",
      rows: 1,
      columns: 3,
      check: "exceptAnchor",
      address: "H1:J1",
    })
    expect(plan(completeWrite(ready, [["old", "", ""]])).target.address).toBe("H1:J1")
  })

  test("a non-empty cell other than a refuses", () => {
    expect(completeWrite(ready, [["old", "", "busy"]])).toEqual({
      ok: false,
      refusal: { code: "office.error.targetNotEmpty", row: 0, column: 2 },
    })
  })
})

describe("U-XL-14 6.3 Replace, multi-cell selection with a different shape", () => {
  test("shapeMismatch with reply and selection sizes", () => {
    expect(prepareWrite("replace", "a\tb\tc\nd", { rowCount: 2, columnCount: 2 })).toEqual({
      ok: false,
      refusal: { code: "office.error.shapeMismatch", params: { replyRows: 2, replyCols: 3, selRows: 2, selCols: 2 } },
    })
  })

  test("prose reply into a multi-cell selection is a mismatch too", () => {
    expect(prepareWrite("replace", "one cell", { rowCount: 3, columnCount: 1 })).toEqual({
      ok: false,
      refusal: { code: "office.error.shapeMismatch", params: { replyRows: 1, replyCols: 1, selRows: 3, selCols: 1 } },
    })
  })
})

describe("U-XL-15 budget", () => {
  test("TSV of 10,000 x 10 short values in <= 300 ms", () => {
    const values = Array.from({ length: 10_000 }, (_, r) =>
      Array.from({ length: 10 }, (_, c) => (c % 3 === 0 ? r * c : c % 3 === 1 ? `v${r}` : c % 2 === 0)),
    )
    const start = performance.now()
    const tsv = valuesToTsv(values)
    const elapsed = performance.now() - start
    expect(tsv.split("\n")).toHaveLength(10_000)
    expect(elapsed).toBeLessThanOrEqual(300)
  })
})

describe("address helper", () => {
  test("column names and ranges", () => {
    expect(address(0, 0, 1, 1)).toBe("A1")
    expect(address(0, 25, 1, 2)).toBe("Z1:AA1")
    expect(address(9, 701, 1, 1)).toBe("ZZ10")
    expect(address(0, 16_383, 1, 1)).toBe("XFD1")
  })
})
