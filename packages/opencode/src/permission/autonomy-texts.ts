// The register's texts to the agent (U11). Neutral on purpose: the permission service, the shell and the task tool all read
// them, and the permission service may import neither tool, since the tools import the permission service.

export const OUTSIDE_WRITE_TEXT =
  "This call did not run. Autonomous mode only reads outside the project folder. Copy the file into the project first (read it, then write the copy inside the project) and change the copy. The original stays as it is."

export const DELETE_COMPOUND_TEXT =
  "This call did not run. In autonomous mode a deletion must be a command of its own (rm, rmdir, unlink or git rm with paths only), so Swarm can move the paths to the archive instead."

export const CREDENTIAL_CHANGE_TEXT =
  "This call did not run. Autonomous mode never adds or changes a remote, a credential or a git account."

/** 1.1.1 (S0.3): refused under the consented bypass, since nothing can undo it. */
export const IRREVERSIBLE_TEXT =
  "This call did not run. In autonomous mode Swarm never runs an action nothing can undo (such as git reset --hard, git clean, a force push, rewriting history, dropping a table or wiping a disk). Do not try to get the same effect another way. Carry on with everything that does not depend on it, and list it in your final message."

/** 1.1.1 (S0.3): refused under the consented bypass, since it asks for admin rights. */
export const ADMIN_RIGHTS_TEXT =
  "This call did not run. Autonomous mode never runs a command with sudo or doas. Carry on without it, and list it in your final message so the person can run it themselves."

/** The class X categories whose refusal names its own way on; any other X gets the general refusal. */
export const REFUSED_TEXT: Readonly<
  Record<"outside_write" | "delete_compound" | "credential_change" | "irreversible" | "admin_rights", string>
> = {
  outside_write: OUTSIDE_WRITE_TEXT,
  delete_compound: DELETE_COMPOUND_TEXT,
  credential_change: CREDENTIAL_CHANGE_TEXT,
  irreversible: IRREVERSIBLE_TEXT,
  admin_rights: ADMIN_RIGHTS_TEXT,
}

/** U11 rule 6 (C92): a script the gate let run changed before it ran, so the shell did not run it. */
export const SCRIPT_CHANGED_TEXT =
  "This call did not run. A script it runs changed after autonomous mode checked it, so what would run is not what was checked. Run the command again to have the script checked as it is now."

/**
 * U11 rule 11: how autonomous mode words a run it stopped. The task tool tells a subagent's stop from a failure by this
 * prefix, so whatever ends the run (the error on its last message, or its last failed call) has to start with it.
 */
export const SUBAGENT_STOPPED = "Stopped by autonomous mode:"

/** The stop for a repeating call (`doom_loop`) to `tool`. */
export function subagentStoppedMessage(tool: string) {
  return `${SUBAGENT_STOPPED} repeated calls to \`${tool}\`.`
}

/** The stop for a spend limit. */
export const SPEND_STOPPED_TEXT = `${SUBAGENT_STOPPED} the spend limit was reached.`

/** 1.1.1 (S0.3): the main agent said no to a subagent's call under the consented bypass. `reason` is one printable line. */
export function mainAgentDeclined(reason: string) {
  return `This call did not run. The main agent declined it: ${reason} Carry on without it, and list it in your final message.`
}

/** 1.1.1 (S0.3): the main agent could not decide on a subagent's call; nothing is held, the call is refused. */
export const MAIN_AGENT_UNAVAILABLE_TEXT =
  "This call did not run. The main agent could not be reached to decide on it in time. Carry on without it, and list it in your final message."

export * as AutonomyTexts from "./autonomy-texts"
