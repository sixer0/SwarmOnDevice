import { describe, expect, test } from "bun:test"
import { setupToolsFor } from "./setup-tools-gate"

// Row 128: swarm-setup ships only in the macOS app (Linux/Windows spec X1, R5.11). The app hides the first-run
// offer (setup-tools-offer.tsx) and the `tools.install` command (install-tools-command.tsx) when
// `platform.setupTools` is undefined, so the gate decides the UI state per OS.
const api = { marker: "setupTools" }

describe("setupToolsFor", () => {
  test("macOS keeps the capability, so the offer and /install-tools stay as before", () => {
    expect(setupToolsFor("macos", api)).toBe(api)
  })

  test("Linux has no capability, so the offer and /install-tools are not rendered", () => {
    expect(setupToolsFor("linux", api)).toBeUndefined()
  })

  test("Windows has no capability, so the offer and /install-tools are not rendered", () => {
    expect(setupToolsFor("windows", api)).toBeUndefined()
  })

  test("an unrecognised OS fails closed", () => {
    expect(setupToolsFor(undefined, api)).toBeUndefined()
  })
})
