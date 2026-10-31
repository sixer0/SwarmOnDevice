// The embedded catalog, about 6 MB. It is a JSON string behind its own dynamic import so that a process which never
// reads it (the TUI's main thread, any plain CLI command) does not load it, and the one that does parses data, not code.
declare const OPENCODE_MODELS_DEV: string | undefined

export const snapshot = typeof OPENCODE_MODELS_DEV === "undefined" ? undefined : OPENCODE_MODELS_DEV
