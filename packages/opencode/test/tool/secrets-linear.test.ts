// The scrubber runs on every tool result, on whatever a program or a hostile file printed. Text that made it quadratic took a
// minute at 256 KB, so at 1 MB a ceiling this loose still tells a linear pass from a quadratic one by orders of magnitude.
import { describe, expect, test } from "bun:test"
import { Secrets } from "../../src/tool/secrets"

const SIZE = 1024 * 1024
const hostile = [
  "a.b-",
  "eyJ-",
  "eyJaaaaaaaaaaaa.",
  "password=",
  "passwd:",
  "password ",
  "a://b:",
  "x://",
  "a+b://",
  "-----BEGIN ",
  "-----BEGIN A ",
  "bearer ",
  "sk-",
  "ghp_",
  "xoxb-",
  "AKIA",
  "AIza",
  "github_pat_",
  "sk_live_",
  "aaaa",
  "    ",
  "=",
  "@",
]

describe("Secrets.scrub on one enormous line", () => {
  for (const unit of hostile) {
    test(`${JSON.stringify(unit)} repeated`, () => {
      const text = unit.repeat(Math.ceil(SIZE / unit.length))
      const started = performance.now()
      Secrets.scrubText(text.slice(0, 1024))
      Secrets.scrub(text, "/nonexistent-swarm-root")
      expect(performance.now() - started).toBeLessThan(5000)
    }, 30_000)
  }

  test("takes about four times as long for four times the text", () => {
    const measure = (size: number) => {
      const text = "a.b-".repeat(size / 4)
      const started = performance.now()
      Secrets.scrub(text, "/nonexistent-swarm-root")
      return performance.now() - started
    }
    measure(64 * 1024)
    const small = Math.max(measure(256 * 1024), 1)
    // Sixteen times the work would be quadratic. Twelve leaves room for a busy machine.
    expect(measure(1024 * 1024) / small).toBeLessThan(12)
  }, 30_000)

  test("what it hides is unchanged", () => {
    const scrub = (text: string) => Secrets.scrub(text, "/nonexistent-swarm-root")
    expect(scrub("db_password=hunter2 next")).toBe("db_password=[hidden:password] next")
    expect(scrub("x.y-password: 'abc123def'")).toBe("x.y-password: '[hidden:password]'")
    expect(scrub("password = req.body.password")).toBe("password = req.body.password")
    expect(scrub("postgres://me:hunter2@host/db")).toBe("postgres://me:[hidden:password]@host/db")
    expect(scrub("git+ssh://me:hunter2@host/db")).toBe("git+ssh://me:[hidden:password]@host/db")
    expect(scrub("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijkl")).toBe("[hidden:token]")
    expect(scrub("sk-abcdefghijklmnopqrstuvwx")).toBe("[hidden:api-key]")
    expect(scrub("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----")).toBe("[hidden:private-key]")
    expect(scrub("the password reset page")).toBe("the password reset page")
  })
})
