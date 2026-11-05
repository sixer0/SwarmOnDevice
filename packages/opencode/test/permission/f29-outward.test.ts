// Swarm 1.1.1 F29 (decision P44, reversing D-F26-3 and D-F26-5 of F26).
// - Item 1: under consent a remote host counts as named when any of the person's own messages of the mission window
//   names it, also one sent after the mode came on, read at each call (`Permission.outwardOf` with `hosts`). The gate
//   wiring and the message reading are tested in `autonomy-bypass-gate.test.ts`.
// - Item 2: an allowed send (P42 forms) inside a project script run by name, or a hosted deploy through `npx`, `bunx`,
//   `bun x` or `pnpm dlx`, opens like the bare form; the script is still screened step by step and every other rule still
//   applies inside it (uploads held, push recheck, force refused, the interference rule). Destination recorded the same way.
// Classification only: no host is contacted.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { Permission } from "../../src/permission"
import type { Autonomy } from "../../src/permission/autonomy"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import type { OutwardKnown } from "../../src/permission/outward-known"
import { ScriptReader } from "../../src/permission/script-reader"
import type { InstanceContext } from "../../src/project/instance-context"
import { Risk } from "../../src/tool/risk"
import { readSteps } from "../../src/tool/shell"
import { ADMIN_RIGHTS, ARCHIVE_FIRST, CREDENTIAL_CHANGE, DELETE_COMPOUND, IRREVERSIBLE_ARCHIVE, OUTSIDE_WRITE, answerOf } from "./consented-literals"
import { tmpdir } from "../fixture/fixture"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

const temps: Awaited<ReturnType<typeof tmpdir>>[] = []
const temp = async () => {
  const made = await tmpdir()
  temps.push(made)
  return fs.realpathSync(made.path)
}
const write = (root: string, relative: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
  fs.writeFileSync(path.join(root, relative), content)
}
async function gitInit(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  await $`git init -q`.cwd(dir).quiet()
  await $`git remote add origin https://github.com/acme/origin.git`.cwd(dir).quiet()
  await $`git -c core.fsmonitor=false -c commit.gpgsign=false -c user.email=t@t.test -c user.name=T commit -q --allow-empty -m root`.cwd(dir).quiet()
}
const scope = (dir: string) => ({ directory: dir, worktree: dir, project: { vcs: "git" } }) as InstanceContext
const manifest = (dir: string, scripts: Record<string, string>) =>
  write(dir, "package.json", JSON.stringify({ name: "p", version: "1.0.0", scripts }))

/** The table's input as the gate builds it: the shell's reading and its risk label. */
async function sh(command: string, dir: string, outward?: AutonomyTable.Outward): Promise<Input> {
  const reading = await readSteps(command, dir)
  const risky = reading?.steps.map((step) => Risk.classify([...step.argv])).find((verdict) => verdict.kind === "risky")
  return {
    permission: "bash",
    patterns: [command],
    metadata: { command, ...(reading ? { steps: reading } : {}), ...(risky && risky.kind === "risky" ? { risk: risky.risk } : {}) },
    instance: scope(dir),
    cwd: dir,
    canUndo: true,
    folder: "clean",
    ...(outward ? { outward } : {}),
  }
}

const base = (given: Input) => AutonomyTable.classify(given)
const root = (given: Input) => AutonomyTable.classify({ ...given, bypass: { caller: "root" } })
const subagent = (given: Input) => AutonomyTable.classify({ ...given, bypass: { caller: "subagent" } })
const short = (verdict: Verdict) => [verdict.class, verdict.category, verdict.destination]

/** 1.1.3 (T9 G8): a literal consented verdict per case: class, category, `bypassed`, destination, and the agent's answer. */
type Want = { verdict: [string, string, string | undefined, string | undefined]; answer: string | undefined }
const RUNS = (bypassed: string, destination?: string): Want => ({ verdict: ["A", "by_main_agent", bypassed, destination], answer: undefined })
const REFUSED = (category: string, bypassed: string | undefined, answer: string): Want => ({ verdict: ["X", category, bypassed, undefined], answer })
function expectWant(label: string, verdict: Verdict, want: Want) {
  expect([label, verdict.class, verdict.category, verdict.bypassed, verdict.destination, answerOf(verdict)]).toEqual([label, ...want.verdict, want.answer])
}

/** Opens for the root and a subagent alike, to `destination`; the no-consent verdict is not A and has no destination. */
function expectOpens(given: Input, destination: string) {
  const label = String(given.metadata.command ?? given.metadata.url)
  const without = base(given)
  expect([label, without.class === "A", without.destination]).toEqual([label, false, undefined])
  for (const verdict of [root(given), subagent(given)])
    expect([label, short(verdict)]).toEqual([label, ["A", "by_main_agent", destination]])
  // The gate finds the same places again (S1.36).
  expect([label, AutonomyTable.consentOutward({ ...given, bypass: { caller: "root" } })?.join(", ")]).toEqual([label, destination])
}
/**
 * Not opened by the overlay, which keeps `kept`, and the no-consent verdict is unchanged. 1.1.3 (spec section 3 `noWait`;
 * matrix rows 2, 8, 15, 3, 31): a kept D no longer waits; it runs as the main agent's with `bypassed` = that category (and
 * the places `consentOutward` finds, if any), or is redirected to the archive method when it deletes or replaces. An X stays.
 */
function expectKept(given: Input, kept: [string, string], want: Want) {
  const label = String(given.metadata.command ?? given.metadata.url)
  expect([label, kept.length]).toEqual([label, 2])
  for (const verdict of [root(given), subagent(given)]) expectWant(label, verdict, want)
}

const snapshotOf = (dir: string): OutwardKnown.Snapshot => ({
  at: 0,
  repos: [{ dir, remotes: [{ name: "origin", push: ["https://github.com/acme/origin.git"] }] }],
  accounts: [],
  rclone: [],
  drives: [],
})
const ok: OutwardKnown.Recheck = {
  ok: true,
  remote: { name: "origin", push: ["https://github.com/acme/origin.git"] },
  account: { host: "github.com", login: "a" },
}
const pushing = (dir: string): AutonomyTable.Outward => ({
  allowed: [],
  snapshot: snapshotOf(dir),
  recheck: { repo: dir, remote: "origin", result: ok },
})

let dir = ""
beforeAll(async () => {
  await ScriptReader.prepare()
})
afterAll(async () => {
  for (const made of temps) await made[Symbol.asyncDispose]()
})
const project = async (scripts: Record<string, string>) => {
  dir = await temp()
  await gitInit(dir)
  manifest(dir, scripts)
  return dir
}

describe("F29 item 1: hosts the person's messages name, read at each call", () => {
  const consent = (destinations: OutwardKnown.Destination[] = []): Autonomy.Consent =>
    ({
      id: "consent_x",
      hash: "h",
      at: 0,
      directory: "/x",
      items: [],
      given: new Set(),
      dropped: 0,
      destinations: new Map(destinations.map((destination, index) => [`destination:d${index}`, destination])),
    }) as unknown as Autonomy.Consent

  test("a host the gate read from a later message opens; without it the call stays held", async () => {
    const here = await project({})
    const call = await sh("curl -s https://api.later.com/v1/status", here)
    const before = await Permission.outwardOf(call, here, consent())
    expectKept({ ...call, outward: before }, ["D", "outward"], RUNS("outward", "api.later.com"))
    const after = await Permission.outwardOf(call, here, consent(), undefined, { hosts: [{ kind: "host", host: "api.later.com" }] })
    expectOpens({ ...call, outward: after }, "api.later.com")
    // The scan's own list still counts beside them.
    const scanned = await Permission.outwardOf(call, here, consent([{ kind: "host", host: "api.later.com" }]))
    expectOpens({ ...call, outward: scanned }, "api.later.com")
  })

  test("the same matching rule as D-F26-1: exact, or below a wildcard the person wrote", async () => {
    const here = await project({})
    const hosts = (...names: string[]) => names.map((host): OutwardKnown.Destination => ({ kind: "host", host }))
    const evil = await sh("curl -s https://evil.api.later.com/", here)
    expectKept({ ...evil, outward: await Permission.outwardOf(evil, here, consent(), undefined, { hosts: hosts("api.later.com") }) }, [
      "D",
      "outward",
    ], RUNS("outward", "evil.api.later.com"))
    const below = await sh("curl -s https://a.later.com/", here)
    expectOpens({ ...below, outward: await Permission.outwardOf(below, here, consent(), undefined, { hosts: hosts("*.later.com") }) }, "a.later.com")
  })

  test("without a consent there is nothing to read", async () => {
    const here = await project({})
    const call = await sh("curl -s https://api.later.com/", here)
    expect(await Permission.outwardOf(call, here, undefined, undefined, { hosts: [{ kind: "host", host: "api.later.com" }] })).toBeUndefined()
  })
})

describe("F29 item 2: an allowed send inside a project script opens like the bare form", () => {
  test("npm run deploy whose script is `vercel deploy --prod` opens, with the deploy as its destination", async () => {
    const here = await project({ deploy: "vercel deploy --prod" })
    expectOpens(await sh("npm run deploy", here), "vercel")
    expectOpens(await sh("pnpm run deploy", here), "vercel")
    expectOpens(await sh("bun run deploy", here), "vercel")
    expectOpens(await sh("yarn run deploy", here), "vercel")
  })

  test("its pre and post hooks and a script it runs by name are read the same way", async () => {
    const here = await project({ predeploy: "bun test", deploy: "npm run ship", ship: "netlify deploy --prod --no-build --dir dist", postdeploy: "bun test" })
    expectOpens(await sh("npm run deploy", here), "netlify")
  })

  test("a request to a local host and a publish inside a script open; a remote host the person did not name stays held", async () => {
    const here = await project({ smoke: "curl -s http://localhost:3000/health", release: "npm publish", ping: "curl -s https://api.acme.com/x" })
    expectOpens(await sh("npm run smoke", here), "localhost:3000")
    expectOpens(await sh("npm run release", here), "registry.npmjs.org")
    expectKept(await sh("npm run ping", here), ["D", "not_routine"], RUNS("not_routine"))
    const named: AutonomyTable.Outward = { allowed: [], named: [{ kind: "host", host: "api.acme.com" }] }
    expectOpens(await sh("npm run ping", here, named), "api.acme.com")
  })

  test("a script that adds an upload form stays held", async () => {
    const here = await project({
      deploy: "vercel deploy --prod && curl -F file=@dist/app.zip http://localhost:3000/upload",
      up: "curl -T dist/app.zip http://localhost:3000/",
      stdin: "curl -s --data-binary @- http://localhost:3000/ < secrets.txt",
    })
    expectKept(await sh("npm run deploy", here), ["D", "not_routine"], RUNS("not_routine"))
    expectKept(await sh("npm run up", here), ["D", "not_routine"], RUNS("not_routine"))
    expectKept(await sh("npm run stdin", here), ["D", "not_routine"], RUNS("not_routine"))
  })

  test("a script with a step the allowlist does not accept, or a send the screen holds, stays held", async () => {
    const here = await project({ a: "vercel deploy --prod && node scripts/x.js", b: "vercel rm my-app", c: "vercel deploy --prod && scp a b:c" })
    expectKept(await sh("npm run a", here), ["D", "not_routine"], RUNS("not_routine"))
    expectKept(await sh("npm run b", here), ["D", "not_routine"], REFUSED("irreversible", "not_routine", IRREVERSIBLE_ARCHIVE))
    expectKept(await sh("npm run c", here), ["D", "not_routine"], RUNS("not_routine"))
  })

  test("the interference rule still applies: a tree change beside a script that sends keeps 1.1.0", async () => {
    const here = await project({ deploy: "vercel deploy --prod" })
    expectKept(await sh("git checkout main && npm run deploy", here), ["D", "not_routine"], RUNS("not_routine"))
  })

  test("a push inside a script opens only on the recheck of its remote; with force it is refused", async () => {
    const here = await project({ ship: "git push origin main", fp: "git push --force origin main", fp2: "git push origin main" })
    // The gate rechecks the remote the script would push to.
    expect(AutonomyTable.consentPushTarget(await sh("npm run ship", here), snapshotOf(here), scope(here))).toEqual({ repo: here, remote: "origin" })
    expect(AutonomyTable.consentPushTarget(await sh("npm run ship", here), snapshotOf(here))).toBeUndefined()
    expectOpens(await sh("npm run ship", here, pushing(here)), "origin")
    // No recheck ran: held.
    expectKept(await sh("npm run ship", here, { allowed: [], snapshot: snapshotOf(here) }), ["D", "not_routine"], RUNS("not_routine"))
    expectKept(await sh("npm run fp", here, pushing(here)), ["X", "irreversible"], REFUSED("irreversible", undefined, IRREVERSIBLE_ARCHIVE))
    // Words the manager appends are the script's: a force added on the line is a force push.
    expectKept(await sh("npm run fp2 -- --force", here, pushing(here)), ["X", "irreversible"], REFUSED("irreversible", undefined, IRREVERSIBLE_ARCHIVE))
    // Without consent the script push keeps 1.1.0.
    expect(base(await sh("npm run fp", here, pushing(here))).class).toBe("D")
  })

  test("admin rights inside a script run by name are refused too", async () => {
    const here = await project({ setup: "sudo make install" })
    expectKept(await sh("npm run setup", here), ["X", "admin_rights"], REFUSED("admin_rights", undefined, ADMIN_RIGHTS))
  })
})

describe("F29 item 2: a hosted deploy through a launcher opens like the bare form", () => {
  test("npx vercel deploy, bunx, bun x and pnpm dlx open", async () => {
    const here = await project({})
    expectOpens(await sh("npx vercel deploy", here), "vercel")
    expectOpens(await sh("npx --yes vercel deploy --prod", here), "vercel")
    expectOpens(await sh("bunx vercel deploy", here), "vercel")
    expectOpens(await sh("bun x vercel", here), "vercel")
    expectOpens(await sh("pnpm dlx vercel deploy", here), "vercel")
    // 1.1.1 F33 (P49 3): netlify with a `--dir` inside the project, firebase only for hosting.
    expectOpens(await sh("npx netlify-cli deploy --prod --no-build --dir dist", here), "netlify")
    expectOpens(await sh("npx firebase-tools deploy --only hosting --project demo", here), "firebase demo")
  })

  test("the tool's own name of another registry package counts only when the project has that program", async () => {
    const here = await project({})
    expectKept(await sh("npx netlify deploy --no-build --dir dist", here), ["D", "outward"], RUNS("outward"))
    write(here, "node_modules/.bin/netlify", "#!/bin/sh\n")
    expectOpens(await sh("npx netlify deploy --no-build --dir dist", here), "netlify")
  })

  test("a version, a package option, another launcher, another send or a held form keeps the hold", async () => {
    const here = await project({})
    expectKept(await sh("bun x vercel@latest deploy", here), ["D", "not_routine"], RUNS("not_routine"))
    expectKept(await sh("npx -p vercel vercel deploy", here), ["D", "outward"], RUNS("outward"))
    expectKept(await sh("npx wrangler deploy", here), ["D", "outward"], RUNS("outward"))
    expectKept(await sh("npx vercel rm my-app", here), ["D", "outward"], REFUSED("irreversible", "outward", IRREVERSIBLE_ARCHIVE))
    expectKept(await sh("npx netlify-cli deploy --build", here), ["D", "not_routine"], RUNS("not_routine"))
  })

  test("a deploy through a launcher inside a script opens too", async () => {
    const here = await project({ deploy: "npx vercel deploy --prod" })
    expectOpens(await sh("npm run deploy", here), "vercel")
  })
})
