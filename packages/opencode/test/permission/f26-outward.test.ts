// Swarm 1.1.1 F26 (decision P42, P43): what the consented bypass lets leave the machine.
// - Requests (curl, wget, httpie, xh, webfetch) open to local hosts and to hosts the person named or ticked; other remote
//   hosts stay held. Uploads of a file from disk, and stdin from a file, stay held.
// - `git push` without force to a remote the consent snapshot knew opens; to a URL, an unknown remote, `--repo` or with
//   force it keeps its refusal or hold. Publish, image push, hosted deploy, `gh pr create` and `gh release create` open.
// - Every opened send carries its destination. Without consent nothing changes.
// - P43: the formatter link scan skips node_modules, .venv, venv and the tool's own default-ignored folders.
// Classification only: no host is contacted.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { OutwardConsent } from "../../src/permission/outward-consent"
import { OutwardKnown } from "../../src/permission/outward-known"
import { ScriptReader } from "../../src/permission/script-reader"
import type { InstanceContext } from "../../src/project/instance-context"
import { Reach } from "../../src/tool/reach"
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
  // Only keys the guard knows run nothing: the push's own hooks and config run with it (GitGuard).
  await $`git init -q`.cwd(dir).quiet()
  await $`git remote add origin https://github.com/acme/app.git`.cwd(dir).quiet()
  await $`git -c core.fsmonitor=false -c commit.gpgsign=false -c user.email=t@t.test -c user.name=T commit -q --allow-empty -m root`.cwd(dir).quiet()
}
const scope = (dir: string) => ({ directory: dir, worktree: dir, project: { vcs: "git" } }) as InstanceContext

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
const fetchInput = (url: string, dir: string, outward?: AutonomyTable.Outward): Input => ({
  permission: "webfetch",
  patterns: [url],
  metadata: { url },
  instance: scope(dir),
  cwd: dir,
  canUndo: true,
  folder: "clean",
  ...(outward ? { outward } : {}),
})

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
  expect([label, without.class === "A"]).toEqual([label, false])
  for (const verdict of [root(given), subagent(given)])
    expect([label, short(verdict)]).toEqual([label, ["A", "by_main_agent", destination]])
  // The gate finds the same places again (S1.36).
  expect([label, AutonomyTable.consentOutward({ ...given, bypass: { caller: "root" } })?.join(", ")]).toEqual([label, destination])
}
/**
 * Held as a send (by the screen, `outward`, or as 1.1.0 had it). 1.1.3 (matrix rows 2, 15, spec section 3 rule 5): that
 * hold no longer waits; the call runs as the main agent's, recorded as the send category it was held on, with the places
 * `consentOutward` finds, else (T7 F1) the host the call names (`destinationsOf`, pinned in f113-fixes-f1-f4).
 */
function expectHeldSend(given: Input, want: Want) {
  const label = String(given.metadata.command ?? given.metadata.url)
  for (const verdict of [root(given), subagent(given)]) expectWant(label, verdict, want)
}
/**
 * Not opened by the overlay, which keeps `consented`. 1.1.3 (spec section 3 `noWait`; matrix rows 2, 15, 3, 31): a kept D
 * no longer waits; it runs as the main agent's with `bypassed` = that category, or is redirected to the archive method
 * when it deletes or replaces. An X stays. T9 G8: the consented verdict is stated literally per case (`want`).
 */
function expectKept(given: Input, consented: [string, string], want: Want) {
  const label = String(given.metadata.command ?? given.metadata.url)
  expect([label, consented.length]).toEqual([label, 2])
  for (const verdict of [root(given), subagent(given)]) expectWant(label, verdict, want)
}

const snapshotOf = (dir: string, remotes = ["origin"]): OutwardKnown.Snapshot => ({
  at: 0,
  repos: [{ dir, remotes: remotes.map((name) => ({ name, push: [`https://github.com/acme/${name}.git`] })) }],
  accounts: [],
  rclone: [],
  drives: [],
})
const named = (...hosts: string[]): AutonomyTable.Outward => ({
  allowed: [],
  named: hosts.map((host) => ({ kind: "host", host })),
})
function pushing(dir: string, result: OutwardKnown.Recheck, remotes = ["origin"], remote = "origin"): AutonomyTable.Outward {
  return { allowed: [], snapshot: snapshotOf(dir, remotes), recheck: { repo: dir, remote, result } }
}
const ok = (dir: string): OutwardKnown.Recheck => ({
  ok: true,
  remote: { name: "origin", push: ["https://github.com/acme/origin.git"] },
  account: { host: "github.com", login: "a" },
})

let dir = ""
beforeAll(async () => {
  await ScriptReader.prepare()
  dir = await temp()
  await gitInit(dir)
  write(dir, "src/a.ts", "export const a = 1\n")
  write(dir, "package.json", JSON.stringify({ name: "p", version: "1.0.0" }))
})
afterAll(async () => {
  for (const made of temps) await made[Symbol.asyncDispose]()
})

describe("F26 item 1: requests to local and named hosts", () => {
  test("loopback, LAN, link-local, service and local names open with their host[:port]", async () => {
    expectOpens(await sh("curl http://localhost:3000/health", dir), "localhost:3000")
    expectOpens(await sh("curl -s http://127.0.0.1:8080/api", dir), "127.0.0.1:8080")
    expectOpens(await sh("curl -fsSL http://10.0.0.5/x", dir), "10.0.0.5")
    expectOpens(await sh("curl http://192.168.1.20:9000", dir), "192.168.1.20:9000")
    expectOpens(await sh("curl http://172.20.1.1", dir), "172.20.1.1")
    // 1.1.1 F33 (P49 1): no link-local IPv4 address opens any more (f33-outward.test.ts).
    expectHeldSend(await sh("curl http://169.254.10.20/latest", dir), RUNS("outward", "169.254.10.20"))
    expectOpens(await sh("curl -g 'http://[::1]:3000/'", dir), "::1:3000")
    expectOpens(await sh("curl http://db:5432", dir), "db:5432")
    expectOpens(await sh("curl http://printer.local/", dir), "printer.local")
    expectOpens(await sh("curl http://app.test/", dir), "app.test")
    expectOpens(await sh("curl localhost:3000/x", dir), "localhost:3000")
  })

  test("any method, headers and bodies with tokens open; the pipe to jq too", async () => {
    expectOpens(
      await sh(`curl -X POST -H 'Authorization: Bearer sk-test-123' -d '{"a":1}' http://localhost:3000/x`, dir),
      "localhost:3000",
    )
    expectOpens(await sh("curl -XDELETE -u admin:secret http://localhost:3000/x/1", dir), "localhost:3000")
    expectOpens(await sh("curl -s http://127.0.0.1:8080/api | jq .", dir), "127.0.0.1:8080")
    expectOpens(await sh("git status && curl -s http://localhost:3000", dir), "localhost:3000")
  })

  test("wget, httpie and xh", async () => {
    expectOpens(await sh("wget -qO- http://localhost:3000", dir), "localhost:3000")
    expectOpens(await sh("wget http://localhost:3000/report.json", dir), "localhost:3000")
    expectOpens(await sh("http GET localhost:3000/x 'Authorization:Bearer t' a=1", dir), "localhost:3000")
    expectOpens(await sh("http POST :3000/items name=x count:=2 q==1", dir), "localhost:3000")
    expectOpens(await sh("xh :8080/x", dir), "localhost:8080")
  })

  test("the webfetch tool", async () => {
    expectOpens(fetchInput("http://localhost:3000/", dir), "localhost:3000")
    expectKept(fetchInput("https://example.com/", dir), ["D", "outward_not_in_mission"], RUNS("outward_not_in_mission", "example.com"))
    expectOpens(fetchInput("https://example.com/docs", dir, named("example.com")), "example.com")
  })

  test("a remote host is held unless the person named it; a named parent with a wildcard covers names below it", async () => {
    expectKept(await sh("curl https://example.com", dir), ["D", "outward"], RUNS("outward", "example.com"))
    expectKept(await sh("curl http://8.8.8.8/", dir), ["D", "outward"], RUNS("outward", "8.8.8.8"))
    // Carrier-grade NAT (a tailnet address) is not local.
    expectKept(await sh("curl http://100.102.23.27:8000/v1", dir), ["D", "outward"], RUNS("outward", "100.102.23.27:8000"))
    expectKept(await sh("curl http://0x08080808/", dir), ["D", "outward"], RUNS("outward", "8.8.8.8"))
    expectOpens(await sh("curl https://api.example.com/v1", dir, named("api.example.com")), "api.example.com")
    // Exact: a named host does not cover another host below or beside it.
    expectKept(await sh("curl https://evil.api.example.com/", dir, named("api.example.com")), ["D", "outward"], RUNS("outward", "evil.api.example.com"))
    expectKept(await sh("curl https://example.com.evil.io/", dir, named("example.com")), ["D", "outward"], RUNS("outward", "example.com.evil.io"))
    expectOpens(await sh("curl https://a.b.example.com/", dir, named("*.example.com")), "a.b.example.com")
    expectOpens(await sh("curl https://example.com/", dir, named("*.example.com")), "example.com")
    // One remote host held holds the whole call.
    expectKept(await sh("curl http://localhost:3000 https://example.com", dir), ["D", "outward"], RUNS("outward", "localhost:3000, example.com"))
    // Ticked in the consent list.
    const ticked: AutonomyTable.Outward = { allowed: [{ id: "d1", destination: { kind: "host", host: "api.acme.io" } }] }
    expectOpens(await sh("curl https://api.acme.io/x", dir, ticked), "api.acme.io")
  })

  test("the mission's words name hosts, wildcards included", () => {
    expect(OutwardKnown.hostsIn("test against api.example.com and *.acme.io and .corp.dev").hosts.toSorted()).toEqual(["*.acme.io", "*.corp.dev", "api.example.com"])
  })

  test("an option this does not read, a proxy, another scheme or a range keeps the hold", async () => {
    expectKept(await sh("curl -x http://proxy.example.com:3128 http://localhost:3000", dir), ["D", "outward"], RUNS("outward", "proxy.example.com:3128, localhost:3000"))
    expectKept(await sh("curl --resolve localhost:80:1.2.3.4 http://localhost", dir), ["D", "outward"], RUNS("outward", "localhost"))
    expectKept(await sh("curl ftp://localhost/x", dir), ["D", "outward"], RUNS("outward"))
    expectKept(await sh("curl file:///etc/passwd", dir), ["D", "outward"], RUNS("outward"))
    expectKept(await sh("curl 'http://localhost:3000/{a,b}'", dir), ["D", "outward"], RUNS("outward"))
    expectKept(await sh("HTTPS_PROXY=http://evil.io curl http://localhost:3000", dir), ["D", "unreadable_command"], RUNS("unreadable_command"))
  })

  test("without consent nothing changes", async () => {
    for (const command of ["curl http://localhost:3000", "wget -qO- http://127.0.0.1", "git push origin main", "npm publish"]) {
      const given = await sh(command, dir, pushing(dir, ok(dir)))
      expect([command, base(given).class, base(given).destination]).toEqual([command, "D", undefined])
    }
  })
})

describe("F26 item 2: uploads from disk stay held", () => {
  test("curl, wget and httpie upload forms", async () => {
    const forms = [
      "curl -F file=@src/a.ts http://localhost:3000/up",
      "curl -F 'f=<src/a.ts' http://localhost:3000/up",
      "curl --form 'f=@src/a.ts;type=text/plain' http://localhost:3000/up",
      "curl -T src/a.ts http://localhost:3000/up",
      "curl --upload-file src/a.ts http://localhost:3000/up",
      "curl --data-binary @src/a.ts http://localhost:3000/up",
      "curl -d @src/a.ts http://localhost:3000/up",
      "curl -d@src/a.ts http://localhost:3000/up",
      "curl --data @src/a.ts http://localhost:3000/up",
      "curl --data-raw @src/a.ts http://localhost:3000/up",
      "curl --data-urlencode name@src/a.ts http://localhost:3000/up",
      "curl --data-urlencode @src/a.ts http://localhost:3000/up",
      "curl --json @src/a.ts http://localhost:3000/up",
      "curl -H @src/a.ts http://localhost:3000/up",
      "curl -b src/a.ts http://localhost:3000/up",
      "curl -K src/a.ts http://localhost:3000/up",
      "curl -d @- http://localhost:3000/up",
      "wget --post-file=src/a.ts http://localhost:3000/up",
      "wget --body-file src/a.ts http://localhost:3000/up",
      "http POST :3000/up file@src/a.ts",
      "http POST :3000/up body=@src/a.ts",
      "http POST :3000/up data:=@src/a.ts",
      "http POST :3000/up X-Key:@src/a.ts",
      "xh --form :3000/up file@src/a.ts",
    ]
    for (const command of forms) expectKept(await sh(command, dir), ["D", "outward"], RUNS("outward", "localhost:3000"))
  })

  test("stdin from a file, or httpie reading a pipe, stays held", async () => {
    expectKept(await sh("curl -d @- http://localhost:3000/up < src/a.ts", dir), ["D", "outward"], RUNS("outward", "localhost:3000"))
    expectKept(await sh("curl http://localhost:3000/up < src/a.ts", dir), ["D", "outward"], RUNS("outward", "localhost:3000"))
    expectKept(await sh("http POST :3000/up < src/a.ts", dir), ["D", "outward"], RUNS("outward", "localhost:3000"))
    expectKept(await sh("cat src/a.ts | http POST :3000/up", dir), ["D", "outward"], RUNS("outward", "localhost:3000"))
    // Told to ignore stdin, a pipe into it sends nothing more.
    expectOpens(await sh("echo hi | http --ignore-stdin POST :3000/up a=1", dir), "localhost:3000")
  })

  test("near misses that send no file open", async () => {
    expectOpens(await sh("curl -F name=value http://localhost:3000/up", dir), "localhost:3000")
    expectOpens(await sh("curl -d 'email=a@b.io' http://localhost:3000/up", dir), "localhost:3000")
    expectOpens(await sh("curl -b 'session=abc' http://localhost:3000/up", dir), "localhost:3000")
    expectOpens(await sh("http POST :3000/up email=a@b.io", dir), "localhost:3000")
  })
})

describe("F26 item 3: push, publish, image push, deploy", () => {
  test("git push without force to a remote the snapshot knew, rechecked, opens with the remote name", async () => {
    expectOpens(await sh("git push origin main", dir, pushing(dir, ok(dir))), "origin")
    expectOpens(await sh("git push -u origin topic", dir, pushing(dir, ok(dir))), "origin")
    // No `gh` login for the host: git uses its own credentials.
    expectOpens(await sh("git push origin main", dir, pushing(dir, { ok: false, reason: "no_credential" })), "origin")
    // No remote named: the repository's only one.
    expectOpens(await sh("git push", dir, pushing(dir, ok(dir))), "origin")
    expectOpens(await sh("git add -A && git commit -m x && git push origin main", dir, pushing(dir, ok(dir))), "origin")
  })

  test("the gate rechecks the remote the consent would push to", async () => {
    const snap = snapshotOf(dir)
    expect(AutonomyTable.consentPushTarget(await sh("git push", dir), snap)).toEqual({ repo: dir, remote: "origin" })
    expect(AutonomyTable.consentPushTarget(await sh("bun test && git push origin", dir), snap)).toEqual({ repo: dir, remote: "origin" })
    expect(AutonomyTable.consentPushTarget(await sh("git push", dir), snapshotOf(dir, ["origin", "fork"]))).toBeUndefined()
    expect(AutonomyTable.consentPushTarget(await sh("git push evil main", dir), snap)).toBeUndefined()
  })

  test("an unknown remote, a URL, --repo, a changed remote, no recheck or two remotes and none named keep the hold", async () => {
    // 1.1.1 F30 (G12-7): a name that is no remote of the repository is refused, as a URL is.
    expectKept(await sh("git push evil main", dir, pushing(dir, ok(dir))), ["X", "credential_change"], REFUSED("credential_change", undefined, CREDENTIAL_CHANGE))
    expectKept(await sh("git push origin main", dir, pushing(dir, { ok: false, reason: "url_changed" })), ["D", "outward"], RUNS("outward", "origin"))
    expectKept(await sh("git push origin main", dir, pushing(dir, { ok: false, reason: "account_changed" })), ["D", "outward"], RUNS("outward", "origin"))
    expectKept(await sh("git push origin main", dir, { allowed: [], snapshot: snapshotOf(dir) }), ["D", "outward"], RUNS("outward", "origin"))
    expectKept(await sh("git push origin main", dir), ["D", "outward"], RUNS("outward", "origin"))
    expectKept(await sh("git push", dir, pushing(dir, ok(dir), ["origin", "fork"])), ["D", "outward"], RUNS("outward"))
    expectKept(await sh("git push --repo=origin", dir, pushing(dir, ok(dir))), ["D", "outward"], RUNS("outward"))
    expectKept(await sh("git push https://github.com/x/y main", dir, pushing(dir, ok(dir))), ["X", "credential_change"], REFUSED("credential_change", undefined, CREDENTIAL_CHANGE))
  })

  test("force, mirror, delete and history rewrites stay refused", async () => {
    for (const command of [
      "git push --force origin main",
      "git push -f origin main",
      "git push --force-with-lease origin main",
      "git push origin +main",
      "git push --mirror origin",
      "git push --delete origin topic",
      "git push origin :topic",
    ])
      expectKept(await sh(command, dir, pushing(dir, ok(dir))), ["X", "irreversible"], REFUSED("irreversible", undefined, IRREVERSIBLE_ARCHIVE))
  })

  test("publish, image push, deploy, pull request and release open with their target", async () => {
    expectOpens(await sh("npm publish", dir), "registry.npmjs.org")
    // 1.1.1 F33 (P49 3): a registry option holds, also when the person named that registry.
    expectHeldSend(await sh("npm publish --access public --registry https://npm.acme.io/", dir, named("npm.acme.io")), RUNS("outward"))
    expectOpens(await sh("npm publish --access public", dir), "registry.npmjs.org")
    expectOpens(await sh("bun publish", dir), "registry.npmjs.org")
    expectOpens(await sh("pnpm publish", dir), "registry.npmjs.org")
    // 1.1.1 F33 (P49 3): each publisher opens beside its own root manifest.
    const crate = await temp()
    await gitInit(crate)
    write(crate, "Cargo.toml", '[package]\nname = "x"\nversion = "0.1.0"\n')
    expectOpens(await sh("cargo publish", crate), "crates.io")
    const python = await temp()
    await gitInit(python)
    write(python, "pyproject.toml", '[project]\nname = "x"\nversion = "0.1.0"\n')
    expectOpens(await sh("poetry publish", python), "pypi.org")
    expectOpens(await sh("uv publish", python), "pypi.org")
    expectOpens(await sh("twine upload dist/x.whl", dir), "pypi.org")
    expectOpens(await sh("docker push ghcr.io/acme/app:1", dir), "ghcr.io/acme/app:1")
    expectOpens(await sh("podman push ghcr.io/acme/app:1", dir), "ghcr.io/acme/app:1")
    expectOpens(await sh("vercel deploy --prod", dir), "vercel")
    // 1.1.1 F30 (P46): netlify builds before a deploy unless told not to; only `--no-build` opens. 1.1.1 F33 (P49 3): with
    // a `--dir` inside the project.
    expectOpens(await sh("netlify deploy --prod --no-build --dir dist", dir), "netlify")
    expectOpens(await sh("fly deploy", dir), "fly.io")
    expectOpens(await sh("gh pr create --fill", dir), "github pr")
    expectOpens(await sh("gh release create v1.0.0 --notes 'first'", dir), "github release")
  })

  test("a publish hook nobody can vouch for, a local build hook, notes or assets from disk keep the hold; vercel rm is refused (T9 G3)", async () => {
    const other = await temp()
    await gitInit(other)
    write(other, "package.json", JSON.stringify({ name: "q", version: "1.0.0", scripts: { prepublishOnly: "node scripts/evil.js" } }))
    expectHeldSend(await sh("npm publish", other), RUNS("outward_not_in_mission", "registry.npmjs.org"))
    write(other, "firebase.json", JSON.stringify({ hosting: { predeploy: ["node x.js"] } }))
    expectHeldSend(await sh("firebase deploy", other), RUNS("outward"))
    expectHeldSend(await sh("netlify deploy --build", dir), RUNS("outward"))
    expectHeldSend(await sh("gh pr create --body-file notes.md", dir), RUNS("outward"))
    expectHeldSend(await sh("gh release create v1 dist/app.tgz", dir), RUNS("outward"))
    expectHeldSend(await sh("gh release create v1 --notes-file notes.md", dir), RUNS("outward"))
    // 1.1.3 (T9 G3, T10): `vercel rm` deletes a remote resource, so it is refused at once with the archive way.
    expectHeldSend(await sh("vercel rm my-app", dir), REFUSED("irreversible", "outward", IRREVERSIBLE_ARCHIVE))
    expectHeldSend(await sh("npm publish ../elsewhere", dir), RUNS("outward"))
  })

  test("firebase deploy without hooks opens", async () => {
    const other = await temp()
    await gitInit(other)
    write(other, "firebase.json", JSON.stringify({ hosting: { public: "dist" } }))
    // 1.1.1 F33 (P49 3): only `--only hosting` opens.
    expectOpens(await sh("firebase deploy --only hosting --project demo", other), "firebase demo")
  })
})

describe("F26 item 4: the destination is on the verdict the gate records", () => {
  test("a compound call records every place it sends to", async () => {
    expectOpens(await sh("curl -s http://localhost:3000 && curl -s http://db:8080", dir), "localhost:3000, db:8080")
    expectOpens(await sh("npm publish && git push origin main", dir, pushing(dir, ok(dir))), "registry.npmjs.org, origin")
  })

  test("a call that sends nowhere carries none", async () => {
    const verdict = root(await sh("git add -A", dir))
    expect(verdict.destination).toBeUndefined()
    expect(AutonomyTable.consentOutward({ ...(await sh("git add -A", dir)), bypass: { caller: "root" } })).toBeUndefined()
  })
})

describe("F26 host rule", () => {
  test("localHost", () => {
    for (const host of ["localhost", "LOCALHOST.", "127.0.0.1", "127.9.9.9", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "::1", "[::1]", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:7f00:1", "db", "my_service", "x.local", "x.test", "x.localhost"])
      expect([host, OutwardConsent.localHost(host)]).toEqual([host, true])
    for (const host of ["172.32.0.1", "172.15.0.1", "100.64.0.1", "100.102.23.27", "8.8.8.8", "example.com", "local.example.com", "2001:db8::1", "::ffff:808:808", "12345", "x.internal", "169.254.169.254", "fd00:ec2::254", "169.254.1.1", "169.254.170.2", "fd00:ec2::23", "metadata", "instance-data"])
      expect([host, OutwardConsent.localHost(host)]).toEqual([host, false])
  })
})

describe("P43: the formatter link scan skips folders the tool never walks", () => {
  test("node_modules, .venv and venv are skipped for every scanned tool; the tool's own defaults too", async () => {
    const at = await temp()
    write(at, "src/a.py", "x = 1\n")
    write(at, "outside/f.txt", "x")
    for (const folder of ["node_modules/.bin", ".venv/bin", "venv/bin", "build/lib", "_tools", "target/debug"]) {
      fs.mkdirSync(path.join(at, folder), { recursive: true })
      fs.symlinkSync(path.join(at, "outside"), path.join(at, folder, "lnk"))
    }
    expect(Reach.linkBelow(at, Reach.LINK_SCAN_CAP, "eslint")).toBe(true) // build, _tools and target are not eslint's
    fs.rmSync(path.join(at, "build"), { recursive: true })
    fs.rmSync(path.join(at, "_tools"), { recursive: true })
    expect(Reach.linkBelow(at, Reach.LINK_SCAN_CAP, "cargo")).toBe(false)
    expect(Reach.linkBelow(at, Reach.LINK_SCAN_CAP, "eslint")).toBe(true) // target
    fs.rmSync(path.join(at, "target"), { recursive: true })
    for (const tool of ["eslint", "biome", "black", "ruff", "go", "cargo"])
      expect([tool, Reach.linkBelow(at, Reach.LINK_SCAN_CAP, tool)]).toEqual([tool, false])
    fs.mkdirSync(path.join(at, "build"))
    fs.symlinkSync(path.join(at, "outside"), path.join(at, "build", "lnk"))
    expect(Reach.linkBelow(at, Reach.LINK_SCAN_CAP, "black")).toBe(false)
    expect(Reach.linkBelow(at, Reach.LINK_SCAN_CAP, "ruff")).toBe(false)
    expect(Reach.linkBelow(at, Reach.LINK_SCAN_CAP, "eslint")).toBe(true)
    // A link anywhere the tool walks is still found.
    fs.symlinkSync(path.join(at, "outside"), path.join(at, "src", "lnk"))
    expect(Reach.linkBelow(at, Reach.LINK_SCAN_CAP, "black")).toBe(true)
  })

  test("eslint --fix . at a project root with links only under node_modules opens under consent", async () => {
    const at = await temp()
    await gitInit(at)
    write(at, "src/a.ts", "export const a = 1\n")
    write(at, "package.json", JSON.stringify({ name: "p", version: "1.0.0" }))
    write(at, "node_modules/eslint/package.json", "{}")
    fs.mkdirSync(path.join(at, "node_modules/.bin"), { recursive: true })
    fs.symlinkSync("../eslint/package.json", path.join(at, "node_modules/.bin/eslint"))
    const given = await sh("npx eslint --fix .", at)
    expect(short(root(given)).slice(0, 2)).toEqual(["A", "by_main_agent"])
    fs.symlinkSync("/tmp", path.join(at, "src", "lnk"))
    // Not opened by the overlay; 1.1.3 (matrix rows 8, 22): that kept verdict no longer waits, it runs as the main agent's.
    const linked = await sh("npx eslint --fix .", at)
    expect(base(linked).class).not.toBe("A")
    expectWant("npx eslint --fix . (linked)", root(linked), RUNS("not_routine"))
  })
})
