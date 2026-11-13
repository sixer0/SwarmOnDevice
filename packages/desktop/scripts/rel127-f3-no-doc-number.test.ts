// Swarm 1.2.7 row 43 (F-3, AC-F3, N7-111; C12 O-1, C13 O-5).
// Shipped samples must not carry a real GSP document number. Every `NNN/GSP/...` literal in the bundled
// datum-house-style skill (excluding references/rev-a/, the vendor-of-vendor manual), the built-in Studio templates
// and the Studio agent guide must either start with the neutral `000/` (never an issued number) or be a format
// example that the manual itself prints (references/rev-a/manual_id.txt or manual_en.txt).
// Failures list file:line only, never the literal value (values are TERBATAS).
// R-5: the skill tree carries no agent scratch path (`/private/tmp/claude-`, `/tmp/claude`).
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const DESKTOP = path.resolve(import.meta.dir, "..")
const SKILL_DIR = path.join(DESKTOP, "datum/datum-house-style")
const REV_A = path.join(SKILL_DIR, "references/rev-a")
const STUDIO = path.resolve(DESKTOP, "../datum-studio")
const TEMPLATES = path.join(STUDIO, "templates")
const GUIDE = path.join(STUDIO, "vendor/docs/STUDIO-AGENT-GUIDE.md")

const DOC_NUMBER = /[0-9]{3}\/GSP\/[A-Za-z0-9/.-]*/g
const SCRATCH = /\/private\/tmp\/claude-|\/tmp\/claude/

async function walk(dir: string, skip: (p: string) => boolean): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (skip(abs) || entry.name === "__pycache__" || entry.name === "node_modules") continue
    if (entry.isDirectory()) out.push(...(await walk(abs, skip)))
    else if (entry.isFile()) out.push(abs)
  }
  return out
}

const read = (p: string) => fs.readFile(p, "latin1")
const rel = (p: string) => path.relative(path.resolve(DESKTOP, ".."), p)

async function scope() {
  const skill = await walk(SKILL_DIR, (p) => p === REV_A)
  const templates = (await fs.readdir(TEMPLATES)).filter((n) => n.endsWith(".json")).map((n) => path.join(TEMPLATES, n))
  return [...skill, ...templates, GUIDE]
}

test("F-3: every GSP document-number literal in shipped samples is 000/... or a manual format example", async () => {
  const manual = (await read(path.join(REV_A, "manual_id.txt"))) + "\n" + (await read(path.join(REV_A, "manual_en.txt")))
  const files = await scope()
  expect(files.length).toBeGreaterThan(50)
  let literals = 0
  const offenders: string[] = []
  for (const file of files) {
    const lines = (await read(file)).split("\n")
    lines.forEach((line, i) => {
      for (const m of line.matchAll(DOC_NUMBER)) {
        literals++
        if (m[0].startsWith("000/") || manual.includes(m[0])) continue
        offenders.push(`${rel(file)}:${i + 1}`)
      }
    })
  }
  // The manual format examples (SKILL.md, references, datum_docx.py header) stay, so the scan is never empty.
  expect(literals).toBeGreaterThan(0)
  expect(offenders).toEqual([])
})

test("F-3 R-5 (C13 O-5): the bundled skill carries no agent scratch path", async () => {
  const offenders: string[] = []
  for (const file of await walk(SKILL_DIR, () => false)) {
    const lines = (await read(file)).split("\n")
    lines.forEach((line, i) => {
      if (SCRATCH.test(line)) offenders.push(`${rel(file)}:${i + 1}`)
    })
  }
  expect(offenders).toEqual([])
})
