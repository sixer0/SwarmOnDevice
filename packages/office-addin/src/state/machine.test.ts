import { describe, expect, test } from "bun:test"
import { enabledControls, initialState, reduce, type ConnectionEvent, type ConnectionState, type Effect } from "./machine"

const TOKEN = "swo1_" + "B".repeat(43)

// Runs events through the reducer on an injected clock: each entry is [ms, event].
function run(events: [number, ConnectionEvent][], start = initialState(0)) {
  return events.reduce(
    (acc, entry) => {
      const result = reduce(acc.state, entry[1], entry[0])
      return { state: result.state, effects: [...acc.effects, ...result.effects], last: result.effects }
    },
    { state: start, effects: [] as Effect[], last: [] as Effect[] },
  )
}

const ready: [number, ConnectionEvent][] = [
  [0, { type: "load" }],
  [5, { type: "officeReady", host: "Word", supported: true }],
]

function unpaired() {
  return run([...ready, [10, { type: "health", ready: true, token: false }]]).state
}

function pairing(at = 100): ConnectionState {
  return run(
    [
      [at, { type: "connect" }],
      [at, { type: "pairResponse", status: 202, requestId: "req1", code: "4821" }],
    ],
    unpaired(),
  ).state
}

function connected() {
  return run([...ready, [10, { type: "health", ready: true, token: true }], [20, { type: "verify", status: 204 }]]).state
}

const types = (effects: Effect[]) => effects.map((effect) => effect.type)

describe("connection machine T1-T17", () => {
  test("U-ST-01 T3 non-Word/Excel host or unsupported set gives unsupported-host with no control", () => {
    const other = run([[0, { type: "load" }], [1, { type: "officeReady", host: "PowerPoint", supported: true }]])
    expect(other.state.name).toBe("unsupported-host")
    expect(enabledControls(other.state)).toEqual([])
    expect(other.last).toEqual([])
    const unsupported = run([[0, { type: "load" }], [1, { type: "officeReady", host: "Excel", supported: false }]])
    expect(unsupported.state.name).toBe("unsupported-host")
    expect(enabledControls(unsupported.state)).toEqual([])
  })

  test("U-ST-02 T1/T2 Office global absent at 10 s stays loading and flags officeJsMissing", () => {
    const loaded = run([[0, { type: "load" }]])
    expect(loaded.state.name).toBe("loading")
    expect(loaded.effects).toEqual([{ type: "startOfficeTimer", ms: 10_000 }])
    const early = run([[9_999, { type: "tick", officePresent: false }]], loaded.state)
    expect(early.state.officeJsMissing).toBe(false)
    const late = run([[10_000, { type: "tick", officePresent: false }]], loaded.state)
    expect(late.state.name).toBe("loading")
    expect(late.state.officeJsMissing).toBe(true)
    const present = run([[10_000, { type: "tick", officePresent: true }]], loaded.state)
    expect(present.state.officeJsMissing).toBe(false)
  })

  test("U-ST-03 T4/T8 health failure gives unavailable; Retry reaches connected with no pair request", () => {
    const down = run([...ready, [10, { type: "health", ready: false, token: true }]])
    expect(down.state.name).toBe("unavailable")
    expect(enabledControls(down.state)).toEqual(["retry"])
    const back = run(
      [
        [50, { type: "retry" }],
        [60, { type: "health", ready: true, token: true }],
        [70, { type: "verify", status: 204 }],
      ],
      down.state,
    )
    expect(back.state.name).toBe("connected")
    expect(types(back.effects)).toEqual(["checkHealth", "verifyToken", "restoreChat"])
    expect(types(back.effects)).not.toContain("pairRequest")
  })

  test("U-ST-04 T5/T6/T7 token paths", () => {
    expect(unpaired().name).toBe("unpaired")
    const ok = run([...ready, [10, { type: "health", ready: true, token: true }], [20, { type: "verify", status: 204 }]])
    expect(ok.state.name).toBe("connected")
    expect(types(ok.effects)).not.toContain("pairRequest")
    const rejected = run([...ready, [10, { type: "health", ready: true, token: true }], [20, { type: "verify", status: 401 }]])
    expect(rejected.state.name).toBe("unpaired")
    expect(rejected.last).toEqual([{ type: "deleteToken" }, { type: "deleteAllSessions" }])
  })

  test("U-ST-05 T9/T11 Connect, 202, approved stores the token and stops polling at 1000 ms", () => {
    const state = unpaired()
    const connect = reduce(state, { type: "connect" }, 100)
    expect(connect.effects).toEqual([{ type: "pairRequest", host: "Word" }])
    const accepted = reduce(state, { type: "pairResponse", status: 202, requestId: "req1", code: "4821" }, 100)
    expect(accepted.state.name).toBe("pairing")
    expect(accepted.state.pairing?.code).toBe("4821")
    expect(accepted.effects).toEqual([{ type: "startPolling", requestId: "req1", ms: 1000 }])
    const approved = reduce(accepted.state, { type: "pairStatus", state: "approved", token: TOKEN }, 1100)
    expect(approved.state.name).toBe("connected")
    expect(approved.effects).toEqual([{ type: "stopPolling" }, { type: "storeToken", token: TOKEN }, { type: "restoreChat" }])
  })

  test("U-ST-06 T12 denied stores no token and enables Connect again", () => {
    const denied = reduce(pairing(), { type: "pairStatus", state: "denied" }, 2000)
    expect(denied.state.name).toBe("denied")
    expect(denied.effects).toEqual([{ type: "stopPolling" }])
    expect(enabledControls(denied.state)).toEqual(["connect"])
    expect(reduce(denied.state, { type: "connect" }, 2100).effects).toEqual([{ type: "pairRequest", host: "Word" }])
  })

  test("U-ST-07 T13 expired, or 120 s on the injected clock, gives unpaired with the expired notice", () => {
    const expired = reduce(pairing(), { type: "pairStatus", state: "expired" }, 5000)
    expect(expired.state.name).toBe("unpaired")
    expect(expired.state.notice).toBe("office.connect.expired")
    const start = pairing(100)
    expect(reduce(start, { type: "tick", officePresent: true }, 120_099).state.name).toBe("pairing")
    const timedOut = reduce(start, { type: "tick", officePresent: true }, 120_100)
    expect(timedOut.state.name).toBe("unpaired")
    expect(timedOut.state.notice).toBe("office.connect.expired")
    expect(timedOut.effects).toEqual([{ type: "stopPolling" }])
    expect(reduce(start, { type: "pairStatus", state: "pending" }, 120_100).state.name).toBe("unpaired")
  })

  test("U-ST-08 T10/T14 429 toasts and keeps the state; consumed gives unpaired plus generic", () => {
    const state = unpaired()
    const limited = reduce(state, { type: "pairResponse", status: 429 }, 100)
    expect(limited.state).toBe(state)
    expect(limited.effects).toEqual([{ type: "toast", key: "office.error.pairRateLimited" }])
    const consumed = reduce(pairing(), { type: "pairStatus", state: "consumed" }, 2000)
    expect(consumed.state.name).toBe("unpaired")
    expect(consumed.effects).toEqual([{ type: "stopPolling" }, { type: "toast", key: "office.error.generic" }])
  })

  test("U-ST-09 T15/FR-30 401 TOKEN_INVALID gives unpaired with no pair request until Connect", () => {
    const out = run(
      [
        [100, { type: "apiError", status: 401, code: "TOKEN_INVALID" }],
        [200, { type: "tick", officePresent: true }],
        [300, { type: "retry" }],
      ],
      connected(),
    )
    expect(out.state.name).toBe("unpaired")
    expect(out.effects).toEqual([{ type: "deleteToken" }, { type: "deleteAllSessions" }])
    expect(types(out.effects)).not.toContain("pairRequest")
    expect(reduce(out.state, { type: "connect" }, 400).effects).toEqual([{ type: "pairRequest", host: "Word" }])
  })

  test("U-ST-10 T16/T17 network failure keeps the list; 404 drops only the current document's key", () => {
    const network = reduce(connected(), { type: "apiError", status: 0 }, 100)
    expect(network.state.name).toBe("unavailable")
    expect(network.effects).toEqual([{ type: "markInterrupted" }])
    expect(types(network.effects)).not.toContain("deleteAllSessions")
    expect(reduce(connected(), { type: "apiError", status: 503, code: "SWARM_UNAVAILABLE" }, 100).state.name).toBe("unavailable")
    expect(reduce(connected(), { type: "streamLost" }, 100).state.name).toBe("unavailable")
    const gone = reduce(connected(), { type: "apiError", status: 404, code: "ROUTE_NOT_ALLOWED", storedSession: true }, 100)
    expect(gone.state.name).toBe("connected")
    expect(gone.effects).toEqual([{ type: "dropCurrentSession" }])
    expect(reduce(connected(), { type: "apiError", status: 413, code: "BODY_TOO_LARGE" }, 100).effects).toEqual([
      { type: "toast", key: "office.error.tooLarge" },
    ])
    expect(reduce(connected(), { type: "apiError", status: 400, code: "FIELD_NOT_ALLOWED" }, 100).effects).toEqual([
      { type: "toast", key: "office.error.generic" },
    ])
  })

  test("events outside their source state are ignored", () => {
    const state = connected()
    expect(reduce(state, { type: "pairStatus", state: "approved", token: TOKEN }, 1).state).toBe(state)
    expect(reduce(state, { type: "connect" }, 1).effects).toEqual([])
    expect(reduce(pairing(), { type: "pairStatus", state: "approved", token: "bad" }, 1).state.name).toBe("unpaired")
  })
})
