// Swarm 1.3.3 row 21 (SB-1): memory-growth harness for the render bridge code that runs in the Electron MAIN process.
// Test-only script: nothing in the app imports it. It needs no Electron: the page engine is a fake, so everything a
// real BrowserWindow / webContents.debugger / printToPDF does is NOT measured here (see the row 21 report).
//
// What it runs for real: dispatch.ts (createDispatcher), pages.ts (htmlWithFonts), fonts.ts (the 16-font base64 block),
// paths.ts (policy checks), page-images.ts (decodePngRgb, composePage, encodePngRgb), socket-server.ts, protocol.ts.
//
//   bun:  cd packages/desktop && bun src/main/datum-render/growth-harness.ts --scenario=dispatch-pdf --n=200
//   node: bun build src/main/datum-render/growth-harness.ts --target=node --outfile="$TMPDIR/gh.mjs" &&
//         node --expose-gc "$TMPDIR/gh.mjs" --scenario=dispatch-pdf --n=200 --fonts="$PWD/datum/datum-house-style/assets/fonts"
//
// Scenarios (one cause each):
//   dispatch-pdf      N pdf jobs of one synthetic HTML file through the real dispatcher; engine returns a PDF-sized buffer
//   dispatch-cdpsim   same, and the fake engine copies the page string the way a CDP send must (JSON text + UTF-8 bytes).
//                     A SIMULATION of the copy sizes in JS; the real copies are made in C++ and are not measured.
//   pagepng-paged     N pagePng jobs, 12 pages each; engine decodes one base64 screenshot per page (as electron-renderer does)
//   pagepng-flow      same, plus decodePngRgb + composePage per page (the flow path of electron-renderer.ts)
//   socket-inline     N checkPage requests with inline html of --mib MiB over the real Unix socket server; counts
//                     Buffer.concat calls and bytes (socket-server.ts `buf = Buffer.concat([buf, chunk])`)
//                     --client=child sends from a second process, so RSS of this process is the server side only
//   socket-churn      N connect / hello / close cycles on the real socket server (per-connection listeners, the open set)
//   control-retain    positive control: the fake engine keeps every page string; shows what real retention looks like here
//
// Output: one JSON document on stdout (figures in MB, 1 MB = 1048576 bytes). No number is derived except deltas.

import { spawn } from "node:child_process"
import { createConnection } from "node:net"
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createDispatcher, type EngineInfo, type PageEngine, type PagePngsResult } from "./dispatch"
import { buildFontBundle } from "./fonts"
import { composePage, decodePngRgb, encodePngRgb } from "./page-images"
import { defaultPolicy } from "./paths"
import { ScriptAllowList } from "./scripts"
import { startSocketServer } from "./socket-server"

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=") as [string, string]))
const scenario = args.scenario ?? "dispatch-pdf"
const N = Number(args.n ?? 100)
const htmlMb = Number(args.htmlMb ?? 3.3)
const pdfMb = Number(args.pdfMb ?? 1.5)
const inlineMib = Number(args.mib ?? 4)
const here = dirname(fileURLToPath(import.meta.url))
const fontsDir = args.fonts ?? resolve(here, "../../../datum/datum-house-style/assets/fonts")

const MB = 1048576
const mb = (n: number) => Math.round((n / MB) * 100) / 100
type Sample = { heapUsedMb: number; rssMb: number; externalMb: number; arrayBuffersMb: number }
function mem(): Sample {
  const m = process.memoryUsage()
  return { heapUsedMb: mb(m.heapUsed), rssMb: mb(m.rss), externalMb: mb(m.external), arrayBuffersMb: mb(m.arrayBuffers) }
}
const bunGc = (globalThis as { Bun?: { gc(sync: boolean): void } }).Bun?.gc
const nodeGc = (globalThis as { gc?: () => void }).gc
const gcKind = bunGc ? "Bun.gc(true)" : nodeGc ? "global.gc (--expose-gc)" : "none"
const tick = () => new Promise<void>((r) => setImmediate(r))
async function gc() {
  for (let i = 0; i < 3; i++) {
    await tick()
    if (bunGc) bunGc(true)
    else nodeGc?.()
  }
}

const peak: Sample = { heapUsedMb: 0, rssMb: 0, externalMb: 0, arrayBuffersMb: 0 }
function track() {
  const s = mem()
  for (const k of Object.keys(peak) as Array<keyof Sample>) if (s[k] > peak[k]) peak[k] = s[k]
}

/** Deterministic synthetic document: no client text, only generated filler in the shape Studio prints (.page blocks). */
function syntheticHtml(targetMb: number) {
  const parts = ['<!doctype html><html><head><style>@page{size:210mm 297mm}</style></head><body>']
  let size = 0
  for (let i = 0; size < targetMb * MB; i++) {
    const p = `<div class="page"><h2>Bagian sintetis ${i}</h2><p>${`Kalimat pengisi nomor ${i} untuk pengukuran memori. `.repeat(40)}</p></div>\n`
    parts.push(p)
    size += p.length
  }
  parts.push("</body></html>")
  return parts.join("")
}

/** Deterministic A4 page image at 150 dpi (1240 x 1754), mildly varied so the PNG is not trivially small. */
function syntheticPng() {
  const width = 1240, height = 1754
  const rgb = new Uint8Array(width * height * 3)
  let x = 12345
  for (let i = 0; i < rgb.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    rgb[i] = i % 97 < 60 ? 255 : (x >> 16) & 0xff
  }
  return { width, height, png: encodePngRgb({ width, height, rgb }) }
}

const info = (): EngineInfo => ({
  electron: "harness", chrome: "harness", partition: "datum-render", sandbox: true, contextIsolation: true,
  nodeIntegration: false, javascriptContent: false, network: "blocked",
})

const work = realpathSync(mkdtempSync(join(tmpdir(), "r21-")))
const logCalls = { info: 0, warn: 0, error: 0 }
const log = (level: "error" | "warn" | "info") => { logCalls[level]++ }
const fonts = buildFontBundle(fontsDir)
const policy = defaultPolicy()
const scripts = new ScriptAllowList()
const SCRIPT = "(function (o) { return { fixture: true, o: o }; })"
scripts.add("row21.fixture", SCRIPT)

const retained: string[] = []
const shot = scenario.startsWith("pagepng") ? syntheticPng() : undefined
const shotB64 = shot?.png.toString("base64")
const pdfBytes = Buffer.alloc(Math.round(pdfMb * MB), 0x25)

const engine: PageEngine = {
  async png() { return Buffer.from(pdfBytes) },
  async pdf(job) {
    if (scenario === "dispatch-cdpsim") {
      // Copy sizes a CDP send of { frameId, html } needs: one JSON text and one UTF-8 byte copy. Dropped at once.
      const json = JSON.stringify({ frameId: "F", html: job.html })
      const utf8 = Buffer.from(json, "utf8")
      if (utf8.length < job.html.length) throw new Error("unreachable")
    }
    if (scenario === "control-retain") retained.push(job.html)
    return Buffer.from(pdfBytes)
  },
  async evaluate() { return { measured: true } },
  async pagePngs(job): Promise<PagePngsResult> {
    const images: PagePngsResult["images"] = []
    for (let n = 1; n <= 12; n++) {
      const raw = Buffer.from(shotB64!, "base64")
      if (scenario === "pagepng-flow") {
        const content = decodePngRgb(raw, [255, 255, 255])
        const png = composePage({ width: shot!.width, height: shot!.height, bg: [255, 255, 255], content, left: 0, top: 0 })
        images.push({ n, png, width: shot!.width, height: shot!.height })
      } else images.push({ n, png: raw, width: shot!.width, height: shot!.height })
    }
    return { layout: scenario === "pagepng-flow" ? "flow" : "paged", media: "print", pageCount: 12, pageSizeMm: job.fallback, pageSizeSource: "fallback", images }
  },
  info,
}

const dispatch = createDispatcher({ engine, policy, fonts: () => fonts, scripts })

let concatCalls = 0, concatBytes = 0
function countConcat() {
  const orig = Buffer.concat
  Buffer.concat = ((list: readonly Uint8Array[], total?: number) => {
    const out = orig.call(Buffer, list, total)
    concatCalls++
    concatBytes += out.length
    return out
  }) as typeof Buffer.concat
}

function request(socketPath: string, line: string, keep = false): Promise<{ reply: string }> {
  return new Promise((ok, fail) => {
    const sock = createConnection(socketPath)
    let got = ""
    sock.on("data", (c) => {
      got += c.toString("utf8")
      if (got.includes("\n")) { if (!keep) sock.end(); ok({ reply: got.slice(0, 200) }) }
    })
    sock.on("error", fail)
    sock.on("connect", () => sock.write(line + "\n"))
  })
}

/** --client=child: K inline requests sent by a second process, so this process holds only the server side. */
function childBatch(socketPath: string, token: string, count: number) {
  return new Promise<void>((ok, fail) => {
    const c = spawn(process.execPath, [process.argv[1], "--scenario=socket-client", `--sock=${socketPath}`, `--token=${token}`, `--count=${count}`, `--mib=${inlineMib}`, `--fonts=${fontsDir}`], { stdio: ["ignore", "ignore", "inherit"] })
    c.on("error", fail)
    c.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`client exited ${code}`))))
  })
}

async function clientMain() {
  const line = JSON.stringify({ id: 1, token: args.token, op: "checkPage", html: syntheticHtml(inlineMib), script: SCRIPT, wMm: 210, hMm: 297 })
  for (let i = 0; i < Number(args.count); i++) {
    const r = await request(args.sock, line)
    if (!r.reply.includes('"ok":true')) throw new Error("bridge refused: " + r.reply)
  }
  rmSync(work, { recursive: true, force: true })
}

async function main() {
  if (scenario === "socket-client") return clientMain()
  const childClient = scenario === "socket-inline" && args.client === "child"
  const src = join(work, "doc.html")
  const html = syntheticHtml(htmlMb)
  writeFileSync(src, html)
  const outDir = join(work, "out")
  mkdirSync(outDir)
  const fixture = { htmlChars: html.length, fontCssChars: fonts.css.length, fontFaces: fonts.faceCount, pdfBytes: pdfBytes.length, pagePngBytes: shot?.png.length ?? null, pageB64Chars: shotB64?.length ?? null }

  let server: Awaited<ReturnType<typeof startSocketServer>> | undefined
  const token = "t".repeat(64)
  let inlineLine = ""
  if (scenario.startsWith("socket")) {
    server = await startSocketServer({ token, dispatch, log, baseDir: args.sockDir ?? work })
    if (scenario === "socket-inline") {
      countConcat()
      inlineLine = childClient ? "" : JSON.stringify({ id: 1, token, op: "checkPage", html: syntheticHtml(inlineMib), script: SCRIPT, wMm: 210, hMm: 297 })
    }
  }

  const job = async (i: number) => {
    if (scenario === "dispatch-pdf" || scenario === "dispatch-cdpsim" || scenario === "control-retain") {
      await dispatch({ op: "pdf", src, dst: join(outDir, `o${i % 4}.pdf`) })
    } else if (scenario.startsWith("pagepng")) {
      await dispatch({ op: "pagePng", src, dstDir: outDir })
    } else if (childClient) {
      await childBatch(server!.socketPath, token, 1)
    } else if (scenario === "socket-inline") {
      const r = await request(server!.socketPath, inlineLine)
      if (!r.reply.includes('"ok":true')) throw new Error("bridge refused: " + r.reply)
    } else if (scenario === "socket-churn") {
      const r = await request(server!.socketPath, JSON.stringify({ id: i, token, op: "hello" }))
      if (!r.reply.includes('"ok":true')) throw new Error("bridge refused: " + r.reply)
    } else throw new Error("unknown scenario " + scenario)
  }

  await gc()
  const startup = mem()
  let sampler: ReturnType<typeof setInterval> | undefined
  if (childClient) sampler = setInterval(track, 5)
  // Warm-up outside the measurement: JIT, lazy module state, first-use buffers.
  for (let i = 0; i < 3; i++) await job(i)
  await gc()
  concatCalls = 0
  concatBytes = 0
  const before = mem()
  const checkpoints: Array<{ jobs: number; raw: Sample; afterGc: Sample }> = []
  const step = Math.max(1, Math.floor(N / 5))
  const t0 = Date.now()
  for (let i = 1; i <= N; i++) {
    await job(i)
    track()
    if (i % step === 0 || i === N) {
      const raw = mem()
      await gc()
      checkpoints.push({ jobs: i, raw, afterGc: mem() })
    }
  }
  const elapsedMs = Date.now() - t0
  if (sampler) clearInterval(sampler)
  const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.().length ?? null
  await server?.close()
  retained.length = 0
  await gc()
  const after = mem()
  const last = checkpoints[checkpoints.length - 1].afterGc
  const first = checkpoints[0].afterGc
  const span = checkpoints[checkpoints.length - 1].jobs - checkpoints[0].jobs
  const result = {
    scenario, n: N, runtime: bunGc ? `bun ${process.versions.bun}` : `node ${process.versions.node} (v8 ${process.versions.v8})`, gc: gcKind,
    params: { htmlMb, pdfMb, inlineMib: scenario === "socket-inline" ? inlineMib : null }, fixture, elapsedMs,
    client: scenario === "socket-inline" ? (childClient ? "child process" : "same process") : null,
    startupBeforeWarmup: startup, before, checkpoints, peakDuring: peak, afterCloseAndGc: after,
    // Retention per job between the first and the last GC'd checkpoint, in KB per job (measured delta / jobs).
    retainedPerJobKb: span > 0 ? {
      heapUsed: Math.round(((last.heapUsedMb - first.heapUsedMb) * 1024 / span) * 100) / 100,
      rss: Math.round(((last.rssMb - first.rssMb) * 1024 / span) * 100) / 100,
      external: Math.round(((last.externalMb - first.externalMb) * 1024 / span) * 100) / 100,
    } : null,
    logCalls, activeHandlesBeforeClose: handles,
    concat: scenario === "socket-inline" ? { calls: concatCalls, totalMb: mb(concatBytes), callsPerRequest: Math.round(concatCalls / N), mbPerRequest: mb(concatBytes / N), requestHtmlMib: inlineMib } : null,
    outFiles: readdirSync(outDir).length,
  }
  rmSync(work, { recursive: true, force: true })
  console.log(JSON.stringify(result))
}

main().catch((error) => {
  // Test-only script: the failure goes to stderr and the exit code; there is no app log to persist it in.
  console.error("row21 harness failed:", error instanceof Error ? error.stack : error)
  try { rmSync(work, { recursive: true, force: true }) } catch {}
  process.exit(1)
})
