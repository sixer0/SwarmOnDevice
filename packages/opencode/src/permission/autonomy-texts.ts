// The register's texts to the agent (U11). Neutral on purpose: the permission service, the shell and the task tool all read
// them, and the permission service may import neither tool, since the tools import the permission service.

export const OUTSIDE_WRITE_TEXT =
  "This call did not run. Autonomous mode only reads outside the project folder. Copy the file into the project first (read it, then write the copy inside the project) and change the copy. The original stays as it is."

/**
 * Row 202: a file tool's write of a protected place outside the project (X `protected_path`). 1.2.6 (P-01d, U12): reads of
 * such a place run as `protected_read`, so the text speaks of writes only and names the way on: a copy inside the project.
 */
export const PROTECTED_PATH_TEXT =
  "This call did not run. Autonomous mode never writes to a protected place: keys and credentials (such as ~/.ssh, ~/.gnupg, ~/.aws, a keychain or Swarm's auth.json), the system's folders or the Swarm app. Reading them is allowed. To change such a file, write the new content to a file inside the project and list it in your final message so the person can put it in place."

/** X `delete_compound`. 1.2.6 (P-01d): also names the checkpoint way, a plain command that names its files. */
export const DELETE_COMPOUND_TEXT =
  "This call did not run. In autonomous mode a deletion must be a command of its own (rm, rmdir, unlink or git rm with paths only) so Swarm can move the paths to the archive, or a plain command that names its files so Swarm can checkpoint them first."

/** X `credential_change`. 1.2.6 (P-01d): names the way on, the person runs it from the final message. */
export const CREDENTIAL_CHANGE_TEXT =
  "This call did not run. Autonomous mode never adds or changes a remote, a credential or a git account. List the remote or credential change in your final message, with the exact command, so the person can run it."

/** 1.1.1 (S0.3): refused under the consented bypass, since nothing can undo it. 1.1.3: no longer given out (now
 * `IRREVERSIBLE_ARCHIVE_TEXT`); kept for review (T5). */
export const IRREVERSIBLE_TEXT =
  "This call did not run. In autonomous mode Swarm never runs an action nothing can undo (such as git reset --hard, git clean, a force push, rewriting history, dropping a table or wiping a disk). Do not try to get the same effect another way. Carry on with everything that does not depend on it, and list it in your final message."

/** 1.1.1 (S0.3): refused under the consented bypass, since it asks for admin rights. */
export const ADMIN_RIGHTS_TEXT =
  "This call did not run. Autonomous mode never runs a command with sudo or doas. Carry on without it, and list it in your final message so the person can run it themselves."

/**
 * 1.1.3 (T3): under consent, a deletion or replacement the shell will not move to the archive does not wait; the agent is
 * told at once how to archive first (X `not_reversible`). 1.2.6 (P-01d, U6): `not_reversible` is left for a real
 * deletion or replacement whose files Swarm could not tell (I-U), so the text says why and how to name them.
 */
export const ARCHIVE_FIRST_TEXT =
  "This call did not run. In autonomous mode Swarm does not delete or replace anything it cannot save first, and Swarm could not tell which files this changes, so it could not save them first. Write it as plain commands that name the files (no -c text, no script, no find -delete); Swarm then archives or checkpoints them and runs it. A deletion as a command of its own (rm, rmdir, unlink or git rm with paths only, inside the project) is moved to .swarm/archive. Then carry on, and list anything you could not do this way in your final message."

/**
 * 1.1.3 (T3): under consent, an action nothing can undo is answered at once (X `irreversible`). 1.2.6 (P-01d, RA-5):
 * `irreversible` means an action outside this computer's files (a remote or the host); local ones are checkpointed or
 * refused `checkpoint_failed`. Nothing here can undo it, so the way on is the person.
 */
export const IRREVERSIBLE_ARCHIVE_TEXT =
  "This call did not run. This acts outside this computer's files (a force push, a remote or cloud deletion, a shutdown), which no checkpoint can undo, so autonomous mode never runs it. Ask the person: open a decision with studio_mission_request_decision, or list it in your final message with the exact command so the person can run it. Carry on with everything that does not depend on it."

/** 1.1.3: the gate's answer when a consented call could not be judged or recorded (X `not_routine`); nothing waits. */
export const UNJUDGED_TEXT =
  "This call did not run. Autonomous mode could not judge or record it, and it runs nothing it has not judged and recorded. Try the call once more. If it is refused again, carry on without it, and list it in your final message."

/**
 * 1.1.3 (T7 F4): under consent, a call that would stop Swarm's own app or server (and with it the run) is refused at once
 * (X `process_not_own`); its consented text ends with `CONSENT_CONTINUE_SUFFIX`. Without consent such a kill waits as
 * 1.1.0 holds it, so this text is never given there.
 */
export const STOPS_SWARM_TEXT =
  "This call did not run. In autonomous mode Swarm never stops its own app or server, since that would stop this run as well. Stop only processes this run started, by their process id, or leave it running and list it in your final message."

/** 1.2.6 (P-01d): X `plan_mode`, a plan agent's change outside its plan file. Module-local (N-149). */
const PLAN_MODE_TEXT =
  "This call did not run. The plan agent only reads and writes its plan file. Put the change in the plan, or hand it to the build agent."

/**
 * 1.2.6 (P-01d, SEC-04): X `app_state`, an agent's write to Swarm's own state or settings (tool-health.json included).
 * 1.2.7 N-1 (N7-050, K7-06): also a look there the SR OP-2 allowlist does not take (a count, a byte dump, a search); the
 * text names the looks that do run.
 */
const APP_STATE_TEXT =
  "This call did not run. Autonomous mode never changes Swarm's own state or settings. To look at those files, use the Read tool or an inspection command such as ls, cat or head; reading them is allowed. Write what should change into your final message for the person."

/**
 * 1.2.7 U4 (N7-054): the refusal a read role (`planner`, `data-collector`; `READ_SHELL_ROLES`) gets for a shell call
 * outside the read class (`isReadOnlyShell`), in every mode, whatever a person's "always", a task grant or user config say.
 */
export const ROLE_SHELL_OUTSIDE_READ_TEXT =
  "This agent role only runs inspection commands (for example ls, head, git log). Hand this command to a coder subagent."

/**
 * 1.2.7 F-4 (N7-052): X `own_api`, a call to Swarm's own running server whose address the call itself names (a literal
 * host and port, a variable assigned in the same text, a config file that was read).
 */
// 1.2.7 row 47l (C79): agents may call Swarm's own server; only the routes that act as the person get this text.
export const OWN_API_TEXT =
  "This call did not run. Agents may call Swarm's own server, but not the routes that act as the person (the autonomous mode and consent, answers to permissions and questions, reverts, folder trust, configuration, shell commands run as the person, control of the person's app, repository commits and patches, upgrades and shutdowns), and not by a socket or program code whose route cannot be read. Use the tools you were given, or write what is needed into your final message for the person."

/**
 * 1.2.7 F-4 (N7-135): X `own_api` with a reason (N7-136), a network call whose address could not be worked out while
 * Swarm's server listens: a config file that could not be read, or a host or port from a variable, a command or a list.
 */
export const OWN_API_UNRESOLVED_TEXT =
  "This call did not run. Autonomous mode cannot tell where this network call goes (the address comes from a variable, a config file or another command), and it never calls Swarm's own server. Write the host and port into the command itself."

/**
 * 1.2.7 U-10 (C63): X `own_api` with reason `person_only`, an agent's shell running `swarm autonomy` (the 1.1.1 rule: only
 * the person turns the mode on, never an agent).
 */
export const OWN_API_PERSON_ONLY_TEXT =
  "This call did not run. Only the person turns autonomous mode on or off, in the app or by typing swarm autonomy at their own terminal; an agent never runs that command. Carry on without it, and if the mode should change, say so in your final message for the person."

/**
 * 1.2.7 F-4 (N7-136): the closed reason list of an X `own_api`. Without a reason the address was named in the call.
 * 1.2.7 U-10: `person_only`, the `swarm autonomy` command.
 */
export type OwnApiReason = "config_file" | "unresolved_target" | "person_only"

/** The text of an X `own_api`: `OWN_API_UNRESOLVED_TEXT` for a reason of the closed list, else `OWN_API_TEXT`. */
export function ownApiText(reason: string | undefined): string {
  if (reason === "person_only") return OWN_API_PERSON_ONLY_TEXT
  return reason === "config_file" || reason === "unresolved_target" ? OWN_API_UNRESOLVED_TEXT : OWN_API_TEXT
}

/** 1.2.6 (P-01d): X `folder_not_trusted`, an agent's ask to trust a folder. Module-local (N-149). */
const FOLDER_NOT_TRUSTED_TEXT =
  "This call did not run. Only the person can trust a folder. Carry on with reads and with work that runs nothing of this folder, and list it in your final message."

/**
 * 1.2.6 (P-01b/P-01d, N-075/N-076): X `checkpoint_failed`, an irreversible local action whose checkpoint could not be
 * made. Without a reason; `checkpointFailedText` adds one from the closed list below, never command text (TX-4).
 */
export const CHECKPOINT_FAILED_TEXT =
  "This call did not run. Swarm could not save a checkpoint of what it changes first, so it does not run it. Make your own copy inside the project (for example a dump file), or ask the person to run it, and list it in your final message."

/**
 * The closed reason list of `checkpointFailedText`: the failures of `ActionCheckpoint.create` (tool/checkpoint.ts,
 * `Failure`, row 37a) plus `not_files` for data a file checkpoint cannot hold (a database, a service's data, a device: I-N).
 * Each phrase is fixed text; nothing from the call reaches the agent through it.
 */
const CHECKPOINT_FAILED_REASON = {
  not_files: "it changes a database, a service's data or a device, which a checkpoint of files cannot hold",
  folder: "the project folder could not be read",
  outside: "it changes a file outside the project",
  checkpoint: "it changes Swarm's checkpoint folder itself",
  checkpoint_link: "the checkpoint folder is a link or not what it should be",
  unreadable: "a file it changes could not be read",
  too_large: "the copy would be larger than 1 GiB",
  git: "the Git state it changes could not be recorded",
  mismatch: "a copy did not match its original",
  failed: "the copy could not be written",
  // 1.2.6 FX-14 (F-3): the copy was made, but the audit line that lets the person revert it could not be written.
  audit: "the checkpoint could not be recorded in the audit log, so the person could not revert it",
} as const

export type CheckpointFailedReason = keyof typeof CHECKPOINT_FAILED_REASON

/** `CHECKPOINT_FAILED_TEXT` with the reason named. A reason outside the closed list is dropped, never echoed. */
export function checkpointFailedText(reason: string | undefined): string {
  if (reason === undefined || !Object.hasOwn(CHECKPOINT_FAILED_REASON, reason)) return CHECKPOINT_FAILED_TEXT
  const phrase = CHECKPOINT_FAILED_REASON[reason as CheckpointFailedReason]
  return CHECKPOINT_FAILED_TEXT.replace("what it changes first,", `what it changes first (${phrase}),`)
}

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
 * 1.2.6 (P-01d): every X category a classifier can return has its text; only an X with no category (a person's `deny`
 * rule, an agent's `autonomy_consent` ask) keeps the general refusal, which names no tool (INV-7).
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
    | "process_not_own"
    | "plan_mode"
    | "app_state"
    | "folder_not_trusted"
    | "checkpoint_failed"
    | "own_api",
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
  plan_mode: PLAN_MODE_TEXT,
  app_state: APP_STATE_TEXT,
  folder_not_trusted: FOLDER_NOT_TRUSTED_TEXT,
  checkpoint_failed: CHECKPOINT_FAILED_TEXT,
  // 1.2.7 F-4: the text without a reason; `ownApiText` picks N7-135 for a reason.
  own_api: OWN_API_TEXT,
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

/**
 * 1.2.6 S-03b (register N-105): a task call named `expected_outputs` and at least one of those paths is absent after the
 * run. Followed by the absent paths; the calling controller marks its mission row `blocked` with this note.
 */
export const SUBAGENT_OUTPUT_MISSING = "Promised output missing:"

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
