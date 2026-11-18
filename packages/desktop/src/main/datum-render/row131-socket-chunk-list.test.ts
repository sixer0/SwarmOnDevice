// 1.3.3 row 131 (SB-1, F1 and F5 of the row 21 diagnosis).
//
// F1: the receive path keeps incoming chunks in a list and joins them once per request line. The join is injected, so
//     the count below is exact and does not depend on timing or on the allocator.
// F5: one "render job memory" log line per job, memory before and after in the register's field names (section 10).
//
// The reader tests need no socket. The two socket tests bind a Unix socket: in the sandbox they fail with listen EPERM
// and are rerun once with the sandbox off.

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLineReader, startSocketServer, type BridgeLog } from "./socket-server"

type Concat = (list: Buffer[], total: number) => Buffer

function counting() {
  const calls: Array<{ parts: number; total: number }> = []
  const concat: Concat = (list, total) => {
    calls.push({ parts: list.length, total })
    return Buffer.concat(list, total)
  }
  return { calls, concat }
}

function reader(maxLine: number) {
  const c = counting()
  const lines: string[] = []
  const tooLong: number[] = []
  const r = createLineReader({ maxLine, concat: c.concat, onLine: (l) => lines.push(l), onTooLong: (bytes) => tooLong.push(bytes) })
  return { ...c, lines, tooLong, push: r.push }
}

/** The receive path before row 131, kept here as the reference the new reader must match event for event. */
function referenceReader(maxLine: number) {
  const events: string[] = []
  let buf = Buffer.alloc(0)
  return {
    events,
    push(chunk: Buffer) {
      buf = Buffer.concat([buf, chunk])
      for (let nl = buf.indexOf(10); nl >= 0; nl = buf.indexOf(10)) {
        const line = buf.subarray(0, nl).toString("utf8").replace(/\r$/, "")
        buf = buf.subarray(nl + 1)
        if (line.trim() === "") continue
        events.push("line:" + line)
      }
      if (buf.length > maxLine) {
        events.push("tooLong:" + buf.length)
        buf = Buffer.alloc(0)
      }
    },
  }
}

function slices(data: Buffer, size: number) {
  const out: Buffer[] = []
  for (let i = 0; i < data.length; i += size) out.push(data.subarray(i, Math.min(data.length, i + size)))
  return out
}

/** Deterministic text with multi-byte characters, so chunk borders fall inside UTF-8 sequences. */
function body(bytes: number) {
  const unit = "render bridge é 測 😀 0123456789 abcdefghijklmnopqrstuvwxyz|"
  const n = Math.ceil(bytes / Buffer.byteLength(unit))
  return unit.repeat(n)
}

describe("row 131 F1: one join per request line", () => {
  test("a 6 MiB line in 1,021-byte chunks comes out equal to the input, with exactly one join", () => {
    const text = body(6 * 1024 * 1024)
    const data = Buffer.from(text + "\n", "utf8")
    const chunks = slices(data, 1021)
    expect(chunks.length).toBeGreaterThan(6000)
    const r = reader(64 * 1024 * 1024)
    for (const c of chunks) r.push(c)
    expect(r.lines.length).toBe(1)
    expect(r.lines[0] === text).toBe(true)
    expect(r.calls.length).toBe(1)
    expect(r.calls[0].total).toBe(data.length - 1)
    expect(r.calls[0].parts).toBe(chunks.length)
    expect(r.tooLong).toEqual([])
  })

  test("three multi-megabyte lines in small chunks: three joins, each line intact", () => {
    const texts = [body(2 * 1024 * 1024) + "A", body(3 * 1024 * 1024) + "B", body(1024 * 1024) + "C"]
    const data = Buffer.from(texts.map((t) => t + "\n").join(""), "utf8")
    const r = reader(64 * 1024 * 1024)
    for (const c of slices(data, 4093)) r.push(c)
    expect(r.lines.length).toBe(3)
    for (let i = 0; i < 3; i++) expect(r.lines[i] === texts[i]).toBe(true)
    expect(r.calls.length).toBe(3)
    expect(r.calls.map((c) => c.total)).toEqual(texts.map((t) => Buffer.byteLength(t)))
  })

  test("a line that arrives whole in one chunk needs no join at all", () => {
    const r = reader(1024)
    r.push(Buffer.from('{"a":1}\n{"b":2}\r\n\n  \n{"c":3}\n'))
    expect(r.lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
    expect(r.calls.length).toBe(0)
  })

  test("the line cap acts on the running byte count, before any join", () => {
    const r = reader(1000)
    const chunk = Buffer.alloc(300, 0x61)
    r.push(chunk)
    r.push(chunk)
    r.push(chunk)
    expect(r.tooLong).toEqual([])
    r.push(chunk)
    expect(r.tooLong).toEqual([1200])
    expect(r.calls.length).toBe(0)
    // The reader starts clean afterwards, as the old `buf = Buffer.alloc(0)` did.
    r.push(Buffer.from("x\n"))
    expect(r.lines).toEqual(["x"])
  })

  test("same lines and same cap events as the old per-chunk concat, for every chunk size", () => {
    const stream = Buffer.from(
      ['{"id":1,"v":"é測😀"}', "", "   ", '{"id":2}\r', "y".repeat(180), "z".repeat(90) + "\r", '{"id":3}', "q".repeat(140)].join("\n") + "\ntail-without-newline",
      "utf8",
    )
    for (const cap of [64, 100, 150, 4096]) {
      for (const size of [1, 2, 3, 7, 16, 50, 97, 128, stream.length]) {
        const ref = referenceReader(cap)
        const events: string[] = []
        const r = createLineReader({ maxLine: cap, onLine: (l) => events.push("line:" + l), onTooLong: (b) => events.push("tooLong:" + b) })
        for (const c of slices(stream, size)) {
          ref.push(c)
          r.push(c)
        }
        expect({ cap, size, events }).toEqual({ cap, size, events: ref.events })
      }
    }
  })
})

describe("row 131: over the real socket (binds a Unix socket)", () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "r131-")))
  const closers: Array<() => Promise<void>> = []
  afterAll(async () => {
    for (const c of closers) await c()
    rmSync(work, { recursive: true, force: true })
  })

  const TOKEN = "k".repeat(64)

  async function start(dispatch: (body: unknown) => Promise<Record<string, unknown>>, extra: { maxLineBytes?: number } = {}) {
    const c = counting()
    const logs: Array<{ level: string; source: string; message: string; context?: Record<string, unknown> }> = []
    const log: BridgeLog = (level, source, message, context) => logs.push({ level, source, message, context })
    const server = await startSocketServer({ token: TOKEN, dispatch, log, baseDir: work, concat: c.concat, ...extra })
    closers.push(() => server.close())
    return { server, logs, calls: c.calls }
  }

  /** Writes `data` in `size`-byte pieces, each after the previous one was flushed, and collects the reply lines. */
  function send(socketPath: string, data: Buffer, size: number, replies: number): Promise<any[]> {
    return new Promise((ok, fail) => {
      const sock = createConnection(socketPath)
      const out: any[] = []
      let got = ""
      sock.on("data", (d) => {
        got += d.toString("utf8")
        for (let nl = got.indexOf("\n"); nl >= 0; nl = got.indexOf("\n")) {
          out.push(JSON.parse(got.slice(0, nl)))
          got = got.slice(nl + 1)
        }
        if (out.length >= replies) sock.end()
      })
      sock.on("close", () => ok(out))
      sock.on("error", (e) => ((e as NodeJS.ErrnoException).code === "EPIPE" ? undefined : fail(e)))
      sock.on("connect", () => {
        let i = 0
        const next = () => {
          if (i >= data.length || sock.destroyed) return
          const piece = data.subarray(i, Math.min(data.length, i + size))
          i += piece.length
          sock.write(piece, next)
        }
        next()
      })
    })
  }

  test("a 5 MiB request sent in 8 KiB writes reaches dispatch unchanged with one join; one memory line per job", async () => {
    const seen: any[] = []
    const { server, logs, calls } = await start(async (b) => {
      seen.push(b)
      return { echoed: (b as { html: string }).html.length }
    })
    const html = body(5 * 1024 * 1024)
    const line = Buffer.from(JSON.stringify({ id: 7, token: TOKEN, op: "checkPage", html }) + "\n", "utf8")
    const replies = await send(server.socketPath, line, 8192, 1)
    expect(replies).toEqual([{ id: 7, ok: true, echoed: html.length }])
    expect(seen.length).toBe(1)
    expect(seen[0].html === html).toBe(true)
    // However the kernel regrouped the writes, the line was joined once (or arrived whole: zero).
    expect(calls.length).toBe(1)
    expect(calls[0].total).toBe(line.length - 1)

    const mem = logs.filter((l) => l.message === "render job memory")
    expect(mem.length).toBe(1)
    expect(mem[0].level).toBe("info")
    expect(mem[0].source).toBe("datum-render.job")
    const ctx = mem[0].context as Record<string, any>
    expect(ctx.op).toBe("checkPage")
    expect(ctx.id).toBe(7)
    expect(ctx.ok).toBe(true)
    expect(ctx.lineBytes).toBe(line.length - 1)
    for (const side of ["before", "after"]) {
      expect(Object.keys(ctx[side]).sort()).toEqual(["externalMb", "heapTotalMb", "heapUsedMb", "rssMb"])
      for (const v of Object.values(ctx[side])) expect(Number.isInteger(v)).toBe(true)
      expect(ctx[side].rssMb).toBeGreaterThan(0)
    }
    // Never the token, never the content.
    const text = JSON.stringify(logs)
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(html.slice(0, 64))
  })

  test("memory line: one per job also when the job fails, none for hello, none for a refused token; cap still answers", async () => {
    const { server, logs, calls } = await start(
      async (b) => {
        if ((b as { op: string }).op === "pdf") throw new Error("engine broke")
        return {}
      },
      { maxLineBytes: 4096 },
    )
    const lines = [
      { id: 1, token: TOKEN, op: "hello" },
      { id: 2, token: TOKEN, op: "pdf", src: "/x" },
      { id: 3, token: "wrong", op: "pdf", src: "/x" },
      { id: 4, token: TOKEN, op: "png", src: "/x" },
    ]
    const data = Buffer.from(lines.map((l) => JSON.stringify(l) + "\n").join(""), "utf8")
    const replies = await send(server.socketPath, data, 5, 4)
    expect(replies.map((r) => [r.id, r.ok, r.code])).toEqual([
      [1, true, undefined],
      [2, false, "RENDER_FAILED"],
      [3, false, "UNAUTHORIZED"],
      [4, true, undefined],
    ])
    const mem = logs.filter((l) => l.message === "render job memory").map((l) => [l.context!.id, l.context!.op, l.context!.ok])
    expect(mem).toEqual([
      [2, "pdf", false],
      [4, "png", true],
    ])
    expect(calls.length).toBeLessThanOrEqual(4)

    // A line over the cap without a newline: same refusal as before, and no join was made for it.
    const before = calls.length
    const over = await send(server.socketPath, Buffer.alloc(6000, 0x61), 500, 1)
    expect(over.length).toBe(1)
    expect(over[0].ok).toBe(false)
    expect(over[0].code).toBe("LINE_TOO_LONG")
    expect(calls.length).toBe(before)
    const warn = logs.filter((l) => l.message === "request line too long")
    expect(warn.length).toBe(1)
    expect(warn[0].context!.bytes as number).toBeGreaterThan(4096)
  })
})
