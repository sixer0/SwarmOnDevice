// 1.1.3 (decision T9 G8, code review M2): literal expectations for the consented path, shared by the pre-1.1.3 tests.
// The texts are written out here on purpose, not imported from autonomy-texts.ts, so a test that pins an answer pins the
// words the agent reads. The shapes are plain values; nothing here calls `noWait` or `destinationsOf`.

import { consentedRefusalText } from "../../src/permission/autonomy-texts"

// 1.2.6 row 39 (P-01d, INTENT per 01g 3.6): the refusal texts name the way on for 1.2.6 (01b section 8), and the list gains
// the new X texts. Each test that pins one of these words pins the new words through this file.

/** X `not_reversible`: a deletion or replacement whose files Swarm could not tell (T3; 1.2.6 I-U). */
export const ARCHIVE_FIRST =
  "This call did not run. In autonomous mode Swarm does not delete or replace anything it cannot save first, and Swarm could not tell which files this changes, so it could not save them first. Write it as plain commands that name the files (no -c text, no script, no find -delete); Swarm then archives or checkpoints them and runs it. A deletion as a command of its own (rm, rmdir, unlink or git rm with paths only, inside the project) is moved to .swarm/archive. Then carry on, and list anything you could not do this way in your final message."
/** X `irreversible` under consent (1.2.6: a remote or the host). */
export const IRREVERSIBLE_ARCHIVE =
  "This call did not run. This acts outside this computer's files (a force push, a remote or cloud deletion, a shutdown), which no checkpoint can undo, so autonomous mode never runs it. Ask the person: open a decision with studio_mission_request_decision, or list it in your final message with the exact command so the person can run it. Carry on with everything that does not depend on it."
/** X `delete_compound`. */
export const DELETE_COMPOUND =
  "This call did not run. In autonomous mode a deletion must be a command of its own (rm, rmdir, unlink or git rm with paths only) so Swarm can move the paths to the archive, or a plain command that names its files so Swarm can checkpoint them first."
/** X `admin_rights` under consent (T6 suffix). */
export const ADMIN_RIGHTS =
  "This call did not run. Autonomous mode never runs a command with sudo or doas. Carry on without it, and list it in your final message so the person can run it themselves. Continue the task without this step."
/** X `outside_write`. */
export const OUTSIDE_WRITE =
  "This call did not run. Autonomous mode only reads outside the project folder. Copy the file into the project first (read it, then write the copy inside the project) and change the copy. The original stays as it is."
/** X `credential_change` under consent (T6 suffix). */
export const CREDENTIAL_CHANGE =
  "This call did not run. Autonomous mode never adds or changes a remote, a credential or a git account. List the remote or credential change in your final message, with the exact command, so the person can run it. Continue the task without this step."
/** X `protected_path`: a write to a protected place (1.2.6: reads run as `protected_read`). */
export const PROTECTED_PATH =
  "This call did not run. Autonomous mode never writes to a protected place: keys and credentials (such as ~/.ssh, ~/.gnupg, ~/.aws, a keychain or Swarm's auth.json), the system's folders or the Swarm app. Reading them is allowed. To change such a file, write the new content to a file inside the project and list it in your final message so the person can put it in place."
/** X `process_not_own` under consent (T6 suffix). */
export const STOPS_SWARM =
  "This call did not run. In autonomous mode Swarm never stops its own app or server, since that would stop this run as well. Stop only processes this run started, by their process id, or leave it running and list it in your final message. Continue the task without this step."
/** X `plan_mode` (1.2.6). */
export const PLAN_MODE =
  "This call did not run. The plan agent only reads and writes its plan file. Put the change in the plan, or hand it to the build agent."
/** X `app_state` (1.2.6, SEC-04 included). */
export const APP_STATE =
  "This call did not run. Autonomous mode never changes Swarm's own state or settings. Write what should change into your final message for the person."
/** X `folder_not_trusted` (1.2.6). */
export const FOLDER_NOT_TRUSTED =
  "This call did not run. Only the person can trust a folder. Carry on with reads and with work that runs nothing of this folder, and list it in your final message."
/** X `checkpoint_failed` (1.2.6, N-076), without a reason. */
export const CHECKPOINT_FAILED =
  "This call did not run. Swarm could not save a checkpoint of what it changes first, so it does not run it. Make your own copy inside the project (for example a dump file), or ask the person to run it, and list it in your final message."

/** What the agent is told for a consented verdict: undefined when the call runs (A), else the refusal's words. */
export function answerOf(verdict: { class: string; category?: string }): string | undefined {
  return verdict.class === "X" ? consentedRefusalText(verdict.category) : undefined
}
