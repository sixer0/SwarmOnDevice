// 1.3.0 row 132 (C110): the typecheck-only surface of packages/setup/src/wiring/proxy_stage.ts that the desktop
// launch refresh (proxy-refresh.ts) imports as "@swarm-setup/proxy-stage". The setup sources use Bun-only typing
// (`.ts` import paths, import.meta.dir, a hermetic node:fs shim), so the desktop typecheck reads this file instead
// (tsconfig.json `paths`); the bundle (electron.vite.config.ts alias) and bun test (the second `paths` entry) use the
// real source. rel130-s6-proxy-refresh.test.ts pins these names and option keys equal to proxy_stage.ts.

export interface ProxyStageOptions {
  readonly base?: string
  readonly programDir?: string
  readonly requireExisting?: boolean
}

export declare const PROXY_REFRESH_UNSAFE_DIR: "PROXY_REFRESH_UNSAFE_DIR"

export type ProxyStageResult =
  | { readonly ok: true; readonly staged: true; readonly changed: boolean; readonly target: string; readonly sha256: string }
  | { readonly ok: true; readonly staged: false; readonly reason: string }
  | { readonly ok: false; readonly reason: string; readonly code?: typeof PROXY_REFRESH_UNSAFE_DIR }

export declare function stageProxyBinary(opts?: ProxyStageOptions): ProxyStageResult
