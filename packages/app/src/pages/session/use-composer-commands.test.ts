import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

// Row 231 put `tools.install` in the composer scope, so it existed only while a session page was mounted.
// Senior 19 (U14 fix pass, row 246) moved it to one always-mounted scope (components/install-tools-command.tsx,
// proven in dialog-install-tools.model.test.ts). This guard keeps a second copy out of the composer. It reads the
// source on purpose: senior 18 found that rendering this hook needs nine process-wide mock.module calls.

const source = (path: string) => readFileSync(join(import.meta.dir, path), "utf8")

describe("/install-tools stays out of the composer scope", () => {
  test("the composer registers no tools.install command and no install-tools slash", () => {
    const composer = source("./use-composer-commands.tsx")
    expect(composer).not.toContain("tools.install")
    expect(composer).not.toContain("install-tools")
    expect(composer).not.toContain("setupTools")
  })

  test("the server-scoped shell mounts the global command next to the first-run offer", () => {
    const app = source("../../app.tsx")
    expect(app).toMatch(/<SetupToolsOffer \/>\s*<InstallToolsCommand \/>/)
    expect(source("../../components/install-tools-command.tsx")).toContain("installToolsCommand({")
  })
})
