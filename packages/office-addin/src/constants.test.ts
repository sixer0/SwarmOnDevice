import { describe, expect, test } from "bun:test"
import * as c from "./constants"

describe("office-addin constants (register rev 5)", () => {
  test("port and origin", () => {
    expect(c.OFFICE_BRIDGE_PORT).toBe(46317)
    expect(c.OFFICE_ORIGIN).toBe("https://localhost:46317")
    expect(c.OFFICE_PANE_URL).toBe(`${c.OFFICE_ORIGIN}/pane/index.html`)
    expect(c.OFFICE_PROXY_BASE_URL).toBe(`${c.OFFICE_ORIGIN}/swarm`)
  })

  test("paths and headers", () => {
    expect(c.OFFICE_PATH_PANE).toBe("/pane")
    expect(c.OFFICE_PATH_PROXY).toBe("/swarm")
    expect(c.OFFICE_PATH_PAIR_REQUEST).toBe("/pair/request")
    expect(c.OFFICE_PATH_PAIR_STATUS).toBe("/pair/status")
    expect(c.OFFICE_PATH_PAIR_VERIFY).toBe("/pair/verify")
    expect(c.OFFICE_PATH_BRIDGE_HEALTH).toBe("/bridge/health")
    expect(c.OFFICE_CSRF_HEADER).toBe("X-Swarm-Office")
    expect(c.OFFICE_TOKEN_HEADER).toBe("X-Swarm-Office-Token")
    expect(c.OFFICE_JS_URL).toBe("https://officeapis.public.onecdn.static.microsoft/1/office.js")
  })

  test("limits", () => {
    expect(c.OFFICE_STREAM_LIMIT).toBe(4)
    expect(c.OFFICE_ERROR_STREAM_LIMIT).toBe("STREAM_LIMIT")
    expect(c.OFFICE_RECENT_CHATS_LIMIT).toBe(20)
    expect(c.OFFICE_HISTORY_LIMIT).toBe(50)
    expect(c.OFFICE_BODY_LIMIT_BYTES).toBe(2097152)
    expect(c.OFFICE_PAIR_IDLE_DAYS).toBe(90)
  })

  test("pane CSP", () => {
    expect(c.OFFICE_PANE_CSP).toBe(
      "default-src 'self'; script-src 'self' https://officeapis.public.onecdn.static.microsoft; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    )
    expect(c.OFFICE_PANE_CSP).toContain("frame-ancestors 'none'")
  })

  test("storage keys, session key and perf marks", () => {
    expect(c.OFFICE_TOKEN_STORAGE_KEY).toBe("swarm.office.token")
    expect(c.OFFICE_SESSION_KEY_FORMAT).toBe("swarm.office.session.<docKey>")
    expect(c.OFFICE_DISCLOSURE_ACK_KEY).toBe("swarm.office.disclosureAck")
    expect(c.OFFICE_CONTEXT_SCOPE_KEY).toBe("swarm.office.contextScope")
    expect(c.OFFICE_PERF_MARK_FIRST_TEXT).toBe("swarm.office.firstText")
    expect(c.OFFICE_PERF_MARK_SEND).toBe("swarm.office.send")
    expect(c.OFFICE_PERF_MARK_REQUEST).toBe("swarm.office.request")
    expect(c.OFFICE_PERF_MARK_BUSY).toBe("swarm.office.busy")
  })

  test("metadata, hosts, providers", () => {
    expect(c.OFFICE_ORIGIN_METADATA_KEY).toBe("swarm.origin")
    expect(c.OFFICE_ORIGIN_VALUE).toBe("office-addin")
    expect(c.OFFICE_HOST_METADATA_KEY).toBe("swarm.office.host")
    expect([...c.OFFICE_HOSTS]).toEqual(["Word", "Excel"])
    expect([...c.INTERNAL_PROVIDER_IDS]).toEqual(["gsp-ai-tail"])
  })

  test("session ruleset deep-equals REG 7.2", () => {
    const expected = [
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "webfetch", pattern: "*", action: "deny" },
      { permission: "websearch", pattern: "*", action: "deny" },
      { permission: "task", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: "*", action: "deny" },
    ]
    expect(JSON.stringify(c.OFFICE_SESSION_RULESET)).toBe(JSON.stringify(expected))
    expect(JSON.parse(JSON.stringify(c.OFFICE_SESSION_RULESET))).toEqual(expected)
  })

  test("Excel number pattern", () => {
    for (const ok of ["0", "7", "-7", "3.14", "-0.5", "1234567"]) expect(c.EXCEL_NUMBER_PATTERN.test(ok)).toBe(true)
    for (const bad of ["+7", ".5", "3e2", "1E-3", "1.", "", " 1", "1 ", "1,5", "--1", "１"])
      expect(c.EXCEL_NUMBER_PATTERN.test(bad)).toBe(false)
  })

  test("Excel formula-leading set", () => {
    expect([...c.EXCEL_FORMULA_LEADING]).toEqual(["=", "+", "-", "@", "\t", " ", "\r", "＝", "＋", "－", "＠"])
  })

  test("error codes", () => {
    expect(c.OFFICE_ERROR_PORT_IN_USE).toBe("PORT_IN_USE")
    expect(c.OFFICE_ERROR_TOKEN_INVALID).toBe("TOKEN_INVALID")
    expect(c.OFFICE_ERROR_FIELD_NOT_ALLOWED).toBe("FIELD_NOT_ALLOWED")
    expect(c.OFFICE_ERROR_BRIDGE_EXITED).toBe("BRIDGE_EXITED")
    expect(c.OFFICE_ERROR_DATA_DIR_UNSAFE).toBe("DATA_DIR_UNSAFE")
    expect(c.OFFICE_ERROR_START_TIMEOUT).toBe("START_TIMEOUT")
  })
})
