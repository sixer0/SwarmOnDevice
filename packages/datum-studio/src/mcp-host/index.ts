/**
 * `virtual:datum-studio-host` (row 111 -> row 31 contract, desktop src/main/datum-studio-host/protocol.ts
 * `StudioHostModule`): the four names the datum-studio-host runner needs, plus the host seams.
 *
 * Runner order (row 111): openHostStore (lock) -> configureTemplateSource -> startStudioHostServer;
 * stop: server.close -> configureTemplateSource(null) -> closeHostStore.
 */
export { startStudioHostServer, LOCAL_API_BASE_URL, HostConfigError, type StudioHostServer, type StudioHostServerOptions } from "./start.ts"
export { openHostStore, closeHostStore } from "../store-bridge/index.ts"
export { configureTemplateSource } from "../../vendor/src/lib/studio/services/templates"
export { HOST_KEPT_TOOLS, HOST_DROPPED_TOOLS, type HostToolExtension, type HostToolSession } from "./tool-table.ts"
export { MCP_PATH, CALLER_CWD_HEADER, AGENT_HEADER } from "./http-server.ts"
export { missionHostExtension, MISSION_TOOL_NAMES, type MissionExporter, type MissionExtensionOptions } from "./mission/index.ts"
