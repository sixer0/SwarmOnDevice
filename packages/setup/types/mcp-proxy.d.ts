// Row-94 additive ambient declarations for the swarm-web MCP proxy + sanitiser/URL-policy
// library. Same pattern as types/bun-net.d.ts (row 82), consent-tty.d.ts (row 83),
// setup-log.d.ts (row 84), node-step.d.ts (row 87) and graft-step.d.ts (row 88): module
// augmentation / interface merge only ADDS members; nothing existing is redeclared or
// changed. Row 106 compiles against the full @types/bun catalog and these shims retire.
// Hermetic-toolchain rationale: env.d.ts header.

declare module "node:crypto" {
  /** CSPRNG bytes for the envelope nonce (§6.3 newNonce). Row 94's addition; randomUUID
   *  (env.d.ts) stays untouched — the nonce must be short hex, not a full UUID. */
  export function randomBytes(length: number): Uint8Array
}

declare module "node:fs" {
  /** Canonical path resolution for the vault-inbox confinement check (§7: realpath of the
   *  resolved target must carry the canonical inbox dir as a prefix). */
  export function realpathSync(path: string): string
}

// URL members row 94 adds on top of env.d.ts's class (interface + class merge, same
// technique bun-net.d.ts used for href/pathname): port for allow-list host:port matching.
interface URL {
  readonly port: string
}

// --- FIX2 (review 107 MAJOR-3): resolve→check→pin transport builtins ---------------------------
// Row-94 fix-round additions, same additive discipline. Mirrors @types/node for exactly the
// members src/mcpproxy/resolve.ts uses: the dns.lookup answer set, and the http/https request
// path with the custom-`lookup` connect option (Node >=10.11 API) that makes pinned connects
// possible without a second resolution. Global Swarm*-prefixed interfaces avoid any collision
// with existing shims; row 106 retires them against the full catalog.

declare module "node:dns" {
  export interface DnsAnswer {
    address: string
    family: number
  }
  export function lookup(
    hostname: string,
    options: { all: true; verbatim?: boolean },
    callback: (err: Error | null, addresses: DnsAnswer[]) => void,
  ): void
}

interface SwarmDnsLookupCallback {
  (err: Error | null, address: string | Array<{ address: string; family: number }>, family?: number): void
}
interface SwarmDnsLookupFn {
  (hostname: string, options: Record<string, unknown>, callback: SwarmDnsLookupCallback): void
}

interface SwarmHttpRequestOptions {
  host: string
  port?: number
  method?: string
  path?: string
  headers?: Record<string, string>
  timeout?: number
  /** TLS SNI + certificate-identity target (https leg). Stays the ORIGINAL hostname under pinning. */
  servername?: string
  /** Trust anchor override — TEST SEAM ONLY in resolve.ts (self-signed fixtures); undefined keeps
   *  the system store and setting it NARROWS trust, never disables verification. */
  ca?: string
  /** Custom resolver hook: serves the pre-vetted pinned address (TOCTOU closure). */
  lookup?: SwarmDnsLookupFn
}

interface SwarmIncomingMessage {
  readonly statusCode?: number
  readonly headers: Record<string, string | string[] | undefined>
  on(event: "data", cb: (chunk: Uint8Array) => void): void
  on(event: "end", cb: () => void): void
  on(event: "error", cb: (err: Error) => void): void
}

interface SwarmClientRequest {
  on(event: "response", cb: (res: SwarmIncomingMessage) => void): void
  on(event: "error", cb: (err: Error) => void): void
  write(chunk: string | Uint8Array): void
  end(): void
  destroy(): void
}

declare module "node:http" {
  const mod: { request(options: SwarmHttpRequestOptions): SwarmClientRequest }
  export default mod
}

declare module "node:https" {
  const mod: { request(options: SwarmHttpRequestOptions): SwarmClientRequest }
  export default mod
}
