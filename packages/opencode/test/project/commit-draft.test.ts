import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LLMEvent } from "@opencode-ai/llm"
import { Agent } from "../../src/agent/agent"
import { Git } from "../../src/git"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { CommitDraft, digest, parse } from "../../src/project/commit-draft"
import { Vcs } from "../../src/project/vcs"
import { Provider } from "../../src/provider/provider"
import { LLM } from "../../src/session/llm"
import { Session } from "../../src/session/session"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

describe("CommitDraft.parse", () => {
  test("reads the subject and summary, past any thinking", () => {
    expect(parse('<think>hm {"subject":"no"}</think>\n{"subject":"Fix  rounding","summary":" Why. "}')).toEqual({
      subject: "Fix rounding",
      summary: "Why.",
    })
  })
  test("anything unusable leaves the run's own record standing", () => {
    expect(parse("no json here")).toEqual({})
    expect(parse('{"summary":"no subject"}')).toEqual({})
    expect(parse(`{"subject":"${"x".repeat(200)}"}`)).toEqual({})
    expect(parse('{"subject": 3}')).toEqual({})
    expect(parse("{broken")).toEqual({})
  })
})

describe("CommitDraft.digest", () => {
  test("one huge file cannot push out the others", () => {
    const text = digest({
      prompts: ["fix it"],
      history: "feat: a",
      diffs: [
        { file: "lock.json", patch: "x".repeat(50_000) },
        { file: "src/a.ts", patch: "the real change" },
      ],
    })
    expect(text).toContain("the real change")
    expect(text).toContain("rest of this diff cut")
    expect(text.length).toBeLessThan(17_000)
  })
})

describe("CommitDraft.write", () => {
  const sessionID = SessionID.make("ses_draft")
  const seen = { llm: [] as unknown[], diff: 0 }
  // Which model the run was on is the whole question here, and the test stands in for the rest of the session around it.
  const model = (url: string) => ({ id: "m", providerID: "p", api: { id: "m", url, npm: "@ai-sdk/openai-compatible" } })
  let url = ""
  const it = testEffect(
    AppNodeBuilder.build(
      LayerNode.group([CommitDraft.node, CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]),
      [
        [
          InstanceBootstrap.node,
          Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
        ],
        [
          Session.node,
          Layer.succeed(
            Session.Service,
            Session.Service.of({
              messages: () =>
                Effect.succeed([
                  {
                    info: { id: "msg_1", role: "user", model: { providerID: "p", modelID: "m" } },
                    parts: [{ type: "text", text: "fix the rounding" }],
                  },
                ]),
            } as unknown as Session.Interface),
          ),
        ],
        [
          Agent.node,
          Layer.succeed(
            Agent.Service,
            Agent.Service.of({ get: () => Effect.succeed({ name: "title" }) } as unknown as Agent.Interface),
          ),
        ],
        [
          Provider.node,
          Layer.succeed(
            Provider.Service,
            Provider.Service.of({
              getModel: () => Effect.succeed(model(url)),
              getProvider: () => Effect.succeed({ options: {} }),
            } as unknown as Provider.Interface),
          ),
        ],
        [
          LLM.node,
          Layer.succeed(
            LLM.Service,
            LLM.Service.of({
              stream: (input: unknown) => {
                seen.llm.push(input)
                return Stream.make(LLMEvent.textDelta({ id: "t", text: '{"subject":"Fix rounding"}' }))
              },
            } as unknown as LLM.Interface),
          ),
        ],
        [
          Vcs.node,
          Layer.succeed(
            Vcs.Service,
            Vcs.Service.of({
              diff: () => {
                seen.diff++
                return Effect.succeed([{ file: "src/a.ts", patch: "+const key = 1" }])
              },
            } as unknown as Vcs.Interface),
          ),
        ],
        [
          Git.node,
          Layer.succeed(
            Git.Service,
            Git.Service.of({ run: () => Effect.succeed({ text: () => "feat: a" }) } as unknown as Git.Interface),
          ),
        ],
      ],
    ),
  )

  it.instance("a run on a cloud model sends no diff anywhere and leaves the run's own record", () =>
    Effect.gen(function* () {
      url = "https://api.example.test/v1"
      seen.llm = []
      seen.diff = 0
      const draft = yield* CommitDraft.Service
      expect(yield* draft.write({ sessionID, files: ["src/a.ts"] })).toEqual({})
      expect(seen.llm).toEqual([])
      expect(seen.diff).toBe(0)
    }),
  )

  it.instance("a run on an on-device or tailnet model gets its draft from that same model", () =>
    Effect.gen(function* () {
      const draft = yield* CommitDraft.Service
      for (const address of ["http://127.0.0.1:11434/v1", "http://100.101.102.103:8000/v1"]) {
        url = address
        seen.llm = []
        expect(yield* draft.write({ sessionID, files: ["src/a.ts"] })).toEqual({ subject: "Fix rounding" })
        expect(seen.llm.length).toBe(1)
      }
    }),
  )
})
