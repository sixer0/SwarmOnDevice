// Row 106 (1.2.6): GUIDE pins for the built-in flux3-image-gen skill text (OFF-02, OFF-08, 01c 10.2 and 11.9 item 3).
// The text is the generalised off-repo FLUX skill: HTTP API only (the project CLI is replaced, not bundled), no machine
// or project paths, health by weights_downloaded, and a degrade path that uses the tool-health status names (TH-05).
// Registration in skill/index.ts is row 106a; this test reads the source file.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const FILE = path.join(import.meta.dir, "..", "..", "src", "skill", "flux3-image-gen.md")
const TEXT = readFileSync(FILE, "utf8")

describe("1.2.6 row 106 flux3-image-gen built-in skill text", () => {
  test("OFF-02/OFF-08: no machine path, project path, project CLI or evaluation subcommand", () => {
    for (const s of [
      "/Users",
      "Default Project",
      "scripts/flux3.py",
      "flux3.py",
      "docs/2026-11-10",
      "Codex",
      "skills-staged",
      "python3",
      "--outdir",
      "--prompts",
      "--summary",
    ])
      expect(TEXT).not.toContain(s)
  })

  test("OFF-02: URL order FLUX3_URL, then the flux3 entry, then the loopback default, with the host rule", () => {
    expect(TEXT).toContain("`FLUX3_URL` from the environment")
    expect(TEXT).toContain("The probe URL of the `flux3` entry")
    expect(TEXT).toContain("`http://127.0.0.1:7863`")
    expect(TEXT).toContain("The host must be `127.0.0.1` or `localhost`")
    expect(TEXT.indexOf("FLUX3_URL")).toBeLessThan(TEXT.indexOf("http://127.0.0.1:7863"))
  })

  test("health is weights_downloaded, not model_loaded (lazy load)", () => {
    expect(TEXT).toContain('Ready means HTTP 200 and `"weights_downloaded": true`')
    expect(TEXT).toContain("`model_loaded: false` is normal")
    expect(TEXT).toContain("Do not wait for `model_loaded`")
  })

  test("request shape and server limits for POST /generate", () => {
    expect(TEXT).toContain("`POST $BASE/generate` with a JSON body of exactly four fields")
    expect(TEXT).toContain('{"prompt":"<prompt>","width":768,"height":512,"seed":42}')
    expect(TEXT).toContain("`prompt`: 1-4000 characters.")
    expect(TEXT).toContain("`width`, `height`: 256-1024, each a multiple of 16.")
    expect(TEXT).toContain("`seed`: 0-4294967295.")
    expect(TEXT).toContain("422")
    expect(TEXT).toContain("429 means the service is busy")
    expect(TEXT).toContain("Never send requests in parallel.")
    expect(TEXT).toContain("89 50 4e 47 0d 0a 1a 0a")
  })

  test("prompt rules P1-P9 are kept", () => {
    for (let n = 1; n <= 9; n++) expect(TEXT).toContain(`- **P${n}** `)
  })

  test("TH-05 degrade: never starts or installs, uses the tool-health status names, continues without images", () => {
    expect(TEXT).toContain("Never install, start, stop or reconfigure the FLUX service")
    expect(TEXT).toContain("Load the `tool-health` skill and read the `flux3` status.")
    for (const status of ["healthy", "revived", "skipped_not_installed", "skipped_never_healthy", "dead", "revive_failed"])
      expect(TEXT).toContain(`\`${status}\``)
    expect(TEXT).toContain("Ask for a re-check of `flux3` through the `tool-health` skill, once.")
    expect(TEXT).toContain("Tell the user the image service is not available and continue without images")
    expect(TEXT).toContain("do not edit `~/.config/swarm/tool-health.json`")
  })

  test("built-in shape: a top heading, no frontmatter, a reasonable size", () => {
    expect(TEXT.startsWith("# ")).toBe(true)
    expect(Buffer.byteLength(TEXT)).toBeLessThan(12_000)
  })
})
