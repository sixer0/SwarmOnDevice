interface ImportMetaEnv {
  readonly OPENCODE_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:opencode-server" {
  export namespace Server {
    export const listen: typeof import("../../../opencode/dist/types/src/node").Server.listen
    export type Listener = import("../../../opencode/dist/types/src/node").Server.Listener
  }
  // Row 38b (SEC-06): the per-launch desktop nonce, set by the sidecar before Server.listen.
  export namespace DesktopNonce {
    export const set: typeof import("../../../opencode/dist/types/src/node").DesktopNonce.set
  }
  export namespace RunLease {
    export const host: typeof import("../../../opencode/dist/types/src/node").RunLease.host
  }
  export namespace Config {
    export const get: typeof import("../../../opencode/dist/types/src/node").Config.get
    export type Info = import("../../../opencode/dist/types/src/node").Config.Info
  }
  export const bootstrap: typeof import("../../../opencode/dist/types/src/node").bootstrap
}
