import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { listenWithNonce, type ServerModule } from "./sidecar-start"

// Office add-in plan row M7-05: U-DT-06 / ST-04 / SC-08 (AC-40, threat TA-3). The Office pane talks only to the bridge's
// own origin, so the desktop sidecar's CORS list never gains https://localhost:46317 or a wildcard.

describe("SC-08 sidecar CORS pin", () => {
  test("the sidecar start passes cors exactly [\"oc://renderer\"]", async () => {
    const seen: unknown[] = []
    const mod: ServerModule<string> = {
      DesktopNonce: { set: () => {} },
      RunLease: { host: () => {} },
      Server: {
        listen: async (options) => {
          seen.push(options.cors)
          return "listening"
        },
      },
    }
    const result = await listenWithNonce(
      { type: "start", hostname: "127.0.0.1", port: 4096, password: "synthetic", userDataPath: "/tmp/none" },
      mod,
    )
    expect(result).toBe("listening")
    expect(seen).toEqual([["oc://renderer"]])
  })

  test("sidecar-start.ts names one cors list and no Office origin or wildcard", () => {
    const source = readFileSync(join(import.meta.dir, "sidecar-start.ts"), "utf8")
    expect(source.match(/cors: \[/g)).toEqual(["cors: ["])
    expect(source).toContain('cors: ["oc://renderer"],')
    expect(source).not.toContain("46317")
    expect(source).not.toMatch(/https:\/\/localhost/)
    expect(source).not.toMatch(/cors: \[[^\]]*"\*"/)
  })
})
