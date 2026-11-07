/**
 * Persistent sink for the store's structured log (row 30 D8, C55: "the host persists the store
 * structured logs"). JSON lines, one entry per line, fields `timestamp, level, source, message,
 * stack_trace, context, correlationId` (no content, no PII: the store logs ids and codes only).
 * Size rotation: `<file>` -> `<file>.1` -> ... -> `<file>.<keep>`.
 * A failing sink never throws into the store; it reports once on stderr.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"
import { SqliteStudioStore, setStudioStore, type StoreLogEntry, type StoreLogger, type StoreOpenOptions } from "../store/index.ts"

export interface FileLoggerOptions {
  /** rotate when the file reaches this size (default 5 MiB) */
  maxBytes?: number
  /** rotated files kept (default 3) */
  keep?: number
  /** also forward each entry (tests, the host's own logger) */
  forward?: StoreLogger
}

export function createStoreFileLogger(file: string, opts: FileLoggerOptions = {}): StoreLogger {
  if (!isAbsolute(file)) throw new TypeError("store log file must be an absolute path")
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024
  const keep = Math.max(1, opts.keep ?? 3)
  let reported = false
  return (e: StoreLogEntry) => {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      if (existsSync(file) && statSync(file).size >= maxBytes) {
        for (let i = keep - 1; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`)
        renameSync(file, `${file}.1`)
      }
      const line = {
        timestamp: new Date(e.timestamp).toISOString(),
        level: e.level,
        source: e.source,
        message: e.message,
        ...(e.stack ? { stack_trace: e.stack } : {}),
        ...(e.context ? { context: e.context } : {}),
        ...(e.correlationId ? { correlationId: e.correlationId } : {}),
      }
      appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 })
    } catch (err) {
      if (!reported) {
        reported = true
        process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "error", source: "datum-studio.store-log", message: "store log sink failed", stack_trace: err instanceof Error ? err.stack : String(err) })}\n`)
      }
    }
    opts.forward?.(e)
  }
}

export interface HostStoreOptions extends Omit<StoreOpenOptions, "log"> {
  /** absolute JSONL file for the store's structured log */
  logFile: string
  logOptions?: FileLoggerOptions
}

/**
 * Open the store at `root` with a persistent log and install it for the vendored services
 * (`getStudioStore()`). The host (row 111) calls this once; `closeHostStore` on quit.
 */
export async function openHostStore(root: string, opts: HostStoreOptions): Promise<SqliteStudioStore> {
  const { logFile, logOptions, ...open } = opts
  const store = new SqliteStudioStore()
  await store.open(root, { ...open, log: createStoreFileLogger(logFile, logOptions) })
  setStudioStore(store)
  return store
}

export async function closeHostStore(store: SqliteStudioStore): Promise<void> {
  setStudioStore(null)
  await store.close()
}
