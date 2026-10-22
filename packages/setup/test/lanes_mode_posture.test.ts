// Row 250 unit lane (blueprint 11) — clause B of the lane guarantee set: a SUCCESSFUL write leaves
// the file's mode and its directory's mode intact, and clause A's metadata leg: a REFUSAL may not
// even chmod. Run from packages/setup (repo rule: tests never run from the root guard):
//   bun test test/lanes_mode_posture.test.ts
// Collected by the package's declared command `bun test` — packages/setup/package.json declares no
// `test` script, so `bun test` from this directory IS the command the repo runs (rule E14; the
// collection delta is quoted in test/s6b_d5_units.md).
//
// WHAT THIS FILE DOES NOT REPEAT. Row 245 (test/lanes.test.ts) proved the setup writer's happy
// posture from a 0700 dir and one 0755 repair; row 247 (packages/opencode/test/server/
// httpapi-global-lanes.test.ts) proved the route writer's posture from a 0700 dir and one 0755
// repair; row 246 (test/estate_apply.test.ts) proved install-time creation. Every one of those
// fixtures starts at 0600 for the file and at either 0700 or 0755 for the directory. The gaps this
// lane closes are exactly the states none of them can reach:
//   B3  a lanes.json found WIDER than 0600 — does a successful commit tighten it, and does
//       create-if-absent leave it alone? (measured: no existing lane fixture sets any mode but 0600;
//       grep for 0o644|0o666|0o604 across the three lane files returns zero matches)
//       AMENDED by row 267: the route write still tightens, and create-if-absent NOW DOES TOO
//       (F-251-1, verification/s6b_13_lanes_security.md §2.1 — the file got the same treatment the directory
//       already had). The bytes stay the user's; only the grants come off.
//   B4  a directory drifted to something other than 0755 — 0777, 0750, 0711, 0500 — does the repair
//       CONVERGE to 0700 and grant nothing to group/other on the way?
//   B5  the repair's SCOPE — does it stop at the setup dir, leaving ~/.swarm and sibling entries
//       exactly as found? "does not widen anything" is meaningless if the repair wanders upward.
//   A4  a REFUSAL against a drifted directory — chmod is itself a write to an inode, so §4.2's
//       "writes nothing" must bind metadata too. Every existing refusal fixture sits at 0700.
//
// WHY THE ROUTE WRITER IS IMPORTED FROM HERE. The guarantee is about the same file written by two
// doors, and the two doors must be compared in one run; row 247 could only see its own door and its
// package's test directory is not this row's ownership area. The import is read-only toward
// packages/opencode/** — this file calls the same pure functions its own lane calls, with an
// explicit sandbox home everywhere (rule E7: nothing here resolves a user path through HOME).
// Scratch lives under $TMPDIR/kilo only; no port, no process, no network, no docker (E10).

import { describe, expect, test, afterAll } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { createLanesFileAtSetup, lanesPath, SETUP_LANE_VALUES } from "../src/composefiles/lanes.ts"
import { MODES } from "../src/constants.ts"
import { applyLanesPatch } from "../../opencode/src/server/shared/lanes-observation.ts"

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Scratch root for this lane. Every home handed to a writer is checked against it before use, so
 *  an accidentally-empty sandbox (the E7 class: a HOME that silently resolves to the real one)
 *  fails here instead of writing into ~/.swarm. One per-run parent directory, removed in afterAll,
 *  so a green run leaves nothing behind under $TMPDIR/kilo. */
const KILO_ROOT = join(process.env.TMPDIR ?? "/tmp", "kilo")
const RUN_ROOT = join(KILO_ROOT, `r250-mp-${process.pid}-${Math.floor(Math.random() * 1e6)}`)

let homeCounter = 0

function freshHome(tag: string): string {
  // A fresh directory per call, not per tag: three tests ask for "filemode" and none of them may
  // inherit another's modes or sibling entries.
  const home = join(RUN_ROOT, `${tag}-${(homeCounter += 1)}`)
  mkdirSync(join(home, ".swarm", "setup"), { recursive: true })
  // mkdirSync's mode option is masked by the process umask, so the register posture is set
  // explicitly afterwards — the lesson row 245 recorded and row 247 repeated.
  chmodSync(join(home, ".swarm"), 0o700)
  chmodSync(join(home, ".swarm", "setup"), 0o700)
  return assertSandbox(home)
}

function assertSandbox(home: string): string {
  if (!home.startsWith(`${RUN_ROOT}/`)) throw new Error(`refusing to hand a non-scratch home to a writer: ${home}`)
  return home
}

afterAll(() => {
  rmSync(RUN_ROOT, { recursive: true, force: true })
})

function setupDir(home: string): string {
  return join(home, ".swarm", "setup")
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

const VALID_TUPLE = { version: 1, lanes: { ...SETUP_LANE_VALUES } }

/** Seed a home whose lanes.json exists at a CHOSEN file mode — the state no existing lane fixture
 *  builds, because every one of them writes the file and lets the writer's own mode stand. */
function homeWithFileMode(fileMode: number, doc: unknown = VALID_TUPLE): string {
  const home = freshHome("filemode")
  const file = lanesPath(home)
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n")
  chmodSync(file, fileMode)
  return home
}

/** Full posture of the directory: listing, both modes, and the committed bytes. */
function posture(home: string) {
  const file = lanesPath(home)
  return {
    listing: readdirSync(setupDir(home)).sort().join(","),
    fileSha: existsSync(file) ? sha(file) : "ABSENT",
    fileMode: existsSync(file) ? modeOf(file) : -1,
    dirMode: modeOf(setupDir(home)),
  }
}

// ---------------------------------------------------------------------------
// B3 — a file found wider than 0600
// ---------------------------------------------------------------------------

describe("r250 B3 — a lanes.json found wider than 0600, across the two writers", () => {
  test("a successful route write TIGHTENS a 0644 file to 0600 and leaves the directory at 0700", () => {
    const home = homeWithFileMode(0o644)
    expect(modeOf(lanesPath(home))).toBe(0o644) // the drift is really present before the call
    const result = applyLanesPatch({ NUQ_WORKER_COUNT: 4 }, home)
    expect(result.ok).toBe(true)
    // Create-time mode carried through the rename (06 §2.2): the committed inode is 0600 whatever
    // the replaced inode said, so a hand-widened private file cannot survive an app write wide.
    expect(modeOf(lanesPath(home))).toBe(0o600)
    expect(modeOf(setupDir(home))).toBe(0o700)
    expect(result.ok && result.state.file.dirModeRepaired).toBe(false) // tightening the FILE is not a dir repair
    // and the tightened file still parses through the shared validator, i.e. the render will take it
    expect(JSON.parse(readFileSync(lanesPath(home), "utf8")).lanes.NUQ_WORKER_COUNT).toBe(4)
  })

  test("create-if-absent keeps a pre-existing file's BYTES and tightens its wide MODE (F-251-1)", () => {
    // Row 250 pinned the opposite posture ("swarm-setup is not that day's writer") as a judgement inside the spec's
    // silence; row 251 §2.1 measured it as an ASYMMETRY — the same function repaired a drifted directory two lines
    // earlier (lanes.ts:289-291) while only reporting a drifted file — and the controller accepted the finding as
    // F-251-1, dispatched to row 267. The register posture is 0600 always (06 §2.2), and the bytes remain the user's:
    // this pins both halves of that distinction at once.
    const home = homeWithFileMode(0o644)
    const before = posture(home)
    const report = createLanesFileAtSetup(home)
    expect(report.created).toBe(false) // never re-created, never overwritten
    expect(report.fileModeBefore).toBe(0o644) // reported as found …
    expect(report.fileModeRepaired).toBe(true) // … and as moved
    expect(report.fileMode).toBe(0o600) // reported as the register wants it, after the repair
    expect(posture(home).fileSha).toBe(before.fileSha) // the payload survives byte-for-byte
    expect(posture(home).fileMode).toBe(0o600)
    expect(posture(home).dirMode).toBe(0o700)
    expect(posture(home).listing).toBe(before.listing) // no temp sibling, no new entry
  })

  test("a tighter-than-register file (0400) is left alone: the repair strips grants, it never adds one", () => {
    // Why the predicate is `mode & 0o077` and not `mode !== 0600`: a 0400 lane file leaks nothing to anyone, and
    // widening it would make "repair" the operation that GRANTS permission. The directory converges from both sides
    // because a 0500 setup dir blocks the owner's own commit path; a read-only file does not block anything, since
    // the route replaces it by rename(2), which needs directory permission, not file permission.
    const home = homeWithFileMode(0o400)
    const before = posture(home)
    const report = createLanesFileAtSetup(home)
    expect(report.fileModeBefore).toBe(0o400)
    expect(report.fileModeRepaired).toBe(false)
    expect(report.fileMode).toBe(0o400)
    expect(posture(home)).toEqual(before)
  })

  test("a wider file whose directory is ALSO adrift gets BOTH repairs, each reported on its own", () => {
    // The two repairs stay independent duties (row 250's phrase) — what changed under F-251-1 is that the file half
    // is now performed as well as reported, so the pair converges instead of converging halfway.
    const home = homeWithFileMode(0o644)
    chmodSync(setupDir(home), 0o755)
    const report = createLanesFileAtSetup(home)
    expect(report.dirModeBefore).toBe(0o755)
    expect(report.dirModeRepaired).toBe(true)
    expect(report.dirModeAfter).toBe(0o700)
    expect(report.created).toBe(false)
    expect(report.fileModeRepaired).toBe(true)
    expect(modeOf(lanesPath(home))).toBe(0o600)
  })
})

// ---------------------------------------------------------------------------
// B4 — repair convergence from every drift, never widening
// ---------------------------------------------------------------------------

const DRIFTS = [0o777, 0o755, 0o750, 0o711, 0o500, 0o700] as const

describe("r250 B4 — the directory repair converges from every drift and grants nothing to group/other", () => {
  for (const drift of DRIFTS) {
    test(`setup writer: dir found at ${drift.toString(8)} ends at exactly 0700, reported iff it moved`, () => {
      const home = freshHome("drift-setup")
      chmodSync(setupDir(home), drift)
      const report = createLanesFileAtSetup(home)
      expect(report.dirModeBefore).toBe(drift)
      expect(report.dirModeRepaired).toBe(drift !== MODES.DIR_0700)
      expect(report.dirModeAfter).toBe(MODES.DIR_0700)
      expect(modeOf(setupDir(home))).toBe(MODES.DIR_0700)
      expect(report.fileMode).toBe(0o600)
      // "does not widen anything", stated bit by bit: no group or other bit is ever granted, and
      // every bit the repair ADDED is an owner bit. 0500 -> 0700 adds owner-write only; 0777 ->
      // 0700 subtracts six bits and adds none.
      const granted = report.dirModeAfter & ~drift
      expect(granted & 0o077).toBe(0)
      expect(granted & 0o700).toBe(granted)
    })
  }

  for (const drift of DRIFTS) {
    test(`route writer: dir found at ${drift.toString(8)} ends at exactly 0700 through a successful PATCH`, () => {
      const home = freshHome("drift-route")
      chmodSync(setupDir(home), drift)
      const result = applyLanesPatch({ NUQ_WORKER_COUNT: 4 }, home)
      expect(result.ok).toBe(true)
      expect(modeOf(setupDir(home))).toBe(MODES.DIR_0700)
      expect(result.ok && result.state.file.dirModeRepaired).toBe(drift !== MODES.DIR_0700)
      expect(modeOf(lanesPath(home))).toBe(0o600)
      const granted = MODES.DIR_0700 & ~drift
      expect(granted & 0o077).toBe(0)
      expect(granted & 0o700).toBe(granted)
    })
  }
})

// ---------------------------------------------------------------------------
// B5 — the repair's scope stops at the setup directory
// ---------------------------------------------------------------------------

describe("r250 B5 — the repair is scoped to PC-PATH-01 and touches nothing else", () => {
  test("neither writer changes ~/.swarm's own mode, nor a sibling file's bytes or mode", () => {
    const home = freshHome("scope")
    const swarmDir = join(home, ".swarm")
    chmodSync(swarmDir, 0o755) // an adrift ANCESTOR: P-4 bars chmod outside ~/.swarm, and the
    // writers' own comments (lanes.ts:268-271) claim the repair stays inside PC-PATH-01 — proven here.
    const siblingPrivate = join(setupDir(home), "state.json")
    const siblingPublic = join(setupDir(home), "notes.txt")
    writeFileSync(siblingPrivate, '{"version":1}\n')
    chmodSync(siblingPrivate, 0o600)
    writeFileSync(siblingPublic, "not a lane file\n")
    chmodSync(siblingPublic, 0o644)

    const namesBefore = readdirSync(setupDir(home)).sort()

    createLanesFileAtSetup(home)
    expect(modeOf(swarmDir)).toBe(0o755) // ancestor untouched even though it is adrift
    expect(modeOf(siblingPrivate)).toBe(0o600)
    expect(modeOf(siblingPublic)).toBe(0o644)
    expect(readdirSync(setupDir(home)).sort()).toEqual([...namesBefore, "lanes.json"].sort())

    applyLanesPatch({ MAX_CONCURRENT_PAGES: 4 }, home)
    expect(modeOf(swarmDir)).toBe(0o755)
    expect(modeOf(siblingPrivate)).toBe(0o600)
    expect(readFileSync(siblingPrivate, "utf8")).toBe('{"version":1}\n')
    expect(modeOf(siblingPublic)).toBe(0o644)
    expect(readFileSync(siblingPublic, "utf8")).toBe("not a lane file\n")
    // Only lanes.json was ever added, and no temp sibling survived either write.
    const listing = readdirSync(setupDir(home)).sort()
    expect(listing).toEqual(["lanes.json", "notes.txt", "state.json"])
    expect(listing.filter((name) => name.startsWith(".tmp-"))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// A4 — a refusal may not even chmod
// ---------------------------------------------------------------------------

describe("r250 A4 — a refusal writes nothing, metadata included", () => {
  test("a refused PATCH against a directory drifted to 0755 leaves the drift in place", () => {
    // The repair lives AFTER validation (lanes-observation.ts:249-260), which is what makes §4.2's
    // "no open, no temp file, no ensureParent until every key and value has passed" true of the
    // directory inode as well as the file. A refusal that repaired the mode would be a write with
    // an error message on it — the E12 class: prove the refusal binds nothing, not merely answers.
    const home = freshHome("refuse-chmod")
    chmodSync(setupDir(home), 0o755)
    writeFileSync(lanesPath(home), JSON.stringify(VALID_TUPLE, null, 2) + "\n")
    chmodSync(lanesPath(home), 0o600)
    const before = posture(home)

    const result = applyLanesPatch({ NUQ_WORKER_COUNT: 9 }, home)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.error.code).toBe("LANE_VALUE_OUT_OF_RANGE")
    expect(posture(home)).toEqual(before)
    expect(modeOf(setupDir(home))).toBe(0o755) // NOT repaired: nothing was committed, so nothing was chmodded
  })

  test("a refused PATCH leaves a wider file's mode exactly as it found it", () => {
    const home = homeWithFileMode(0o644)
    const before = posture(home)
    const result = applyLanesPatch({ GRANIAN_BLOCKING_THREADS: 5 }, home)
    expect(result.ok).toBe(false)
    expect(posture(home)).toEqual(before)
    expect(modeOf(lanesPath(home))).toBe(0o644) // tightening happens on commit, never on refusal
  })
})
