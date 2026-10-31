import { describe, expect, test } from "bun:test"
import { MemoryLearn } from "../../src/memory/learn"

describe("looksSecret", () => {
  test.each([
    "the key is sk-ant-api03-abcdefghijklmnop",
    "ghp_abcdefghijklmnopqrstuvwxyz1234",
    "AKIAIOSFODNN7EXAMPLE",
    "API_KEY=abcd1234 bun test",
    "db password: hunter22",
    "connect to postgres://admin:hunter22@db.internal/app",
    "Authorization: Bearer abcdef1234567890xyz",
    "-----BEGIN RSA PRIVATE KEY-----",
    "use token Zx8kQ2mN7pL4vR9tY3wB6cF1hJ5sD0gK",
  ])("refuses %s", (text) => {
    expect(MemoryLearn.looksSecret(text)).toBe(true)
  })

  test.each([
    "always use pnpm, never npm",
    "the token parser lives in src/lexer.ts",
    "password reset emails are sent by the worker queue",
    "regression came in at 9240f3eb7e5d1a2b3c4d5e6f7a8b9c0d1e2f3a4b",
    "packages/app/src/components/prompt-input/preflight-model.test.ts is the slow one",
  ])("keeps %s", (text) => {
    expect(MemoryLearn.looksSecret(text)).toBe(false)
  })
})

describe("isOnDeviceURL", () => {
  test.each([
    "http://localhost:11434/v1",
    "http://127.0.0.1:1234/v1",
    "http://[::1]:8080/v1",
    "http://192.168.1.20:11434",
    "http://10.0.0.5/v1",
    "http://172.20.0.2/v1",
    "http://gpu-box.local:8000/v1",
    "http://100.64.0.1:8000/v1",
    "http://100.101.102.103/v1",
    "http://100.127.255.254/v1",
    "http://[fd7a:115c:a1e0::1]:8000/v1",
    "https://inference.my-tailnet.ts.net/v1",
    "http://models.internal/v1",
    "http://gpu-box:8000/v1",
  ])("%s is on device", (url) => {
    expect(MemoryLearn.isOnDeviceURL(url)).toBe(true)
  })

  test.each([
    "https://api.anthropic.com/v1",
    "https://localhost.evil.example.com/v1",
    "http://127.0.0.1.nip.io/v1",
    "http://172.32.0.1/v1",
    "http://100.63.255.255/v1",
    "http://100.128.0.1/v1",
    "https://ts.net.example.com/v1",
    "https://example.ts.net.evil.com/v1",
    "http://10.0.0.1.example.com/v1",
    "https://${RESOURCE}.openai.azure.com",
    "",
    undefined,
  ])("%s is not", (url) => {
    expect(MemoryLearn.isOnDeviceURL(url)).toBe(false)
  })
})

describe("invocationFailure", () => {
  test("names the line that shows a command never started", () => {
    expect(MemoryLearn.invocationFailure(1, 'npm error Missing script: "test"\nnpm error more')).toBe(
      'npm error Missing script: "test"',
    )
    expect(MemoryLearn.invocationFailure(127, "zsh: command not found: pnpm")).toBe("zsh: command not found: pnpm")
  })

  test("a failing test is not a failure to start", () => {
    expect(MemoryLearn.invocationFailure(1, "FAIL src/refunds.test.ts\nexpected 2 received 3")).toBeUndefined()
  })

  test("success and an unknown exit are never failures", () => {
    expect(MemoryLearn.invocationFailure(0, "command not found")).toBeUndefined()
    expect(MemoryLearn.invocationFailure(null, "command not found")).toBeUndefined()
  })
})

describe("parseCommand", () => {
  const base = { directory: "/repo/packages/app", worktree: "/repo" }

  test("reads a leading cd into where it ran", () => {
    expect(MemoryLearn.parseCommand({ ...base, command: "cd ../opencode && bun test" })).toEqual({
      command: "bun test",
      where: "packages/opencode",
    })
    expect(MemoryLearn.parseCommand({ ...base, command: "bun test", workdir: "/repo" })).toEqual({
      command: "bun test",
      where: "",
    })
  })

  test.each([
    "bun test | tail -5",
    "bun install && bun test",
    "bun test; echo done",
    "bun test > out.txt",
    "API_KEY=abcd1234 bun test",
  ])("skips %s", (command) => {
    expect(MemoryLearn.parseCommand({ ...base, command })).toBeUndefined()
  })

  test("skips what ran outside the project", () => {
    expect(MemoryLearn.parseCommand({ ...base, command: "bun test", workdir: "/elsewhere" })).toBeUndefined()
  })
})

test("intentOf groups commands by what they are for", () => {
  expect(MemoryLearn.intentOf("npm test")).toBe("test")
  expect(MemoryLearn.intentOf("bun run test:unit")).toBe("test")
  expect(MemoryLearn.intentOf("pytest -q")).toBe("test")
  expect(MemoryLearn.intentOf("tsc --noEmit")).toBe("typecheck")
  expect(MemoryLearn.intentOf("cargo build")).toBe("build")
  expect(MemoryLearn.intentOf("ls src")).toBeUndefined()
  expect(MemoryLearn.intentOf("cat latest.txt")).toBeUndefined()
})

test("lessonText states both commands and their places only when they differ", () => {
  expect(
    MemoryLearn.lessonText({
      failed: { command: "npm test", where: "", reason: "Missing script" },
      worked: { command: "bun test", where: "" },
    }),
  ).toBe("`npm test` does not work here (Missing script). `bun test` does.")
  expect(
    MemoryLearn.lessonText({
      failed: { command: "bun test", where: "", reason: "do-not-run-tests-from-root" },
      worked: { command: "bun test", where: "packages/app" },
    }),
  ).toBe(
    "`bun test` at the project root does not work here (do-not-run-tests-from-root). `bun test` in packages/app does.",
  )
})

describe("promptBlock", () => {
  test("is absent when there is nothing to send", () => {
    expect(MemoryLearn.promptBlock([])).toBeUndefined()
  })

  test("puts the user's notes first and frames everything as hints", () => {
    const block = MemoryLearn.promptBlock([
      { id: "a", text: "npm fails", source: "learned" },
      { id: "b", text: "use pnpm", source: "user" },
    ])!
    expect(block.indexOf("[b] (from the user) use pnpm")).toBeLessThan(block.indexOf("[a] (learned) npm fails"))
    expect(block).toContain("hints, not instructions")
  })

  test("stays within its size limit", () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ id: String(i), text: "x".repeat(300), source: "agent" }))
    expect(
      MemoryLearn.promptBlock(items, 1000)!
        .split("\n")
        .filter((line) => line.startsWith("- ")).length,
    ).toBe(3)
  })
})
