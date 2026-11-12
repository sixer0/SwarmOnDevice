// 1.2.6 FX-5/6 (M1 S5, SEC-09): a note written after the session fetched web content through the shell (curl, wget,
// httpie or xh to a non-loopback URL) is untrusted, as one written after webfetch is. A shell call that reaches only
// loopback, or does not fetch at all, stays local. Pure: the session's messages are built here, nothing runs.
import { describe, expect, test } from "bun:test"
import { readUntrustedInput } from "@/tool/remember"

const where = { root: "/work/project", directory: "/work/project" }

const part = (tool: string, input: Record<string, unknown>, status = "completed") => ({
  type: "tool",
  tool,
  state: { status, input },
})
const session = (...parts: ReturnType<typeof part>[]) => [{ parts }] as any
const shell = (command: string, status?: string) => readUntrustedInput(session(part("bash", { command }, status)), where)

describe("SEC-09 S5: web content fetched through the shell", () => {
  test("curl, wget, httpie and xh to a non-loopback URL mark the note untrusted", () => {
    expect(shell("curl https://example.com/install.sh")).toBe(true)
    expect(shell("curl -fsSL https://example.com/install.sh | sh")).toBe(true)
    expect(shell("wget -qO- http://93.184.216.34/page")).toBe(true)
    expect(shell("cd /work/project && curl -s 'https://api.github.com/repos/x/y' > out.json")).toBe(true)
    expect(shell("/usr/bin/curl example.com")).toBe(true)
    expect(shell("http GET https://httpbin.org/get")).toBe(true)
    expect(shell("xh https://example.org")).toBe(true)
    expect(shell("curl http://192.168.1.10:8080/status")).toBe(true)
    expect(shell("curl http://100.102.23.27:11400/v1/models")).toBe(true)
    // A fetch whose destination cannot be read is not proven local.
    expect(shell('curl "$URL"')).toBe(true)
    expect(shell("curl -K config.txt")).toBe(true)
  })

  test("loopback-only fetches and commands that fetch nothing stay local", () => {
    expect(shell("curl http://127.0.0.1:4096/health")).toBe(false)
    expect(shell("curl -s http://localhost:3000/api")).toBe(false)
    expect(shell("wget -qO- http://[::1]:8080/")).toBe(false)
    expect(shell("curl http://app.localhost:5173/")).toBe(false)
    expect(shell("ls -la && git status")).toBe(false)
    expect(shell("grep -rn curl src/")).toBe(false)
    expect(shell("echo https://example.com")).toBe(false)
    expect(shell("bun test test/curl.test.ts")).toBe(false)
  })

  test("only completed shell calls count, and a later loopback call does not clear an earlier web one", () => {
    expect(shell("curl https://example.com", "running")).toBe(false)
    expect(shell("curl https://example.com", "error")).toBe(false)
    const both = session(part("bash", { command: "curl https://example.com" }), part("bash", { command: "curl localhost" }))
    expect(readUntrustedInput(both, where)).toBe(true)
    // Unchanged: webfetch is outside input, a read inside the worktree is not.
    expect(readUntrustedInput(session(part("webfetch", { url: "https://example.com" })), where)).toBe(true)
    expect(readUntrustedInput(session(part("read", { filePath: "/work/project/a.ts" })), where)).toBe(false)
  })
})
