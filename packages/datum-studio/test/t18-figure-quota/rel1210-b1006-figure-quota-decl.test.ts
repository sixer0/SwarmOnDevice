// Swarm 1.3.0 row 69 (AC-B1006, N10-195, backlog B10-06; PROBE stop, decisions C11 and C19 D-6).
// Question closed: does `src/mcp-host/figure-quota.ts` fail declaration emit because the exported functions and the
// `readFigureQuota` const name the file-local types FigureQuota, FigureQuotaReader and FigureQuotaOptions?
// Answer at BASE a3e3c4c93a (TypeScript 5.8.2): no. `declaration` + `emitDeclarationOnly` gives 0 declaration
// diagnostics and the emitted text declares the three types locally. Not reproduced, so there is no product change
// (re-exporting them would fail the 1.2.9 .63a file-local sweep in script/swarm/rel129-a03-export-guard.test.ts).
// This file keeps that result as a pin: green at BASE and at HEAD.
// Mutation (kept, in this file): a virtual module whose exported function returns a type it cannot name
// (a function-local class) must give at least one declaration diagnostic, so the check cannot pass by being blind.
// A second, external mutation is applied only in the red-base worktree: delete `interface FigureQuota` from the
// source; case 1 then fails on the diagnostics and on the missing local declaration.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import ts from "typescript"

const PKG = path.resolve(import.meta.dir, "..", "..")
const SOURCE = path.join(PKG, "src", "mcp-host", "figure-quota.ts")
const LOCAL_TYPES = ["FigureQuota", "FigureQuotaReader", "FigureQuotaOptions"] as const

function compilerOptions(): ts.CompilerOptions {
  const cfgPath = path.join(PKG, "tsconfig.json")
  const read = ts.readConfigFile(cfgPath, ts.sys.readFile)
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"))
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, PKG)
  return {
    ...parsed.options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    skipLibCheck: true,
    incremental: false,
    composite: false,
    tsBuildInfoFile: undefined,
  }
}

function emitDeclarations(options: ts.CompilerOptions, host?: ts.CompilerHost) {
  const program = ts.createProgram({ rootNames: [SOURCE], options, host })
  const sf = program.getSourceFile(SOURCE)
  if (!sf) throw new Error("source file missing: " + SOURCE)
  const diagnostics = program.getDeclarationDiagnostics(sf)
  let text = ""
  program.emit(sf, (name, data) => { if (name.endsWith(".d.ts")) text = data }, undefined, true)
  return { diagnostics, text }
}

describe("AC-B1006 figure-quota declaration emit (N10-195; C11, C19 D-6)", () => {
  test("declaration emit of figure-quota.ts: 0 diagnostics, the three types declared locally", () => {
    const { diagnostics, text } = emitDeclarations(compilerOptions())
    expect(diagnostics.map((d) => `TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`)).toEqual([])
    expect(text.length).toBeGreaterThan(0)
    for (const name of LOCAL_TYPES) expect(text).toMatch(new RegExp(`^(declare )?interface ${name}\\b|^(declare )?type ${name}\\b`, "m"))
    // the three stay file-local: none is exported from the module
    for (const name of LOCAL_TYPES) expect(text).not.toMatch(new RegExp(`^export (interface|type) ${name}\\b`, "m"))
  }, 120_000)

  test("mutation: an exported function returning an unnameable type gives a declaration diagnostic", () => {
    const virtual = path.join(PKG, "src", "mcp-host", "__b1006_virtual__.ts")
    const options = compilerOptions()
    const host = ts.createCompilerHost(options)
    const body = "export function hiddenOf() { class Hidden { private x = 1 }; return new Hidden() }\n"
    const read = host.readFile.bind(host)
    const exists = host.fileExists.bind(host)
    const getSf = host.getSourceFile.bind(host)
    host.fileExists = (f) => f === virtual || exists(f)
    host.readFile = (f) => (f === virtual ? body : read(f))
    host.getSourceFile = (f, lang, onError, shouldCreate) =>
      f === virtual ? ts.createSourceFile(f, body, lang) : getSf(f, lang, onError, shouldCreate)
    const program = ts.createProgram({ rootNames: [virtual], options, host })
    const sf = program.getSourceFile(virtual)!
    const diagnostics = program.getDeclarationDiagnostics(sf)
    expect(diagnostics.length).toBeGreaterThanOrEqual(1)
    expect(diagnostics.every((d) => d.code >= 4000 && d.code < 5000)).toBe(true)
  }, 120_000)
})
