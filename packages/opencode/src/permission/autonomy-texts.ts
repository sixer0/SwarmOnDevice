// The register's class X refusal texts (U11). Neutral on purpose: the permission service and the shell both read them,
// and neither may import the other, since the shell tool imports the permission service.

export const OUTSIDE_WRITE_TEXT =
  "This call did not run. Autonomous mode only reads outside the project folder. Copy the file into the project first (read it, then write the copy inside the project) and change the copy. The original stays as it is."

export const DELETE_COMPOUND_TEXT =
  "This call did not run. In autonomous mode a deletion must be a command of its own (rm, rmdir, unlink or git rm with paths only), so Swarm can move the paths to the archive instead."

export const CREDENTIAL_CHANGE_TEXT =
  "This call did not run. Autonomous mode never adds or changes a remote, a credential or a git account."

export * as AutonomyTexts from "./autonomy-texts"
