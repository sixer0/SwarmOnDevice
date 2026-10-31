import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import type { AssistantMessage, Message, Part, UserMessage } from "@opencode-ai/sdk/v2"
import {
  assessFile,
  buildActivity,
  buildBrief,
  changeHash,
  classifyCommand,
  findClaims,
  flaggedLines,
  nextOpenFile,
  parsePatch,
  reversePatch,
  type DiffInput,
  type RunActivity,
} from "./review-brief-model"

const patchOf = (removed: string[], added: string[], start = 1) =>
  `diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -${start},${removed.length} +${start},${added.length} @@\n` +
  [...removed.map((line) => "-" + line), ...added.map((line) => "+" + line)].join("\n") +
  "\n"

const diffOf = (
  file: string,
  removed: string[],
  added: string[],
  status: DiffInput["status"] = "modified",
): DiffInput => ({
  file,
  patch: patchOf(removed, added),
  additions: added.length,
  deletions: removed.length,
  status,
})

const kinds = (diff: DiffInput, all: string[] = [diff.file]) => assessFile(diff, all).flags.map((flag) => flag.kind)

const idle: RunActivity = { touches: [], checks: [], attributes: false }

describe("parsePatch", () => {
  test("numbers added and removed lines across hunks, and keeps lines that look like headers", () => {
    const parsed = parsePatch(
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -10,3 +10,3 @@ fn\n ctx\n--- removed dashes\n+++ added plus\n ctx\n@@ -20 +20,2 @@\n-a\n+b\n+c\n",
    )
    expect(parsed.hunks).toBe(2)
    expect(parsed.removed).toEqual([
      { line: 11, text: "-- removed dashes" },
      { line: 20, text: "a" },
    ])
    expect(parsed.added).toEqual([
      { line: 11, text: "++ added plus" },
      { line: 20, text: "b" },
      { line: 21, text: "c" },
    ])
  })
})

describe("changeHash", () => {
  test("ignores where a change sits and notices what it says", () => {
    const here = changeHash({ patch: patchOf(["a"], ["b"], 1), additions: 1, deletions: 1 })
    expect(changeHash({ patch: patchOf(["a"], ["b"], 90), additions: 1, deletions: 1 })).toBe(here)
    expect(changeHash({ patch: patchOf(["a"], ["c"], 1), additions: 1, deletions: 1 })).not.toBe(here)
  })
})

describe("assessFile", () => {
  test("catches a test edited to agree with the code", () => {
    const flags = assessFile(
      diffOf("src/total.test.ts", ["  expect(total(items)).toBe(10)"], ["  expect(total(items)).toBe(11)"]),
      [],
    ).flags
    expect(flags.map((flag) => flag.kind)).toEqual(["expectation-changed"])
    expect(flags[0].lines[0]).toMatchObject({ line: 1, side: "additions" })
  })

  test("counts tests and assertions taken away, net of those added", () => {
    const found = assessFile(
      diffOf(
        "src/a.test.ts",
        ['it("one", () => {', "  expect(a).toBe(1)", "  expect(b).toBe(2)", "})", 'it("two", () => {', "})"],
        ['it("one", () => {', "  expect(a).toBeDefined()", "})"],
      ),
      [],
    ).flags
    expect(found.find((flag) => flag.kind === "tests-removed")?.count).toBe(1)
    expect(found.find((flag) => flag.kind === "assertions-removed")?.count).toBe(1)
  })

  test("flags skipped and focused tests, in several languages", () => {
    for (const line of [
      'it.skip("x", () => {})',
      'test.only("x", () => {})',
      "@pytest.mark.skip",
      "t.Skip()",
      "#[ignore]",
    ]) {
      expect(kinds(diffOf("src/a_test.py", [], [line]))).toContain("test-skipped")
    }
  })

  test("a deleted test file is removed tests, a deleted code file is a deletion", () => {
    expect(kinds(diffOf("src/a.test.ts", ['it("x", () => {})'], [], "deleted"))).toContain("tests-removed")
    expect(kinds(diffOf("src/a.ts", ["export const a = 1"], [], "deleted"))).toContain("file-deleted")
  })

  test("finds secrets anywhere, including docs, and leaves placeholders alone", () => {
    expect(kinds(diffOf("README.md", [], ["key AKIAIOSFODNN7EXAMPLE"]))).toContain("secret")
    expect(kinds(diffOf("src/c.ts", [], ['const password = "hunter2hunter2"']))).toContain("secret")
    expect(kinds(diffOf("src/c.ts", [], ["const password = process.env.PASSWORD"]))).not.toContain("secret")
    expect(kinds(diffOf("src/c.ts", [], ['const apiKey = "${KEY}"']))).not.toContain("secret")
  })

  test("flags silenced checkers, swallowed errors and risky calls in code, but not in a comment", () => {
    expect(kinds(diffOf("src/c.ts", [], ["// @ts-ignore"]))).toContain("suppression")
    expect(kinds(diffOf("src/c.ts", [], ["const x = y as any"]))).toContain("suppression")
    expect(kinds(diffOf("src/c.ts", [], ["try { a() } catch (e) {}"]))).toContain("swallowed-error")
    expect(kinds(diffOf("src/c.ts", [], ["p.catch(() => {})"]))).toContain("swallowed-error")
    expect(kinds(diffOf("src/c.py", [], ["except Exception: pass"]))).toContain("swallowed-error")
    expect(kinds(diffOf("src/c.ts", [], ["eval(input)"]))).toContain("dangerous")
    expect(kinds(diffOf("src/c.ts", [], ["// never call eval(input)"]))).not.toContain("dangerous")
  })

  test("names new dependencies and ignores version bumps and package metadata", () => {
    const added = assessFile(
      diffOf("package.json", ['    "left": "^1.0.0"'], ['    "left": "^2.0.0"', '    "lodash": "^4.17.21"']),
      [],
    )
    expect(added.flags.find((flag) => flag.kind === "dependency")?.detail).toBe("lodash")
    expect(kinds(diffOf("package.json", ['  "version": "1.0.0"'], ['  "version": "1.0.1"']))).not.toContain(
      "dependency",
    )
  })

  test("sensitive paths are flagged even when the lines look harmless", () => {
    for (const file of [
      "src/auth/session.ts",
      "db/migrations/01.sql",
      ".github/workflows/ci.yml",
      ".env.local",
      "src/billing.ts",
    ]) {
      expect(kinds(diffOf(file, ["a"], ["b"]))).toContain("sensitive-path")
    }
    expect(kinds(diffOf("src/author.ts", ["a"], ["b"]))).not.toContain("sensitive-path")
  })

  test("a lockfile alone is suspicious, with its manifest it is routine", () => {
    const lock = diffOf("bun.lock", ["a"], ["b"])
    expect(assessFile(lock, ["bun.lock"]).flags.map((flag) => flag.kind)).toEqual(["lockfile-alone"])
    expect(assessFile(lock, ["bun.lock", "package.json"]).flags).toEqual([])
    expect(assessFile(lock, ["bun.lock", "package.json"]).trait).toBe("lockfile")
  })

  test("recognises changes nobody needs to read closely", () => {
    expect(assessFile(diffOf("src/a.ts", ["  a( b )"], ["    a(b)"]), []).trait).toBe("formatting")
    expect(assessFile(diffOf("src/a.ts", ['import a from "a"'], ['import a from "b"']), []).trait).toBe("imports")
    expect(assessFile(diffOf("docs/a.md", ["a"], ["b"]), []).trait).toBe("docs")
    expect(assessFile(diffOf("src/gen/a.ts", ["a"], ["b"]), []).trait).toBe("generated")
  })

  test("a diff it could not read says so rather than passing silently", () => {
    const result = assessFile({ file: "src/huge.ts", additions: 9000, deletions: 3, patch: "" }, [])
    expect(result.assessed).toBe(false)
    expect(result.flags.map((flag) => flag.kind)).toEqual(["not-assessed"])
  })
})

describe("classifyCommand", () => {
  test("recognises checks across ecosystems and skips what only mentions them", () => {
    expect(classifyCommand("bun test")?.kinds).toEqual(["test"])
    expect(classifyCommand("npm run test:unit")?.kinds).toEqual(["test"])
    expect(classifyCommand("cargo test --all")?.kinds).toEqual(["test"])
    expect(classifyCommand("pytest -q")?.kinds).toEqual(["test"])
    expect(classifyCommand("tsc --noEmit")?.kinds).toEqual(["typecheck"])
    expect(classifyCommand("bun run lint")?.kinds).toEqual(["lint"])
    expect(classifyCommand("pnpm build")?.kinds).toEqual(["build"])
    expect(classifyCommand("tsc --noEmit && bun test")?.kinds.toSorted()).toEqual(["test", "typecheck"])
    expect(classifyCommand('echo "bun test"')).toBeUndefined()
    expect(classifyCommand("git log --grep test")).toBeUndefined()
    expect(classifyCommand("ls src")).toBeUndefined()
  })

  test("an exit code that cannot speak for the check is hidden", () => {
    for (const command of [
      "bun test | tail -5",
      "bun test || true",
      "bun test; echo done",
      "bun test 2>&1 | grep -v noise",
    ]) {
      expect(classifyCommand(command)?.hidden).toBe(true)
    }
    for (const command of [
      "bun test",
      "cd pkg && bun test",
      "bun test && echo ok",
      "bun test 2>&1",
      "set -o pipefail; bun test | tail -5",
      "set -e; bun test; echo done",
    ]) {
      expect(classifyCommand(command)?.hidden).toBe(false)
    }
  })

  test("notices when only part of a suite ran", () => {
    expect(classifyCommand("bun test src/a.test.ts")?.partial).toBe(true)
    expect(classifyCommand("pytest -k rounding")?.partial).toBe(true)
    expect(classifyCommand("bun test")?.partial).toBe(false)
  })
})

describe("findClaims", () => {
  test("reads a plain claim and quotes it", () => {
    expect(findClaims("Fixed it. All tests pass now.")).toEqual([{ kind: "test", quote: "All tests pass now." }])
    expect(
      findClaims("Typecheck is clean and the build succeeds.")
        .map((claim) => claim.kind)
        .toSorted(),
    ).toEqual(["build", "typecheck"])
  })

  test("does not take a hedge or a to-do for a claim", () => {
    for (const text of [
      "I could not confirm the tests pass.",
      "Tests should pass after this.",
      "Run it once tests pass.",
      "I did not run anything, so tests passing is not confirmed.",
    ]) {
      expect(findClaims(text)).toEqual([])
    }
  })
})

// ---- Run activity over real message and part shapes -------------------------------------------------------------------

const user = (id: string, created: number): UserMessage =>
  ({ id, role: "user", sessionID: "s", time: { created } }) as unknown as UserMessage
const assistant = (id: string, parentID: string, created: number): AssistantMessage =>
  ({
    id,
    role: "assistant",
    parentID,
    sessionID: "s",
    time: { created, completed: created + 1 },
  }) as unknown as AssistantMessage
const tool = (id: string, name: string, input: object, start: number, metadata: object = {}): Part =>
  ({
    id,
    type: "tool",
    tool: name,
    state: { status: "completed", input, metadata, output: "", title: "", time: { start, end: start + 1 } },
  }) as unknown as Part
const textPart = (id: string, text: string): Part => ({ id, type: "text", text }) as unknown as Part

function run(parts: Record<string, Part[]>, messages: Message[], ids = "s") {
  return buildActivity({
    sessions: [{ id: ids, messages, parts: (id) => parts[id] ?? [] }],
    roots: ["/repo"],
  })
}

describe("buildActivity and buildBrief", () => {
  const messages: Message[] = [user("u1", 1), assistant("a1", "u1", 2)]
  const code = diffOf("src/a.ts", ["a"], ["b"])
  const other = diffOf("src/b.ts", ["a"], ["b"])
  const spec = diffOf("src/a.test.ts", [], ['it("x", () => { expect(1).toBe(1) })'])

  test("a check nobody allowed did not fail: it did not run, and saying it passed is called out", () => {
    const skipped = (id: string, start: number) =>
      ({
        id,
        type: "tool",
        tool: "bash",
        state: {
          status: "error",
          input: { command: "bun test" },
          error: "Nobody answered this permission request in time, so this call did not run.",
          metadata: { notRun: "away" },
          time: { start, end: start + 1 },
        },
      }) as unknown as Part
    const activity = run(
      {
        u1: [textPart("t", "Fix the total")],
        a1: [
          tool("e1", "edit", { filePath: "/repo/src/a.ts" }, 10, {
            filediff: { file: "src/a.ts", additions: 1, deletions: 1 },
          }),
          skipped("b1", 20),
          textPart("c", "Fixed. All tests pass."),
        ],
      },
      messages,
    )
    expect(activity.checks).toEqual([])
    const brief = buildBrief({ diffs: [code], activity, marks: {}, running: false, complete: true })
    expect(brief.headline).toEqual({ key: "claim", kind: "test" })
    expect(brief.evidence[0]).toMatchObject({ type: "claim", against: "none" })
    expect(brief.evidence.some((row) => row.type === "check" && row.status === "failed")).toBe(false)
  })

  test("once only files that are not this run's are left, nothing asks for a review or a commit", () => {
    const activity = run(
      {
        u1: [textPart("t", "Fix the total")],
        a1: [
          tool("e1", "edit", { filePath: "/repo/src/a.ts" }, 10, {
            filediff: { file: "src/a.ts", additions: 1, deletions: 1 },
          }),
          tool("r1", "bash", { command: "bun test" }, 20, { exit: 0 }),
        ],
      },
      messages,
    )
    const brief = buildBrief({ diffs: [other], activity, marks: {}, running: false, complete: true })
    expect(brief.headline).toEqual({ key: "elsewhere", count: 1 })
    expect(brief.tone).toBe("neutral")
    expect(brief.evidence.some((row) => row.type === "elsewhere")).toBe(false)
    expect(buildBrief({ diffs: [code, other], activity, marks: {}, running: false, complete: true }).headline.key).not.toBe(
      "elsewhere",
    )
  })

  test("a pass before the last edit goes stale and names the file", () => {
    const activity = run(
      {
        u1: [textPart("t", "Fix the total")],
        a1: [
          tool("e1", "edit", { filePath: "/repo/src/a.ts" }, 10, {
            filediff: { file: "/repo/src/a.ts", additions: 1, deletions: 1 },
          }),
          tool("c1", "bash", { command: "bun test" }, 20, { exit: 0 }),
          tool("e2", "write", { filePath: "/repo/src/b.ts", content: "x" }, 30),
        ],
      },
      messages,
    )
    expect(activity.touches.map((item) => item.file)).toEqual(["src/a.ts", "src/b.ts"])
    expect(activity.touches[0].prompt).toBe("Fix the total")
    const brief = buildBrief({ diffs: [code, other, spec], activity, marks: {}, running: false, complete: true })
    const check = brief.evidence.find((row) => row.type === "check")
    expect(check).toMatchObject({ kind: "test", status: "stale", editedAfter: ["src/b.ts"] })
    expect(brief.headline).toEqual({ key: "stale", count: 1 })
    expect(brief.byFile.get("src/b.ts")?.editedAfterChecks).toBe(true)
    expect(brief.byFile.get("src/a.ts")?.editedAfterChecks).toBe(false)
  })

  test("a failed last run outranks everything but a contradicted claim, and a passing one is clear", () => {
    const parts = (exit: number, closing: string) => ({
      u1: [textPart("t", "Fix it")],
      a1: [
        tool("e1", "edit", { filePath: "/repo/src/a.ts" }, 10, {
          filediff: { file: "/repo/src/a.ts", additions: 1, deletions: 1 },
        }),
        tool("c1", "bash", { command: "bun test" }, 20, { exit }),
        textPart("end", closing),
      ],
    })
    const failed = buildBrief({
      diffs: [code, spec],
      activity: run(parts(1, "Done."), messages),
      marks: {},
      running: false,
      complete: true,
    })
    expect(failed.headline).toEqual({ key: "failed", command: "bun test" })
    expect(failed.tone).toBe("critical")
    expect(failed.sendable).toBe(true)

    const lying = buildBrief({
      diffs: [code, spec],
      activity: run(parts(1, "All tests pass."), messages),
      marks: {},
      running: false,
      complete: true,
    })
    expect(lying.headline).toEqual({ key: "claim", kind: "test" })
    expect(lying.evidence[0]).toMatchObject({ type: "claim", against: "failed" })

    const fine = buildBrief({
      diffs: [code, spec],
      activity: run(parts(0, "All tests pass."), messages),
      marks: {},
      running: false,
      complete: true,
    })
    expect(fine.headline).toEqual({ key: "clear" })
    expect(fine.tone).toBe("ok")
  })

  test("a piped test run is hidden, never a pass, and a claim with no run is called out", () => {
    const parts = {
      a1: [
        tool("e1", "edit", { filePath: "/repo/src/a.ts" }, 10, {
          filediff: { file: "/repo/src/a.ts", additions: 1, deletions: 1 },
        }),
        tool("c1", "bash", { command: "bun test | tail -3" }, 20, { exit: 0 }),
      ],
    }
    const hidden = buildBrief({
      diffs: [code, spec],
      activity: run(parts, messages),
      marks: {},
      running: false,
      complete: true,
    })
    expect(hidden.headline).toEqual({ key: "hidden", command: "bun test | tail -3" })

    const claimed = buildBrief({
      diffs: [code, spec],
      activity: run({ a1: [parts.a1[0], textPart("end", "All tests pass.")] }, messages),
      marks: {},
      running: false,
      complete: true,
    })
    expect(claimed.evidence[0]).toMatchObject({ type: "claim", against: "none" })
  })

  test("nothing is claimed missing or foreign until the whole history is here", () => {
    const activity = run(
      {
        a1: [
          tool("e1", "edit", { filePath: "/repo/src/a.ts" }, 10, {
            filediff: { file: "/repo/src/a.ts", additions: 1, deletions: 1 },
          }),
          textPart("end", "All tests pass."),
        ],
      },
      messages,
    )
    const partial = buildBrief({ diffs: [code, other], activity, marks: {}, running: false, complete: false })
    expect(
      partial.evidence.some((row) => row.type === "none" || row.type === "claim" || row.type === "elsewhere"),
    ).toBe(false)
    expect(partial.headline).toEqual({ key: "history" })
    expect(partial.byFile.get("src/b.ts")?.group).toBe("read")

    const whole = buildBrief({ diffs: [code, other], activity, marks: {}, running: false, complete: true })
    expect(whole.byFile.get("src/b.ts")?.group).toBe("elsewhere")
    expect(whole.evidence.some((row) => row.type === "elsewhere")).toBe(true)
  })

  test("a session with no record of edits does not disown files", () => {
    const brief = buildBrief({ diffs: [code], activity: idle, marks: {}, running: false, complete: true })
    expect(brief.byFile.get("src/a.ts")?.group).toBe("read")
    expect(brief.evidence.some((row) => row.type === "elsewhere")).toBe(false)
  })

  test("files a command changed are attributed from patch parts, dated by that command", () => {
    const activity = run(
      {
        a1: [
          tool("c0", "bash", { command: "sed -i s/a/b/ src/a.ts" }, 10, { exit: 0 }),
          tool("c1", "bash", { command: "bun test" }, 20, { exit: 0 }),
          tool("c2", "bash", { command: "sed -i s/a/b/ src/b.ts" }, 30, { exit: 0 }),
          { id: "p", type: "patch", files: ["/repo/src/b.ts"] } as unknown as Part,
        ],
      },
      messages,
    )
    expect(activity.attributes).toBe(true)
    expect(activity.touches).toHaveLength(1)
    expect(activity.touches[0]).toMatchObject({ file: "src/b.ts", at: 31 })
  })

  test("a subagent's edits and checks count for the run, and only the root's closing text is the claim", () => {
    const parts: Record<string, Part[]> = {
      a1: [textPart("root", "All tests pass.")],
      c1: [
        tool("e", "edit", { filePath: "/repo/src/a.ts" }, 10, {
          filediff: { file: "/repo/src/a.ts", additions: 1, deletions: 1 },
        }),
        tool("t", "bash", { command: "bun test" }, 20, { exit: 1 }),
        textPart("child", "Build succeeds."),
      ],
    }
    const activity = buildActivity({
      sessions: [
        { id: "root", messages, parts: (id) => parts[id] ?? [] },
        { id: "child", messages: [user("u2", 1), assistant("c1", "u2", 2)], parts: (id) => parts[id] ?? [] },
      ],
      roots: ["/repo"],
    })
    expect(activity.touches.map((item) => [item.file, item.sessionID])).toEqual([["src/a.ts", "child"]])
    expect(activity.checks.map((item) => [item.kind, item.status, item.sessionID])).toEqual([
      ["test", "failed", "child"],
    ])
    expect(activity.closing).toBe("All tests pass.")
    const brief = buildBrief({ diffs: [code, spec], activity, marks: {}, running: false, complete: true })
    expect(brief.headline).toEqual({ key: "claim", kind: "test" })
  })

  test("queues the risky first, marks follow the content, and a re-edited file comes back to the top", () => {
    const risky = diffOf("src/r.ts", [], ["eval(x)"])
    const plain = diffOf("src/p.ts", ["a", "b", "c"], ["d"])
    const small = diffOf("src/s.ts", ["a"], ["b"])
    const doc = diffOf("README.md", ["a"], ["b"])
    const base = { activity: idle, running: false, complete: false }
    const brief = buildBrief({ ...base, diffs: [doc, small, plain, risky], marks: {} })
    expect(brief.order).toEqual(["src/r.ts", "src/p.ts", "src/s.ts", "README.md"])
    expect(brief.groups.map((group) => group.id)).toEqual(["look", "read", "skim"])
    expect(brief.progress).toMatchObject({ total: 4, ok: 0, open: 4 })

    const hash = changeHash(small)
    const marked = buildBrief({
      ...base,
      diffs: [doc, small, plain, risky],
      marks: { "src/s.ts": { hash, verdict: "ok" } },
    })
    expect(marked.byFile.get("src/s.ts")?.mark).toBe("ok")
    expect(marked.progress).toMatchObject({ ok: 1, open: 3 })

    const again = buildBrief({
      ...base,
      diffs: [doc, diffOf("src/s.ts", ["a"], ["z"]), plain, risky],
      marks: { "src/s.ts": { hash, verdict: "ok" } },
    })
    expect(again.byFile.get("src/s.ts")?.mark).toBe("changed")
    expect(again.groups.find((group) => group.id === "read")?.files[0]).toBe("src/s.ts")
  })

  test("nextOpenFile skips decided files and wraps; flaggedLines reads top to bottom without repeats", () => {
    const brief = buildBrief({
      diffs: [diffOf("a.ts", ["a"], ["b"]), diffOf("b.ts", ["a"], ["b"]), diffOf("c.ts", ["a"], ["b"])],
      activity: idle,
      marks: { "b.ts": { hash: changeHash(diffOf("b.ts", ["a"], ["b"])), verdict: "ok" } },
      running: false,
      complete: false,
    })
    expect(nextOpenFile(brief, "a.ts")).toBe("c.ts")
    expect(nextOpenFile(brief, "c.ts")).toBe("a.ts")
    const lines = flaggedLines(assessFile(diffOf("src/q.ts", [], ["x as any", "eval(y as any)"]), []))
    expect(lines.map((line) => line.line)).toEqual([1, 2])
  })
})

// ---- Undo, against real git: the reversed patch has to be something git really applies. --------------------------------

describe("reversePatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-brief-"))
  const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n")
  writeFileSync(join(dir, "nonl.txt"), "one\ntwo")
  writeFileSync(join(dir, "gone.txt"), "bye\nnow\n")
  git("add", ".")
  git("commit", "-qm", "base")

  const diff = (file: string) => git("diff", "HEAD", "--unified=2147483647", "--", file).stdout
  const apply = (patch: string) => spawnSync("git", ["apply", "-"], { cwd: dir, input: patch, encoding: "utf8" })

  test("restores a modified file, even with the changed last line missing its newline", () => {
    writeFileSync(join(dir, "a.txt"), "one\n--- two\nthree\nfour\n")
    writeFileSync(join(dir, "nonl.txt"), "one\nTWO")
    for (const [file, before] of [
      ["a.txt", "one\ntwo\nthree\n"],
      ["nonl.txt", "one\ntwo"],
    ] as const) {
      const forward = diff(file)
      const after = readFileSync(join(dir, file), "utf8")
      const result = apply(reversePatch(forward)!)
      expect(result.stderr).toBe("")
      expect(result.status).toBe(0)
      expect(readFileSync(join(dir, file), "utf8")).toBe(before)
      // And the original patch is the way back.
      expect(apply(forward).status).toBe(0)
      expect(readFileSync(join(dir, file), "utf8")).toBe(after)
      expect(apply(reversePatch(forward)!).status).toBe(0)
    }
  })

  test("removes an added file and brings back a deleted one", () => {
    writeFileSync(join(dir, "new.txt"), "fresh\n")
    git("add", "-N", "new.txt")
    const added = diff("new.txt")
    expect(apply(reversePatch(added)!).status).toBe(0)
    expect(existsSync(join(dir, "new.txt"))).toBe(false)
    expect(apply(added).status).toBe(0)
    expect(readFileSync(join(dir, "new.txt"), "utf8")).toBe("fresh\n")

    rmSync(join(dir, "gone.txt"))
    const deleted = diff("gone.txt")
    expect(apply(reversePatch(deleted)!).status).toBe(0)
    expect(readFileSync(join(dir, "gone.txt"), "utf8")).toBe("bye\nnow\n")
  })

  test("refuses what it cannot reverse exactly", () => {
    expect(reversePatch("")).toBeUndefined()
    expect(reversePatch("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n")).toBeUndefined()
    expect(
      reversePatch("diff --git a/x b/y\nsimilarity index 90%\nrename from x\nrename to y\n@@ -1 +1 @@\n-a\n+b\n"),
    ).toBeUndefined()
    expect(reversePatch("diff --git a/x b/x\nBinary files a/x and b/x differ\n")).toBeUndefined()
    expect(reversePatch("diff --git a/x b/x\nindex 1..2\n")).toBeUndefined()
  })
})
