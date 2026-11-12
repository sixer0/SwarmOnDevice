// Probe kinds http, http-unix and file (spec 01c 3.2, TH-01). The `process: render-bridge` kind is supplied by the
// bridge owner (row 93, TH-04) through `ProbeDeps.processProbe`.
//
// A probe is never an outward request: http URLs are loopback-only (checked when the registry loads, and again here),
// `redirect: "manual"`, and no Host header is ever set (fetch derives it from the URL; FLUX answers 403 to any other).
// A probe never throws; every outcome is a ProbeResult with a reason from the closed set (N-151).

import { request as httpRequest } from "node:http"
import { stat } from "node:fs/promises"
import { resolveElkBundle } from "../datum-studio-host/elk-runtime"
import { HEALTH_PROBE_TIMEOUT_MS, PROBE_BODY_MAX_BYTES, type ToolHealthProbe, type ToolHealthReason } from "./types"

export type ProbeResult = {
  healthy: boolean
  reason: ToolHealthReason
  /** Short, no query string, no token, no body beyond the mismatching key. */
  detail: string
}

export type ProbeDeps = {
  fetch?: typeof fetch
  /** TH-04: the in-process render-bridge probe. */
  processProbe?: (probe: Extract<ToolHealthProbe, { kind: "process" }>, timeoutMs: number) => Promise<ProbeResult>
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

function expected(status: number | number[]): number[] {
  return Array.isArray(status) ? status : [status]
}

function describeExpected(status: number | number[]): string {
  const list = expected(status)
  if (list.length <= 4) return list.join(", ")
  const sorted = [...list].sort((a, b) => a - b)
  return `${sorted[0]}..${sorted[sorted.length - 1]} (${list.length} codes)`
}

/** The URL without query or fragment, for messages. */
function safeUrl(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`
}

async function readCapped(response: Response, max: number): Promise<string | undefined> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

export async function probeHttp(
  probe: Extract<ToolHealthProbe, { kind: "http" }>,
  deps: ProbeDeps = {},
): Promise<ProbeResult> {
  const timeoutMs = probe.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS
  let url: URL
  try {
    url = new URL(probe.url)
  } catch {
    return { healthy: false, reason: "PROBE_URL_NOT_LOOPBACK", detail: "probe URL is not a URL" }
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname))
    return { healthy: false, reason: "PROBE_URL_NOT_LOOPBACK", detail: `${url.protocol}//${url.host} is not loopback http` }
  const where = safeUrl(url)
  const doFetch = deps.fetch ?? fetch
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const unreachable = (why: string): ProbeResult => ({
    healthy: false,
    reason: "HTTP_UNREACHABLE",
    detail: `${where}: ${why}`,
  })
  try {
    const response = await Promise.race([
      doFetch(probe.url, { method: "GET", redirect: "manual", signal: controller.signal }),
      new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("timeout")))),
    ])
    const ok = expected(probe.expectStatus).includes(response.status)
    if (!ok) {
      void response.body?.cancel().catch(() => undefined)
      if (response.status === 403)
        return { healthy: false, reason: "HTTP_HOST_REFUSED", detail: `${where} answered 403` }
      return {
        healthy: false,
        reason: "HTTP_STATUS",
        detail: `${where} answered ${response.status}; expected ${describeExpected(probe.expectStatus)}`,
      }
    }
    if (!probe.expectJson) {
      void response.body?.cancel().catch(() => undefined)
      return { healthy: true, reason: "OK", detail: `GET ${where} -> ${response.status}` }
    }
    const text = await Promise.race([
      readCapped(response, PROBE_BODY_MAX_BYTES),
      new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("timeout")))),
    ])
    if (text === undefined)
      return { healthy: false, reason: "HTTP_BODY_MISMATCH", detail: `${where} body is larger than ${PROBE_BODY_MAX_BYTES} bytes` }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return { healthy: false, reason: "HTTP_BODY_MISMATCH", detail: `${where} body is not JSON` }
    }
    if (typeof body !== "object" || body === null || Array.isArray(body))
      return { healthy: false, reason: "HTTP_BODY_MISMATCH", detail: `${where} body is not a JSON object` }
    for (const [key, want] of Object.entries(probe.expectJson)) {
      const got = (body as Record<string, unknown>)[key]
      if (got !== want) {
        const shown = typeof got === "string" || typeof got === "number" || typeof got === "boolean" ? JSON.stringify(got) : typeof got
        return {
          healthy: false,
          reason: "HTTP_BODY_MISMATCH",
          detail: `${key} is ${shown}, expected ${JSON.stringify(want)}`.slice(0, 200),
        }
      }
    }
    return { healthy: true, reason: "OK", detail: `GET ${where} -> ${response.status}` }
  } catch (error) {
    if (timedOut) return unreachable(`timed out after ${timeoutMs} ms`)
    const code = (error as { code?: string; cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code
    return unreachable(code ? `connection failed (${code})` : "connection failed")
  } finally {
    clearTimeout(timer)
  }
}

export function probeHttpUnix(probe: Extract<ToolHealthProbe, { kind: "http-unix" }>): Promise<ProbeResult> {
  const timeoutMs = probe.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS
  return new Promise<ProbeResult>((resolve) => {
    let settled = false
    const done = (result: ProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const down = (why: string) => done({ healthy: false, reason: "SOCKET_UNREACHABLE", detail: `${probe.socketPath}: ${why}` })
    const req = httpRequest({ socketPath: probe.socketPath, path: probe.path, method: "GET" }, (res) => {
      res.resume()
      const status = res.statusCode ?? 0
      if (status === probe.expectStatus) done({ healthy: true, reason: "OK", detail: `GET ${probe.path} -> ${status}` })
      else down(`GET ${probe.path} answered ${status}; expected ${probe.expectStatus}`)
      req.destroy()
    })
    const timer = setTimeout(() => {
      down(`no answer within ${timeoutMs} ms`)
      req.destroy()
    }, timeoutMs)
    req.on("error", (error: NodeJS.ErrnoException) => down(error.code ?? "connection failed"))
    req.end()
  })
}

export async function probeFile(probe: Extract<ToolHealthProbe, { kind: "file" }>): Promise<ProbeResult> {
  if (probe.elkVendorRoot !== undefined) {
    // TH-06 (01c 4.5): the file the host would load, by the host's own rule; `{error}` is dead with its text.
    const where = resolveElkBundle({ STUDIO_VENDOR_ROOT: probe.elkVendorRoot })
    if ("error" in where) return { healthy: false, reason: "FILE_MISSING", detail: where.error }
    return probeFile({ kind: "file", path: where.file })
  }
  try {
    const st = await stat(probe.path)
    if (st.isFile()) return { healthy: true, reason: "OK", detail: "file present" }
    return { healthy: false, reason: "FILE_MISSING", detail: `${probe.path} is not a regular file` }
  } catch (error) {
    return { healthy: false, reason: "FILE_MISSING", detail: `${probe.path} (${(error as NodeJS.ErrnoException).code ?? "unreadable"})` }
  }
}

/** Runs one probe. Never throws. */
export async function runProbe(probe: ToolHealthProbe, deps: ProbeDeps = {}): Promise<ProbeResult> {
  try {
    switch (probe.kind) {
      case "http":
        return await probeHttp(probe, deps)
      case "http-unix":
        return await probeHttpUnix(probe)
      case "file":
        return await probeFile(probe)
      case "process":
        if (!deps.processProbe)
          return { healthy: false, reason: "BRIDGE_NOT_STARTED", detail: "no render-bridge probe is wired in this build" }
        return await deps.processProbe(probe, probe.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS)
    }
  } catch (error) {
    return { healthy: false, reason: "HTTP_UNREACHABLE", detail: error instanceof Error ? error.message.slice(0, 200) : "probe failed" }
  }
}
