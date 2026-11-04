// Swarm 1.1.1 F10b (decision P19): the shell tool's own reader (`tool/shell.ts` `decompose`, tree-sitter bash), read
// synchronously, so the permission table (pure and sync) can read a project script's text the way the shell reads a
// command. Setting tree-sitter up is asynchronous, and `Parser.init` replaces the library's one global module, so a
// second init here would break the shell's parser. This never calls it: it asks the shell's own reader once, which sets
// tree-sitter up there, then loads its own copy of the bash grammar into a parser of its own. Until that is done, and
// whenever it fails, `read` answers undefined, which keeps the call at its 1.1.0 verdict.
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import type { Node, Parser } from "web-tree-sitter"
import type { ShellReading } from "../tool/shell"

export type Ready = { bash: Parser; decompose: (root: Node, cwd: string) => ShellReading | undefined }

let ready: Ready | undefined
let pending: Promise<void> | undefined
// 1.1.1 F12a (m29): when the last start failed. Within `RETRY_AFTER_MS` of it nothing starts again and nothing is
// logged again, so a reader that cannot start costs one warning a minute, not one per request.
let failedAt: number | undefined
let generation = 0
// 1.1.1 F14 (G5-P4): when the start now running began. The gate's wait is counted from here, so a start that never
// settles costs one bounded wait in all, not one per request.
let startedAt: number | undefined
/** 1.1.1 F12a (m29): how long a failed start is remembered before the next request may try again. */
export const RETRY_AFTER_MS = 60_000
let loader: () => Promise<Ready> = start
let warn: (error: unknown) => void = (error) => {
  Effect.runFork(
    Effect.logWarning("script reader could not start; project scripts keep their 1.1.0 verdict", {
      source: "ScriptReader.prepare",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }),
  )
}

/**
 * Starts the reader once; resolves when it can read, or when it could not start (then `read` keeps answering undefined).
 * A failed start is not retried for a minute.
 */
export function prepare(): Promise<void> {
  if (ready) return Promise.resolve()
  if (pending) return pending
  if (failedAt !== undefined && Date.now() - failedAt < RETRY_AFTER_MS) return Promise.resolve()
  // A start that finishes after the state was replaced (tests) belongs to a state that is gone: it records nothing.
  const at = generation
  const run: Promise<void> = (async () => loader())()
    .then(
      (made) => {
        if (at !== generation) return
        ready = made
        failedAt = undefined
      },
      (error: unknown) => {
        if (at !== generation) return
        failedAt = Date.now()
        try {
          warn(error)
        } catch {
          // A broken log sink changes nothing here: the reader stays not ready and scripts keep 1.1.0.
        }
      },
    )
    .finally(() => {
      if (pending === run) {
        pending = undefined
        startedAt = undefined
      }
    })
  pending = run
  startedAt = Date.now()
  return run
}

/**
 * 1.1.1 F14 (G5-P4): how much of `bound` ms is left for waiting on the start now running, counted from when it began.
 * 0 when nothing is running or the bound has gone by, so later requests do not wait again for a start that hangs.
 */
export function waitLeft(bound: number): number {
  if (ready || startedAt === undefined) return 0
  return Math.max(0, bound - (Date.now() - startedAt))
}

/**
 * 1.1.1 F12a (P4, m29): start the reader now, without waiting for it: the autonomy service calls this when a person gives
 * the bypass consent, so the first consented request finds it ready. Never throws.
 */
export function warm(): void {
  void prepare().catch(() => undefined)
}

/** Whether the reader can read now. */
export function isReady() {
  return ready !== undefined
}

/**
 * Test seam (1.1.1 F12a, m33): swap the loader and the warning sink, starting from nothing; `restore` puts back what was
 * there, a ready reader included.
 */
export const testing = {
  replace(next: { loader?: () => Promise<Ready>; warn?: (error: unknown) => void }) {
    const saved = { ready, pending, failedAt, loader, warn }
    generation++
    ready = undefined
    pending = undefined
    startedAt = undefined
    failedAt = undefined
    if (next.loader) loader = next.loader
    if (next.warn) warn = next.warn
    return () => {
      generation++
      // A start still running from before belongs to an older generation and would record nothing: drop it.
      ;({ ready, failedAt, loader, warn } = saved)
      pending = undefined
      startedAt = undefined
    }
  },
  /** Moves the remembered failure into the past, as if `RETRY_AFTER_MS` had gone by. */
  expireFailure() {
    if (failedAt !== undefined) failedAt -= RETRY_AFTER_MS
  },
}

/** The shell's reading of a text run from `cwd`, or undefined: not ready yet, not understood, or not read in full. */
export function read(text: string, cwd: string): ShellReading | undefined {
  if (!ready) {
    warm()
    return undefined
  }
  const tree = (() => {
    try {
      return ready.bash.parse(text)
    } catch {
      return null
    }
  })()
  if (!tree) return undefined
  try {
    return ready.decompose(tree.rootNode, cwd)
  } catch {
    return undefined
  } finally {
    tree.delete()
  }
}

async function start(): Promise<Ready> {
  const shell = await import("../tool/shell")
  // The shell tool's reader sets tree-sitter up for the process, once.
  await shell.readSteps("true", "/")
  const { Parser, Language } = await import("web-tree-sitter")
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const language = await Language.load(resolveWasm(bashWasm))
  const bash = new Parser()
  bash.setLanguage(language)
  return { bash, decompose: shell.decompose }
}

// As `tool/shell.ts` resolves its grammar: a bundled asset, an absolute path, or one next to this file.
function resolveWasm(asset: string) {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  return fileURLToPath(new URL(asset, import.meta.url))
}

export * as ScriptReader from "./script-reader"
