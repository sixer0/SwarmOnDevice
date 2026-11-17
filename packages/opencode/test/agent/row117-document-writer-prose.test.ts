import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const root = path.join(import.meta.dir, "../..")
const prompt = readFileSync(path.join(root, "src/agent/prompt/document-writer.txt"), "utf8")
const skill = readFileSync(path.join(root, "src/skill/gsp-document-prose.md"), "utf8")
const WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen"]

test("document-writer prompt names the registered skill exactly", () => {
  const name = skill.match(/^name:\s*(\S+)/m)?.[1]
  expect(name).toBe("gsp-document-prose")
  expect(prompt).toContain(`load the skill ${name} with the skill tool`)
})

test("the stated rule count equals the numbered rules in the bundled file", () => {
  const section = skill.split(/^## 2\..*$/m)[1]!.split(/^## 3\./m)[0]!
  const count = section.split("\n").filter((l) => /^\d+\. \*\*/.test(l)).length
  expect(count).toBe(12)
  expect(prompt).toContain(`its ${WORDS[count - 1]} rules`)
})
