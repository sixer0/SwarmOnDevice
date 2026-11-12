import { expect, test } from "bun:test"
import path from "path"

// GUIDE pin, 1.2.6 row 104 (S-01, S-04, W-12): verifier.txt defines a blind-judge mode.
const FILE = path.join(import.meta.dir, "../../src/agent/prompt/verifier.txt")

const blindJudge = async () => {
  const lines = (await Bun.file(FILE).text()).split("\n").filter((line) => line.startsWith("- Blind judge:"))
  expect(lines.length).toBe(1)
  return lines[0]
}

test("verifier blind judge reads images and scores per stated criteria (S-01)", async () => {
  const line = await blindJudge()
  expect(line).toContain("you read images")
  expect(line).toContain("A/B figures")
  expect(line).toContain("Score per stated criteria")
})

test("verifier blind judge gets no project context and no candidate labels (S-01, S-04)", async () => {
  const line = await blindJudge()
  expect(line).toContain("no project context or candidate labels")
})

test("verifier blind judge sides are randomised before sending (W-12)", async () => {
  const line = await blindJudge()
  expect(line).toContain("sides randomised before sending")
})
