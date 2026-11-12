import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ModelsDev } from "../../../core/src/models-dev"
import { BUNDLED_PROVIDER, BUNDLED_PROVIDER_ENV } from "./bundled-provider"

const withEnv = <T>(value: string, run: () => T) => {
  const before = process.env[ModelsDev.BUNDLED_ENV]
  process.env[ModelsDev.BUNDLED_ENV] = value
  try {
    return run()
  } finally {
    if (before === undefined) delete process.env[ModelsDev.BUNDLED_ENV]
    else process.env[ModelsDev.BUNDLED_ENV] = before
  }
}

describe("bundled provider", () => {
  test("the server reads exactly what the app hands it", () => {
    const decoded = withEnv(BUNDLED_PROVIDER_ENV[ModelsDev.BUNDLED_ENV], ModelsDev.bundled)
    expect(decoded?.provider.id).toBe("gsp-ai-tail")
    expect(decoded?.provider.npm).toBe("@ai-sdk/openai-compatible")
    expect(Object.keys(decoded?.provider.models ?? {})).toEqual(["thinker", "worker", "worker-fast"])
    expect(decoded?.subagents).toEqual({
      general: "worker",
      explore: "worker-fast",
      coder: "worker",
      planner: "thinker",
      verifier: "thinker",
      "data-collector": "worker-fast",
      "document-writer": "worker",
    })
  })

  test("the sidecar hands it over before the server starts", () => {
    const source = readFileSync(join(import.meta.dir, "sidecar.ts"), "utf8")
    expect(source).toContain("...BUNDLED_PROVIDER_ENV")
    expect(source.indexOf("prepareSidecarEnv(command.password")).toBeLessThan(source.indexOf('import("virtual:opencode-server")'))
  })

  test("every subagent tier names a bundled model", () => {
    const models = Object.keys(BUNDLED_PROVIDER.provider.models)
    expect(Object.values(BUNDLED_PROVIDER.subagents).every((tier) => models.includes(tier))).toBe(true)
  })

  test("no key travels with it and no model is priced", () => {
    const text = JSON.stringify(BUNDLED_PROVIDER)
    expect(text).not.toMatch(/apiKey|api_key|authorization|bearer|token|secret/i)
    expect(Object.values(BUNDLED_PROVIDER.provider.models).every((model) => !("cost" in model))).toBe(true)
  })
})

import { describe as describeVision, expect as expectVision, test as testVision } from "bun:test"
import { BUNDLED_PROVIDER as VISION_PROVIDER } from "./bundled-provider"

describeVision("GSP AI vision (2026-11-09)", () => {
  testVision("thinker, worker and worker-fast accept images", () => {
    for (const id of ["thinker", "worker", "worker-fast"] as const) {
      const m = VISION_PROVIDER.provider.models[id]
      expectVision(m.attachment).toBe(true)
      expectVision(m.modalities.input).toEqual(["text", "image"])
    }
  })
})

describe("row 208: the payload fits the Windows launcher and still decodes whole", () => {
  test("within the 1000 bytes set /p reads, and the server fills name and release_date", () => {
    const json = BUNDLED_PROVIDER_ENV[ModelsDev.BUNDLED_ENV]
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(1000)
    const decoded = withEnv(json, ModelsDev.bundled)
    for (const id of ["thinker", "worker", "worker-fast"]) {
      const m = decoded?.provider.models[id]
      expect(m?.id).toBe(id)
      expect(m?.name).toBe(id)
      expect(m?.release_date).toBe("")
      expect(m?.attachment).toBe(true)
      expect(m?.modalities?.input).toEqual(["text", "image"])
    }
  })

  test("an explicit name or release_date still wins, and a broken payload is still refused", () => {
    const explicit = JSON.stringify({
      provider: {
        id: "p",
        name: "P",
        env: [],
        models: {
          a: {
            id: "a",
            name: "Shown A",
            release_date: "2026-01-01",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            limit: { context: 0, output: 0 },
          },
        },
      },
    })
    const decoded = withEnv(explicit, ModelsDev.bundled)
    expect(decoded?.provider.models.a?.name).toBe("Shown A")
    expect(decoded?.provider.models.a?.release_date).toBe("2026-01-01")
    expect(withEnv("{not json", ModelsDev.bundled)).toBeUndefined()
    expect(withEnv("", ModelsDev.bundled)).toBeUndefined()
    expect(withEnv(JSON.stringify({ provider: { id: "p", models: {} } }), ModelsDev.bundled)).toBeUndefined()
  })
})

// 1.2.6 row 32 (CFG-01, CFG-05; U1, U2). Literals on purpose, not imported from MODEL_LIMITS.
const U1_LIMITS = {
  thinker: { context: 784000, output: 120000 },
  worker: { context: 512000, output: 90000 },
  "worker-fast": { context: 512000, output: 60000 },
} as const

describe("row 32: per-model limits ship with the bundled provider (CFG-01)", () => {
  test("T1a: each model declares the U1 window", () => {
    for (const id of ["thinker", "worker", "worker-fast"] as const) {
      expect(BUNDLED_PROVIDER.provider.models[id].limit).toEqual(U1_LIMITS[id])
    }
  })

  test("T1b: the limits survive the server decode and the payload stays within the Windows budget", () => {
    const json = BUNDLED_PROVIDER_ENV[ModelsDev.BUNDLED_ENV]
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(1000)
    expect(/^[\x20-\x7e]*$/.test(json)).toBe(true)
    expect(json).not.toContain("\n")
    const decoded = withEnv(json, ModelsDev.bundled)
    for (const id of ["thinker", "worker", "worker-fast"] as const) {
      expect(decoded?.provider.models[id]?.limit).toEqual(U1_LIMITS[id])
    }
  })
})

describe("row 32: the U2 provider URL is shipped unchanged (CFG-05)", () => {
  test("T5 CHAR-U2: api pin", () => {
    expect(BUNDLED_PROVIDER.provider.api).toBe("http://100.102.23.27:11400/v1")
  })
})

// 1.2.6 row 34, CFG-06 T6a (01d_spec_config.md §7, C2): the bundled provider payload and the
// env value handed to the server carry no instructions, no gsp-core-rules and no /Users/ path.
describe("CFG-06 T6a bundled provider ships no private content", () => {
  test("no instructions, gsp-core-rules or /Users/ in BUNDLED_PROVIDER or its env payload", () => {
    for (const text of [JSON.stringify(BUNDLED_PROVIDER), JSON.stringify(BUNDLED_PROVIDER_ENV)]) {
      expect(text).not.toContain("instructions")
      expect(text).not.toContain("gsp-core-rules")
      expect(text).not.toContain("/Users/")
    }
  })
})
