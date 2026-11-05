// S11 line cut length (register 14.2). Defined here so this file imports nothing; patch-common.ts re-exports it.
export const PATCH_S11_MAX_CHARS = 500

// Names and codes shared by the handoff wrapper (swarm-patch-handoff.ts, row 57), the result reader
// (swarm-patch-result.ts, row 58) and the menu flows (rows 56, 59). One copy only (review row 31 M5, C27).
// patch-codes.test.ts parses the applier's SP_CODE table (resources/swarm-patch/swarm-patch) and checks it against
// PATCH_EXIT_NAMES, so a new or renumbered applier code fails a test instead of drifting.

// Register section 7, the applier's SP_CODE table. E_OK prints no S11 line.
export const PATCH_EXIT_NAMES = Object.freeze<Record<number, string>>({
  0: "E_OK",
  2: "E_USAGE",
  10: "E_CONTAINER",
  11: "E_SIGNATURE",
  12: "E_MANIFEST",
  13: "E_HASH",
  14: "E_DOWNGRADE",
  15: "E_SEAL",
  20: "E_RUNNING",
  21: "E_DISK",
  22: "E_VOLUME",
  23: "E_BUSY",
  24: "E_MIGRATION",
  25: "E_CONFIRM",
  30: "E_RESTORED",
  31: "E_RECOVER",
})

// The same table by name.
export const PATCH_EXIT_CODES: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(Object.entries(PATCH_EXIT_NAMES).map(([code, name]) => [name, Number(code)])),
)

// BN-64: <userData>/swarm-patch-result, written by the wrapper and read once at the next start.
export const HANDOFF_RESULT_FILE_NAME = "swarm-patch-result"
// BN-65: the reader refuses a larger file; R3 also caps each line at this size.
export const HANDOFF_RESULT_MAX_BYTES = 16384

// R5: an S11 line in the result file, with its E_* name captured, at most PATCH_S11_MAX_CHARS of printable ASCII.
export const PATCH_S11_NAMED = new RegExp(`^swarm-patch: (E_[A-Z]+): [ -~]{0,${PATCH_S11_MAX_CHARS}}$`)
