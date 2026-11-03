// Row 86 — preflight: the detect-and-guide gates that run BEFORE anything is installed.
//
// Three refusals + one stop-with-instructions, each fail-closed and each naming its
// evidence in the message:
//
//  1. macOS floor: macOS 13, colima's vz floor (02d §5.4). Row 266 lowered it back from the
//     oldest reviewed bottle codename: since row 264 the lock versions are minimums and
//     Homebrew verifies its own bottles, so a macOS or CPU without a reviewed bottle hash
//     in tools.lock.json is accepted with a note instead of refused. The reviewed set is
//     still computed mechanically from the lock bottle maps (intersection across colima/
//     lima/docker_cli/docker_compose/qemu) and still checked where it applies.
//  2. Virtualization.framework presence — D-12 is closed by this row declaring vz the
//     ONLY supported vm-type (colima's own default on modern macOS, 02d §5.2), so the
//     framework is a hard prerequisite and QEMU is never installed.
//  3. Rosetta-shaped Homebrew on Apple Silicon (/usr/local brew without /opt/homebrew) —
//     Colima's FAQ warns it breaks startup (02d §5.4); refuse rather than start a VM
//     that cannot come up. On an Intel Mac /usr/local is the native prefix and is used.
//  4. Homebrew absent entirely -> SKIPPED_WITH_INSTRUCTIONS (P-3: stop with
//     instructions; the setup never installs Homebrew itself, never pipes curl to bash).
//
// Measurements (no refusal) recorded for downstream rows: the >=16 GiB Firecrawl memory
// floor ([H-MEM], 01e §7.1 — below floor Firecrawl is skipped per decision 12, SearXNG
// alone may still install) and the >=8-core CPU guidance (size down with a printed
// message rather than refuse, 01e §7.1 row-86 cell).

import { existsSync } from "node:fs"
import type { LockFile } from "../../lockfile.ts"
import { OUTCOME, type OutcomeToken } from "../../outcomes.ts"
import { SYSTEM_TOOLS } from "./commands.ts"
import type { CommandRunner } from "./commands.ts"

/** Apple release-name -> macOS major version, for exactly the codenames a brew bottle
 *  key can name in this pin set (02d §4/§5/§6 bottle observations). An unlisted major
 *  means "no reviewed bottle" — the fail-closed branch, not a guess. */
export const CODENAME_BY_MAJOR: Readonly<Record<number, string>> = {
  13: "ventura", // vendor-floor era; NO artifact has an arm64_ventura bottle — below floor
  14: "sonoma", // only colima has a sonoma bottle; the intersection excludes it => below floor
  15: "sequoia",
  26: "tahoe",
  27: "golden_gate",
}

const BOTTLE_KEY_PREFIX = "arm64_"

/** The runtime sub-artifacts whose bottle maps jointly define what this step installs. */
const BOTTLE_BEARING_FIELDS = ["colima", "lima", "docker_cli", "docker_compose", "qemu"] as const

function bottleMapOf(component: Record<string, unknown>, field: string): Record<string, string> | null {
  const sub = component[field]
  if (!sub || typeof sub !== "object" || Array.isArray(sub)) return null
  const entry = sub as Record<string, unknown>
  const map = entry.brew_bottles ?? entry.bottle_sha256 // lock uses both spellings per artifact
  if (!map || typeof map !== "object" || Array.isArray(map)) return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v
  }
  return out
}

/** Codename keys (strip arm64_) present in EVERY bottle-bearing runtime artifact.
 *  Intersection, not union: one artifact lacking a codename's hash means that OS would
 *  fetch an unreviewed bottle for it — exactly what the brew-floor ruling forbids. */
export function reviewedCodenames(lock: LockFile): string[] {
  const maps = BOTTLE_BEARING_FIELDS.map((f) => bottleMapOf(lock.components.runtime ?? {}, f)).filter(
    (m): m is Record<string, string> => m !== null,
  )
  if (maps.length === 0) return []
  const [first, ...rest] = maps
  if (!first) return []
  return Object.keys(first)
    .filter((k) => k.startsWith(BOTTLE_KEY_PREFIX))
    .map((k) => k.slice(BOTTLE_KEY_PREFIX.length))
    .filter((name) => rest.every((m) => Object.keys(m).some((k) => k === `${BOTTLE_KEY_PREFIX}${name}`)))
}

export interface BottleFloor {
  readonly codename: string // e.g. "sequoia"
  readonly major: number // e.g. 15
  readonly lockVersion: string
}

/** Oldest reviewed codename whose major we can name. Unknown codenames rank last and
 *  never DEFINE the floor (a codename we cannot date cannot lower a gate we must date). */
export function bottleFloor(lock: LockFile): BottleFloor | null {
  const majors = reviewedCodenames(lock)
    .map((name) => ({ name, major: majorOfCodename(name) }))
    .filter((x): x is { name: string; major: number } => x.major !== null)
  if (majors.length === 0) return null
  const oldest = majors.reduce((a, b) => (b.major < a.major ? b : a))
  return { codename: oldest.name, major: oldest.major, lockVersion: lock.version }
}

function majorOfCodename(name: string): number | null {
  for (const [major, codename] of Object.entries(CODENAME_BY_MAJOR)) {
    if (codename === name) return Number(major)
  }
  return null
}

export function codenameOfMajor(major: number): string | null {
  return CODENAME_BY_MAJOR[major] ?? null
}

// --- host probe ---------------------------------------------------------------------------

export interface HostInfo {
  readonly productVersion: string // sw_vers -productVersion, e.g. "27.0.1"
  readonly darwinMajor: number | null // 27; null when unparseable (fail-closed upstream)
  readonly memsizeBytes: number // sysctl hw.memsize
  readonly ncpu: number // sysctl hw.ncpu
  readonly virtualizationFramework: boolean // /System/Library/Frameworks/Virtualization.framework
  readonly appleSilicon: boolean // sysctl hw.optional.arm64 == 1 (also true under Rosetta)
  readonly brewPrefix: string | null // the native Homebrew for this CPU when it exists, else null
  readonly rosettaBrewOnly: boolean // Apple Silicon with only the x86 /usr/local brew
}

const VIRT_FRAMEWORK = "/System/Library/Frameworks/Virtualization.framework"
const ARM64_BREW = "/opt/homebrew/bin/brew"
const X86_BREW = "/usr/local/bin/brew"

/** colima's vz vm-type needs macOS 13 Ventura (Virtualization.framework file sharing). */
export const VZ_MACOS_FLOOR = 13

/** The probe commands, exported so --dry-run prints EXACTLY what the real path executes
 *  (same argv, zero spawn). Read-only system introspection; binds nothing, writes nothing. */
export function preflightProbeArgv(): string[][] {
  return [
    [SYSTEM_TOOLS.sw_vers, "-productVersion"],
    [SYSTEM_TOOLS.sysctl, "-n", "hw.memsize"],
    [SYSTEM_TOOLS.sysctl, "-n", "hw.ncpu"],
    [SYSTEM_TOOLS.sysctl, "-n", "hw.optional.arm64"],
  ]
}

export function probeHost(runner: CommandRunner): HostInfo {
  const version = runner.run([SYSTEM_TOOLS.sw_vers, "-productVersion"]).stdout.trim()
  const memRaw = runner.run([SYSTEM_TOOLS.sysctl, "-n", "hw.memsize"]).stdout.trim()
  const cpuRaw = runner.run([SYSTEM_TOOLS.sysctl, "-n", "hw.ncpu"]).stdout.trim()
  // Intel Macs have no hw.optional.arm64 key (sysctl exits nonzero): that reads as Intel.
  const appleSilicon = runner.run([SYSTEM_TOOLS.sysctl, "-n", "hw.optional.arm64"]).stdout.trim() === "1"
  return {
    productVersion: version,
    darwinMajor: parseDarwinMajor(version),
    memsizeBytes: /^\d+$/.test(memRaw) ? Number(memRaw) : 0,
    ncpu: /^\d+$/.test(cpuRaw) ? Number(cpuRaw) : 0,
    virtualizationFramework: existsSync(VIRT_FRAMEWORK),
    appleSilicon,
    brewPrefix: nativeBrewPrefix(appleSilicon),
    rosettaBrewOnly: appleSilicon && !existsSync(ARM64_BREW) && existsSync(X86_BREW),
  }
}

/** Homebrew's own default prefix per CPU: /opt/homebrew on Apple Silicon, /usr/local on Intel. */
export function nativeBrewPrefix(appleSilicon: boolean): string | null {
  if (appleSilicon) return existsSync(ARM64_BREW) ? "/opt/homebrew" : null
  return existsSync(X86_BREW) ? "/usr/local" : null
}

/** The key Homebrew uses for this host's bottle: `arm64_<codename>` on Apple Silicon, the bare
 *  codename on Intel; "unknown" when the macOS major has no codename in the table. */
export function bottleKeyFor(host: HostInfo): string {
  const codename = codenameOfMajor(host.darwinMajor ?? -1) ?? "unknown"
  return host.appleSilicon ? `${BOTTLE_KEY_PREFIX}${codename}` : codename
}

export function parseDarwinMajor(productVersion: string): number | null {
  const m = /^(\d+)(\.\d+)*/.exec(productVersion)
  if (!m || !m[1]) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n > 0 ? n : null
}

// --- verdict --------------------------------------------------------------------------------

/** 01e §7.1: Firecrawl is offered at all only when physmem >= 16 GiB (17179869184 B).
 *  [H-MEM]: the threshold is row 75's ratified hypothesis until row 112 measures live. */
export const FIRECRAWL_MEM_FLOOR_BYTES = 17_179_869_184
/** 01e §7.1 sizing contract line (row 75): Firecrawl selected -> 8 CPU / 10 GiB. */
export const SIZING_FIRECRAWL = { cpu: 8, memoryGiB: 10 } as const
/** 01e §7.1: SearXNG-only -> 2 CPU / 2 GiB. */
export const SIZING_SEARXNG_ONLY = { cpu: 2, memoryGiB: 2 } as const
/** 01e §7.1 practical minimum cores for the Firecrawl-sized VM. */
export const FIRECRAWL_CPU_MIN = 8
// (disk is a command-surface constant — commands.ts::DISK_GIB_CONTRACT, one home.)

export interface PreflightPass {
  readonly verdict: "pass"
  readonly sizing: { readonly cpu: number; readonly memoryGiB: number }
  readonly contractSizing: { readonly cpu: number; readonly memoryGiB: number }
  readonly firecrawlOffered: boolean
  readonly memoryFloor: { readonly thresholdBytes: number; readonly actualBytes: number; readonly meetsFloor: boolean }
  readonly cpuFloor: { readonly threshold: number; readonly actual: number; readonly sizedDown: boolean }
  readonly floor: BottleFloor
  readonly host: HostInfo
  readonly notes: readonly string[]
}

export interface PreflightRefuse {
  readonly verdict: "refuse"
  readonly token: OutcomeToken // REFUSED_PLATFORM for every hard environment refusal
  readonly message: string
  readonly host?: HostInfo
}

export interface PreflightSkipInstructions {
  readonly verdict: "skip_instructions"
  readonly token: OutcomeToken // SKIPPED_WITH_INSTRUCTIONS (P-3)
  readonly message: string
  readonly instructions: readonly string[]
}

export type PreflightOutcome = PreflightPass | PreflightRefuse | PreflightSkipInstructions

/** Pure decision core — unit-testable against fixture HostInfo values (the fake-old-
 *  macOS refusal needs no machine spoofing, only a fixture, mirroring r82/r83 seam honesty). */
export function evaluatePreflight(host: HostInfo, lock: LockFile, firecrawlConsented: boolean): PreflightOutcome {
  const floor = bottleFloor(lock)
  if (!floor) {
    return refuse(
      "cannot derive the brew-bottle floor from tools.lock.json (no reviewed codename shared by all runtime artifacts) — refusing fail-closed",
      host,
    )
  }

  if (host.darwinMajor === null) {
    return refuse(
      `cannot parse macOS product version ${JSON.stringify(host.productVersion)} — refusing fail-closed (floor: macOS ${floor.major} "${floor.codename}")`,
      host,
    )
  }
  if (host.darwinMajor < VZ_MACOS_FLOOR) {
    return refuse(
      `unsupported macOS ${host.productVersion}: the runtime VM (colima vm-type vz) needs macOS ${VZ_MACOS_FLOOR} Ventura or later`,
      host,
    )
  }
  // Row 266 (universal install): with the minimum-version policy (row 264) Homebrew installs and
  // verifies its own bottle for any macOS and CPU. The lock's bottle hashes are an extra check
  // where they apply (arm64 on a reviewed macOS); elsewhere the host is accepted and the gap noted.
  const notes: string[] = []
  const codename = codenameOfMajor(host.darwinMajor)
  if (!host.appleSilicon || codename === null || !reviewedCodenames(lock).includes(codename)) {
    notes.push(
      `macOS ${host.productVersion} ${host.appleSilicon ? "Apple Silicon" : "Intel"}: ${floor.lockVersion} has no reviewed bottle hash for this host (reviewed: arm64 ${reviewedCodenames(lock).join(", ")}); Homebrew installs and verifies its own bottle`,
    )
  }

  if (!host.virtualizationFramework) {
    return refuse(
      "Virtualization.framework is absent — this build supports vm-type vz ONLY (D-12 closed: QEMU is never installed); refusing fail-closed",
      host,
    )
  }

  if (host.rosettaBrewOnly) {
    return refuse(
      "only an x86_64-prefix Homebrew was found (/usr/local without /opt/homebrew) — Colima's FAQ warns this shape breaks VM startup on Apple Silicon (02d §5.4); refusing fail-closed",
      host,
    )
  }

  if (host.brewPrefix === null) {
    return {
      verdict: "skip_instructions",
      token: OUTCOME.SKIPPED_WITH_INSTRUCTIONS,
      message: "Homebrew is absent: swarm-setup will not bootstrap it (P-3 stop-with-instructions, no pipe-to-shell)",
      instructions: [
        "Install Homebrew from https://brew.sh (official installer, run it yourself), then re-run: swarm-setup install runtime",
      ],
    }
  }

  const meetsMem = host.memsizeBytes >= FIRECRAWL_MEM_FLOOR_BYTES
  const contract = firecrawlConsented ? SIZING_FIRECRAWL : SIZING_SEARXNG_ONLY
  const firecrawlOffered = firecrawlConsented && meetsMem
  const target = firecrawlConsented && meetsMem ? SIZING_FIRECRAWL : SIZING_SEARXNG_ONLY

  if (firecrawlConsented && !meetsMem) {
    notes.push(
      `host RAM ${(host.memsizeBytes / 1024 ** 3).toFixed(1)} GiB < 16 GiB floor: Firecrawl is SKIPPED (decision 12 / [H-MEM]); SearXNG-only sizing applies — row 92 reads firecrawlOffered=false`,
    )
  }
  let cpu: number = target.cpu
  let sizedDown = false
  if (firecrawlConsented && meetsMem && host.ncpu < FIRECRAWL_CPU_MIN) {
    cpu = Math.max(SIZING_SEARXNG_ONLY.cpu, Math.min(FIRECRAWL_CPU_MIN, host.ncpu - 2))
    sizedDown = true
    notes.push(
      `host has ${host.ncpu} cores (< ${FIRECRAWL_CPU_MIN}): sizing DOWN to ${cpu} vCPU with this printed message, per 01e §7.1 ("refuses/sizes down")`,
    )
  }
  // Never hand the VM more than host-minus-4 GiB: macOS itself needs ~4-6 GiB (01e §7.1 derivation).
  const hostGiB = Math.floor(host.memsizeBytes / 1024 ** 3)
  const memCeiling = Math.max(SIZING_SEARXNG_ONLY.memoryGiB, hostGiB - 4)
  const memoryGiB = Math.min(target.memoryGiB, memCeiling)
  if (memoryGiB !== target.memoryGiB) {
    notes.push(`memory sized down ${target.memoryGiB} -> ${memoryGiB} GiB to leave macOS its headroom (01e §7.1)`)
  }

  return {
    verdict: "pass",
    sizing: { cpu, memoryGiB },
    contractSizing: contract,
    firecrawlOffered,
    memoryFloor: { thresholdBytes: FIRECRAWL_MEM_FLOOR_BYTES, actualBytes: host.memsizeBytes, meetsFloor: meetsMem },
    cpuFloor: { threshold: FIRECRAWL_CPU_MIN, actual: host.ncpu, sizedDown },
    floor,
    host,
    notes,
  }
}

function refuse(message: string, host: HostInfo): PreflightRefuse {
  return { verdict: "refuse", token: OUTCOME.REFUSED_PLATFORM, message, host }
}
