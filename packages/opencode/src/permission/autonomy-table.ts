// What autonomous mode does with a request nobody is there to answer. This decides on what the request says and on bytes,
// and no model is involved: only class P ever reaches one, and a model's answer cannot raise a request into P. It is an
// allow list because a list of what to refuse let through every way of spelling `git push` that was tried.
//
// 1.2.8 R-1: the code lives in `./autonomy-parts/`; this file only re-exports the names it exported before the split.

export type {
  Class,
  CheckClass,
  RoutineCategory,
  CommandKind,
  AllowedCategory,
  HeldCategory,
  EditClass,
  Verdict,
  Outward,
  Input,
  Consent,
} from "./autonomy-parts/types"
export { CHECK_CLASS, TRUST_PERMISSION } from "./autonomy-parts/types"
export { noRepositoryBetween, lockfileUnchanged, routine } from "./autonomy-parts/routine"
export { READ_SHELL_COMMANDS, READ_SHELL_ROLES, isReadOnlyShell, readRoleRefuses } from "./autonomy-parts/read-class"
export { personOnlyRoute, netOptions, callsOwnServer } from "./autonomy-parts/own-api"
export { shellReading, classifyBase, classify } from "./autonomy-parts/shell-steps"
export { outsideKind, spelling, searchedStateFolders, protectedOutside } from "./autonomy-parts/outside"
export { pushTarget, commandWords } from "./autonomy-parts/outward"
export type { CheckpointPlan, CheckpointInput } from "./autonomy-parts/checkpoint"
export { checkpointPlan } from "./autonomy-parts/checkpoint"
export { SUBAGENT_RUNS_LIKE_ROOT, subagentSendsAnyway } from "./autonomy-parts/subagent"
export { OUTPUT_FOLDERS, replacingTargets, destinationsOf, noWait } from "./autonomy-parts/destroys"
export {
  KEPT_D,
  HARD_SCRIPT_FLAGS,
  underConsent,
  OUTWARD_HELD,
  consentOutward,
  consentPushTarget,
  consentRefusedPush,
  consentPush,
} from "./autonomy-parts/consent"

export * as AutonomyTable from "./autonomy-table"
