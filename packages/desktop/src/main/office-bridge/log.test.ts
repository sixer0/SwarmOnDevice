import { describe, expect, test } from "bun:test"
import { bridgeLogContext, bridgeLogRecord, formatBridgeLog, routeIdFor } from "./log"

// Row 48 (plan M2-02). U-BR-13 (SC-33, AC-39): a log record has only method, route id, status, host and duration.
// A token, a body string and a query string never appear in the formatted line.

const TOKEN = "swo1_" + "A".repeat(43)
const BASIC = "Basic b3BlbmNvZGU6c2VjcmV0LXBhc3N3b3Jk"
const BODY = "Quarterly revenue draft: confidential"
const SESSION = "ses_0123456789abcdefABCDEF"

describe("U-BR-13 log formatter", () => {
  test("only the five fields, in fixed order", () => {
    const record = bridgeLogRecord({ method: "GET", url: "/swarm/session?limit=20", status: 200, host: "localhost:46317", durationMs: 12.4 })
    expect(Object.keys(record)).toEqual(["method", "route", "status", "host", "durationMs"])
    expect(formatBridgeLog(record)).toBe("method=GET route=P3 status=200 host=localhost:46317 durationMs=12")
    expect(Object.keys(bridgeLogContext(record))).toEqual(["method", "route", "status", "host", "durationMs"])
  })

  test("a token, a body string, a query string and a session id never appear", () => {
    // Extra fields a careless caller might pass are not copied (the input type does not even allow them).
    const input = {
      method: "POST",
      url: `/swarm/session/${SESSION}/prompt_async?auth_token=${TOKEN}&directory=/Users/x`,
      status: 204,
      host: "localhost:46317",
      durationMs: 5,
      token: TOKEN,
      authorization: BASIC,
      body: BODY,
      headers: { "x-swarm-office-token": TOKEN },
    }
    const record = bridgeLogRecord(input)
    const line = formatBridgeLog(record)
    const context = JSON.stringify(bridgeLogContext(record))
    expect(line).toBe("method=POST route=P6 status=204 host=localhost:46317 durationMs=5")
    for (const secret of [TOKEN, BASIC, BODY, SESSION, "auth_token", "directory", "?", "/Users/x", "/swarm"]) {
      expect(line).not.toContain(secret)
      expect(context).not.toContain(secret)
    }
  })

  test("a hostile Host header or method is replaced, never echoed", () => {
    const record = bridgeLogRecord({
      method: "GET\r\nX-Injected: 1",
      url: "/",
      status: 421,
      host: `evil.example\r\nmethod=FAKE ${TOKEN}`,
      durationMs: 1,
    })
    expect(formatBridgeLog(record)).toBe("method=OTHER route=root status=421 host=invalid durationMs=1")
    expect(bridgeLogRecord({ method: "GET", url: "/", status: 200, host: undefined, durationMs: 1 }).host).toBe("invalid")
    expect(bridgeLogRecord({ method: "GET", url: "/", status: 200, host: "[::1]:46317", durationMs: 1 }).host).toBe("[::1]:46317")
  })

  test("status and duration are normalised numbers", () => {
    const record = bridgeLogRecord({ method: "GET", url: "/", status: 9999, host: "localhost:46317", durationMs: Number.NaN })
    expect(record.status).toBe(0)
    expect(record.durationMs).toBe(0)
    expect(bridgeLogRecord({ method: "GET", url: "/", status: 200, host: "localhost:46317", durationMs: -3 }).durationMs).toBe(0)
  })
})

describe("routeIdFor", () => {
  test("P1-P8 per register §7.3", () => {
    expect(routeIdFor("GET", "/swarm/global/health")).toBe("P1")
    expect(routeIdFor("POST", "/swarm/session")).toBe("P2")
    expect(routeIdFor("GET", "/swarm/session?limit=20")).toBe("P3")
    expect(routeIdFor("GET", `/swarm/session/${SESSION}`)).toBe("P4")
    expect(routeIdFor("GET", `/swarm/session/${SESSION}/message?limit=50`)).toBe("P5")
    expect(routeIdFor("POST", `/swarm/session/${SESSION}/prompt_async`)).toBe("P6")
    expect(routeIdFor("POST", `/swarm/session/${SESSION}/abort`)).toBe("P7")
    expect(routeIdFor("GET", "/swarm/event")).toBe("P8")
  })

  test("bridge-local routes and the static branch", () => {
    expect(routeIdFor("GET", "/")).toBe("root")
    expect(routeIdFor("GET", "/pane/index.html")).toBe("pane")
    expect(routeIdFor("GET", "/bridge/health")).toBe("health")
    expect(routeIdFor("POST", "/pair/request")).toBe("pair-request")
    expect(routeIdFor("GET", "/pair/status?requestId=abc")).toBe("pair-status")
    expect(routeIdFor("GET", "/pair/verify")).toBe("pair-verify")
  })

  test("anything else is unmatched", () => {
    expect(routeIdFor("PATCH", `/swarm/session/${SESSION}`)).toBe("unmatched")
    expect(routeIdFor("POST", `/swarm/session/${SESSION}/message`)).toBe("unmatched")
    expect(routeIdFor("GET", "/swarm/global/event")).toBe("unmatched")
    expect(routeIdFor("GET", "/api/session")).toBe("unmatched")
    expect(routeIdFor("GET", "https://localhost:46317/swarm/event")).toBe("unmatched")
  })
})
