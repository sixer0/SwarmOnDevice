// Minimal, self-contained ambient declarations for the runtime surface this
// skeleton actually uses. The monorepo's node_modules does not carry @types/node
// or @types/bun in this checkout (the handoff did not copy them), and this row
// must not run `bun install` (driver_rules_e1 rule 8 red line: no changes to the
// machine's existing tooling / tracked bun.lock). Row 106 compiles swarm-setup
// against the full @types/bun catalog; until then these shims keep `tsc --noEmit`
// hermetic and honest about exactly which builtins the skeleton touches.
//
// Every declaration here mirrors the Node/Bun builtin signature for the members
// used by src/*.ts and nothing more.

declare module "node:fs" {
  export interface Stats {
    isDirectory(): boolean
    isFile(): boolean
    mode: number
  }
  export function existsSync(path: string): boolean
  export function readFileSync(path: string, encoding: "utf8"): string
  export function readFileSync(path: string): Uint8Array
  export function writeFileSync(
    path: string,
    data: string | Uint8Array,
    options?: { encoding?: "utf8"; mode?: number; flag?: string },
  ): void
  export function appendFileSync(
    path: string,
    data: string | Uint8Array,
    options?: { encoding?: "utf8"; mode?: number },
  ): void
  export function renameSync(oldPath: string, newPath: string): void
  export function mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): void
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void
  export function readdirSync(path: string): string[]
  export function statSync(path: string): Stats
  export function openSync(path: string, flags: string | number): number
  export function fsyncSync(fd: number): void
  export function closeSync(fd: number): void
}

declare module "node:path" {
  export function join(...parts: string[]): string
  export function resolve(...parts: string[]): string
  export function dirname(path: string): string
  export function basename(path: string, ext?: string): string
}

declare module "node:os" {
  export function homedir(): string
  export function platform(): string
  export function arch(): string
  export function userInfo(): { uid: number; username: string }
}

declare module "node:crypto" {
  export function randomUUID(): string
}

interface SwarmWriteStream {
  readonly isTTY?: boolean
}

interface SwarmProcess {
  argv: string[]
  env: Record<string, string | undefined>
  pid: number
  execPath: string
  platform: string
  exitCode: number
  stdout: SwarmWriteStream
  stderr: SwarmWriteStream
  exit(code?: number): never
  getuid?(): number
  /** POSIX signal delivery. Used only as a liveness probe via `process.kill(pid, 0)`,
   *  which throws ESRCH when the pid is gone and EPERM when it exists under another uid. */
  kill(pid: number, signal: number): void
}

declare var process: SwarmProcess

interface SwarmConsole {
  log(...data: unknown[]): void
  error(...data: unknown[]): void
}

declare var console: SwarmConsole

// Only the hostname-parsing member is used (tools.lock.json allow-list check).
declare class URL {
  constructor(input: string)
  readonly hostname: string
  readonly protocol: string
}

// Bun exposes import.meta.dir (the directory of the current module). It is not in
// the standard lib types, so it is declared here for the source-run posture; the
// compiled-binary posture resolves the program directory from process.execPath.
interface ImportMeta {
  readonly dir: string
  readonly url: string
  readonly path: string
}
