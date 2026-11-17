import { describe, expect, test } from "bun:test"
import path from "node:path"
import { detectTextCall, type TextCallTool } from "../../src/session/text-call"

// MC-1 (1.3.3 row 10): the text-call detector.
//
// Where the fixtures come from
// - "recorded R1": text parts found in the session database on 2026-11-17 (8 parts, all of the markup form; extract
//   `research/replay/R1_opencode_calls/r1_text_form_calls.jsonl` of the patch task folder). Tool names, parameter names,
//   parameter order, whitespace and the JSON structure are as recorded. Every free-text value (mission ids, titles, paths,
//   verification sentences, figure labels) is replaced with a synthetic one, and row lists are cut to one or two rows.
// - "recorded R13": provider captures in `research/mc1_raw/` (r15, r16, r17, r18, r28, r28_rep1, r28_rep2, r29). Their
//   content was synthetic when captured and is used verbatim.
// - "constructed": written for this test from a description; nothing of that form was found in the database.
//
// The schemas are the synthetic ones the R13 requests sent (`r09_*.request.json`), plus one written here for
// `studio_figure_revise`. They are not the real Studio schemas.

const DS = "datum-studio"

const missionCreate = {
  type: "object",
  properties: {
    dryRun: { type: "boolean" },
    mission: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        type: { type: "string" },
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, title: { type: "string" }, status: { type: "string" } },
            required: ["id", "title"],
          },
        },
      },
      required: ["id", "title", "rows"],
    },
  },
  required: ["mission"],
}

const tools: TextCallTool[] = [
  { name: "read", schema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } },
  {
    name: "bash",
    schema: {
      type: "object",
      properties: { command: { type: "string" }, description: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
  { name: `${DS}_studio_mission_create`, schema: missionCreate },
  {
    name: `${DS}_studio_mission_set_status`,
    schema: { type: "object", properties: { mission: { type: "string" }, to: { type: "string" } }, required: ["mission", "to"] },
  },
  {
    name: `${DS}_studio_figure_revise`,
    schema: {
      type: "object",
      properties: { pid: { type: "string" }, patch: { type: "object" }, change: { type: "object" } },
      required: ["pid", "patch"],
    },
  },
  {
    name: `${DS}_demo_route_list`,
    schema: { type: "object", properties: { id: { type: "string" }, note: { type: "string" } }, required: ["id"] },
  },
]

/** The picture after the Studio server lost its tools (R13 "drop_mission_tools"): the other tools are still listed. */
const withoutStudio = tools.filter((tool) => !tool.name.startsWith(`${DS}_studio_`))

const detect = (text: string, extra: { tools?: TextCallTool[]; hasToolCalls?: boolean; servers?: string[] } = {}) =>
  detectTextCall({ text, tools: extra.tools ?? tools, hasToolCalls: extra.hasToolCalls, servers: extra.servers ?? [DS] })

type Row = Record<string, unknown>
const row = (id: string, more: Row = {}): Row => ({
  id,
  phase: "brief",
  kind: "intake",
  title: `Synthetic row ${id}`,
  agent: "data-collector",
  model: { tier: "worker-fast", reason: "synthetic reason" },
  deps: [],
  size: "S",
  status: "pending",
  output: `out/synthetic-${id}.md`,
  verification: "synthetic check",
  ...more,
})

/** The recorded layout: every tag on its own line, values as the model wrote them (JSON with ", " and ": "). */
const pyJson = (value: unknown) =>
  JSON.stringify(value, null, 1)
    .replace(/\n\s*/g, " ")
    .replace(/([[{]) /g, "$1")
    .replace(/ ([\]}])/g, "$1")
const markup = (name: string, params: Array<[string, string]>, lead = "\n\n") =>
  `${lead}<tool_call>\n<function=${name}>\n${params.map(([k, v]) => `<parameter=${k}>\n${v}\n</parameter>\n`).join("")}</function>\n</tool_call>`

const mission = (slug: string, rows: Row[], more: Row = {}) => ({
  id: `2026-01-01_${slug}`,
  title: `Synthetic mission ${slug}`,
  type: "document",
  owner: "swarm-workflow",
  ...more,
  rows,
})

// --- recorded R1 (8 text parts; last six characters of the part id) -------------------------------------------------
const R1 = {
  // unprefixed name, dryRun then mission, one row, three leading newlines
  GSMGkO: markup(
    "studio_mission_create",
    [
      ["dryRun", "true"],
      ["mission", pyJson(mission("probe", [row("1", { agent: "planner", model: { tier: "thinker" } })], { type: "research" }))],
    ],
    "\n\n\n",
  ),
  // prefixed name; the header lost its ">" and the opening tag of the first parameter (the large figure spec)
  CFz7VA: `\n\n<tool_call>\n<function=${DS}_studio_figure_revise\n</parameter>\n<parameter=change>\n${pyJson({
    impact: "synthetic impact",
    what: "synthetic what",
    why: "synthetic why",
  })}\n</parameter>\n<parameter=pid>\np-synthetic01\n</parameter>\n<parameter=patch>\n${pyJson({
    spec: {
      direction: "TB",
      edges: [
        { from: "f1", kind: "data", label: "synthetic", to: "a1" },
        { from: "f2", kind: "data", label: "synthetic", to: "a2" },
      ],
      nodes: [
        { class: {}, id: "f1", label: "Synthetic node" },
        { class: {}, id: "x1", label: "Synthetic offpage", shape: "offpage" },
      ],
    },
  })}\n</parameter>\n</function>\n</tool_call>`,
  // unprefixed, dryRun then mission, mission.project.dir present
  cxuJWn: markup("studio_mission_create", [
    ["dryRun", "true"],
    ["mission", pyJson(mission("p5", [row("1", { kind: "research" }), row("2")], { project: { dir: "/synthetic/project" } }))],
  ]),
  c0DAdE: markup("studio_mission_create", [
    ["dryRun", "true"],
    ["mission", pyJson(mission("p1", [row("1"), row("2")], { project: { dir: "/synthetic/project" } }))],
  ]),
  // unprefixed, mission only (no dryRun parameter)
  cPgEl4: markup("studio_mission_create", [["mission", pyJson(mission("p2", [row("1", { kind: "research" }), row("2", { kind: "spec" })]))]]),
  OyNdBk: markup("studio_mission_create", [
    ["dryRun", "true"],
    ["mission", pyJson(mission("p3", [row("1"), row("2")]))],
  ]),
  gr7Y69: markup("studio_mission_create", [
    ["mission", pyJson(mission("p3", [row("1", { kind: "research", agent: "planner", model: { tier: "thinker" } })]))],
  ]),
  "2eIcvj": markup("studio_mission_create", [["mission", pyJson(mission("u2", [row("1"), row("2")]))]]),
}

// --- recorded R13 (verbatim; synthetic when captured) ----------------------------------------------------------------
const paint = (dryRun: string, body: string) =>
  `\n\n<tool_call>\n<function=${DS}_studio_mission_create>\n<parameter=dryRun>\n${dryRun}\n</parameter>\n<parameter=mission>\n${body}\n</parameter>\n</function>\n</tool_call>`
const R13 = {
  r15: paint(
    "false",
    '{"id": "2026-02-02_paint-shed", "title": "Paint the shed", "type": "feature-release", "rows": [{"id": "1", "title": "Buy paint", "status": "pending"}, {"id": "2", "title": "Paint walls", "status": "pending"}]}',
  ),
  r28: paint(
    "false",
    '{"id": "2026-02-02_paint-shed", "title": "Paint the shed", "type": "feature-release", "rows": [{"id": "1", "status": "pending", "title": "Buy paint"}, {"id": "2", "status": "pending", "title": "Paint walls"}]}',
  ),
  r28_rep1: paint(
    "False",
    '{"id": "2026-02-02_paint-shed", "title": "Paint the shed", "type": "feature-release", "rows": [{"id": "1", "status": "pending", "title": "Buy paint"}, {"id": "2", "status": "pending", "title": "Paint walls"}]}',
  ),
  r28_rep2: paint(
    "false",
    '{"id": "2026-02-02_paint-shed", "rows": [{"id": "1", "status": "pending", "title": "Buy paint"}, {"id": "2", "status": "pending", "title": "Paint walls"}], "title": "Paint the shed", "type": "feature-release"}',
  ),
  r16: '\n\nstudio_mission_create {"dryRun":true,"mission":{"id":"2026-02',
  r17: '\n\n<tool_call>\n<function=x> labels", "type": "feature-release", "rows": [{"id": "1", "title": "Check </tool_call> text\\nsecond line", "status": "pending"}]}\n</parameter>\n</function>\n</tool_call>',
  r18: '\n\n text\\nsecond line", "status": "pending"}]}\n</parameter>\n</function>\n</tool_call>',
}
const paintMission = {
  id: "2026-02-02_paint-shed",
  title: "Paint the shed",
  type: "feature-release",
  rows: [
    { id: "1", title: "Buy paint", status: "pending" },
    { id: "2", title: "Paint walls", status: "pending" },
  ],
}

const smallMission = { id: "2026-01-01_small", title: "Synthetic small", rows: [{ id: "1", title: "One" }] }

describe("text-call detector: recorded R1 texts (session database, 2026-11-17)", () => {
  test.each(["GSMGkO", "cxuJWn", "c0DAdE", "cPgEl4", "OyNdBk", "gr7Y69", "2eIcvj"] as const)(
    "recorded R1 part %s: unprefixed markup maps to the registered Studio tool",
    (id) => {
      const result = detect(R1[id])
      expect(result).toMatchObject({
        kind: "call",
        form: "markup",
        tool: `${DS}_studio_mission_create`,
        written: "studio_mission_create",
        registered: true,
        server: DS,
      })
      if (result.kind !== "call") throw new Error("unreachable")
      expect((result.args.mission as { id: string }).id).toStartWith("2026-01-01_")
      const hasDryRun = R1[id].includes("<parameter=dryRun>")
      expect(result.args.dryRun).toBe(hasDryRun ? true : undefined)
    },
  )

  test("recorded R1 part CFz7VA: header without '>' and a lost parameter tag is a damaged call that names its tool", () => {
    expect(detect(R1.CFz7VA)).toEqual({
      kind: "damaged",
      form: "markup",
      tool: `${DS}_studio_figure_revise`,
      written: `${DS}_studio_figure_revise`,
      registered: true,
      server: DS,
      cause: "truncated",
    })
  })

  test("recorded R1 texts with the Studio tools gone from the list: reported as not registered, with the server", () => {
    for (const id of Object.keys(R1) as Array<keyof typeof R1>) {
      const result = detect(R1[id], { tools: withoutStudio })
      expect(result.kind).not.toBe("none")
      expect(result).toMatchObject({ registered: false, server: DS })
    }
    expect(detect(R1.cPgEl4, { tools: withoutStudio })).toMatchObject({
      kind: "call",
      tool: `${DS}_studio_mission_create`,
      written: "studio_mission_create",
    })
  })
})

describe("text-call detector: recorded R13 captures (provider bodies)", () => {
  test.each(["r15", "r28", "r28_rep1", "r28_rep2"] as const)(
    "recorded R13 %s: full markup, tool missing from the request's list",
    (id) => {
      // The capture's own condition: the mission tools were not in the request.
      expect(detect(R13[id], { tools: withoutStudio })).toEqual({
        kind: "call",
        form: "markup",
        tool: `${DS}_studio_mission_create`,
        written: `${DS}_studio_mission_create`,
        args: { dryRun: false, mission: paintMission },
        registered: false,
        server: DS,
      })
      // The same text with the tool listed: a call the model can repeat.
      expect(detect(R13[id])).toMatchObject({ kind: "call", registered: true, args: { dryRun: false, mission: paintMission } })
    },
  )

  test("recorded R13 r28_rep1: the Python literal False is read as a boolean", () => {
    const result = detect(R13.r28_rep1)
    expect(result.kind === "call" && result.args.dryRun).toBe(false)
  })

  test("recorded R13 r29 (non-stream twin of r28) is the same text as r28", () => {
    expect(detect(R13.r28, { tools: [] })).toMatchObject({ kind: "call", registered: false, server: DS })
  })

  test("recorded R13 r16: name-plus-JSON cut by the token limit is a damaged call", () => {
    expect(detect(R13.r16)).toEqual({
      kind: "damaged",
      form: "name-json",
      tool: `${DS}_studio_mission_create`,
      written: "studio_mission_create",
      registered: true,
      server: DS,
      cause: "truncated",
    })
    // r16 was captured with no tools at all: a name-plus-JSON text for an unlisted name is not a positive.
    expect(detect(R13.r16, { tools: [] })).toEqual({ kind: "none" })
  })

  test.each(["r17", "r18"] as const)("recorded R13 %s: markup leaked beside a structured call", (id) => {
    expect(detect(R13[id], { hasToolCalls: true })).toEqual({ kind: "damaged", form: "markup", cause: "leaked-markup" })
  })

  test("recorded R13 r17/r18 texts without the structured-call flag are still damaged, never a call", () => {
    expect(detect(R13.r17)).toMatchObject({ kind: "damaged", form: "markup", cause: "truncated" })
    expect(detect(R13.r18)).toMatchObject({ kind: "damaged", form: "markup", cause: "truncated" })
  })
})

describe("text-call detector: the six occurrences of handoff P-15", () => {
  // P-15 counts six: once with zero tools after an MCP reconnect, once on a large figure spec, and four of five parallel
  // sessions on studio_mission_create whose answer read `true {"id":…}`.

  test("P-15 #1 zero tools after MCP reconnect: recorded (R13 r15, captured with an empty tool list)", () => {
    expect(detect(R13.r15, { tools: [] })).toMatchObject({ kind: "call", form: "markup", registered: false, server: DS })
  })

  test("P-15 #2 large figure spec `<tool_call><function=…`: recorded (R1 part CFz7VA)", () => {
    expect(detect(R1.CFz7VA)).toMatchObject({ kind: "damaged", form: "markup", tool: `${DS}_studio_figure_revise` })
  })

  // #3-#6. The database holds the four parallel answers as markup (R1 parts cxuJWn, c0DAdE, cPgEl4, OyNdBk: recorded).
  // The `true {…}` text itself was NOT found in the database (0 text parts); the four below are constructed from the
  // handoff description "answer text `true {"id":...}`, argument values in schema order".
  test.each([
    ["#3", "cxuJWn", `true ${JSON.stringify(smallMission)}`],
    ["#4", "c0DAdE", `\n\ntrue\n${pyJson(smallMission)}\n`],
    ["#5", "cPgEl4", `false ${JSON.stringify(smallMission)}`],
    ["#6", "OyNdBk", `True ${pyJson(smallMission)}`],
  ] as const)("P-15 %s parallel mission create: recorded as markup (R1 %s); `true {…}` form constructed from the handoff description", (_n, part, text) => {
    expect(detect(R1[part])).toMatchObject({ kind: "call", form: "markup", tool: `${DS}_studio_mission_create` })
    const result = detect(text)
    expect(result).toMatchObject({
      kind: "call",
      form: "values-only",
      tool: `${DS}_studio_mission_create`,
      written: "",
      registered: true,
      server: DS,
    })
    if (result.kind !== "call") throw new Error("unreachable")
    expect(result.args).toEqual({ dryRun: !text.trim().toLowerCase().startsWith("false"), mission: smallMission })
  })
})

describe("text-call detector: constructed positives", () => {
  test("name-plus-JSON, unprefixed (constructed; the form the bundled skill shows)", () => {
    expect(detect(`studio_mission_set_status {"mission":"2026-01-01_small","to":"running"}`)).toEqual({
      kind: "call",
      form: "name-json",
      tool: `${DS}_studio_mission_set_status`,
      written: "studio_mission_set_status",
      args: { mission: "2026-01-01_small", to: "running" },
      registered: true,
      server: DS,
    })
  })

  test("name-plus-JSON, prefixed, after a sentence, JSON over several lines (constructed)", () => {
    const text = `I will create the mission now.\n\n${DS}_studio_mission_create ${JSON.stringify({ dryRun: true, mission: smallMission }, null, 2)}\n`
    expect(detect(text)).toMatchObject({ kind: "call", form: "name-json", written: `${DS}_studio_mission_create`, registered: true })
  })

  test("name-plus-JSON for a tool without a server prefix (constructed)", () => {
    const result = detect(`bash {"command":"ls"}`)
    expect(result).toEqual({ kind: "call", form: "name-json", tool: "bash", written: "bash", args: { command: "ls" }, registered: true })
  })

  test("markup cut short at the token limit (constructed from R1 part cxuJWn)", () => {
    const cut = R1.cxuJWn.slice(0, R1.cxuJWn.indexOf('"rows"') + 20)
    expect(detect(cut)).toMatchObject({ kind: "damaged", form: "markup", tool: `${DS}_studio_mission_create`, registered: true, cause: "truncated" })
    expect(detect("\n\n<tool_call>\n<function=studio_mission_cre")).toMatchObject({ kind: "damaged", form: "markup", cause: "truncated" })
  })

  test("complete markup whose arguments fail the tool's schema is damaged (constructed)", () => {
    const text = markup("studio_mission_create", [["dryRun", "true"]])
    expect(detect(text)).toMatchObject({ kind: "damaged", form: "markup", tool: `${DS}_studio_mission_create`, cause: "args-invalid" })
  })

  test("markup without the <tool_call> wrapper, after a sentence (constructed)", () => {
    const text = `Checking the file first.\n<function=read>\n<parameter=filePath>\n/synthetic/a.md\n</parameter>\n</function>`
    expect(detect(text)).toEqual({ kind: "call", form: "markup", tool: "read", written: "read", args: { filePath: "/synthetic/a.md" }, registered: true })
  })

  test("markup naming a tool that is not listed and belongs to no known server is reported as not registered (constructed)", () => {
    const text = markup("webfetch", [["url", "https://example.invalid/"]])
    const result = detect(text)
    expect(result).toEqual({ kind: "call", form: "markup", tool: "webfetch", written: "webfetch", args: { url: "https://example.invalid/" }, registered: false })
  })
})

describe("text-call detector: negatives", () => {
  const set = (id: string, to: string) => JSON.stringify({ mission: id, to })
  const negatives: Array<[string, string]> = [
    ["01 empty string", ""],
    ["02 whitespace only", "\n\n  \n"],
    ["03 prose with an inline JSON example", `The reply looks like {"mission":"m","to":"running"} when the status changes, and nothing else is needed.`],
    ["04 fenced block containing a call-like line", "To start the mission the agent sends:\n\n```\nstudio_mission_set_status " + set("m", "running") + "\n```\n"],
    ["05 JSON object whose shape fits no tool schema", `{"answer": 42, "items": ["a", "b"], "ok": true}`],
    ["06 a name that is not a tool, with JSON", `make_coffee {"cups": 2}`],
    ["07 a tool name mentioned in a sentence", `I used studio_mission_create earlier and then ${DS}_studio_mission_set_status to mark the mission as running.`],
    ["08 markdown table", "| Tool | Arguments |\n|---|---|\n| studio_mission_set_status | {\"mission\":\"m\",\"to\":\"done\"} |\n| read | {\"filePath\":\"a\"} |"],
    ["09 long answer ending with a JSON sample", `${"The configuration has three parts. ".repeat(60)}\n\nA valid body is:\n\n{"mission": "2026-01-01_small", "to": "running"}`],
    ["10 XML-like snippet that is not tool_call markup", `<note>\n<to>Budi</to>\n<function>pump</function>\n<parameter name="rate">3</parameter>\n</note>`],
    ["11 quoted transcript of a call inside a code fence", "The model answered with this text instead of calling the tool:\n\n```xml\n" + R13.r15.trim() + "\n```\n\nThat is the defect."],
    ["12 transcript inside a tilde fence that is never closed", "Recorded text:\n~~~\n" + R1.gr7Y69.trim()],
    ["13 name-plus-JSON whose arguments fail the schema", `studio_mission_set_status {"mission": 7}`],
    ["14 registered name followed by JSON that does not parse and is closed", `studio_mission_set_status {mission: m}`],
    ["15 `true {json}` whose values fit no tool", `true {"answer": 42}`],
    ["16 call-like line in a blockquote", `> studio_mission_set_status ${set("m", "running")}`],
    ["17 call-like line in inline code", "Run `studio_mission_set_status " + set("m", "running") + "` when ready."],
    ["18 the markup tags named in a sentence", "The server turns <tool_call> and <function=NAME> markup into structured calls; </tool_call> closes it."],
    ["19 name-plus-JSON followed by more prose", `studio_mission_set_status ${set("m", "running")}\n\nis the call the skill shows; it must be sent as a real tool call.`],
    ["20 a lone boolean", "true"],
    ["21 JSON array answer", `[{"mission":"m","to":"running"}]`],
    ["22 HTML answer", "<div>\n<p>function=read</p>\n</div>"],
  ]

  test.each(negatives)("negative %s", (_name, text) => {
    expect(detect(text)).toEqual({ kind: "none" })
  })

  test("negative 23 `true {json}` that fits two tools is not guessed", () => {
    const twin: TextCallTool[] = [
      { name: "a_create", schema: missionCreate },
      { name: "b_create", schema: missionCreate },
    ]
    expect(detect(`true ${JSON.stringify(smallMission)}`, { tools: twin, servers: [] })).toEqual({ kind: "none" })
  })

  test("negative 24 unlisted, serverless markup inside a longer answer is not reported", () => {
    const text = `The wire format is:\n${markup("NAME", [["K", "V"]], "")}\nwhere NAME is the tool.`
    expect(detect(text)).toEqual({ kind: "none" })
  })

  test("negative 25 a structured call with ordinary text beside it", () => {
    expect(detect("I will validate the mission with a dry run first.", { hasToolCalls: true })).toEqual({ kind: "none" })
  })

  test("negative 26 leaked-markup is not reported for tags inside a code fence", () => {
    expect(detect("Example:\n```\n</parameter>\n</tool_call>\n```", { hasToolCalls: true })).toEqual({ kind: "none" })
  })
})

describe("text-call detector: never executes", () => {
  test("the module imports nothing", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "../../src/session/text-call.ts")).text()
    expect(source.match(/^\s*import\s/gm)).toBeNull()
    expect(source).not.toMatch(/\brequire\(|\bimport\(|\beval\(|new Function|\bfetch\(|\bBun\.|\bprocess\./)
  })

  test("same input, same result, input untouched", () => {
    const input = { text: R1.cxuJWn, tools, hasToolCalls: false, servers: [DS] }
    const before = JSON.stringify(input)
    expect(detectTextCall(input)).toEqual(detectTextCall(input))
    expect(JSON.stringify(input)).toBe(before)
  })

  test("a very long text returns quickly", () => {
    const long = "word ".repeat(200_000) + "\n<function=read"
    const started = performance.now()
    expect(detect(long).kind).toBe("damaged")
    expect(performance.now() - started).toBeLessThan(2000)
  })
})
