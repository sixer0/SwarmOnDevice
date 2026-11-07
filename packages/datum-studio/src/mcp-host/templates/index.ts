/**
 * Template tools of the Studio host server (row 68, U10): `templateHostExtension(opts?)` returns the five
 * `HostToolExtension`s (toolset `templates`) that `startStudioHostServer` lists after its kept tools.
 * Integration (pass I-2, start.ts is not this row's file): pass them in `extensions`, e.g.
 * `extensions: [...templateHostExtension({ log: write }), ...(opts.extensions ?? [])]`.
 */
export { templateHostExtension, type TemplateHostExtensionOptions, type TemplateToolLog } from "./tools.ts"
export { TEMPLATE_TOOL_NAMES, TEMPLATE_TOOL_SCHEMAS, PREVIEW_FORMAT_ENUM, type TemplateToolName } from "./schemas.ts"
