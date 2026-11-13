// N7-097 (AC-U9, row 34), pure half: a reasoning part with text is renderable whatever "Show reasoning summaries" says;
// the setting only sets the block's default open state (C11). The render half (click, Enter, Space via aria-expanded)
// runs in app/test-browser/rel127-u9-reasoning-toggle.test.ts because session-ui has no DOM harness.
import { describe, expect, mock, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"

const INNER = "REL127_U9_INNER"

if (process.env[INNER] !== "1") {
  // message-part.tsx pulls in Kobalte, which needs the browser build of solid-js; the package's `bun test src` runs the
  // server build. Run the checks below in a child with the browser condition, so `renderable` is imported as shipped.
  test("U-9 pure half passes under the browser condition", async () => {
    const run = Bun.spawn([process.execPath, "test", "--conditions=browser", import.meta.path], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: { ...process.env, [INNER]: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
    if (code !== 0) throw new Error(output)
    expect(output).toContain(" 3 pass")
    expect(output).toContain(" 0 fail")
  }, 60_000)
} else {
  // The markdown and diff workers are imported as `?worker&url`, which only Vite resolves; the pure half draws nothing.
  mock.module("./markdown", () => ({ Markdown: () => null }))
  mock.module("../pierre/worker", () => ({}))
  const { renderable } = await import("./message-part")

  const reasoning = (text: string) =>
    ({ id: "prt_r", sessionID: "ses_1", messageID: "msg_1", type: "reasoning", text, time: { start: 1 } }) as Part

  describe("U-9 reasoning toggle (pure half)", () => {
    test("reasoning with text is renderable with the setting off", () => {
      expect(renderable(reasoning("x"), false)).toBe(true)
    })

    test("reasoning with text is renderable with the setting on", () => {
      expect(renderable(reasoning("x"), true)).toBe(true)
    })

    test("reasoning without text is not renderable, setting on or off", () => {
      expect(renderable(reasoning(""), false)).toBe(false)
      expect(renderable(reasoning("  \n "), true)).toBe(false)
    })
  })
}
