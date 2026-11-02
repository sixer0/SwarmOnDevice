// The setup-tools channels (U14 register, plus C74's mark-offered). Both the preload and main import this
// file, so a renamed or mistyped channel fails typecheck instead of passing every test. It has no imports,
// which keeps it safe for the sandboxed preload bundle.
export const SETUP_TOOLS_IPC = {
  preview: "setup-tools-preview",
  install: "setup-tools-install",
  state: "setup-tools-state",
  progress: "setup-tools-progress",
  markOffered: "setup-tools:mark-offered",
} as const
