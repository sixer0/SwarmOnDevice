// 1.1.3 decision T7 (rows 7-9 follow-ups), on the consented path; the path without consent is pinned unchanged.
// - F1: an outward call to a host nobody named runs, and its verdict (the audit line's `destination`) names where it goes.
// - F2: a consented compound records the category of the step that would have waited before 1.1.3, a send first, so the
//   report's "Sent outside the computer" stays complete.
// - F3 (narrowed by T8): a shell overwrite of an existing file no Undo snapshot covers (`>`, `>|`, `tee` without -a) gets
//   ARCHIVE_FIRST_TEXT at once; the write, edit and patch tools keep running everywhere, a folder without Git included.
// - F4: stopping Swarm's own app or server gets an immediate refusal ending with CONSENT_CONTINUE_SUFFIX.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import {
  ARCHIVE_FIRST_TEXT,
  CONSENT_CONTINUE_SUFFIX,
  STOPS_SWARM_TEXT,
  consentedRefusalText,
} from "../../src/permission/autonomy-texts"
import { refusedByMode, refusedUnderConsent } from "../../src/permission"
import type { InstanceContext } from "../../src/project/instance-context"
import { AutonomyReport } from "../../src/session/autonomy-report"
import { readSteps } from "../../src/tool/shell"
import { tmpdir } from "../fixture/fixture"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

let fixture: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  dir = fixture.path
  await $`git config --unset core.fsmonitor && git config --unset commit.gpgsign`.cwd(dir).quiet()
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  fs.mkdirSync(path.join(dir, "src"), { recursive: true })
  fs.writeFileSync(path.join(dir, "src/a.ts"), "x\n")
  fs.writeFileSync(path.join(dir, "notes.txt"), "n\n")
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { ping: "curl https://ping.example.org/up" } }))
})

afterAll(async () => {
  await fixture[Symbol.asyncDispose]()
})

async function sh(command: string, extra: Partial<Input> = {}): Promise<Input> {
  const steps = await readSteps(command, dir)
  return {
    permission: "bash",
    patterns: [command],
    metadata: { command, ...(steps ? { steps } : {}) },
    instance,
    cwd: dir,
    canUndo: true,
    folder: "clean",
    ...extra,
  }
}
const edit = (file: string, extra: Partial<Input> = {}): Input => ({
  permission: "edit",
  patterns: [file],
  metadata: { filepath: path.join(dir, file) },
  instance,
  cwd: dir,
  canUndo: false,
  folder: "clean",
  editClass: "no_undo",
  ...extra,
})
const fetchOf = (url: string): Input => ({
  permission: "webfetch",
  patterns: [url],
  metadata: { url },
  instance,
  cwd: dir,
  canUndo: true,
  folder: "clean",
})

const base = (input: Input) => AutonomyTable.classify(input)
const root = (input: Input) => AutonomyTable.classify({ ...input, bypass: { caller: "root" } })
const subagent = (input: Input) => AutonomyTable.classify({ ...input, bypass: { caller: "subagent" } })
const both = (input: Input) => [root(input), subagent(input)]

const REDIRECTED = (bypassed: string): Verdict => ({ class: "X", decidedBy: "gate", category: "not_reversible", bypassed } as Verdict)
const STOPPED = (bypassed: string): Verdict => ({ class: "X", decidedBy: "gate", category: "process_not_own", bypassed } as Verdict)

describe("T7 F1: a send to a host nobody named carries its destination", () => {
  test("request tools, read as the tool reads its URL", async () => {
    const cases: [string, string][] = [
      ["curl https://x.example", "x.example"],
      ["curl -s -o out.txt https://x.example/a", "x.example"],
      ["curl -sS x.example", "x.example"],
      ["curl -X POST -d 'a=b' https://api.example.net:8443/v1", "api.example.net:8443"],
      ["curl -s https:/evil.example/x", "evil.example"],
      ["curl https://user:pw@evil.example/", "evil.example"],
      ["wget -q -O - http://dl.example.com/f.tgz", "dl.example.com"],
      ["http post https://unnamed.example.net/x a=b", "unnamed.example.net"],
      ["curl https://a.example && curl https://b.example", "a.example, b.example"],
      // an upload is held by the reader; the host still stands, never the file
      ["curl -T notes.txt https://up.example.com/", "up.example.com"],
      ["http :3000/x f@secret.txt", "localhost:3000"],
    ]
    for (const [command, destination] of cases) {
      const input = await sh(command)
      for (const verdict of both(input)) {
        expect([command, verdict.class, verdict.category, verdict.destination]).toEqual([command, "A", "by_main_agent", destination])
        expect([command, AutonomyTable.OUTWARD_HELD.has(verdict.bypassed ?? "")]).toEqual([command, true])
      }
    }
  })

  test("webfetch and a push to a remote the snapshot does not know", async () => {
    for (const verdict of both(fetchOf("https://x.example/"))) expect(verdict).toMatchObject({ class: "A", bypassed: "outward_not_in_mission", destination: "x.example" })
    const push = await sh("git push upstream main")
    for (const verdict of both(push)) expect(verdict.destination).toBe("upstream")
  })

  test("a project script run by name keeps its category; the report reads the send inside it", async () => {
    const input = await sh("npm run ping")
    for (const verdict of both(input)) expect(verdict).toMatchObject({ class: "A", bypassed: "not_routine" })
    expect(AutonomyTable.destinationsOf({ ...input, bypass: { caller: "root" } })).toEqual(["ping.example.org"])
  })

  test("a host that cannot be read with certainty records none rather than a wrong one", async () => {
    for (const verdict of both(await sh("curl 'http://a@b@evil.example/'"))) {
      expect(verdict.class).toBe("A")
      expect(verdict.destination).toBeUndefined()
    }
  })

  test("without consent nothing changes: still held, with no destination", async () => {
    const input = await sh("curl https://x.example")
    expect(base(input).class).toBe("D")
    expect(base(input).destination).toBeUndefined()
  })
})

describe("T7 F2: a consented compound records the step that would have waited, a send first", () => {
  test("bun install && curl: outward with its host, so the report lists it under Sent outside", async () => {
    for (const command of ["bun install && curl https://x.example", "curl https://x.example && bun install", "bun test; curl -s https://x.example"]) {
      const input = await sh(command)
      for (const verdict of both(input))
        expect([command, verdict.class, verdict.category, verdict.bypassed, verdict.destination]).toEqual([
          command,
          "A",
          "by_main_agent",
          "outward",
          "x.example",
        ])
      // The report files a line by its category and destination (`sendsOf`): this one is a send.
      const line = {
        type: "decision",
        sessionID: "ses_f2",
        requestID: "per_f2",
        agent: "build",
        directory: dir,
        permission: "bash",
        patterns: [command],
        class: "A",
        category: "by_main_agent",
        risk: null,
        canUndo: true,
        decidedBy: "agent:main/build",
        decision: "allow",
        via: "main_agent",
        bypassed: root(input).bypassed,
        destination: root(input).destination,
        time: 0,
      } as unknown as Parameters<typeof AutonomyReport.sendsOf>[0][number]
      expect([command, AutonomyReport.sendsOf([line], dir).get(line)?.destination]).toEqual([command, "x.example"])
    }
  })

  test("a step that waited before 1.1.3 wins over one the 1.1.1 overlay opened", async () => {
    // `kill 4242` (process_not_own) waited in 1.1.2; `bun install` was opened by the overlay or ran.
    const input = await sh("bun install && kill 4242")
    for (const verdict of both(input)) expect(verdict).toMatchObject({ class: "A", category: "by_main_agent", bypassed: "process_not_own" })
  })

  test("without consent the compound keeps its 1.1.0 verdict", async () => {
    expect(base(await sh("bun install && curl https://x.example")).class).not.toBe("A")
  })
})

describe("T7 F3: replacing an existing file no Undo snapshot covers is redirected to the archive method", () => {
  test("a `>` redirect or `tee` onto an existing file without Undo", async () => {
    for (const command of ["echo hi > notes.txt", "echo hi >| notes.txt", "date &> notes.txt", "echo hi | tee notes.txt", "bun test > notes.txt", "echo a | tee src/a.ts other.txt"]) {
      const input = await sh(command, { canUndo: false })
      for (const verdict of both(input)) expect([command, verdict.class, verdict.category]).toEqual([command, "X", "not_reversible"])
      // the gate's answer under consent
      expect(consentedRefusalText(root(input).category)).toBe(ARCHIVE_FIRST_TEXT)
    }
    // what ran silently in 1.1.2 (class A) names the missing Undo as its reason
    expect(root(await sh("echo hi > notes.txt", { canUndo: false }))).toEqual(REDIRECTED("no_undo"))
  })

  test("T8: in a folder without Git a shell overwrite is redirected; the write and edit tools keep running", async () => {
    const plain = await tmpdir()
    try {
      const where = { directory: plain.path, worktree: "/", project: { vcs: undefined } } as unknown as InstanceContext
      fs.writeFileSync(path.join(plain.path, "notes.txt"), "n\n")
      // as the gate passes a call there: no Undo (canUndo needs Git), the edit tools say `no_undo`
      for (const command of ["echo hi > notes.txt", "echo hi >| notes.txt", "echo hi | tee notes.txt"]) {
        const steps = await readSteps(command, plain.path)
        const input: Input = { permission: "bash", patterns: [command], metadata: { command, ...(steps ? { steps } : {}) }, instance: where, cwd: plain.path, canUndo: false, folder: "clean" }
        for (const verdict of both(input)) expect([command, verdict.class, verdict.category]).toEqual([command, "X", "not_reversible"])
        expect(consentedRefusalText(root(input).category)).toBe(ARCHIVE_FIRST_TEXT)
      }
      // the write tool replacing notes.txt, the edit tool changing it, a patch: all run under consent, as without it
      for (const tool of [{}, { metadata: { filepath: path.join(plain.path, "notes.txt"), diff: "-n\n+m\n" } }, { metadata: { filepath: "notes.txt", files: [] } }]) {
        const input: Input = { ...edit("notes.txt", { instance: where, cwd: plain.path }), metadata: { filepath: path.join(plain.path, "notes.txt") }, ...tool }
        for (const verdict of both(input)) {
          expect(verdict.class).toBe("A")
          expect(verdict.category === "not_reversible").toBe(false)
        }
      }
    } finally {
      await plain[Symbol.asyncDispose]()
    }
  })

  test("T8: a write or edit of an existing file the edit tools found no Undo for runs (never redirected)", () => {
    for (const input of [edit("notes.txt"), edit("src/a.ts"), edit("src/a.ts", { canUndo: true })])
      for (const verdict of both(input)) {
        expect(verdict.class).toBe("A")
        expect(verdict.class === "X").toBe(false)
      }
    // `sed -i` keeps running too (T8)
  })

  test("near misses: an append, a new file, a file Undo covers, or a redirect outside the file all run as before", async () => {
    for (const command of ["echo hi >> notes.txt", "echo hi | tee -a notes.txt", "echo hi > brand-new.txt", "bun test 2>&1"]) {
      const input = await sh(command, { canUndo: false })
      for (const verdict of both(input)) expect([command, verdict.class]).not.toEqual([command, "X"])
    }
    expect(root(await sh("sed -i '' 's/n/m/' notes.txt", { canUndo: false })).class).not.toBe("X")
    // With Undo the snapshot covers a tracked file inside the project: unchanged.
    const covered = await sh("echo hi > notes.txt")
    expect(root(covered).class).not.toBe("X")
    expect(root(edit("brand-new.ts")).class).toBe("A")
    expect(root(edit("src/a.ts", { canUndo: true, editClass: "ordinary" }))).toEqual(base(edit("src/a.ts", { canUndo: true, editClass: "ordinary" })))
  })

  test("without consent the 1.1.0 verdict is unchanged", async () => {
    const input = await sh("echo hi > notes.txt", { canUndo: false })
    expect(base(input).class).not.toBe("X")
    expect(base(edit("src/a.ts")).class).toBe("A")
  })
})

describe("T7 F4: stopping Swarm's own app or server is refused at once, with the continue suffix", () => {
  const app = process.ppid
  test("a kill of this server, the app that started it, a group or every process; pkill/killall by Swarm's names", async () => {
    const commands = [
      `kill ${process.pid}`,
      `kill -9 ${process.pid}`,
      `kill -s TERM ${process.pid}`,
      ...(app > 1 ? [`kill ${app}`] : []),
      "kill -9 -1",
      "kill -- -1",
      "kill 0",
      "pkill Swarm",
      "pkill -f opencode",
      "pkill -9 -f 'Swarm Helper'",
      "killall Swarm",
      "killall -9 opencode",
      "pkill -f /Applications/Swarm.app/Contents/MacOS/Swarm",
      "pgrep -f opencode | xargs kill",
      "kill $(pgrep -f opencode)",
      `bun test && kill ${process.pid}`,
    ]
    for (const command of commands) {
      const input = await sh(command)
      for (const verdict of both(input)) expect([command, verdict.class, verdict.category]).toEqual([command, "X", "process_not_own"])
    }
    expect(root(await sh(`kill ${process.pid}`))).toEqual(STOPPED("process_not_own"))
  })

  test("the gate's text: STOPS_SWARM_TEXT ending with CONSENT_CONTINUE_SUFFIX, on the consented path only", () => {
    const text = consentedRefusalText("process_not_own")
    expect(text).toBe(`${STOPS_SWARM_TEXT} ${CONSENT_CONTINUE_SUFFIX}`)
    expect(text?.endsWith(CONSENT_CONTINUE_SUFFIX)).toBe(true)
    expect(refusedUnderConsent("process_not_own").message).toBe(text!)
    // without consent `process_not_own` is a hold, never class X; the 1.1.0 refusal text has no suffix
    expect(refusedByMode("process_not_own").message.endsWith(CONSENT_CONTINUE_SUFFIX)).toBe(false)
  })

  test("near misses: another process, one this session started, a dev server under a folder called swarm, a list of signals", async () => {
    const own = { ownProcesses: new Set([4242]) }
    expect(root(await sh("kill 4242", own))).toMatchObject({ class: "A" })
    expect(root(await sh("kill 98765"))).toMatchObject({ class: "A", bypassed: "process_not_own" })
    expect(root(await sh("pkill -f swarm/node_modules/.bin/vite"))).toMatchObject({ class: "A", bypassed: "process_not_own" })
    expect(root(await sh("pkill node"))).toMatchObject({ class: "A", bypassed: "process_not_own" })
    expect(root(await sh("kill -l"))).not.toMatchObject({ class: "X" })
    expect(root(await sh("pgrep -f opencode"))).not.toMatchObject({ class: "X" })
  })

  test("without consent the kill is held as in 1.1.0", async () => {
    // (the 1.1.0 table holds both as not routine; the consent's screen is what names `process_not_own`)
    expect(base(await sh(`kill ${process.pid}`)).class).toBe("D")
    expect(base(await sh("pkill Swarm")).class).toBe("D")
  })
})
