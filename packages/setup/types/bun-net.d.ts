// Additive ambient declarations for the network + streaming builtins that the
// row-82 fetch/verify library touches. This file is NEW and deliberately separate
// from types/env.d.ts (row 81's): nothing existing is redeclared or changed —
// module augmentation only ADDS members to node:crypto / node:fs, and the web
// globals declared here (Response, RequestInit, ReadableStream, AbortSignal,
// Headers) are not declared anywhere in env.d.ts, so there is no collision.
//
// Same rationale as env.d.ts: this checkout has no @types/node / @types/bun and
// `bun install` is a red line, so `tsc --noEmit` stays hermetic by declaring
// exactly the runtime surface src/*.ts uses. Row 106 builds against the full
// @types/bun catalog; these shims mirror the real builtin signatures for the
// members used and nothing more.

declare module "node:crypto" {
  export interface Hash {
    update(data: Uint8Array | string): Hash
    digest(encoding: "hex"): string
  }
  export function createHash(algorithm: "sha256" | "sha512"): Hash
}

declare module "node:fs" {
  // Row 82's additions to the row-81 declaration of the same module.
  export function mkdtempSync(prefix: string): string
  export function writeSync(fd: number, data: Uint8Array): number
  /** Overload carrying the creation mode (staging temp files are created 0600). */
  export function openSync(path: string, flags: string | number, mode: number): number
}

declare module "node:timers/promises" {
  export function setTimeout(ms: number, value?: undefined): Promise<void>
}

declare module "node:child_process" {
  export interface SpawnSyncResult {
    /** Process exit status; null when killed by a signal or never started. */
    status: number | null
    stdout: string
    stderr: string
    /** Set when the spawn itself failed (ENOENT etc.), distinct from a nonzero exit. */
    error?: unknown
    signal?: string | null
  }
  /** Synchronous spawn of an ABSOLUTE-path SYSTEM tool with an argv array (never a
   *  shell). Row 82 uses it ONLY for /usr/bin/codesign and /usr/sbin/spctl INSPECTING
   *  a downloaded file — it never executes downloaded content (P-1 boundary). */
  export function spawnSync(
    command: string,
    args?: readonly string[],
    options?: { encoding?: "utf8"; timeout?: number },
  ): SpawnSyncResult
}

// Only the base64<->hex conversions npm-integrity parsing needs.
declare var Buffer: {
  from(input: string, encoding: "base64" | "hex" | "utf8"): { toString(encoding: "hex" | "base64" | "utf8"): string }
}

// URL members row 82 adds on top of env.d.ts's class (interface + class merge):
// href for redirect chains and pathname for the sanitized destination file name.
// (The two-argument constructor is NOT merged here — class constructors do not
// merge across declarations; fetch.ts resolveRelative carries that cast.)
interface URL {
  readonly href: string
  readonly pathname: string
}

interface AbortSignalLike {
  readonly aborted: boolean
}

interface AbortSignalConstructor {
  new (): AbortSignalLike
  timeout(milliseconds: number): AbortSignalLike
}

declare var AbortSignal: AbortSignalConstructor

interface HeadersLike {
  get(name: string): string | null
}

interface ReadableStreamLike {
  readonly locked: boolean
  cancel(reason?: unknown): Promise<void>
  /** WHATWG reader protocol — the shape Bun's fetch body exposes (read(), not next()). */
  getReader(): { read(): Promise<{ done?: boolean; value?: unknown }> }
}

interface ResponseLike {
  readonly status: number
  readonly ok: boolean
  readonly headers: HeadersLike
  readonly body: ReadableStreamLike | null
  text(): Promise<string>
}

interface RequestInitLike {
  method?: string
  headers?: Record<string, string> | HeadersLike
  redirect?: "follow" | "error" | "manual"
  signal?: AbortSignalLike
  [extra: string]: unknown
}

declare function fetch(input: string, init?: RequestInitLike): Promise<ResponseLike>

// Bun's own surface (mirrors @types/bun for exactly the members row 82 uses).
interface BunServeTLSOptions {
  key: string | Blob
  cert: string | Blob
  passphrase?: string
}

interface BunServeOptions {
  port?: number
  hostname?: string
  tls?: BunServeTLSOptions
  fetch(request: RequestLike): ResponseLike | Promise<ResponseLike>
}

interface RequestLike {
  readonly url: string
  readonly method: string
}

interface BunServer {
  readonly port: number
  /** stop(true) also aborts still-pending handlers (the /hangs fixture route). */
  stop(force?: boolean): void
}

interface BunBlob {
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}

interface BunWriteStream {
  readonly write: number
}

interface BunNamespace {
  /** Bun.file(path) — a lazy blob; only .text()/.arrayBuffer() are used here. */
  file(path: string): BunBlob
  /** Bun.serve(options) — used ONLY by test fixtures, never by src/*.ts. */
  serve(options: BunServeOptions): BunServer
  /** Bun.write(dest, data) — returns a promise resolving to the byte count. */
  write(dest: string | URL | number, data: unknown): Promise<BunWriteStream>
}

declare var Bun: BunNamespace
