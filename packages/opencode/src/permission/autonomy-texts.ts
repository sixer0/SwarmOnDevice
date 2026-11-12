// The register's texts to the agent (U11). Neutral on purpose: the permission service, the shell and the task tool all read
// them, and the permission service may import neither tool, since the tools import the permission service.

export const OUTSIDE_WRITE_TEXT =
  "This call did not run. Autonomous mode only reads outside the project folder. Copy the file into the project first (read it, then write the copy inside the project) and change the copy. The original stays as it is."

/** Row 202: a file tool's read or write of a protected place outside the project (X `protected_path`). */
export const PROTECTED_PATH_TEXT =
  "This call did not run. Autonomous mode never reads or writes a protected place outside the project: keys and credentials (such as ~/.ssh, ~/.gnupg, ~/.aws, a keychain or Swarm's auth.json), the system's folders or the Swarm app. Do not try to get the same effect another way. Carry on with everything that does not depend on it, and list it in your final message so the person can do it themselves."

export const DELETE_COMPOUND_TEXT =
  "This call did not run. In autonomous mode a deletion must be a command of its own (rm, rmdir, unlink or git rm with paths only), so Swarm can move the paths to the archive instead."

export const CREDENTIAL_CHANGE_TEXT =
  "This call did not run. Autonomous mode never adds or changes a remote, a credential or a git account."

/** 1.1.1 (S0.3): refused under the consented bypass, since nothing can undo it. 1.1.3: no longer given out (now
 * `IRREVERSIBLE_ARCHIVE_TEXT`); kept for review (T5). */
export const IRREVERSIBLE_TEXT =
  "This call did not run. In autonomous mode Swarm never runs an action nothing can undo (such as git reset --hard, git clean, a force push, rewriting history, dropping a table or wiping a disk). Do not try to get the same effect another way. Carry on with everything that does not depend on it, and list it in your final message."

/** 1.1.1 (S0.3): refused under the consented bypass, since it asks for admin rights. */
export const ADMIN_RIGHTS_TEXT =
  "This call did not run. Autonomous mode never runs a command with sudo or doas. Carry on without it, and list it in your final message so the person can run it themselves."

/**
 * 1.1.3 (T3): under consent, a deletion or replacement the shell will not move to the archive does not wait; the agent is
 * told at once how to archive first (X `not_reversible`).
 */
export const ARCHIVE_FIRST_TEXT =
  "This call did not run. In autonomous mode Swarm does not delete or replace anything it cannot move to the archive first. Archive first: delete with a command of its own (rm, rmdir, unlink or git rm with paths only, inside the project), which Swarm moves to .swarm/archive, or copy the file to a new name before you replace it. Then carry on, and list anything you could not do this way in your final message."

/** 1.1.3 (T3): under consent, an action nothing can undo is answered at once with the archive or snapshot way (X `irreversible`). */
export const IRREVERSIBLE_ARCHIVE_TEXT =
  "This call did not run. In autonomous mode Swarm never runs an action nothing can undo (such as git reset --hard, git clean, a force push, rewriting history, dropping a table or wiping a disk). Archive or snapshot first, then use a way that can be undone: delete files with a command of its own (rm, rmdir, unlink or git rm with paths only) so Swarm moves them to the archive, commit or create a branch before you change history, and copy a table or file before you replace it. Carry on with everything that does not depend on it, and list it in your final message."

/** 1.1.3: the gate's answer when a consented call could not be judged or recorded (X `not_routine`); nothing waits. */
export const UNJUDGED_TEXT =
  "This call did not run. Autonomous mode could not judge or record it, and it runs nothing it has not judged and recorded. Try the call once more. If it is refused again, carry on without it, and list it in your final message."

/**
 * 1.1.3 (T7 F4): under consent, a call that would stop Swarm's own app or server (and with it the run) is refused at once
 * (X `process_not_own`); its consented text ends with `CONSENT_CONTINUE_SUFFIX`. Without consent such a kill waits as
 * 1.1.0 holds it, so this text is never given there.
 */
export const STOPS_SWARM_TEXT =
  "This call did not run. In autonomous mode Swarm never stops its own app or server, since that would stop this run as well."

/**
 * 1.1.3 (T6): appended, after one space, to the refusal of `credential_change` and `admin_rights` on the consented path
 * only (`consentedRefusalText`). Without consent those refusals stay as 1.1.0 words them.
 */
export const CONSENT_CONTINUE_SUFFIX = "Continue the task without this step."

/** 1.1.3 (T6, T7 F4): the categories whose consented refusal ends with `CONSENT_CONTINUE_SUFFIX`. */
export const CONSENT_CONTINUE: ReadonlySet<string> = new Set(["credential_change", "admin_rights", "process_not_own"])

/** 1.1.3: the class X answers that redirect the agent to the archive method; the report lists them as "Redirected". */
export const ARCHIVE_REDIRECT: ReadonlySet<string> = new Set(["not_reversible", "delete_compound", "irreversible"])

/**
 * The class X categories whose refusal names its own way on; any other X gets the general refusal. 1.1.3: `not_reversible`,
 * `not_routine` and `process_not_own` are class X only under consent, and `irreversible` is refused only under consent (`underConsent`).
 */
export const REFUSED_TEXT: Readonly<
  Record<
    | "outside_write"
    | "protected_path"
    | "delete_compound"
    | "credential_change"
    | "irreversible"
    | "admin_rights"
    | "not_reversible"
    | "not_routine"
    | "process_not_own",
    string
  >
> = {
  outside_write: OUTSIDE_WRITE_TEXT,
  protected_path: PROTECTED_PATH_TEXT,
  delete_compound: DELETE_COMPOUND_TEXT,
  credential_change: CREDENTIAL_CHANGE_TEXT,
  irreversible: IRREVERSIBLE_ARCHIVE_TEXT,
  admin_rights: ADMIN_RIGHTS_TEXT,
  not_reversible: ARCHIVE_FIRST_TEXT,
  not_routine: UNJUDGED_TEXT,
  // 1.1.3 (T7 F4): class X only under consent (`noWait`); without consent `process_not_own` is a hold, never refused.
  process_not_own: STOPS_SWARM_TEXT,
}

/**
 * 1.1.3 (T6): the text a consented class X refusal gives, or undefined for the general refusal. `REFUSED_TEXT`, plus
 * `CONSENT_CONTINUE_SUFFIX` for the categories in `CONSENT_CONTINUE`. The gate calls this only while `bypass` is set.
 */
export function consentedRefusalText(category: string | undefined): string | undefined {
  if (category === undefined || !Object.hasOwn(REFUSED_TEXT, category)) return undefined
  const text = REFUSED_TEXT[category as keyof typeof REFUSED_TEXT]
  return CONSENT_CONTINUE.has(category) ? `${text} ${CONSENT_CONTINUE_SUFFIX}` : text
}

/** U11 rule 6 (C92): a script the gate let run changed before it ran, so the shell did not run it. */
export const SCRIPT_CHANGED_TEXT =
  "This call did not run. A script it runs changed after autonomous mode checked it, so what would run is not what was checked. Run the command again to have the script checked as it is now."

/**
 * U11 rule 11: how autonomous mode words a run it stopped. The task tool tells a subagent's stop from a failure by this
 * prefix, so whatever ends the run (the error on its last message, or its last failed call) has to start with it.
 */
export const SUBAGENT_STOPPED = "Stopped by autonomous mode:"

/**
 * 1.2.6 S-03a (register N-103): a subagent run that ended without an answer. Followed by the reason (`length`,
 * `tool-calls`, `no-text`, `unfinished`) and the task_id; the task call reports it instead of an empty result.
 */
export const SUBAGENT_NO_RESULT = "Subagent returned no result:"

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
