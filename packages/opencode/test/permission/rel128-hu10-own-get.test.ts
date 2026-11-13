// 1.2.8 row 28 (H-U10, AC-HU10, N8-315; SR8-01/02/03, decisions C5 and C13). Under the person's consent (root or
// subagent) a call to Swarm's own server is class A `own_api_read` (N8-386), run by the gate without the main agent, only
// when all of these hold: the method is GET or HEAD as read from its words; the route is on `OWN_API_READ_ROUTES`
// (N8-387, 01_specs §3.3, mapped to the exact registered paths, OP20-10); no `directory`/`workspace` query parameter or
// `x-opencode-directory`/`x-opencode-workspace` header, or a directory inside the caller's worktree; every option is on
// `OWN_API_READ_OPTIONS` (N8-388) with one URL and no `--next`. Every other own-server call keeps its 1.2.7 verdict: the
// same answer as the same call to a port that is not Swarm's (the twin), or X `own_api` for a person-only route. With the
// mode off nothing changes (C5, U10). Also pinned: the person-only entries of P-3, `PERSON_ONLY_WRITES` /skill (AC-SKd)
// and `PERSON_ONLY_ROUTES` /project/rehome (AC-PROJi). Red at BASE: no `own_api_read`; `PUT /skill` and
// `POST /project/rehome` were not person-only. Synthetic values only: no server is contacted, home is a fresh mkdtemp.
//
// Run targeted: cd packages/opencode && bun test test/permission/rel128-hu10-own-get.test.ts

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import * as osModule from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import type { InstanceContext } from "../../src/project/instance-context"
import { SelfAddress } from "../../src/server/self-address"
import { tmpdir } from "../fixture/fixture"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

const PORT = 47286
const SELF = { hostname: "127.0.0.1", port: PORT }
const OWN = `http://127.0.0.1:${PORT}`
const READ: Verdict = { class: "A", decidedBy: "gate", category: "own_api_read" as Verdict["category"] }
const OWN_API: Verdict = { class: "X", decidedBy: "gate", category: "own_api" }

let fixture: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext
let home: string
let spies: { mockRestore(): void }[] = []
const savedEnv = {
  CURL_HOME: process.env.CURL_HOME,
  WGETRC: process.env.WGETRC,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  HTTPIE_CONFIG_DIR: process.env.HTTPIE_CONFIG_DIR,
  XH_CONFIG_DIR: process.env.XH_CONFIG_DIR,
}

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  dir = fixture.path
  mkdirSync(path.join(dir, "sub"), { recursive: true })
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  for (const name of Object.keys(savedEnv)) delete process.env[name]
})
afterAll(async () => {
  for (const [name, value] of Object.entries(savedEnv))
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  await fixture[Symbol.asyncDispose]()
})
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "hu10h-"))
  spies = [spyOn(os, "homedir").mockReturnValue(home), spyOn(osModule, "homedir").mockReturnValue(home)]
  SelfAddress.add(SELF)
})
afterEach(() => {
  SelfAddress.remove(SELF)
  for (const spy of spies) spy.mockRestore()
  rmSync(home, { recursive: true, force: true })
})

const request = (permission: string, fields: Partial<Input> = {}): Input => ({
  permission,
  patterns: ["*"],
  metadata: {},
  instance,
  cwd: dir,
  canUndo: true,
  folder: "clean",
  ...fields,
})
const bash = (command: string) => request("bash", { patterns: [command], metadata: { command } })
const fetchOf = (url: string) => request("webfetch", { patterns: [url], metadata: { url } })
const label = (input: Input) => String(input.metadata.command ?? input.metadata.url)
const consented = (input: Input, caller: "root" | "subagent") => AutonomyTable.classify({ ...input, bypass: { caller } })
/** The same call to a port that is not Swarm's, as 47k's `expectRuns` builds it. */
const twinOf = (input: Input) => {
  const other = (value: string) => value.replaceAll(String(PORT), String(PORT + 1))
  return input.permission === "webfetch" ? fetchOf(other(label(input))) : bash(other(String(input.metadata.command)))
}
const same = (verdict: Verdict) => JSON.stringify(verdict).replaceAll(String(PORT + 1), String(PORT))

/** Class A `own_api_read` for root and subagent under consent; with the mode off the 1.2.7 verdict (the twin's). */
const expectRead = (input: Input) => {
  for (const caller of ["root", "subagent"] as const)
    expect({ call: label(input), caller, ...consented(input, caller) }).toEqual({ call: label(input), caller, ...READ })
  expect([label(input), "mode off", JSON.stringify(AutonomyTable.classify(input))]).toEqual([
    label(input),
    "mode off",
    same(AutonomyTable.classify(twinOf(input))),
  ])
}
/**
 * Not `own_api_read`: the 1.2.7 verdict, which is the twin's under consent and with the mode off, or the 1.2.7 X `own_api`
 * for a form whose route cannot be read (`--next`, a header file) in every layer. Under consent the twin is usually A
 * `by_main_agent` (decided by the main agent, not the gate), which is what "non-A" means in AC-HU10.
 */
const expectKept = (input: Input) => {
  if (AutonomyTable.classify(input).category === "own_api") {
    for (const caller of ["root", "subagent"] as const)
      expect([label(input), caller, consented(input, caller).category]).toEqual([label(input), caller, "own_api"])
    return
  }
  for (const caller of ["root", "subagent"] as const) {
    const verdict = consented(input, caller)
    expect([label(input), caller, verdict.category === ("own_api_read" as string)]).toEqual([label(input), caller, false])
    expect([label(input), caller, JSON.stringify(verdict)]).toEqual([
      label(input),
      caller,
      same(consented(twinOf(input), caller)),
    ])
  }
  expect([label(input), "mode off", JSON.stringify(AutonomyTable.classify(input))]).toEqual([
    label(input),
    "mode off",
    same(AutonomyTable.classify(twinOf(input))),
  ])
}
const expectRefused = (input: Input) => {
  for (const verdict of [AutonomyTable.classify(input), consented(input, "root"), consented(input, "subagent")])
    expect({ call: label(input), ...verdict }).toEqual({ call: label(input), ...OWN_API })
}

describe("AC-HU10: listed GET/HEAD routes with listed options are class A own_api_read under consent", () => {
  test("curl on every route of the list", () => {
    for (const route of [
      "/global/health",
      "/global/agents",
      "/session",
      "/session/status",
      "/session/ses_1",
      "/session/ses_1/children",
      "/session/ses_1/todo",
      "/session/ses_1/message",
      "/session/ses_1/message/msg_1",
      "/session/ses_1/diff",
      "/project",
      "/project/current",
      "/path",
      "/vcs",
      "/vcs/status",
      "/vcs/diff",
      "/agent",
      "/command",
      "/skill",
      "/skill/drafts",
      "/skill/source?scope=project&name=a",
      "/lsp",
      "/formatter",
      "/mcp",
      "/question",
      "/permission",
      "/memory/vault",
    ])
      expectRead(bash(`curl -s '${OWN}${route}'`))
  })
  test("the spec's red case at BASE: health on localhost, the session list, a webfetch", () => {
    expectRead(bash(`curl -s http://localhost:${PORT}/global/health`))
    expectRead(bash(`curl -s ${OWN}/session`))
    expectRead(fetchOf(`${OWN}/session`))
  })
  test("every listed option: -s -S -f -i -I -v -m/--max-time --connect-timeout --compressed -H, -G without data", () => {
    for (const command of [
      `curl ${OWN}/session`,
      `curl -sSfiv ${OWN}/session`,
      `curl -I ${OWN}/global/health`,
      `curl -s -m 5 ${OWN}/session`,
      `curl -s -m5 ${OWN}/session`,
      `curl -s --max-time 5 ${OWN}/session`,
      `curl -s --connect-timeout 2 ${OWN}/session`,
      `curl -s --compressed ${OWN}/session`,
      `curl -s -H 'accept: application/json' ${OWN}/session`,
      `curl -s -G ${OWN}/session`,
    ])
      expectRead(bash(command))
  })
  test("httpie and xh: GET/HEAD, query items a==b, header items a:b", () => {
    for (const command of [
      `http :${PORT}/session`,
      `http GET :${PORT}/session limit==5`,
      `https HEAD 127.0.0.1:${PORT}/global/health`,
      `xh GET :${PORT}/session/ses_1/message accept:application/json`,
      `xh ${OWN}/project/current`,
    ])
      expectRead(bash(command))
  })
  test("directory rule: a directory inside the caller's worktree is still A", () => {
    expectRead(bash(`curl -s '${OWN}/vcs/status?directory=${dir}'`))
    expectRead(bash(`curl -s '${OWN}/vcs/status?directory=${path.join(dir, "sub")}'`))
    expectRead(bash(`curl -s -H 'x-opencode-directory: ${dir}' ${OWN}/path`))
    expectRead(bash(`http :${PORT}/path directory==${dir}`))
  })
})

describe("AC-HU10 red cases (SR8-01): routes off the list keep their 1.2.7 verdict", () => {
  test("file content with a directory override, find, config, global config, memory, provider auth, experimental", () => {
    for (const route of [
      `/file/content?directory=${encodeURIComponent(path.join(home, ".local/share/swarm"))}&path=auth.json`,
      "/file/content?path=auth.json",
      "/find?pattern=key",
      "/find/file?query=a",
      "/find/symbol?query=a",
      "/config",
      "/config/providers",
      "/global/config",
      "/memory",
      "/provider",
      "/provider/auth",
      "/experimental/resource",
      "/experimental/tool",
      "/event",
      "/global/event",
      "/autonomy/session",
      "/pty",
      "/saved-command",
      "/experimental/workspace",
      "/vcs/diff/raw",
      "/session/ses_1/message/msg_1/part",
      "/experimental/workspace/w1/session",
      "/",
    ])
      expectKept(bash(`curl -s '${OWN}${route}'`))
    expectKept(fetchOf(`${OWN}/config`))
    expectKept(fetchOf(`${OWN}/file/content?path=auth.json`))
  })
  test("directory rule: a directory or workspace outside the caller's worktree", () => {
    for (const command of [
      `curl -s '${OWN}/session?directory=${home}'`,
      `curl -s '${OWN}/session?directory=/'`,
      `curl -s '${OWN}/session?directory=${dir}/../x'`,
      `curl -s '${OWN}/session?directory=sub'`,
      `curl -s '${OWN}/session?%64irectory=${home}'`,
      `curl -s '${OWN}/session?workspace=wrk_1'`,
      `curl -s -H 'x-opencode-directory: ${home}' ${OWN}/session`,
      `curl -s -H 'X-Opencode-Directory: /' ${OWN}/session`,
      `curl -s -H 'x-opencode-workspace: wrk_1' ${OWN}/session`,
      `curl -s -H @headers.txt ${OWN}/session`,
      `http :${PORT}/session directory==${home}`,
      `http :${PORT}/session x-opencode-directory:${home}`,
    ])
      expectKept(bash(command))
    expectKept(fetchOf(`${OWN}/session?directory=${home}`))
  })
})

describe("AC-HU10 red cases (SR8-02): an option off the list keeps the 1.2.7 verdict", () => {
  test("curl options that write, send, or change the request", () => {
    for (const command of [
      `curl -s -o f ${OWN}/session`,
      `curl -s -O ${OWN}/session`,
      `curl -s --output-dir d -O ${OWN}/session`,
      `curl -s -D f ${OWN}/session`,
      `curl -s -c f ${OWN}/session`,
      `curl -s --trace f ${OWN}/session`,
      `curl -s --json '{}' ${OWN}/session`,
      `curl -s -F a=b ${OWN}/session`,
      `curl -s -G -d a=b ${OWN}/session`,
      `curl -s ${OWN}/session --next ${OWN}/session`,
      `curl -s ${OWN}/session ${OWN}/project`,
      `curl -s -X GET ${OWN}/session`,
      `curl -s --silent ${OWN}/session`,
      `curl -s -H 'X-HTTP-Method-Override: DELETE' ${OWN}/session`,
      `curl -s ${OWN}/session > out.json`,
      `curl -s ${OWN}/session | tee out.json`,
      `curl -s ${OWN}/session; echo done`,
      `H=127.0.0.1; curl -s $H:${PORT}/session`,
      `curl -s "${OWN}/session?x=$(id)"`,
      `./curl -s ${OWN}/session`,
      `wget -qO- ${OWN}/session`,
      // Only one plain command qualifies; a wrapper keeps the 1.2.7 verdict (the main agent decides under consent).
      `sh -c 'curl -s ${OWN}/session'`,
      `env curl -s ${OWN}/session`,
      `rtk curl -s ${OWN}/session`,
    ])
      expectKept(bash(command))
  })
  test("httpie and xh options and items that write, send, or post", () => {
    for (const command of [
      `http :${PORT}/session a=b`,
      `http :${PORT}/session a:=1`,
      `http :${PORT}/session a@file`,
      `http --download :${PORT}/session`,
      `http --session=s :${PORT}/session`,
      `http -o f :${PORT}/session`,
      `http POST :${PORT}/session`,
      `xh --offline :${PORT}/session`,
    ])
      expectKept(bash(command))
  })
  test("a user curl config makes curl read options nobody wrote on the line", () => {
    const rc = path.join(home, ".curlrc")
    writeFileSync(rc, "output = stolen.json\n")
    expectKept(bash(`curl -s ${OWN}/session`))
  })
})

describe("AC-HU10: person-only routes stay X own_api; other forms keep their verdicts", () => {
  test("person-only reads stay refused in every layer", () => {
    for (const command of [`curl -s ${OWN}/autonomy/mode`, `curl -s ${OWN}/project/trust`, `curl -s ${OWN}/session/ses_1/autonomy/consent`])
      expectRefused(bash(command))
  })
  test("a write to a listed route is not A own_api_read", () => {
    for (const command of [`curl -s -X POST ${OWN}/session`, `curl -s -X DELETE ${OWN}/session/ses_1`, `http POST :${PORT}/question`])
      for (const caller of ["root", "subagent"] as const)
        expect([command, consented(bash(command), caller).category]).not.toEqual([command, "own_api_read"])
  })
  test("no listener: nothing is own_api_read", () => {
    SelfAddress.remove(SELF)
    for (const caller of ["root", "subagent"] as const)
      expect(consented(bash(`curl -s ${OWN}/session`), caller).category).not.toBe("own_api_read" as string)
  })
})

describe("P-3 person-only entries (AC-SKd, AC-PROJi contributors)", () => {
  test("PERSON_ONLY_WRITES /skill: agent PUT/DELETE/POST under /skill are person-only; the three GETs are not", () => {
    for (const [method, route] of [
      ["PUT", "/skill"],
      ["DELETE", "/skill"],
      ["POST", "/skill/drafts/x/approve"],
      ["DELETE", "/skill/drafts/x"],
      [undefined, "/skill"],
    ] as const)
      expect([method, route, AutonomyTable.personOnlyRoute({ method, path: route })]).toEqual([method, route, true])
    for (const route of ["/skill", "/skill/drafts", "/skill/source"])
      expect([route, AutonomyTable.personOnlyRoute({ method: "GET", path: route })]).toEqual([route, false])
    expect(AutonomyTable.personOnlyRoute({ method: "PUT", path: "/skills" })).toBe(false)
    expectRefused(bash(`curl -s -X PUT ${OWN}/skill -d '{}'`))
    expectRefused(bash(`curl -s -X DELETE '${OWN}/skill?scope=project&name=a'`))
  })
  test("PERSON_ONLY_ROUTES /project/rehome: any method", () => {
    for (const method of ["POST", "GET", "HEAD", undefined])
      expect([method, AutonomyTable.personOnlyRoute({ method, path: "/project/rehome" })]).toEqual([method, true])
    expect(AutonomyTable.personOnlyRoute({ method: "POST", path: "/experimental/workspace/w1/project/rehome/" })).toBe(true)
    expect(AutonomyTable.personOnlyRoute({ method: "GET", path: "/project/rehomed" })).toBe(false)
    expectRefused(bash(`curl -s -X POST ${OWN}/project/rehome -d '{}'`))
    expectRefused(bash(`curl -s ${OWN}/project/rehome`))
  })
})

describe("OP20-10: the lists are pinned and every route is a registered GET path", () => {
  test("OWN_API_READ_ROUTES maps to exact server paths (the list may only shrink)", async () => {
    const own = await import("../../src/permission/autonomy-parts/own-api")
    expect(own.OWN_API_READ_ROUTES.map((entry) => entry.route)).toEqual([
      "/global/health",
      "/global/agents",
      "/session",
      "/session/status",
      "/session/:sessionID",
      "/session/:sessionID/children",
      "/session/:sessionID/todo",
      "/session/:sessionID/message",
      "/session/:sessionID/message/:messageID",
      "/session/:sessionID/diff",
      "/project",
      "/project/current",
      "/path",
      "/vcs",
      "/vcs/status",
      "/vcs/diff",
      "/agent",
      "/command",
      "/skill",
      "/skill/drafts",
      "/skill/source",
      "/lsp",
      "/formatter",
      "/mcp",
      "/question",
      "/permission",
      "/memory/vault",
    ])
    const openapi = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../../sdk/openapi.json", import.meta.url)), "utf8"),
    ) as { paths: Record<string, Record<string, unknown>> }
    for (const { route } of own.OWN_API_READ_ROUTES) {
      // Row 43e adds GET /memory/vault (AC-OBSe pins it on this list); until then it has no path in the contract.
      if (route === "/memory/vault" && openapi.paths["/memory/vault"] === undefined) continue
      const key = route.replace(/:(\w+)/g, "{$1}")
      expect([route, openapi.paths[key]?.get !== undefined]).toEqual([route, true])
    }
    // Each pattern matches its own path (with sample ids) and nothing longer.
    for (const { route, pattern } of own.OWN_API_READ_ROUTES) {
      const sample = route.replace(/:\w+/g, "id_1")
      expect([route, pattern.test(sample), pattern.test(`${sample}/x`), pattern.test(`/x${sample}`)]).toEqual([
        route,
        true,
        false,
        false,
      ])
    }
  })
  test("OWN_API_READ_OPTIONS is the N8-388 list", async () => {
    const { NetOptions } = await import("../../src/permission/net-options")
    const options = (NetOptions as unknown as Record<string, unknown>).OWN_API_READ_OPTIONS as {
      curl: { flags: readonly string[]; values: readonly string[] }
      httpie: { methods: readonly string[]; items: readonly string[] }
    }
    expect({
      curlFlags: [...options.curl.flags],
      curlValues: [...options.curl.values],
      httpieMethods: [...options.httpie.methods],
      httpieItems: [...options.httpie.items],
    }).toEqual({
      curlFlags: ["-s", "-S", "-f", "-i", "-I", "-v", "-G", "--compressed"],
      curlValues: ["-m", "--max-time", "--connect-timeout", "-H"],
      httpieMethods: ["GET", "HEAD"],
      httpieItems: ["a==b", "a:b"],
    })
  })
})
