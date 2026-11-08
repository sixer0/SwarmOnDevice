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
