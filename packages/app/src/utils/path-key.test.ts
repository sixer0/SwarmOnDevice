import { describe, expect, test } from "bun:test"
import { canonicalPathKey, pathKey } from "./path-key"

// The two spellings of one directory proven causal by the row-161 experiment
// ($D/verification/s5_promotions/f137_causal_test.md): macOS serves /etc, /var and /tmp as
// symlinks into /private, so the client can store the short spelling while the server
// reports the resolved one. canonicalPathKey must collapse both onto one key.
describe("canonicalPathKey", () => {
  test("folds the macOS /private spelling onto the short spelling", () => {
    expect(String(canonicalPathKey("/private/var/folders/sy/nt4h2c8t/kilo/home/.cache"))).toBe(
      "/var/folders/sy/nt4h2c8t/kilo/home/.cache",
    )
    expect(String(canonicalPathKey("/private/etc/hosts"))).toBe("/etc/hosts")
    expect(String(canonicalPathKey("/private/tmp/demo"))).toBe("/tmp/demo")
  })

  test("maps both spellings of one directory to one key", () => {
    expect(String(canonicalPathKey("/var/folders/sy/nt4h2c8t/kilo/home/.cache"))).toBe(
      String(canonicalPathKey("/private/var/folders/sy/nt4h2c8t/kilo/home/.cache")),
    )
  })

  test("leaves non-symlink paths unchanged", () => {
    expect(String(canonicalPathKey("/Users/dev/repos/app"))).toBe("/Users/dev/repos/app")
    // /private/opt is not one of the three macOS system links, so it must NOT be folded.
    expect(String(canonicalPathKey("/private/opt/custom"))).toBe("/private/opt/custom")
    // A directory literally named /private stays itself.
    expect(String(canonicalPathKey("/private"))).toBe("/private")
  })

  test("handles the symlink roots themselves", () => {
    expect(String(canonicalPathKey("/private/var"))).toBe("/var")
    expect(String(canonicalPathKey("/private/etc"))).toBe("/etc")
    expect(String(canonicalPathKey("/private/tmp"))).toBe("/tmp")
  })

  test("keeps pathKey normalisation for separators and trailing slashes", () => {
    expect(String(canonicalPathKey("/private/var/demo///"))).toBe("/var/demo")
    expect(String(canonicalPathKey("C:\\Users\\dev\\app\\"))).toBe("C:/Users/dev/app")
    expect(String(canonicalPathKey("/"))).toBe("/")
  })

  test("is idempotent", () => {
    const once = canonicalPathKey("/private/var/folders/sy/x")
    expect(String(canonicalPathKey(once))).toBe(String(once))
  })

  test("pathKey alone still distinguishes the two spellings (why the canonical key exists)", () => {
    // Guards the contract this row deliberately kept: pathKey mints persisted storage names
    // (utils/persist.ts:367,384-385) and cache keys, so its output must not change here.
    expect(String(pathKey("/var/folders/sy/x"))).not.toBe(String(pathKey("/private/var/folders/sy/x")))
  })
})
