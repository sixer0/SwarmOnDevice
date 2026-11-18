// Spike S1 / S1v / S2 (plan row 32, M0-03): throwaway HTTPS server.
//
// Main listeners: https://127.0.0.1:46317 and https://[::1]:46317 with the
// localhost leaf. Binding the specific address ::1 is IPv6-only by nature (only
// the wildcard "::" can accept IPv4-mapped connections), so the two listeners
// never overlap and the access log shows which family Office used (O4 / RC-4).
//
// ST-10 listener: https://127.0.0.1:46318 with the example.com leaf, for
//   curl --resolve example.com:46318:127.0.0.1 https://example.com:46318/
// (README.md: the primary ST-10 evidence is verify-cert; curl is supporting).
//
// Usage: bun server.ts [outDir]   (outDir = the gen-certs.ts output directory)
// Queue: lines appended to <outDir>/s3-queue.txt are handed to the S3 pane by GET /s3/next.
// Env:   SPIKE_PORT (default 46317), SPIKE_ALT_PORT (default 46318),
//        SPIKE_V6=0 to skip the ::1 listener,
//        SPIKE_S3_FRAME_ANCESTORS to append frame-ancestors to the /s3/* CSP.
import { appendFile, rename } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Server } from "bun"

const out = process.argv[2] ?? join(process.env.TMPDIR ?? tmpdir(), "swarm-office-spike-s1-s2")
const port = Number(process.env.SPIKE_PORT ?? 46317)
const altPort = Number(process.env.SPIKE_ALT_PORT ?? 46318)
const withV6 = process.env.SPIKE_V6 !== "0"
const logFile = join(out, "access.log")
// Row 33b (C20): command queue for the S3 pane. One command per line; GET /s3/next pops the first.
const queueFile = join(out, "s3-queue.txt")
// Row 33b: /pane/log keeps bodies up to 256 KiB whole (S3 probe results); larger ones get 413.
const MAX_REPORT = 256 * 1024
const paneHtml = join(import.meta.dir, "pane", "index.html")
// Row 32a (request from row 33): the S3 probe pane, served same-origin under /s3/.
const s3Dir = join(import.meta.dir, "..", "s3")
const NO_STORE = { "Cache-Control": "no-store" }
// Row 32b: register rev 2 §4.1 pane CSP (RC-6), exact literal, on /s3/* only.
// /pane/ stays without CSP so S1 isolates certificate trust from CSP effects.
// The register has no frame-ancestors value yet (O7/G11, decided after SG-1);
// SPIKE_S3_FRAME_ANCESTORS="<sources>" appends one for the row 37 experiment.
const RC6_CSP =
  "default-src 'self'; script-src 'self' https://officeapis.public.onecdn.static.microsoft; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'"
const frameAncestors = process.env.SPIKE_S3_FRAME_ANCESTORS
const S3_CSP = frameAncestors ? `${RC6_CSP}; frame-ancestors ${frameAncestors}` : RC6_CSP
const S3_HEADERS = { ...NO_STORE, "Content-Security-Policy": S3_CSP }

const tls = {
  cert: await Bun.file(join(out, "localhost.cert.pem")).text(),
  key: await Bun.file(join(out, "localhost.key.pem")).text(),
}
const exampleTls = {
  cert: await Bun.file(join(out, "example.cert.pem")).text(),
  key: await Bun.file(join(out, "example.key.pem")).text(),
}

async function log(entry: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
  console.log(line)
  await appendFile(logFile, line + "\n")
}

// Atomic read-rewrite: the rest of the queue goes to a temp file, then rename() replaces the
// queue in one step. Pops are chained so two polls never read the same first line.
let queueTail: Promise<unknown> = Promise.resolve()
function popCommand() {
  const next = queueTail.then(async () => {
    if (!(await Bun.file(queueFile).exists())) await Bun.write(queueFile, "")
    // An `echo >> s3-queue.txt` landing between read and rename would be lost: re-read
    // when the queue changed meanwhile (bounded, the window is a few milliseconds).
    for (let attempt = 0; attempt < 5; attempt++) {
      const text = await Bun.file(queueFile).text()
      const lines = text.split("\n")
      const index = lines.findIndex((line) => line.trim() !== "")
      if (index === -1) return null
      const tmp = `${queueFile}.${process.pid}.tmp`
      await Bun.write(tmp, lines.slice(index + 1).join("\n"))
      if ((await Bun.file(queueFile).text()) !== text) continue
      await rename(tmp, queueFile)
      return lines[index].trim()
    }
    return null
  })
  queueTail = next.catch(() => undefined)
  return next
}

function handler(listener: string) {
  return async (req: Request, server: Server<undefined>) => {
    const url = new URL(req.url)
    const peer = server.requestIP(req)
    // Polled every second by the S3 pane: logged only when a command is handed out.
    if (req.method === "GET" && url.pathname === "/s3/next") {
      const cmd = await popCommand()
      if (cmd !== null) await log({ listener, event: "s3-dispatch", cmd, peer: peer?.address })
      return Response.json({ cmd }, { headers: S3_HEADERS })
    }
    await log({
      listener,
      method: req.method,
      path: url.pathname,
      host: req.headers.get("host"),
      origin: req.headers.get("origin"),
      peer: peer?.address,
      family: peer?.family,
      ua: req.headers.get("user-agent"),
    })
    if (req.method === "POST" && url.pathname === "/pane/log") {
      const body = await req.text()
      const bytes = Buffer.byteLength(body)
      if (bytes > MAX_REPORT) {
        await log({ listener, event: "pane-report-too-large", bytes })
        return new Response(null, { status: 413, headers: NO_STORE })
      }
      await log({ listener, event: "pane-report", bytes, report: body })
      return new Response(null, { status: 204, headers: NO_STORE })
    }
    if (url.pathname === "/" || url.pathname === "/pane/" || url.pathname === "/pane/index.html") {
      return new Response(Bun.file(paneHtml), { headers: { ...NO_STORE, "Content-Type": "text/html; charset=utf-8" } })
    }
    if (url.pathname === "/s3/" || url.pathname === "/s3/index.html") {
      return new Response(Bun.file(join(s3Dir, "index.html")), {
        headers: { ...S3_HEADERS, "Content-Type": "text/html; charset=utf-8" },
      })
    }
    if (url.pathname === "/s3/pane.js") {
      return new Response(Bun.file(join(s3Dir, "pane.js")), {
        headers: { ...S3_HEADERS, "Content-Type": "text/javascript; charset=utf-8" },
      })
    }
    if (url.pathname === "/pane/icons/icon-32.png" || url.pathname === "/pane/icons/icon-64.png") {
      const name = url.pathname.slice("/pane/icons/".length)
      return new Response(Bun.file(join(out, "icons", name)), { headers: { "Content-Type": "image/png" } })
    }
    return new Response("not found\n", { status: 404, headers: NO_STORE })
  }
}

const servers = [
  Bun.serve({ hostname: "127.0.0.1", port, tls, fetch: handler(`127.0.0.1:${port}`) }),
  ...(withV6 ? [Bun.serve({ hostname: "::1", port, tls, fetch: handler(`[::1]:${port}`) })] : []),
  Bun.serve({
    hostname: "127.0.0.1",
    port: altPort,
    tls: exampleTls,
    fetch: async (req, server) => {
      await log({ listener: `example 127.0.0.1:${altPort}`, path: new URL(req.url).pathname, peer: server.requestIP(req)?.address })
      return new Response("hello from the out-of-constraint example.com leaf (ST-10)\n", { headers: NO_STORE })
    },
  }),
]

await log({ event: "listening", listeners: servers.map((s) => s.url.href), out })

function stop() {
  for (const s of servers) s.stop(true)
  void log({ event: "stopped" }).then(() => process.exit(0))
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
