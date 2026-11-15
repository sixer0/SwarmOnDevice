// 1.2.10 row 67 (AC-B1004, N10-193): the log-path scrubber (`src/util/log-path.ts`) stops leaking an account or folder
// name in more input forms (01g AT-B1004 as amended by C27/C30, S10-34 and S10-35):
// (1) `%2F`/`%5C` are decoded before the path rules (`withoutPaths` only);
// (2) a `file:` URL becomes `file:<path>` (the `file:` scheme only; `https://...` and other schemes stay as they are);
// (3) in a path glued to the previous character, the home folder and everything after it becomes `~`, `~/`,
//     `~/<path>` or `~` + a dot tail (also inside `vscode://file/...` and a decoded `obsidian://...?path=`);
// (4) a `.` followed by `)` `,` `;` or `]` ends the home folder (also in `replaceHome`, raw and Markdown-escaped);
// (5) the home folder is matched case-folded on darwin and win32 (`replaceHome(..., platform)`, N10-105).
//
// T-1 rows are red at BASE (a3e3c4c93a), T-2 rows are controls (C11 is INTENT: decoding is visible), T-3 calls
// `replaceHome` with an explicit platform, T-4 pins the known limit (an unquoted path with a space).
// Synthetic home `/Users/alice` only (syn129), set through OPENCODE_TEST_HOME with os.homedir stubbed to the same value,
// so the real home folder is never read.

import { afterEach, describe, expect, spyOn, test } from "bun:test"
import os from "node:os"

const HOME = "/Users/alice"
const FOLDS = process.platform === "darwin" || process.platform === "win32"

let restore: (() => void) | undefined
afterEach(() => {
  restore?.()
  restore = undefined
})
const home = (value: string) => {
  restore?.()
  const before = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = value
  const spy = spyOn(os, "homedir").mockReturnValue(value)
  restore = () => {
    spy.mockRestore()
    if (before === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = before
  }
}
const mod = () => import("../../src/util/log-path")
const vault = () => import("../../src/memory/vault-mirror")

// No account or folder name of the synthetic inputs may survive (case-insensitive).
const LEAK = /alice|clients|acme/i

// [#, form, input, expected at HEAD, folds?] — `withoutPaths` rows of table T-1.
const T1_WP: [string, string, string, string, boolean?][] = [
  ["B1", "`.` + `)`, glued", "x(-C/Users/alice.)", "x(-C~.)"],
  ["B2", "`.` + `,`, glued", "-C/Users/alice., y", "-C~., y"],
  ["B3", "`.` + `]`, glued", "x[-C/Users/alice.]", "x[-C~.]"],
  ["B4", "`.` + `;`, glued", "-C/Users/alice.; y", "-C~.; y"],
  ["B7", "%2F upper case", "open %2FUsers%2Falice%2FClients%2FAcme failed", "open <path> failed"],
  ["B8", "%2f lower case", "%2fUsers%2falice%2fClients", "<path>"],
  ["B9", "%5C", "open C:%5CUsers%5Calice%5CClients failed", "open <path> failed"],
  ["B10", "case-shifted home, glued", "x/USERS/ALICE/Clients/Acme", "x~/<path>", true],
  ["B11", "case-shifted home, glued", "-C/users/alice/Clients/Acme", "-C~/<path>", true],
  ["B12", "file://", "file:///Users/alice/Clients/Acme/x", "file:<path>"],
  ["B13", "file:// with host", "file://localhost/Users/alice/Clients/Acme", "file:<path>"],
  ["B14", "glued path under home (S9-07b form)", "git -C/Users/alice/Clients/Acme", "git -C~/<path>"],
  ["B15", "glued path under home (S9-07a form)", "a -/Users/alice/Clients", "a -~/<path>"],
  // S10-34 (C27): the `file:` scheme only, case-insensitive, also with one slash, a drive letter and in single quotes.
  ["F1", "FILE: upper case", "FILE:///Users/alice/Clients", "FILE:<path>"],
  ["F2", "file: one slash", "file:/Users/alice/Clients", "file:<path>"],
  ["F3", "file: drive letter", "file:///C:/Users/alice/x", "file:<path>"],
  ["F4", "file: in single quotes", "'file:///Users/alice/x'", "'file:<path>'"],
  // S10-35: the widened glued rule reaches home inside an app address.
  ["G1", "vscode://file glued home", "vscode://file/Users/alice/Clients/Acme/x.ts", "vscode://file~/<path>"],
  ["G2", "obsidian:// encoded path", "obsidian://open?path=%2FUsers%2Falice%2FClients", "obsidian://open?path=~/<path>"],
]

// [#, input, expected] — `replaceHome` rows of table T-1 (vault mirror), raw and Markdown-escaped.
const T1_RH: [string, string, string][] = [
  ["B5", "in /Users/alice.)", "in ~.)"],
  ["B6", "in /Users/alice.]", "in ~.]"],
]

describe("AC-B1004 T-1: the scrubber removes account and folder names (red at BASE)", () => {
  for (const [id, form, input, expected, folds] of T1_WP) {
    test.if(!folds || FOLDS)(`${id} ${form}: ${JSON.stringify(input)}`, async () => {
      home(HOME)
      const out = (await mod()).withoutPaths(input)
      expect(out).toBe(expected)
      expect(out).not.toMatch(LEAK)
    })
  }

  for (const [id, input, expected] of T1_RH) {
    test(`${id} vault mirror, raw and escaped: ${JSON.stringify(input)}`, async () => {
      const { replaceHome } = await mod()
      const { escapeText } = await vault()
      expect(replaceHome(input, HOME, "~")).toBe(expected)
      expect(replaceHome(escapeText(input), escapeText(HOME), escapeText("~"), true)).toBe(escapeText(expected))
      expect(replaceHome(input, HOME, "~")).not.toMatch(LEAK)
    })
  }
})

// [#, input, expected, why]
const T2: [string, string, string, string][] = [
  ["C1", "failed (in /Users/alice.) now", "failed (in <path>) now", "not glued: R3 takes it first"],
  ["C2", "in /USERS/ALICE/Clients/Acme", "in <path>", "not glued"],
  ["C3", "a -/Users/bob/x", "a -/Users/bob/x", "glued, not under home (C8)"],
  ["C4", "a -/Users/alice.old/z", "a -/Users/alice.old/z", "sibling"],
  ["C5", "a -/Users/alicexyz/z", "a -/Users/alicexyz/z", "sibling"],
  ["C6", "a -/Users/alice.y", "a -/Users/alice.y", "dot followed by a letter"],
  ["C7", "a -/Users/alice", "a -~", "home alone"],
  ["C8", "a -/Users/alice. next", "a -~. next", "sentence dot (67i)"],
  ["C9", "C:\\Users\\alice\\y failed", "<path> failed", "drive letter at offset 0 still a path"],
  ["C10", "keep ./rel/x and ~/x and a/b", "keep ./rel/x and ~/x and a/b", "relative forms"],
  // INTENT (red at BASE by design): decoding is visible in the text; `/b` is glued and not under home, so it stays.
  ["C11", "q=a%2Fb", "q=a/b", "INTENT: %2F is decoded"],
  // C27 / S10-34: control row, unchanged at BASE and HEAD (web addresses keep their debug value).
  ["C12", "fetch https://example.com/a failed", "fetch https://example.com/a failed", "control: no scheme but file: is touched"],
  ["C13", "see vscode://example/a and https://example.com/a", "see vscode://example/a and https://example.com/a", "control: other schemes without home"],
]

describe("AC-B1004 T-2: controls", () => {
  for (const [id, input, expected, why] of T2) {
    test(`${id} (${why}): ${JSON.stringify(input)}`, async () => {
      home(HOME)
      expect((await mod()).withoutPaths(input)).toBe(expected)
    })
  }
})

describe("AC-B1004 T-3: replaceHome folds case only on darwin and win32 (N10-105)", () => {
  const replaceHome = async (...args: unknown[]) =>
    ((await mod()).replaceHome as (...a: unknown[]) => string)(...args)

  test("L1 linux: another user's /USERS/ALICE is a different folder", async () => {
    expect(await replaceHome("x/USERS/ALICE/y", HOME, "~", false, "linux")).toBe("x/USERS/ALICE/y")
  })
  test("L2 darwin: the case-shifted home is the home folder", async () => {
    expect(await replaceHome("x/USERS/ALICE/y", HOME, "~", false, "darwin")).toBe("x~/y")
  })
  test("L3 win32: the case-shifted home is the home folder", async () => {
    expect(await replaceHome("C:\\USERS\\ALICE\\y", "C:\\Users\\alice", "~", false, "win32")).toBe("~\\y")
  })
  test("L4 darwin: fold and dot boundary together", async () => {
    expect(await replaceHome("in /USERS/ALICE.)", HOME, "~", false, "darwin")).toBe("in ~.)")
  })
})

describe("AC-B1004 T-4: known limit RN-15 (RN-22), an unquoted path with a space", () => {
  test("known limit RN-15: the folder fragment after the space stays, the account name does not", async () => {
    home(HOME)
    const out = (await mod()).withoutPaths("in /Users/alice/Clients Acme/plan.md")
    expect(out).toBe("in <path> Acme/plan.md")
    expect(out).not.toMatch(/alice/i)
  })
})
