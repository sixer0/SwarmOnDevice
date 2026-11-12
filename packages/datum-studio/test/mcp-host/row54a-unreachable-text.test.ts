// Swarm 1.2.6 row 54a (M-02, U5; register N-050): REMOTE_UNREACHABLE text names the operation, the limit constant
// that fired and the follow-up (studio_document_status), and never prints the in-process placeholder origin.
import { describe, expect, test } from "bun:test"
import * as client from "../../vendor/scripts/studio/_http-client.ts"

const IN_PROCESS = "http://127.0.0.1:1"
const SECRET = "s".repeat(64)

function timeoutError(): Error {
  const e = new Error("The operation timed out.")
  e.name = "TimeoutError"
  return e
}

async function failure(baseUrl: string, method: client.StudioMethod, path: string, thrown: Error, timeoutMs?: number) {
  try {
    await client.studioRequest(
      { baseUrl, secret: SECRET, redirect: "manual", fetchImpl: async () => { throw thrown }, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
      method,
      path,
    )
  } catch (e) {
    return e as client.StudioUnreachableError
  }
  throw new Error("expected studioRequest to throw")
}

describe("row 54a: REMOTE_UNREACHABLE text (M-02)", () => {
  test("IN_PROCESS_ENDPOINT_LABEL is registered as 'studio-host (in-process)'", () => {
    expect((client as Record<string, unknown>).IN_PROCESS_ENDPOINT_LABEL).toBe("studio-host (in-process)")
  })

  test("a timed-out R17 call names the operation, STUDIO_RENDER_CALL_TIMEOUT_MS and studio_document_status, never 127.0.0.1:1", async () => {
    const e = await failure(IN_PROCESS, "POST", "/api/studio/documents/cdoc1/render", timeoutError(), client.STUDIO_RENDER_CALL_TIMEOUT_MS)
    expect(e.code).toBe("REMOTE_UNREACHABLE")
    expect(e.timedOut).toBe(true)
    expect(e.message).toContain("POST /api/studio/documents/cdoc1/render")
    expect(e.message).toContain("540 detik")
    expect(e.message).toContain("STUDIO_RENDER_CALL_TIMEOUT_MS")
    expect(e.message).toContain("studio_document_status")
    expect(e.message).toContain("studio-host (in-process)")
    expect(e.message).not.toContain(IN_PROCESS)
    expect(e.message).not.toContain(SECRET)
  })

  test("a call on the default budget names STUDIO_HTTP_TIMEOUT_MS (60 s) and the follow-up", async () => {
    const e = await failure(IN_PROCESS, "GET", "/api/studio/documents/cdoc1/status", timeoutError())
    expect(e.timedOut).toBe(true)
    expect(e.message).toContain("GET /api/studio/documents/cdoc1/status")
    expect(e.message).toContain("60 detik")
    expect(e.message).toContain("STUDIO_HTTP_TIMEOUT_MS")
    expect(e.message).not.toContain("STUDIO_RENDER_CALL_TIMEOUT_MS")
    expect(e.message).toContain("studio_document_status")
    expect(e.message).not.toContain(IN_PROCESS)
  })

  test("the operation drops the query string (search terms are not echoed)", async () => {
    const e = await failure(IN_PROCESS, "GET", "/api/studio/search?q=rahasia-klien", timeoutError())
    expect(e.message).toContain("GET /api/studio/search")
    expect(e.message).not.toContain("rahasia-klien")
  })

  test("a refused in-process connection names the operation and the label, never 127.0.0.1:1", async () => {
    const e = await failure(IN_PROCESS, "GET", "/api/studio/templates", new Error(`connect ECONNREFUSED ${IN_PROCESS}`))
    expect(e.code).toBe("REMOTE_UNREACHABLE")
    expect(e.timedOut).toBe(false)
    expect(e.message).toContain("GET /api/studio/templates")
    expect(e.message).toContain("studio-host (in-process)")
    expect(e.message).not.toContain(IN_PROCESS)
  })

  test("a real remote base URL (CLI --remote) is still named so the operator can check it", async () => {
    const e = await failure("http://studio.example:9021", "GET", "/api/studio/templates", timeoutError())
    expect(e.message).toContain("http://studio.example:9021")
    expect(e.message).toContain("STUDIO_HTTP_TIMEOUT_MS")
  })
})
