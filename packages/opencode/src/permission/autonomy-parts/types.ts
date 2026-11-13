// Part of the autonomy table (R-1, 1.2.8): Types and the check class shared by every part of the autonomy table.
// Moved unchanged from `autonomy-table.ts`, which re-exports the public names; import from there, not from here.
import type { ProjectTrust } from "@opencode-ai/core/project/trust"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { OutwardKnown } from "../outward-known"
import { ScriptScreen } from "../script-screen"
import type { InstanceContext } from "../../project/instance-context"
import type { CheckpointFailedReason, OwnApiReason } from "../autonomy-texts"
export type Class = "A" | "P" | "D" | "B" | "X"
export type CheckClass = Extract<Class, "P" | "D">

/**
 * A test or a build runs with all of the user's rights, and a decider only ever sees `bun test`. The user accepted that
 * for this mode. "D" holds every check for a person instead. This is a constant on purpose, and no setting reaches it.
 */
export const CHECK_CLASS: CheckClass = "P"

export type RoutineCategory = "check" | "file-op" | "git-local"
/** What `routine` finds a command to be. "read" only looks at the folder, and is class A. */
export type CommandKind = RoutineCategory | "read"
/**
 * The category names are the schema's (`PermissionV1`), so the gate, the table and the audit cannot name a category the
 * others lack. Only the routine kinds, "edit-not-ordinary" and "own_api_read" are the table's own (the audit's
 * `DecisionCategory` in `autonomy.ts` lists them too).
 */
export type AllowedCategory = RoutineCategory | "edit-not-ordinary" | OwnApiReadCategory | PermissionV1.AllowedCategory
/**
 * 1.2.8 row 28 (H-U10, N8-386, C13): under consent, a GET/HEAD of a route on `OWN_API_READ_ROUTES` of Swarm's own server,
 * with only `OWN_API_READ_OPTIONS` and no directory outside the caller's worktree, run by the gate without the main agent.
 */
export type OwnApiReadCategory = "own_api_read"
export type HeldCategory = PermissionV1.DeferredCategory

/** What the edit tools learned from `Reach.editTrust`. Absent means nobody said, and that is held. */
export type EditClass = "ordinary" | "not_ordinary" | "no_undo" | "sensitive" | "secret"

export type Verdict = {
  class: Class
  /** The name of who settled it. "agent" is filled in with the model by whoever calls it. Absent when it is not recorded. */
  decidedBy?: "gate" | "agent" | "person"
  category?: AllowedCategory | HeldCategory
  /** U11 rule 3: it leaves the machine for a destination a person named and ticked, which `consentID` is the item of. */
  via?: "outward"
  /** The consent item a class A answer used: rule 3's destination with `via`, or rule 2's file with category "consented". */
  consentID?: string
  /**
   * That destination as the audit shows it (`OutwardKnown.label`), with account names hidden. 1.1.1 F26 (P42): on a call
   * the consent opened to send, where it goes (`host[:port]`, a remote name, a registry or deploy target), comma separated.
   */
  destination?: string
  /**
   * U11 rule 6: the screen behind a `script` or `script_flagged` answer, for the gate to put on record. The decider is only
   * ever given the closed summary of it (C70), and none of it is the script's text.
   */
  screen?: { bytes: number; lines: number; sha256: string; flags: readonly ScriptScreen.Flag[] }
  /** 1.1.1 (S1.12): the category the call had before the consented bypass let it run. Present only on an overlay A. */
  bypassed?: AllowedCategory | HeldCategory
  /**
   * 1.2.6 row 37b (P-01b): on an X `checkpoint_failed`, why no checkpoint could be made, from the closed list of
   * `checkpointFailedText` (autonomy-texts.ts). Never command text.
   */
  reason?: CheckpointFailedReason | OwnApiReason
}

/**
 * What the gate knows for U11 rule 3, from the root's consent: the destinations a person named and ticked, the snapshot
 * they were matched in before the mode could change anything, and for a push the recheck it ran just now on the remote
 * `pushTarget` names. The table only reads this, so nothing an agent says can add to it. Absent: nothing may leave.
 */
export type Outward = {
  allowed: readonly { id: string; destination: OutwardKnown.Destination }[]
  snapshot?: OutwardKnown.Snapshot
  recheck?: { repo: string; remote: string; result: OutwardKnown.Recheck }
  /** 1.1.1 F26 (P42): every destination named in the mission, ticked or not. Only the consented bypass reads it. */
  named?: readonly OutwardKnown.Destination[]
}

export type Input = {
  permission: string
  patterns: readonly string[]
  metadata: Readonly<Record<string, unknown>>
  instance: InstanceContext
  /** Where a command would really run. Its relative paths mean nothing without this. */
  cwd: string
  canUndo: boolean
  /** Undefined when it could not be read, which is treated as not trusted. */
  folder: ProjectTrust.Status["state"] | undefined
  harmless?: boolean
  editClass?: EditClass
  /** The root session's last person's message used the plan agent, for this request and all of its descendants. */
  plan?: boolean
  /** "user_catch_all" is `"*": "ask"` written by a person, who asked to be asked every time. */
  rule?: "deny" | "user_catch_all"
  /** Prompts answered together with this one. An `external_directory` for an edit says so here. */
  follows?: readonly { permission: string }[]
  outward?: Outward
  /** U11 rule 2, as the gate passes it (`Permission.Consented`). Read only here; absent means no list, so all is held. */
  consent?: Consent
  /**
   * 1.1.1 (S1.10): the person consented that the main agent decides during this run, and whose call this is. Absent: the
   * 1.1.0 table, to the byte.
   */
  bypass?: { readonly caller: "root" | "subagent" }
  /**
   * 1.2.7 row 47j (C76): the agent that asked, as the gate passes it. Only read to keep the read roles (`READ_SHELL_ROLES`)
   * at their U4 limits where the consent opens more for the main agent and other subagents. Absent: no read role.
   */
  agent?: string
  /** The processes Swarm started (S1.28), for `kill` under the bypass. Absent: none is known to be Swarm's. */
  ownProcesses?: ReadonlySet<number>
  /**
   * 1.1.1 F26 (P42): the whole text of the call a step of `classifySteps` came from, so a request step still sees a `<`
   * or a pipe the step's own words no longer carry. Absent: the call's own command.
   */
  whole?: string
}

/**
 * What a person allowed of the root's consent list: each concrete path they were shown, with the id of the item covering
 * it. A pattern such as `.env*` is only how the list reads to them; a file it would match that is not here is not covered.
 */
export type Consent = {
  id: string
  files: ReadonlyMap<string, string>
}

/** Not a prompt today. A folder's trust is a person's answer through its own endpoint, so nothing may answer it from here. */
export const TRUST_PERMISSION = "project_trust"

export const held = (category: HeldCategory): Verdict => ({ class: "D", decidedBy: "gate", category })
export const refused = (category: HeldCategory): Verdict => ({ class: "X", decidedBy: "gate", category })
export const QUIET: Verdict = { class: "A" }
