// 1.1.3 (decision T9 G8, code review M2): literal expectations for the consented path, shared by the pre-1.1.3 tests.
// The texts are written out here on purpose, not imported from autonomy-texts.ts, so a test that pins an answer pins the
// words the agent reads. The shapes are plain values; nothing here calls `noWait` or `destinationsOf`.

import { consentedRefusalText } from "../../src/permission/autonomy-texts"

/** X `not_reversible`: a deletion or replacement nothing archives (T3). */
export const ARCHIVE_FIRST =
  "This call did not run. In autonomous mode Swarm does not delete or replace anything it cannot move to the archive first. Archive first: delete with a command of its own (rm, rmdir, unlink or git rm with paths only, inside the project), which Swarm moves to .swarm/archive, or copy the file to a new name before you replace it. Then carry on, and list anything you could not do this way in your final message."
/** X `irreversible` under consent. */
export const IRREVERSIBLE_ARCHIVE =
  "This call did not run. In autonomous mode Swarm never runs an action nothing can undo (such as git reset --hard, git clean, a force push, rewriting history, dropping a table or wiping a disk). Archive or snapshot first, then use a way that can be undone: delete files with a command of its own (rm, rmdir, unlink or git rm with paths only) so Swarm moves them to the archive, commit or create a branch before you change history, and copy a table or file before you replace it. Carry on with everything that does not depend on it, and list it in your final message."
/** X `delete_compound`. */
export const DELETE_COMPOUND =
  "This call did not run. In autonomous mode a deletion must be a command of its own (rm, rmdir, unlink or git rm with paths only), so Swarm can move the paths to the archive instead."
/** X `admin_rights` under consent (T6 suffix). */
export const ADMIN_RIGHTS =
  "This call did not run. Autonomous mode never runs a command with sudo or doas. Carry on without it, and list it in your final message so the person can run it themselves. Continue the task without this step."
/** X `outside_write`. */
export const OUTSIDE_WRITE =
  "This call did not run. Autonomous mode only reads outside the project folder. Copy the file into the project first (read it, then write the copy inside the project) and change the copy. The original stays as it is."
/** X `credential_change` under consent (T6 suffix). */
export const CREDENTIAL_CHANGE =
  "This call did not run. Autonomous mode never adds or changes a remote, a credential or a git account. Continue the task without this step."

/** What the agent is told for a consented verdict: undefined when the call runs (A), else the refusal's words. */
export function answerOf(verdict: { class: string; category?: string }): string | undefined {
  return verdict.class === "X" ? consentedRefusalText(verdict.category) : undefined
}
