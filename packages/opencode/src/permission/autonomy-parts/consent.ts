// Part of the autonomy table (R-1, 1.2.8): The consent layer: kept D classes, hard script flags, `underConsent`, outward and push consent.
// Moved unchanged from `autonomy-table.ts`, which re-exports the public names; import from there, not from here.
import { OutwardKnown } from "../outward-known"
import { OutwardConsent } from "../outward-consent"
import { BypassLists } from "../bypass-lists"
import { BypassScreen } from "../bypass-screen"
import { GitGuard } from "../../tool/git-guard"
import { Reach } from "../../tool/reach"
import { held, refused, type Input, type Verdict } from "./types"
import { editTargets, shellReading } from "./shell-steps"
import { within } from "./outside"
import { canRunIn, noRepositoryBetween } from "./routine"
/**
 * Categories the overlay never opens. The first four are the person's in 1.1.0 already (P5 A2a, A2c, rule 6); the rest are
 * what the overlay itself holds, so overlaying a step's answer a second time keeps it (S1.15). `sensitive_file` (1.1.1
 * D-F1-2): an edit, write or patch of a file that changes later runs or what is allowed, and a shell write (`tee`, `sed -i`,
 * a redirect) to one, stays the person's. The one list: the gate (`index.ts`) reads it to refuse a forged verdict.
 */
export const KEPT_D: ReadonlySet<string> = new Set([
  "outward",
  "outward_not_in_mission",
  "outside_folder",
  "script_unreadable",
  "outside_write_held",
  "system_service",
  "process_not_own",
  "unreadable_command",
  "sensitive_file",
])
/** The script-screen flags that keep a `script_flagged` call for a person under consent. The one list (D-F1-3), which
 * lives in `bypass-lists.ts` so the screen reads the same one; re-exported here for the gate (`index.ts`). */
export const HARD_SCRIPT_FLAGS = BypassLists.HARD_SCRIPT_FLAGS

/**
 * The permissions Swarm's own tools ask with (`src/tool/*`, the session's plan and spend prompts). A name missing here only
 * keeps a call at its 1.1.0 verdict, which P8 allows, so the list errs short rather than long.
 */
const BUILT_IN_PERMISSIONS: ReadonlySet<string> = new Set([
  "bash",
  "edit",
  "read",
  "glob",
  "grep",
  "lsp",
  "git",
  "webfetch",
  "websearch",
  "task",
  "question",
  "todowrite",
  "skill",
  "external_directory",
  "plan_enter",
  "plan_exit",
])

/** 1.1.1 F9: an MCP tool (it carries its source), a tool that says nothing about itself, or a name no Swarm tool asks with. */
function externalTool(input: Input, base: Verdict) {
  const mcp = input.metadata.mcp
  if (typeof mcp === "object" && mcp !== null) return true
  if (base.category === "external_tool" || base.category === "mcp_tool") return true
  return !BUILT_IN_PERMISSIONS.has(input.permission)
}

/**
 * An edit, write or patch with any target `Reach.sensitive` sees (a hook, a manifest, a config), judged as the edit is.
 * 1.1.1 F12b (S4-2): or a tool's configuration (`Reach.consentSensitive`): a compiler or test run the consent opens writes
 * where that file says.
 */
function editsSensitive(input: Input) {
  if (input.permission !== "edit") return false
  const instance = input.instance
  // Without Git the worktree is `/`, and every name would be judged from the top of the disk.
  const base = instance.worktree === "/" ? { ...instance, worktree: instance.directory } : instance
  return editTargets(input).some((file) => Reach.consentSensitive(file, base))
}

/**
 * S1.13 under decision P8: the bypass loosens and never tightens. A call that is A without consent stays A; the only
 * answers stricter than the 1.1.0 one are the irreversible list and admin rights, which are refused (X), and (1.1.1 F25,
 * decision P40) a shell call whose reading is incomplete, which is held. Everything a
 * person kept in 1.1.0 stays theirs, and what this cannot read it does not open. First match wins.
 */
export function underConsent(input: Input, base: Verdict): Verdict {
  // 1. A spend limit or a repeating call stops the run for a person, whatever was consented.
  if (base.class === "B") return base
  // 1b. 1.1.1 F9 (P15 G2-5, P16): a plugin or MCP tool, or any tool that is not Swarm's own, keeps its 1.1.0 verdict. The
  // table cannot see what such a tool does, so the consent never opens it.
  if (externalTool(input, base)) return base
  // 1c. 1.2.6 row 37b (U6): the shell checkpoints this call before it runs (A `checkpointed`), or no checkpoint can hold
  // what it changes (X `checkpoint_failed`). The screen's "nothing can undo it" is what the checkpoint answers.
  if (base.category === "checkpointed" || base.category === "checkpoint_failed") return base
  // 2. Nothing can undo it, or it asks for admin rights: refused by code before any agent sees it.
  const found = BypassScreen.screen(input)
  if (found.x === "irreversible" || found.x === "admin_rights") return refused(found.x)
  // 2b. 1.1.1 F30 (G12-7, P42): a push to a place that is no remote of the repository is refused, as P42 and the consent
  // dialog say. Decision D-F30-1: stricter than 1.1.0 (which held a push to a folder), by the person's own choice in P42.
  if (consentRefusedPush(input)) return refused("credential_change")
  // 3. A write outside the project waits for a person instead of being refused (P5 A2c); any other X stays X.
  if (base.class === "X") return base.category === "outside_write" ? held("outside_write_held") : base
  // 3b. 1.1.1 F25 (CR11-1, V11-1): a shell call whose reading the screen could not finish (more distinct `cd`s than are
  // judged) waits for a person, as it did when such a reading was unread: the consent never takes 1.1.0's A for it.
  if (base.class === "A" && input.permission === "bash" && shellReading(input.metadata.steps, input.instance)?.complete === false)
    return held("unreadable_command")
  // 4. P8: what ran without consent (a look, a ticked destination, a webfetch) runs as it did.
  if (base.class === "A") return base
  // 5. A deletion the shell cannot archive is never opened. 1.1.3 (T3): it does not wait either; the agent is told at once
  // to delete with a command of its own, which the shell moves to the archive.
  if (found.x === "delete_compound") return refused("delete_compound")
  // 6. What leaves the machine, a system service, a process Swarm did not start, text nobody can read: kept for a person.
  if (found.d) return base.class === "D" ? held(found.d) : base
  // 6a. 1.1.1 F26 (P42): a call that sends only where the person allowed (a local or named host, a remote the repository
  // had, a publish or deploy) is not kept for that reason; every check below still applies to it.
  const sends = OUTWARD_HELD.has(base.category ?? "") ? consentOutward(input) : undefined
  if (base.category !== undefined && KEPT_D.has(base.category) && sends === undefined) return base
  // 6b. An edit of a sensitive file keeps its 1.1.0 verdict, whatever category it carries (a P edit-not-ordinary included).
  if (editsSensitive(input)) return base
  // 7. What nothing could undo (a deletion or overwrite the shell could not archive, a label of `irreversible`) stays for
  // the person. Rule 9 would keep every such shell call too; this keeps it for any other tool as well.
  if (base.category === "not_reversible") return base
  // 7b. 1.1.1 F10a (G3-4): an edit nothing can undo keeps its 1.1.0 verdict. Rule 4 has already let through the one that
  // was A in 1.1.0 (an ordinary file inside the folder); any other (a file that is not ordinary) is not opened.
  if (input.permission === "edit" && (input.editClass === "no_undo" || !input.canUndo)) return base
  // 8. 1.1.1 F1b (P10, P11), kept as an extra check: a shell, inline code or an unscreened script, an alias, an unknown
  // program before a risky one, SQL from a file or stdin, anything the wide reader sees deleting or replacing, or a command
  // substitution with anything unknown in it: the 1.1.0 verdict stands.
  if (BypassScreen.unclear(input, base) !== undefined) return base
  // 9. 1.1.1 F7 (P15): a shell call is opened only when every step is a development command the allowlist recognises, in a
  // form it recognises, and the shell's own reading carries no label. Anything else keeps its 1.1.0 verdict. A flagged or
  // unflagged script never matches it, so neither does any form rule 7 of F1b used to judge.
  // 1.1.1 F12b (Perf P2, S4-2): the undo-snapshot question of every file the call writes is asked once, in one batch, after
  // the allowlist; a file outside the snapshot, or a tool's configuration, keeps the 1.1.0 verdict.
  if (input.permission === "bash" || input.permission === "external_directory") {
    // 1.1.1 F14 (G5-P2): a call the allowlist does not open keeps 1.1.0 whatever git says, so git is not asked.
    const allowed = Reach.deferSnapshot(
      () => BypassScreen.allowlisted(input, base),
      (value) => value === true,
    )
    if (!allowed.value || allowed.outside) return base
  }
  // 10. Anything else held or judged: the main agent decides it.
  if ((base.class !== "D" && base.class !== "P") || base.category === undefined) return base
  const destinations = sends ?? consentOutward(input)
  return {
    class: "A",
    decidedBy: "agent",
    category: "by_main_agent",
    bypassed: base.category,
    ...(destinations && { destination: destinations.join(", ") }),
  }
}

/** 1.1.1 F26 (P42): the held categories a send carries in 1.1.0, which the consent may open (`consentOutward`). */
export const OUTWARD_HELD: ReadonlySet<string> = new Set(["outward", "outward_not_in_mission"])

/**
 * 1.1.1 F26 (P42): where a call the consent may let out sends, step by step in order, or undefined when it sends nowhere
 * P42 opens or any send in it is held. The gate asks it again on a verdict that opened an outward category (S1.36).
 */
export function consentOutward(input: Input): string[] | undefined {
  if (input.permission === "webfetch") {
    const found = OutwardConsent.fetch(input.metadata.url, input.patterns, input.outward)
    return "held" in found ? undefined : found.destinations
  }
  if (input.permission !== "bash") return undefined
  return BypassScreen.outwardOpened(input)
}

/**
 * 1.1.1 F26 (P42): the repository and remote of every `git push` step of a call, when they are one: a push without force
 * (`OutwardConsent.pushWords`) in a folder of a repository the consent snapshot knew, with no other repository between, to
 * a remote it named, or with none named to its only remote. The gate runs `OutwardKnown.recheck` on this.
 */
export function consentPushTarget(
  input: Pick<Input, "metadata" | "cwd">,
  snapshot: OutwardKnown.Snapshot,
  // 1.1.1 F29 (P44): with the project, the pushes inside the project scripts the call runs by name count as its own.
  instance?: Input["instance"],
) {
  const own = BypassScreen.readSteps(input) ?? []
  // 1.1.1 F30 (G12-P3): only a script whose manifest says `push` is expanded.
  const steps = instance
    ? own.flatMap((step) => [
        step,
        ...step.cwds.flatMap((cwd) =>
          BypassScreen.scriptMayPush(step.argv, cwd, instance) ? BypassScreen.scriptSteps(step.argv, cwd, instance) : [],
        ),
      ])
    : own
  let target: { repo: string; remote: string } | undefined
  for (const step of steps) {
    if (step.argv[0] !== "git" || step.argv[1] !== "push") continue
    for (const cwd of step.cwds) {
      const found = pushAt(step.argv, cwd, snapshot)
      if (!found || (target && (target.repo !== found.repo || target.remote !== found.remote))) return undefined
      target = found
    }
  }
  return target
}

function pushAt(argv: readonly string[], cwd: string, snapshot: OutwardKnown.Snapshot) {
  const named = OutwardConsent.pushWords(argv)
  if (named === undefined) return undefined
  const here = Reach.real(cwd)
  if (here === undefined) return undefined
  const repo = snapshot.repos.filter((item) => within(item.dir, here)).toSorted((a, b) => b.dir.length - a.dir.length)[0]
  if (!repo || !noRepositoryBetween(here, repo.dir)) return undefined
  const remote = named === "" ? (repo.remotes.length === 1 ? repo.remotes[0]!.name : undefined) : named
  if (!remote || !repo.remotes.some((item) => item.name === remote)) return undefined
  return { repo: repo.dir, remote }
}

/**
 * 1.1.1 F30 (G12-7, P42): under consent, a `git push` of the call, or of a project script it runs by name, whose repository
 * word is a place (a URL, `host:path`, a path to a folder) or a name the consent snapshot's repository for that folder
 * has no remote of. Without a snapshot only a place counts.
 */
export function consentRefusedPush(input: Input): boolean {
  if (input.permission !== "bash" || typeof input.metadata.command !== "string") return false
  const own = BypassScreen.readSteps(input) ?? []
  const steps = own.flatMap((step) => [step, ...step.cwds.flatMap((cwd) => BypassScreen.scriptSteps(step.argv, cwd, input.instance))])
  const snapshot = input.outward?.snapshot
  return steps.some((step) => {
    const words = OutwardConsent.pushRepositories(step.argv)
    if (!words) return false
    return words.some((word) => {
      if (OutwardConsent.pushPlace(word)) return true
      if (!snapshot) return false
      return step.cwds.some((cwd) => {
        const here = Reach.real(cwd)
        if (here === undefined) return false
        const repo = snapshot.repos.filter((item) => within(item.dir, here)).toSorted((a, b) => b.dir.length - a.dir.length)[0]
        return repo !== undefined && noRepositoryBetween(here, repo.dir) && !repo.remotes.some((remote) => remote.name === word)
      })
    })
  })
}

/**
 * 1.1.1 F26 (P42): one `git push` step the consent lets out: to a remote the snapshot knew (`pushAt`), whose recheck just
 * now found the same push URLs (a missing `gh` login is no reason to hold it: git uses its own credentials), in a
 * repository the guard vouches for, run in a folder a command may run in. undefined: not a push.
 */
export function consentPush(argv: readonly string[], cwd: string, input: Pick<Input, "outward" | "instance">): OutwardConsent.Reading | undefined {
  if (argv[0] !== "git" || argv[1] !== "push") return undefined
  const snapshot = input.outward?.snapshot
  const target = snapshot && canRunIn(cwd, input.instance) ? pushAt(argv, cwd, snapshot) : undefined
  if (!target || GitGuard.inspect(target.repo).refused !== undefined) return { held: "form" }
  const check = input.outward?.recheck
  if (!check || check.repo !== target.repo || check.remote !== target.remote) return { held: "form" }
  if (!check.result.ok && check.result.reason !== "no_credential") return { held: "form" }
  return { destinations: [target.remote], outputs: [] }
}
