// `virtual:datum-studio-host` = the host-side module the utility-process entry loads (row 111 seam, same pattern as
// `virtual:opencode-server` in ../env.d.ts). Row 45 resolves it in electron.vite.config.ts to the row 31 barrel
// `packages/datum-studio/src/mcp-host/index.ts`, which exports these four names (file_requests row111 lines).
declare module "virtual:datum-studio-host" {
  export const openHostStore: import("./protocol").StudioHostModule["openHostStore"]
  export const closeHostStore: import("./protocol").StudioHostModule["closeHostStore"]
  export const configureTemplateSource: import("./protocol").StudioHostModule["configureTemplateSource"]
  export const startStudioHostServer: import("./protocol").StudioHostModule["startStudioHostServer"]
}
