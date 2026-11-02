// Proxy stager (U14 row 221). The swarm-web MCP entry needs the Swarm-built proxy binary at PC-PATH-14
// (~/.swarm/setup/bin/swarm-web-proxy); config_writer.ts eligibility() only checks that it exists there.
// Nothing copied it, so every install skipped swarm-web with "proxy binary not staged at PC-PATH-14".
//
// The app bundle ships the proxy (PC-PKG-06) beside the swarm-setup binary and its tools.lock.json, so the
// source is the program directory (paths.ts resolveProgramDir, the same anchor the lock is read from). The
// proxy is a local copy, not a download, so it is NOT a lock component (tools.lock.json PC-PATH-14 note,
// D-06): the hash check here is source against copy, not against a pin.
//
// Mechanics, all inside the P-16 whitelist (~/.swarm/setup):
//   - source absent             -> nothing written, `{ ok: true, staged: false, reason }`; the writer then keeps
//                                  its own skip reason unchanged;
//   - target already byte-equal  -> no-op (same sha256 and mode 0755);
//   - otherwise                 -> exclusive temp in bin/, write, fchmod 0755, fsync, re-hash the temp from
//                                  disk, rename only when that hash equals the source hash;
//   - target is a symlink or not a regular file -> refused, nothing followed or replaced.
// The health rule stays in the writer: this module never reads state.json and never decides eligibility.

import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { MODES, PATHS } from "../constants.ts"
import { ensureDir, homeDir, resolveProgramDir } from "../paths.ts"
import { writeSetupLog } from "../setuplog.ts"
import { PROXY_BINARY_NAME, PROXY_BINARY_PATH } from "../mcpproxy/register.ts"

/** Mode of the staged proxy: it is executed by the swarm MCP launcher. */
export const PROXY_MODE = 0o755
/** Upper bound on the source size. A compiled bun binary is tens of MB; anything far above is not ours. */
export const PROXY_MAX_BYTES = 256 * 1024 * 1024

const SOURCE = "swarm-setup.wiring.proxy_stage"

export interface ProxyStageOptions {
  /** HOME base for PC-PATH-14 and setup.log; defaults to paths.homeDir(). */
  readonly base?: string
  /** Directory holding the shipped proxy; defaults to paths.resolveProgramDir(). */
  readonly programDir?: string
}

export type ProxyStageResult =
  | { readonly ok: true; readonly staged: true; readonly changed: boolean; readonly target: string; readonly sha256: string }
  | { readonly ok: true; readonly staged: false; readonly reason: string }
  | { readonly ok: false; readonly reason: string }

function underHome(tildePath: string, base: string): string {
  if (tildePath.startsWith("~/")) return join(base, tildePath.slice(2))
  return tildePath
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function log(base: string, level: "info" | "error", message: string, context: Record<string, unknown>): void {
  try {
    writeSetupLog({ level, source: SOURCE, message, context }, { path: underHome(PATHS.SETUP_LOG, base) })
  } catch {
    // setup.log is an audit aid, not a commit point (setuplog.ts); a log failure never changes the outcome.
  }
}

/** Copy the shipped swarm-web-proxy into PC-PATH-14 with a hash check. Call before writeConfigEntries. */
export function stageProxyBinary(opts: ProxyStageOptions = {}): ProxyStageResult {
  const base = opts.base ?? homeDir()
  const source = join(opts.programDir ?? resolveProgramDir(), PROXY_BINARY_NAME)
  const target = underHome(PROXY_BINARY_PATH, base)

  let sourceSize: number
  try {
    const st = statSync(source)
    if (!st.isFile()) return { ok: true, staged: false, reason: `no ${PROXY_BINARY_NAME} file beside the program` }
    sourceSize = st.size
  } catch {
    return { ok: true, staged: false, reason: `no ${PROXY_BINARY_NAME} beside the program` }
  }
  if (sourceSize === 0 || sourceSize > PROXY_MAX_BYTES) {
    const reason = `${PROXY_BINARY_NAME} beside the program has an implausible size (${sourceSize} bytes)`
    log(base, "error", reason, { sourceSize })
    return { ok: false, reason }
  }

  try {
    const bytes = readFileSync(source)
    const want = sha256(bytes)

    const existing = lstatOrNull(target)
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isFile()) {
        const reason = `refusing to replace PC-PATH-14: it is ${existing.isSymbolicLink() ? "a symlink" : "not a regular file"}`
        log(base, "error", reason, {})
        return { ok: false, reason }
      }
      if ((existing.mode & 0o777) === PROXY_MODE && sha256(readFileSync(target)) === want) {
        return { ok: true, staged: true, changed: false, target, sha256: want }
      }
    }

    ensureDir(dirname(target), MODES.DIR_0700)
    const tmp = join(dirname(target), `.tmp-${randomUUID()}`)
    const fd = openSync(tmp, "wx", 0o600)
    let committed = false
    try {
      try {
        let offset = 0
        while (offset < bytes.length) {
          const n = writeSync(fd, bytes.subarray(offset))
          if (n <= 0) throw new Error(`short write to ${tmp}`)
          offset += n
        }
        fchmodSync(fd, PROXY_MODE)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      const got = sha256(readFileSync(tmp))
      if (got !== want) {
        const reason = `copied ${PROXY_BINARY_NAME} does not match its source (sha256 ${got.slice(0, 12)} != ${want.slice(0, 12)})`
        log(base, "error", reason, {})
        return { ok: false, reason }
      }
      renameSync(tmp, target)
      committed = true
    } finally {
      if (!committed) rmSync(tmp, { force: true })
    }
    log(base, "info", `staged ${PROXY_BINARY_NAME} at PC-PATH-14`, { sha256: want, bytes: sourceSize })
    return { ok: true, staged: true, changed: true, target, sha256: want }
  } catch (err) {
    const reason = `could not stage ${PROXY_BINARY_NAME}: ${(err as Error).message}`
    log(base, "error", reason, { stack: (err as Error).stack })
    return { ok: false, reason }
  }
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}
