// Source tests for the pane (REG §7.1, C30). They read the files, not the bundle.
import { describe, expect, test } from "bun:test"
import path from "node:path"

const SRC = path.resolve(import.meta.dir, "..")

async function sources() {
  const glob = new Bun.Glob("**/*.{ts,tsx}")
  // This file names the forbidden specifier in its own fixtures, so it is not scanned.
  const files = (await Array.fromAsync(glob.scan({ cwd: SRC }))).filter((file) => file !== "api/source.test.ts")
  return Promise.all(
    files.map(async (file) => ({ file, text: await Bun.file(path.join(SRC, file)).text() })),
  )
}

// Module specifiers of static imports, dynamic imports, re-exports and require calls.
function specifiers(text: string) {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g
  return [...text.matchAll(pattern)].map((match) => match[1] ?? "")
}

describe("pane source rules", () => {
  test("REG §7.1: no import of the package root @opencode-ai/sdk; only the v2/client subpath", async () => {
    const all = await sources()
    expect(all.length).toBeGreaterThan(0)
    const sdk = all.flatMap((source) =>
      specifiers(source.text)
        .filter((spec) => spec === "@opencode-ai/sdk" || spec.startsWith("@opencode-ai/sdk/"))
        .map((spec) => `${source.file}: ${spec}`),
    )
    expect(sdk.filter((entry) => !entry.endsWith(": @opencode-ai/sdk/v2/client"))).toEqual([])
    // The API layer builds the client on the subpath.
    expect(sdk).toContain("api/client.ts: @opencode-ai/sdk/v2/client")
  })

  test("the specifier scanner sees the forms it guards against", () => {
    expect(specifiers(`import { a } from "@opencode-ai/sdk"`)).toEqual(["@opencode-ai/sdk"])
    expect(specifiers(`export * from '@opencode-ai/sdk'`)).toEqual(["@opencode-ai/sdk"])
    expect(specifiers(`const m = await import("@opencode-ai/sdk")`)).toEqual(["@opencode-ai/sdk"])
    expect(specifiers(`import "@opencode-ai/sdk"`)).toEqual(["@opencode-ai/sdk"])
  })

  test("C30: the API layer never names `system` or `tools` as a request field", async () => {
    const all = await sources()
    const api = all.filter((source) => source.file.startsWith("api/") && !source.file.endsWith(".test.ts") && source.file !== "api/fake-bridge.ts")
    expect(api.length).toBeGreaterThan(0)
    for (const source of api) {
      expect(source.text).not.toMatch(/\bsystem\s*:/)
      expect(source.text).not.toMatch(/\btools\s*:/)
    }
  })
})
