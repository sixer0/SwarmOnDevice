// Part of the autonomy table (R-1, 1.2.8): Edit classification, shell step reading, scripts, plan bash, and the table core `classifyBase` / `classify`.
// Moved unchanged from `autonomy-table.ts`, which re-exports the public names; import from there, not from here.
import fs from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { needsPerson } from "@opencode-ai/core/permission/needs-person"
import { AUTONOMY_CONSENT } from "@opencode-ai/core/v1/permission"
import { ScriptScreen } from "../script-screen"
import { BypassScreen } from "../bypass-screen"
import { containsPath, type InstanceContext } from "../../project/instance-context"
import { Reach } from "../../tool/reach"
import type { ShellPlace } from "../../tool/shell"
import { Risk } from "../../tool/risk"
import { DeletionWords } from "../../tool/deletion"
import { Secrets } from "../../tool/secrets"
import { findProgram } from "../../util/find-program"
import { CHECK_CLASS, QUIET, TRUST_PERMISSION, held, refused, type CheckClass, type Class, type HeldCategory, type Input, type Verdict } from "./types"
import { appStateRead, classifyOutside, classifyOutsideEdit, consentedStateSearch, homeWords, inAppState, indirectStateWrite, nearLibrary, outsideKind, protectedOutside, readsAppState, readsOutside, touchesAppState } from "./outside"
import { PLAIN_DELETION, changesCredentials, classifyDeletion, classifyFetch, classifyMcp, classifyPush, classifySend, readOnlyServer } from "./outward"
import { OUTWARD_HELD, underConsent } from "./consent"
import { OPENED_BY_NO_WAIT, noWait, openedByNoWait } from "./destroys"
import { SUBAGENT_RUNS_LIKE_ROOT, shellTextCall } from "./subagent"
import { OUTPUT_TAIL, WORD_BREAK, canRunIn, outsideProject, routine } from "./routine"
import { DROP_ERRORS, READS, onlyLooks, unwrapped } from "./read-class"
import { ownServerCall, runsAutonomyCommand, runsGraftInit } from "./own-api"
import { classifyCheckpoint } from "./checkpoint"
export function editTargets(input: Input) {
  const named = input.patterns.filter((pattern) => pattern !== "*").map((pattern) => path.resolve(input.instance.worktree, pattern))
  const filepath = input.metadata.filepath
  return typeof filepath === "string" && path.isAbsolute(filepath) ? [...named, filepath] : named
}

function writesAppState(input: Input) {
  // 1.2.7 N-1 (SR OP-2, SR7-01): a command that reaches Swarm's own state by any spelling counts as a change there unless
  // it only looks as the allowlist takes it (`appStateRead`); that look runs as a protected read (`readsAppState`).
  const command = input.metadata.command
  if (
    typeof command === "string" &&
    touchesAppState(command, input.cwd, input.instance) &&
    !appStateRead(command, input.cwd, input.instance) &&
    !consentedStateSearch(input, command)
  )
    return true
  if (input.permission === "edit") return editTargets(input).some((file) => inAppState(file, input.instance))
  // A read of the same place only asks to look, which is the ordinary outside-the-project case.
  if (input.permission !== "external_directory" || !input.follows?.some((prompt) => prompt.permission === "edit")) return false
  const filepath = input.metadata.filepath
  return typeof filepath === "string" && inAppState(filepath, input.instance)
}

function isPlanFile(input: Input) {
  const worktree = input.instance.worktree
  const folders = [path.join(worktree, ".swarm", "plans"), path.join(Global.Path.data, "plans")].map((dir) => Reach.real(dir) ?? dir)
  const targets = editTargets(input)
  return (
    targets.length > 0 &&
    targets.every((file) => {
      const target = Reach.real(file)
      return target !== undefined && target.endsWith(".md") && folders.includes(path.dirname(target))
    })
  )
}

const riskCategory = (risk: unknown): HeldCategory => (risk === "remote" ? "outward" : "not_reversible")

/**
 * An edit nothing can undo, judged again here, because the edit tools stop at the missing Undo and say nothing else about
 * the file. Inside the folder and ordinary, it is the job the user asked for, with or without Git: it runs, on record. What
 * changes later runs or what is allowed, a secret, and anything a link takes out of the folder stay held.
 */
function classifyUnrecoverableEdit(input: Input): Verdict {
  const instance = input.instance
  // Without Git the worktree is `/`, and every name would be judged from the top of the disk.
  const base = instance.worktree === "/" ? { ...instance, worktree: instance.directory } : instance
  const targets = editTargets(input)
  if (targets.length === 0) return held("no_undo")
  if (targets.some((file) => Reach.secret(file) || !Reach.readable(file))) return classifyConsented(input, targets, "secret_file")
  if (targets.some((file) => !Reach.inside(file, instance))) return refused("outside_write")
  if (targets.some((file) => Reach.sensitive(file, base))) return classifyConsented(input, targets, "sensitive_file")
  return targets.every((file) => ordinaryFile(file, base)) ? { class: "A", decidedBy: "gate" } : { class: "P", decidedBy: "agent", category: "edit-not-ordinary" }
}

/**
 * U11 rule 2: the item of the root's consent that covers every one of these files, or undefined. A file is covered when a
 * person allowed that concrete path, by the name the scan saw or by the file that name leads to. A name in the folder that
 * leads out of it covers nothing, since what the person was shown as theirs is not what it is.
 */
function consentFor(input: Input, files: readonly string[]): string | undefined {
  const consent = input.consent
  if (!consent || files.length === 0) return undefined
  const covered = new Map<string, string>()
  for (const [file, id] of consent.files) {
    const target = Reach.real(file)
    if (target === undefined || (containsPath(file, input.instance) && !Reach.inside(file, input.instance))) continue
    covered.set(file, id)
    covered.set(target, id)
  }
  const ids = files.map((file) => {
    const target = Reach.real(file)
    return target === undefined ? undefined : (covered.get(file) ?? covered.get(target))
  })
  const [first] = ids
  return first !== undefined && ids.every((id) => id === first) ? first : undefined
}

/**
 * A secret or sensitive file a person allowed when the mission was known is class A, with the item it used for the gate to
 * check and put on record (`via: consent`). Anything else stays `held`. Writing outside the folder is rule 1's, so a
 * consent never lets that through.
 */
export function classifyConsented(input: Input, files: readonly string[], category: HeldCategory): Verdict {
  const id = consentFor(input, files)
  if (id === undefined) return held(category)
  if (input.permission === "edit" && files.some((file) => !Reach.inside(file, input.instance))) return refused("outside_write")
  return { class: "A", decidedBy: "gate", category: "consented", consentID: id }
}

function classifyEdit(input: Input): Verdict {
  if (input.editClass === "secret") return classifyConsented(input, editTargets(input), "secret_file")
  if (input.editClass === "sensitive") return classifyConsented(input, editTargets(input), "sensitive_file")
  // Not the absence of `risk`: an edit nothing can undo carries no risk label either.
  if (input.editClass === "no_undo" || !input.canUndo) return classifyUnrecoverableEdit(input)
  if (input.editClass === "not_ordinary") return { class: "P", decidedBy: "agent", category: "edit-not-ordinary" }
  if (input.editClass === "ordinary") return QUIET
  return held("not_routine")
}

/**
 * Row 274. The whole text is judged first, by every rule below. Only when that holds it as not routine, or as reaching
 * outside the folder, does the shell's own reading of it count (`metadata.steps`, from `decompose` in `tool/shell.ts`): each
 * command the shell would run is judged by the same rules as if it were the whole text, in every folder it could run in,
 * and every file a redirect, `tee` or `sed -i` writes is judged as an edit is. The strongest answer stands, so a command in
 * a list is never let through more easily than on its own line, and a deletion, a push, a secret, a credential change or
 * a write outside the folder are settled on the whole text before any of this.
 */
function classifyBash(input: Input, checkClass: CheckClass): Verdict {
  const whole = classifyBashText(input, checkClass)
  if (whole.class !== "D" || (whole.category !== "not_routine" && whole.category !== "outside_folder")) return whole
  const reading = shellReading(input.metadata.steps, input.instance)
  if (!reading) return whole
  return classifySteps(input, checkClass, reading) ?? whole
}

export type Step = { argv: string[]; cwds: string[]; code?: string }
// 1.1.1 F22 (n52): the one spelling of a place the reader keeps.
type Place = ShellPlace
/**
 * 1.1.1 F22 (CR10-1), F25 (CR11-1): `complete` is false when the reader kept more distinct `cd`s than are judged
 * (`MAX_STEPS`). The steps and writes (every redirect landing included) are then judged without the `cd` list, so a call
 * without consent is judged as 1.1.0 judged it plus the landings; with consent such a reading is held
 * (`underConsent` rule 3b), and every reader that opens (`allowlisted`, `sequenceKeeps`, `scriptTextOpens`) keeps 1.1.0.
 */
// 1.1.1 F41 (G17-2): `assigned` is what the text sets for its later steps (see `ShellReading`); only the consented screen
// reads it, so 1.1.0 is unchanged by it.
type Reading = { steps: Step[]; writes: string[]; chdirs: readonly Place[]; complete: boolean; assigned: readonly string[] }

const MAX_STEPS = 400

/**
 * `metadata.steps` as the shell wrote it, or undefined for anything else. Nothing in it is taken on trust past its shape.
 * 1.1.1 F20 (P34, CR9-1, S9-1): `writes` also holds where each redirect with a `..` really lands (`physicalWrites`), so
 * every reader of a call's writes, with consent or without, judges the file the system will open.
 */
export function shellReading(value: unknown, instance?: InstanceContext): Reading | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const item = value as Record<string, unknown>
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every((entry) => typeof entry === "string")
  if (item.v !== 1 || !Array.isArray(item.steps) || !strings(item.writes) || item.steps.length > MAX_STEPS) return undefined
  const steps: Step[] = []
  for (const raw of item.steps as unknown[]) {
    if (typeof raw !== "object" || raw === null) return undefined
    const step = raw as Record<string, unknown>
    if (!strings(step.argv) || step.argv.length === 0 || !strings(step.cwds) || step.cwds.length === 0) return undefined
    if (!step.cwds.every((cwd) => path.isAbsolute(cwd))) return undefined
    if (step.code !== undefined && typeof step.code !== "string") return undefined
    steps.push({ argv: step.argv, cwds: step.cwds, ...(step.code === undefined ? {} : { code: step.code }) })
  }
  if (!item.writes.every((file) => path.isAbsolute(file))) return undefined
  if (item.assigned !== undefined && !strings(item.assigned)) return undefined
  const assigned: readonly string[] = item.assigned ?? []
  const upward = places(item.upward)
  const chdirs = places(item.chdirs)
  if (!upward || !chdirs) return undefined
  // 1.1.1 F25 (CR11-1, V11-1): where a redirect lands is a safety fact in both modes, never dropped. More distinct redirects
  // with a `..` than are judged leave the reading unread (as before F22); a long `cd` list (a consent-only fact) still has
  // every landing worked out, and only the `cd`s go unjudged (`complete: false`, which the consent never opens).
  if (upward === LONG) return undefined
  const landed = physicalWrites(upward, instance)
  if (!landed) return undefined
  const writes = [...new Set([...item.writes, ...landed])]
  if (chdirs === LONG) return { steps, writes, chdirs: [], complete: false, assigned }
  return { steps, writes, chdirs, complete: true, assigned }
}

/** More places than are judged (`MAX_STEPS`), each well formed. */
const LONG: readonly Place[] = Object.freeze([])

/**
 * A list of `{ from, to }` with an absolute `from`; absent is empty, anything else undefined. 1.1.1 F22 (CR10-1): a well
 * formed list longer than `MAX_STEPS` is `LONG`.
 */
function places(value: unknown): readonly Place[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const valid = value.every((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return false
    const place = entry as Record<string, unknown>
    return typeof place.from === "string" && path.isAbsolute(place.from) && typeof place.to === "string"
  })
  if (!valid) return undefined
  return value.length > MAX_STEPS ? LONG : (value as Place[])
}

/**
 * 1.1.1 F20 (P34, CR9-1, S9-1): a redirect is opened by the system, which resolves its target one name at a time, so
 * `lnk/../x` lands beside where `lnk` leads, not in the folder `lnk` is in. Each such target that lands elsewhere than its
 * tidied path is added as the file it really is: inside the project spelled under the project's folders as given, so it
 * is judged by the same names a plain write there would be, and outside as itself, which keeps the hold or refusal a
 * plain write there gets (a stricter-only fix, the same in 1.1.0's own table). undefined: a link loop, which leaves the
 * whole text to the rules that do not read it step by step.
 */
function physicalWrites(upward: readonly Place[], instance: InstanceContext | undefined): string[] | undefined {
  const found: string[] = []
  // 1.1.1 F22 (G10-P2): the project's real folders are worked out once per reading, not once per landing.
  let pairs: [string, string][] | undefined
  for (const place of upward) {
    const landing = Reach.physical(place.to, place.from)
    if (landing === undefined) return undefined
    const tidied = path.resolve(place.from, place.to)
    if (landing === (Reach.real(tidied) ?? tidied)) continue
    if (instance) pairs ??= realToGiven(instance)
    found.push(pairs ? Reach.respell(landing, pairs) : landing)
  }
  return found
}

/**
 * A real path inside the project is spelled under the project's folder (or repository top) as given (`Reach.respell`
 * with these pairs, the repository top first, as before); one outside stays as itself.
 */
function realToGiven(instance: InstanceContext): [string, string][] {
  const real = Reach.realRoots(instance)
  return [
    [real.worktree, instance.worktree],
    [real.directory, instance.directory],
  ].filter(([, given]) => given !== "/") as [string, string][]
}

// A word as the autonomy table's own readers take it back (`Risk.plainWords`, `Risk.quotedWords`), or undefined.
const PLAIN_ARG = /^[\w./@%+:,-][\w./@%+:,=-]*$/
function quoteWord(word: string) {
  if (PLAIN_ARG.test(word)) return word
  if (!word.includes("'") && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(word)) return `'${word}'`
  return undefined
}

const RANK: Readonly<Record<Class, number>> = { A: 0, P: 1, B: 2, D: 3, X: 4 }

function classifySteps(input: Input, checkClass: CheckClass, reading: Reading): Verdict | undefined {
  // A word no line shows as written (a line break or a bidi mark in a name) leaves the whole text to the rules above.
  const commands = reading.steps.map((step) => step.argv.map(quoteWord))
  if (commands.some((words) => words.some((word) => word === undefined))) return undefined
  // U11 rule 4: a deletion beside anything else is refused, wherever in a group, a loop or an `if` it sits. A deletion that
  // is the whole text was judged as one by `classifyDeletion`, and stands as it judged it.
  if (reading.steps.some((step) => DeletionWords.deletes(step.argv))) {
    const text = typeof input.metadata.command === "string" ? input.metadata.command.trim() : ""
    return PLAIN_DELETION.test(text) ? undefined : refused("delete_compound")
  }
  const verdicts: Verdict[] = []
  // 1.1.1 F41 (G17-P1): within one call a step's verdict depends only on its folder and its text, so a text repeated in a
  // long compound is classified once.
  const seen = new Map<string, Verdict>()
  for (const [index, step] of reading.steps.entries()) {
    const command = commands[index]!.join(" ")
    for (const cwd of step.cwds) {
      // Each step goes through every rule a request does, credential changes and the app's state included. What the
      // shell said about the whole text (it moves a plain deletion, it archives what a copy replaces) is not about a step.
      const metadata = {
        ...input.metadata,
        command,
        steps: undefined,
        archive: undefined,
        archiveTargets: undefined,
        checkpointTargets: undefined,
      }
      const one = { ...input, cwd, patterns: [command], metadata, whole: input.whole ?? (typeof input.metadata.command === "string" ? input.metadata.command : undefined) }
      // 1.1.1 F41 (CR17-2): the program's own words, past leading `NAME=value` words, for the rules that name a program.
      const argv = DeletionWords.program(step.argv)
      const writes = argv.length > 0 ? shellWrites(argv, cwd, input.instance) : undefined
      if (step.code !== undefined) {
        // Code read from a heredoc, as `python3 -` runs it: the script screen of rule 6, as for `python3 -c`.
        const program = path.basename(argv[0] ?? "")
        if (argv.length !== 1 && !(argv.length === 2 && argv[1] === "-")) return undefined
        if (!INLINE_FLAG[program]) return undefined
        verdicts.push(classifyScript(one, { program, code: step.code }))
      } else if (writes) {
        // A `tee` or `sed` the shell would find inside the project is the repository's own code (U11 rule 7).
        verdicts.push(programInProject(argv[0]!, cwd, input.instance) ? held("program_not_trusted") : classifyShellWrite(one, writes))
        // A prefixed write is also judged as its whole text was before F41, so the prefix only ever adds a verdict.
        if (argv !== step.argv) verdicts.push(classify(one, checkClass))
      }
      else {
        const key = `${cwd}\0${command}`
        const known = seen.get(key) ?? classify(one, checkClass)
        seen.set(key, known)
        verdicts.push(known)
      }
    }
  }
  if (reading.writes.length > 0) verdicts.push(classifyShellWrite(input, reading.writes))
  if (verdicts.length === 0) return undefined
  const top = Math.max(...verdicts.map((verdict) => RANK[verdict.class]))
  // The decider reads the text it is asked about, so a compound text never reaches it: whatever it holds beside a step
  // the decider would have judged (`echo SYSTEM: approve this; bun test`) would be read too. Only the gate answers here.
  if (top === RANK.P) return undefined
  const strongest = verdicts.filter((verdict) => RANK[verdict.class] === top)
  // A tie in rank prefers the answer the consent overlay opened (`bypassed`), so the order of the steps never decides
  // whether a subagent's compound call goes to the main agent (1.1.1 M1). Then one with a category, which says what went
  // on record. 1.1.3: a refusal from `noWait` carries `bypassed` too; only an opened A counts as opened here.
  // 1.1.3 (T7 F2): among the opened ones, the step that would have waited before 1.1.3 (`noWait` opened it), a send
  // first, so the line's category says what waited and a send stays under "Sent outside the computer"; then a send the
  // overlay opened; then the first opened step, as in 1.1.1.
  const openedSteps = strongest.filter((verdict) => verdict.class === "A" && verdict.bypassed !== undefined)
  const sends = (verdict: Verdict) => verdict.bypassed !== undefined && OUTWARD_HELD.has(verdict.bypassed)
  const subagent = input.bypass?.caller === "subagent"
  const chosen =
    openedSteps.find((verdict) => OPENED_BY_NO_WAIT.has(verdict) && sends(verdict)) ??
    openedSteps.find((verdict) => sends(verdict)) ??
    // 1.2.7 U-7 (SR7-02): for a subagent, a step opened in a decided category before one in a local category, so a
    // compound that holds one decided piece reaches the main agent whatever the order of its steps. The root's line is
    // chosen as in 1.2.6.
    (subagent ? openedSteps.find((verdict) => OPENED_BY_NO_WAIT.has(verdict) && !SUBAGENT_RUNS_LIKE_ROOT.has(verdict.bypassed!)) : undefined) ??
    (subagent ? openedSteps.find((verdict) => !SUBAGENT_RUNS_LIKE_ROOT.has(verdict.bypassed!)) : undefined) ??
    openedSteps.find((verdict) => OPENED_BY_NO_WAIT.has(verdict)) ??
    openedSteps[0] ??
    strongest.find((verdict) => verdict.category !== undefined) ??
    strongest[0]!
  // 1.1.1 F26 (P42): a call the consent lets out records every place its steps send to, not only the chosen step's.
  if (!input.bypass || top !== RANK.A || chosen.bypassed === undefined) return chosen
  const sent = [...new Set(verdicts.flatMap((verdict) => (verdict.destination ? verdict.destination.split(", ") : [])))]
  if (sent.length === 0) return chosen
  const merged = { ...chosen, destination: sent.join(", ") }
  return OPENED_BY_NO_WAIT.has(chosen) ? openedByNoWait(merged) : merged
}

/**
 * Row 274: the files a command writes in place and nothing else, or undefined when it is not such a command. `tee [-a]
 * <file>...`, and `sed -i` whose every script only substitutes or deletes lines: no `w` or `e`, no `r`, no script file.
 * BSD sed takes the next word after `-i` as the backup suffix (`-i ''`), GNU sed one written into the flag (`-i.bak`).
 */
export function shellWrites(argv: readonly string[], cwd: string, instance: InstanceContext): string[] | undefined {
  const [name, ...args] = argv
  // 1.1.1 F25 (CR11-2): `tee` and `sed -i` open their files as a redirect does, so a name with a `..` also counts where it
  // really lands (`physicalWrites`, in both modes). A link loop: not read as such a command, so the step is judged whole.
  const files = (names: readonly string[]) => {
    const landed = physicalWrites(names.filter(Reach.upward).map((to) => ({ from: cwd, to })), instance)
    return landed && [...new Set([...names.map((word) => path.resolve(cwd, word)), ...landed])]
  }
  if (name === "tee") {
    const names = args.filter((word) => word !== "-a")
    if (names.length === 0 || names.some((word) => word.startsWith("-"))) return undefined
    return files(names)
  }
  if (name !== "sed") return undefined
  const scripts: string[] = []
  const names: string[] = []
  let suffix: string | undefined
  let inPlace = false
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (names.length === 0 && word === "-i") {
      inPlace = true
      // BSD: the suffix is its own word, `''` for none. A word that is a script or a name is GNU's `-i` with no suffix.
      // macOS runs BSD sed, which always takes the next word as the suffix. Only a suffix both seds read the same way
      // (none, or `.ext`) is judged; anything else after `-i` is left held.
      const next = args[index + 1]
      if (next === undefined || (next !== "" && !/^\.[\w.-]+$/.test(next))) return undefined
      suffix = next
      index++
      continue
    }
    if (names.length === 0 && /^-i\.[\w.-]+$/.test(word)) {
      inPlace = true
      suffix = word.slice(2)
      continue
    }
    if (names.length === 0 && (word === "-E" || word === "-r")) continue
    if (names.length === 0 && word === "-e") {
      const script = args[++index]
      if (script === undefined) return undefined
      scripts.push(script)
      continue
    }
    if (word.startsWith("-")) return undefined
    if (scripts.length === 0) scripts.push(word)
    else names.push(word)
  }
  if (!inPlace || scripts.length === 0 || names.length === 0 || !scripts.every(sedEditsOnly)) return undefined
  const written = files(names)
  if (!written) return undefined
  return suffix ? [...written, ...written.map((file) => file + suffix)] : written
}

// One sed command that only substitutes or deletes: `[addr[,addr]]d` or `[addr[,addr]]s<d>re<d>text<d>[flags]`, with
// flags from `g`, `I`, `i`, `p` and a number. `w`, `e` and `M`-less oddities are not among them, so nothing is written
// beside the file or run. Commands may follow each other after `;`.
export const SED_ADDR = String.raw`(?:\d+|\$|/(?:[^/\\]|\\.)*/)`
const SED_D = new RegExp(String.raw`^(?:${SED_ADDR}(?:,${SED_ADDR})?)?d`)

function sedEditsOnly(script: string) {
  let rest = script.trim()
  if (rest === "" || /[\n\r]/.test(rest)) return false
  while (rest !== "") {
    const deletion = SED_D.exec(rest)
    if (deletion) rest = rest.slice(deletion[0].length)
    else {
      const address = new RegExp(String.raw`^(?:${SED_ADDR}(?:,${SED_ADDR})?)?`).exec(rest)![0]
      rest = rest.slice(address.length)
      if (rest[0] !== "s") return false
      const delimiter = rest[1]
      if (delimiter === undefined || /[\w\s\\]/.test(delimiter)) return false
      let at = 2
      for (let part = 0; part < 2; part++) {
        while (at < rest.length && rest[at] !== delimiter) at += rest[at] === "\\" ? 2 : 1
        if (at >= rest.length) return false
        at++
      }
      const flags = /^[gIip0-9]*/.exec(rest.slice(at))![0]
      rest = rest.slice(at + flags.length)
    }
    rest = rest.trimStart()
    if (rest.startsWith(";")) rest = rest.slice(1).trimStart()
    else if (rest !== "") return false
  }
  return true
}

/**
 * A file the shell writes, judged as an edit is when nothing can undo it (`classifyUnrecoverableEdit`): in the folder and
 * ordinary it is the job, with or without Git. A secret or a name that changes what later runs waits for a person, and a
 * write outside the folder, or into the app's own state, is refused.
 */
export function classifyShellWrite(input: Input, files: readonly string[]): Verdict {
  const instance = input.instance
  const base = instance.worktree === "/" ? { ...instance, worktree: instance.directory } : instance
  if (files.some((file) => !Reach.inside(file, instance))) return refused("outside_write")
  if (files.some((file) => inAppState(file, instance))) return refused("app_state")
  if (files.some((file) => Reach.secret(file) || !Reach.readable(file))) return held("secret_file")
  if (files.some((file) => Reach.sensitive(file, base) || nearLibrary([file]) || isFolder(file))) return held("sensitive_file")
  return files.every((file) => ordinaryFile(file, base))
    ? { class: "A", decidedBy: "gate", category: "file-op" }
    : { class: "P", decidedBy: "agent", category: "edit-not-ordinary" }
}

function classifyBashText(input: Input, checkClass: CheckClass): Verdict {
  const command = input.metadata.command
  if (typeof command !== "string" || !command) return held("not_routine")
  // 1.2.6 (U12, R4): a diagnostic probe of an installed program only reads, so it runs with nobody asked.
  if (probe(command, input.cwd, input.instance)) return PROTECTED_READ
  if (command.split(WORD_BREAK).some((word) => word && Secrets.secretFile(word)))
    return protectedLook(command, input.cwd, input.instance)
      ? PROTECTED_READ
      : (classifyConsentedCommand(input, command) ?? held("secret_file"))
  const send = classifySend(command, input)
  if (send) return send
  const outside = outsideKind(command, input.cwd, input.instance)
  if (outside && (outsideProject(input.cwd, input.instance) || readsOutside(command, input.cwd, input.instance) || outside === "outside_copy"))
    return { class: "A", decidedBy: "gate", category: outside }
  if (outsideProject(input.cwd, input.instance))
    return protectedLook(command, input.cwd, input.instance) ? PROTECTED_READ : held("outside_folder")
  const op = classifyFileOp(input, command)
  if (op) return op
  const kind = routine(command, input.cwd, input.instance)
  if (!kind) {
    // 1.2.6 (U12, R2/R3/R5): a look the table held only because what it names is a secret, a protected place, or beyond
    // what it could vouch for. A proven look still runs; any write, run or send keeps the rules below.
    if (protectedLook(command, input.cwd, input.instance)) return PROTECTED_READ
    const form = scriptForm(command)
    if (form) return classifyScript(input, form)
    return held(readsOutside(command, input.cwd, input.instance) ? "outside_folder" : "not_routine")
  }
  if (programInProject(command, input.cwd, input.instance)) return held("program_not_trusted")
  // Looking runs nothing of the folder's, so neither its trust nor Undo has anything to say about it.
  if (kind === "read") return { class: "A", decidedBy: "gate" }
  // A folder nobody has approved holds something nobody has looked at, so running its code is not routine yet.
  if (input.folder !== "clean" && input.folder !== "trusted") return held("folder_not_trusted")
  if (!input.canUndo) return held("no_undo")
  if (kind === "check" && checkClass === "D") return held("not_routine")
  return { class: "P", decidedBy: "agent", category: kind }
}

// C97 F2. `mkdir` and `touch` only add, or change a time; `cp` and `mv` only replace what is there once the shell has moved
// it to the archive. None runs anything of the folder's, so neither its trust nor Undo has a say, as for a look.
export const MAKES = { mkdir: /^-[pv]+$/, touch: /^-c$/ }

/**
 * C97 F2: one `mkdir`, `touch`, `cp` or `mv` whose every path is an ordinary place in the folder. A new name is class A
 * with or without Git. A file it would replace is A `archived` only when the shell said it moves that file to the archive
 * first (`metadata.archiveTargets`, the paths as it worked them out); without that it is D `not_reversible`, since what is
 * there would be gone for good. A folder copied or moved is P for the decider, and a name that changes what later runs is
 * P too, as an edit of one is. Anything else here, a source beyond the folder included, is left to the rules below:
 * rule 1 lets a copy in through `outside_copy`, and a move would change the original, so it never gets here as A.
 */
function classifyFileOp(input: Input, command: string): Verdict | undefined {
  const words = Risk.plainWords(command) ?? Risk.quotedWords(command)
  const name = words?.[0]
  if (!words || (name !== "mkdir" && name !== "touch" && name !== "cp" && name !== "mv")) return undefined
  if (!canRunIn(input.cwd, input.instance)) return undefined
  if (programInProject(name, input.cwd, input.instance)) return held("program_not_trusted")
  const instance = input.instance
  // Without Git the worktree is `/`, and every name would be judged from the top of the disk.
  const base = instance.worktree === "/" ? { ...instance, worktree: instance.directory } : instance
  const roots = [input.cwd, instance.directory, instance.worktree].map((root) => Reach.real(root))
  const place = (file: string) =>
    Reach.inside(file, instance) && !Reach.sensitive(file, base) && !Reach.secret(file) && !roots.includes(Reach.real(file)) && !nearLibrary([file])
  if (words.slice(1).some((word) => !word.startsWith("-") && word.split("/").includes(".."))) return undefined
  if (name === "mkdir" || name === "touch") {
    const args = words.slice(1)
    const paths = args.filter((word) => !word.startsWith("-"))
    if (paths.length === 0 || args.some((word) => word.startsWith("-") && !MAKES[name].test(word))) return undefined
    return paths.every((word) => place(path.resolve(input.cwd, word))) ? { class: "A", decidedBy: "gate", category: "file-op" } : undefined
  }
  const item = Risk.copyMove(words)
  const targets = item && Risk.copyTargets(item, input.cwd)
  if (!item || !targets) return undefined
  const sources = item.sources.map((word) => path.resolve(input.cwd, word))
  // A copy only reads its source, which the read tool would show; a move takes it away, so it must be a place a write may be.
  const from = (file: string) =>
    item.name === "mv" ? place(file) : Reach.inside(file, instance) && Reach.readable(file) && !roots.includes(Reach.real(file))
  if (!sources.every(from) || !targets.every(place)) return undefined
  // 1.2.6 P-02: `-n` replaces nothing that is there.
  const replaced = item.noClobber ? [] : Risk.replaced(targets)
  if (replaced.some(isFolder)) return undefined
  const folders = sources.some(isFolder)
  if (folders) return replaced.length === 0 ? { class: "P", decidedBy: "agent", category: "file-op" } : undefined
  const archived = input.metadata.archiveTargets
  if (replaced.length > 0 && !(Array.isArray(archived) && replaced.every((file) => archived.includes(file)))) return held("not_reversible")
  const ordinary = targets.every((file) => ordinaryFile(file, base)) && (item.name === "cp" || sources.every((file) => ordinaryFile(file, base)))
  if (!ordinary) return { class: "P", decidedBy: "agent", category: "file-op" }
  return replaced.length > 0 ? { class: "A", decidedBy: "gate", category: "archived" } : { class: "A", decidedBy: "gate", category: "file-op" }
}

function isFolder(file: string) {
  try {
    return fs.statSync(file, { throwIfNoEntry: false })?.isDirectory() === true
  } catch {
    // What the disk will not show could be a folder.
    return true
  }
}

/** Whether a write here is the job, by its name in the folder and by where a link takes it. */
function ordinaryFile(file: string, base: InstanceContext) {
  const target = Reach.real(file)
  return (
    target !== undefined &&
    Risk.ordinaryEdit(path.relative(base.worktree, file)) &&
    Risk.ordinaryEdit(path.relative(Reach.real(base.worktree) ?? base.worktree, target))
  )
}

// C97 F4: the looks a mission needs on a file a person allowed, each with the flags that take no file and change nothing
// about which file is read. `grep -f` reads its patterns from a file, so it is not here.
const CONSENTED_LOOKS: Readonly<Record<string, RegExp>> = {
  cat: /^-[nbsuv]+$/,
  head: /^-(\d+|[nc]\d*)$/,
  tail: /^-(\d+|[nc]\d*)$/,
  wc: /^-[lwcmL]+$/,
  grep: /^-[inlvwcHhsqxFE]+$/,
}

/**
 * C97 F4, U11 rule 2 for the shell. `cat`, `grep`, `head`, `tail` or `wc` whose every file is one a person allowed, under
 * one item, is A `consented`, with nothing after it but the output cut down on this machine (` | tail -N`). `source` and `.`
 * of an allowed file run it, which a consent to read it does not cover: they go through the script screen as any script
 * does (rule 6, `outside_path` included). Undefined for anything else, which stays held as a secret.
 */
function classifyConsentedCommand(input: Input, command: string): Verdict | undefined {
  if (!canRunIn(input.cwd, input.instance)) return undefined
  const body = unwrapped(command.replace(OUTPUT_TAIL, ""))
  // `.` is no program name `quotedWords` takes, and it means what `source` does.
  const words = Risk.quotedWords(body.startsWith(". ") ? "source" + body.slice(1) : body)
  if (!words) return undefined
  if (words[0] === "source") {
    const file = words.length === 2 ? path.resolve(input.cwd, words[1]!) : undefined
    if (!file || body !== command || consentFor(input, [file]) === undefined) return undefined
    return classifyScript(input, { file: words[1]! })
  }
  const flags = CONSENTED_LOOKS[words[0]!]
  if (!flags || programInProject(command, input.cwd, input.instance)) return undefined
  const files: string[] = []
  const args = words.slice(1)
  for (const [index, word] of args.entries()) {
    if (word.startsWith("-")) {
      if (!flags.test(word)) return undefined
      continue
    }
    // `head -n 5`: the count belongs to the flag before it.
    if ((args[index - 1] === "-n" || args[index - 1] === "-c") && /^\+?\d+$/.test(word)) continue
    files.push(word)
  }
  // grep's first word is what it looks for, not a file.
  const named = words[0] === "grep" ? files.slice(1) : files
  if (named.length === 0) return undefined
  const id = consentFor(input, named.map((word) => path.resolve(input.cwd, word)))
  return id === undefined ? undefined : { class: "A", decidedBy: "gate", category: "consented", consentID: id }
}

/**
 * U11 rule 6. `<interpreter> <file> [args]`, `./<file> [args]`, or `<interpreter> -c|-e '<code>'` with nothing else on the
 * line. A file name has a `.` or a `/` in it, so `bun install` or `deno run` is no script and stays with the allow list.
 * `bash -c`, `sh -c` and `zsh -c` are not here: their code is a command line, which the allow list judges as one, and a
 * screen would let any program through that a fixed pattern does not name.
 */
type ScriptForm = { program?: string; file: string; code?: undefined } | { program: string; code: string; file?: undefined }

const SCRIPT_WORD = /^[\w./@%+:,=-]+$/
// Single quotes are taken as written. In double quotes the shell would expand `$`, backquotes and `\`, so what was screened
// would not be what runs: none of them may appear there.
const INLINE = /^([a-z0-9]+) (-[ce]) (?:'([^']*)'|"([^"$`\\]*)")$/
const INLINE_FLAG: Readonly<Record<string, string>> = { python: "-c", python3: "-c", node: "-e", bun: "-e", ruby: "-e", perl: "-e" }
const INTERPRETERS: ReadonlySet<string> = new Set(ScriptScreen.INTERPRETERS)

export function scriptForm(command: string): ScriptForm | undefined {
  const inline = INLINE.exec(command)
  if (inline) return INLINE_FLAG[inline[1]!] === inline[2] ? { program: inline[1]!, code: inline[3] ?? inline[4]! } : undefined
  const words = command.split(" ")
  if (!words.every((word) => SCRIPT_WORD.test(word))) return undefined
  if (words[0]!.startsWith("./") && words[0]!.length > 2) return { file: words[0]! }
  const file = words[1]
  if (!INTERPRETERS.has(words[0]!) || !file || file.startsWith("-") || !/[./]/.test(file)) return undefined
  return { program: words[0]!, file }
}

/**
 * U11 rules 6 and 7. Code reads the script and looks for fixed patterns; what passes goes to the decider as P `script`,
 * which judges it against the task on a closed summary. A file must be one the shell hashed for this request with the same
 * bytes (`metadata.scripts`, row 154), so the shell can compare it again right before it runs: one it did not hash is held.
 * A file that is not there is not a script, and is left as any other command. A screen raises the cost of hiding something
 * in a script; it is no proof that the script is safe, and one that passes runs with the account's full rights (G1).
 */
function classifyScript(input: Input, form: ScriptForm): Verdict {
  if (!canRunIn(input.cwd, input.instance)) return held("not_routine")
  const file = form.file === undefined ? undefined : path.resolve(input.cwd, form.file)
  // The bundled library stays as it was before U11 (XF-03): a script of it is not screened into anything.
  if (file && nearLibrary([file])) return held("not_routine")
  if ((form.program && programInProject(form.program, input.cwd, input.instance)) || (file && installed(file, input.instance)))
    return held("program_not_trusted")
  if (input.folder !== "clean" && input.folder !== "trusted") return held("folder_not_trusted")
  if (!input.canUndo) return held("no_undo")
  const screen =
    form.code === undefined
      ? ScriptScreen.file({ directory: input.instance.directory, file: form.file, cwd: input.cwd })
      : ScriptScreen.inline(form.code, {
          roots: [...new Set([input.instance.directory, Reach.real(input.instance.directory) ?? input.instance.directory])],
          cwd: input.cwd,
        })
  if (!screen.ok) return held(screen.reason === "missing" ? "not_routine" : "script_unreadable")
  const found = { bytes: screen.bytes, lines: screen.lines, sha256: screen.sha256, flags: [...screen.flags] }
  if (found.flags.length > 0) return { ...held("script_flagged"), screen: found }
  if (file && !hashed(input.metadata.scripts, file, found.sha256)) return held("script_unreadable")
  return { class: "P", decidedBy: "agent", category: "script", screen: found }
}

/** Whether the shell listed `file` for this request with this hash. Anything else it says is read as not listed. */
function hashed(scripts: unknown, file: string, sha256: string) {
  if (!Array.isArray(scripts)) return false
  return scripts.some(
    (item: unknown) =>
      typeof item === "object" && item !== null && "file" in item && "sha256" in item && item.file === file && item.sha256 === sha256,
  )
}

/** A dependency's own program (`node_modules/.bin/x`, or a file of a package): code nobody in the project wrote or screened. */
function installed(file: string, instance: InstanceContext) {
  return [file, Reach.real(file)].some(
    (place) => place !== undefined && path.relative(instance.directory, place).split(path.sep).includes("node_modules"),
  )
}

/**
 * U11 rule 7: a program the shell would find inside the project, through a `PATH` entry there or a relative one such as
 * `node_modules/.bin` or `.`, is the repository's own code under a trusted name. `command` is one program or a command
 * `routine` accepted, whose every piece is checked. A program not found at all cannot start, and is left as it was.
 */
export function programInProject(command: string, cwd: string, instance: InstanceContext) {
  const pieces = command.replace(OUTPUT_TAIL, "").split(" && ")
  const first = pieces[0]!.split(" ")
  // A leading `cd <path>` is where every later piece looks for its program.
  const moves = first[0] === "cd" && first.length === 2
  const here = moves ? path.resolve(cwd, first[1]!) : cwd
  return pieces.some((piece, index) => {
    if (index === 0 && moves) return false
    const words = piece.split(" ")
    return (words[0] === "rtk" ? words.slice(0, 2) : words.slice(0, 1)).some((name) => {
      const searched = (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((entry) => path.resolve(here, entry))
        .join(path.delimiter)
      const found = findProgram(name, searched)
      return found !== undefined && (containsPath(found, instance) || Reach.inside(found, instance))
    })
  })
}

/**
 * U11 rule 8: the plan agent may look, here and beyond the folder as rule 1 lets build, and does nothing else. A look the
 * table cannot vouch for, or one naming a secret, waits for a person as it would for build. Any other command is refused
 * with nobody asked, a check and a copy into the folder included, since either one changes what is there.
 */
function classifyPlanBash(input: Input, checkClass: CheckClass): Verdict {
  const command = input.metadata.command
  if (input.metadata.risk || typeof command !== "string") return refused("plan_mode")
  const verdict = classifyBash(input, checkClass)
  // Sending a copy away is not looking either (rule 3 is build's).
  if (verdict.class === "A" && !PLAN_WRITES.has(verdict.category) && verdict.via !== "outward") return verdict
  return verdict.class === "D" && onlyLookPieces(command) ? verdict : refused("plan_mode")
}

// What the table lets through as A that writes, which the plan agent never does.
const PLAN_WRITES = new Set<Verdict["category"]>(["outside_copy", "file-op", "archived"])

/** Whether every piece of `[cd <path> && ]<look>[ && <look>...][ | tail -N]` is a program that only looks. */
function onlyLookPieces(command: string) {
  return command
    .replace(OUTPUT_TAIL, "")
    .split(" && ")
    .every((piece, index) => {
      const words = homeWords(piece)
      return words !== undefined && ((index === 0 && words[0] === "cd" && words.length === 2) || onlyLooks(words))
    })
}

export const OUTSIDE_EDIT: Verdict = { class: "A", decidedBy: "gate", category: "outside_edit" }

/**
 * 1.2.6 (U6, U12; P-01a): a read of a secret or sensitive file, a protected place, a place beyond the folder the table could
 * not vouch for, or a diagnostic probe. In autonomous mode every read runs with nobody asked, in both layers; writes, sends
 * and a person's own rules keep their verdict. The read tool still masks secret values (U16).
 */
export const PROTECTED_READ: Verdict = { class: "A", decidedBy: "gate", category: "protected_read" }

/** A piece's words, `~` read as the shell reads it, with whole-word quotes (`find ~/x -name '*.md'`) as a look takes them. */
export function lookWords(piece: string) {
  const home = homedir()
  const spelled = unwrapped(piece).replace(/(^| )~(?=\/| |$)/g, (_match, space: string) => space + home)
  return Risk.plainWords(spelled) ?? Risk.quotedWords(spelled)
}

/**
 * 1.2.6 (U12, 01b 3.1 rule 2): `[cd <path> && ]<look>[ && <look>...][ | tail -N]` whose every look passes `onlyLooks` and
 * the program's cap on names (`xxd a b` writes b). Only the readability test is left out, so a secret or protected place
 * may be looked at; a write, a redirect, a run or a send never passes. The bundled library and a program of the project
 * under a look's name keep their rules (XF-03, U11 rule 7).
 */
export function protectedLook(command: string, cwd: string, instance: InstanceContext) {
  if (command.includes("\n")) return false
  let here = cwd
  const named: string[] = []
  let looks = 0
  for (const [index, piece] of command.replace(OUTPUT_TAIL, "").split(" && ").entries()) {
    // As `routine` reads it: a piece may drop its own error output, and nothing else.
    const words = lookWords(piece.replace(DROP_ERRORS, ""))
    if (!words) return false
    if (index === 0 && words[0] === "cd" && words.length === 2) {
      here = path.resolve(cwd, words[1]!)
      named.push(here)
      continue
    }
    if (!onlyLooks(words)) return false
    const paths = words.slice(1).filter((word) => !word.startsWith("-"))
    const cap = READS.get(words[0]!)?.maxPaths
    if (cap !== undefined && paths.length > cap) return false
    named.push(...paths.map((word) => path.resolve(here, word)))
    looks++
  }
  if (looks === 0 || nearLibrary([cwd, ...named])) return false
  return !programInProject(command, cwd, instance)
}

// 1.2.6 (U12, 01b 3.1 rule 3): what a diagnostic probe may be, each as the whole command.
const PROBE_FLAGS = new Set(["--version", "-V", "-v", "--help", "-h"])
// Programs whose probe is not a look: they act on the host or on a person's account, or start another program.
const NO_PROBE = new Set([
  "sudo", "su", "doas", "login", "passwd", "shutdown", "reboot", "halt", "poweroff", "init", "telinit", "systemctl",
  "launchctl", "security", "osascript", "open", "xargs", "nohup", "nice", "time", "watch", "caffeinate", "eval", "exec",
  "source", "command", "builtin", "kill", "killall", "pkill",
  // 1.2.7 row 47a (M1-04): zsh builtins that run the next command or a text.
  "noglob", "nocorrect", "emulate", "trap",
])
// Shells and interpreters read `-v` and `-h` as something else (verbose, a host), so only the long forms and `-V` are probes.
const LONG_PROBE_ONLY = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "python", "python2", "python3", "perl", "ruby", "php", "lua"])

/**
 * 1.2.6 (U12, R4): `<program> --version|-V|-v|--help|-h`, `go version`, a bare `env` and `printenv [NAME]`, of an installed
 * program the shell would not find inside the project. `env NAME=x cmd` runs a program, so it is not one.
 */
export function probe(command: string, cwd: string, instance: InstanceContext) {
  const words = Risk.plainWords(command)
  if (!words) return false
  const [program, ...rest] = words
  if (!program || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(program) || NO_PROBE.has(program)) return false
  const flag = rest.length === 1 ? rest[0]! : undefined
  const form =
    (program === "env" && rest.length === 0) ||
    (program === "printenv" && (rest.length === 0 || (flag !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(flag)))) ||
    (program === "go" && flag === "version") ||
    (flag !== undefined && PROBE_FLAGS.has(flag) && !(LONG_PROBE_ONLY.has(program) && (flag === "-v" || flag === "-h")))
  return form && !programInProject(program, cwd, instance)
}

/**
 * The class of one request, per the table this mode was specified with. Stricter rules are asked first, so a request can
 * only get here with less room than a later rule would give it. `checkClass` exists for the test of both values.
 */
export function classifyBase(input: Input, checkClass: CheckClass = CHECK_CLASS): Verdict {
  // A spend limit and a repeating call stop a run so that a person looks. Nothing here or later may answer them.
  if (needsPerson(input.permission)) return { class: "B", decidedBy: "person" }
  if (input.rule === "deny") return { class: "X" }
  if (input.permission === TRUST_PERMISSION) return { class: "X", decidedBy: "person", category: "folder_not_trusted" }
  // U11 rule 2 (C100): only the server makes a consent entry, from its own scan. An agent that asks for one is refused.
  if (input.permission === AUTONOMY_CONSENT) return { class: "X", decidedBy: "gate" }
  if ((input.permission === "bash" || input.permission === "external_directory") && changesCredentials(input))
    return refused("credential_change")

  const planEdit = input.plan === true && input.permission === "edit"
  const planFile = planEdit && isPlanFile(input)
  if (planEdit && !planFile) return refused("plan_mode")
  // 1.2.7 row 47k (U9-7, C76): a write that reaches the state folder only through a glob, a link or a variable is held
  // for the person (D), as in 1.2.6; spelled out, or under the consent (where nothing waits for a person), it is refused.
  if (!planFile && writesAppState(input)) return indirectStateWrite(input) ? held("app_state") : refused("app_state")
  // 1.2.7 U-10 (C63): only the person turns the mode on (1.1.1 rule); an agent's `swarm autonomy` never runs.
  if (input.permission === "bash" && runsAutonomyCommand(input.metadata.command))
    return { ...refused("own_api"), reason: "person_only" }
  // 1.2.7 row 47j (U9-3, C76): every graft sub-command runs under the consent except `graft init`, which writes the
  // machine's own hook and MCP configuration: refused in autonomous mode, the root's as a subagent's, as a write of a
  // protected place is (the consent never turns it into a held write outside, which the main agent could open).
  if (input.permission === "bash" && runsGraftInit(input.metadata.command)) return refused("protected_path")
  // 1.2.7 F-4 (N7-051): Swarm's own API has its own category, split from `app_state`; a reason names an unresolved form.
  const ownApi = ownServerCall(input)
  if (ownApi) return ownApi.reason ? { ...refused("own_api"), reason: ownApi.reason } : refused("own_api")

  if (input.rule === "user_catch_all") return held("asks_every_time")
  if (planFile) return { class: "A", decidedBy: "gate" }
  // 1.2.7 N-1 (N7-091): a look at Swarm's own state the OP-2 allowlist takes runs as a protected read; `cat`/`head`/`tail`
  // output stays masked (U16, SR7-07).
  if (readsAppState(input)) return PROTECTED_READ
  if (input.plan === true && input.permission === "bash") return classifyPlanBash(input, checkClass)
  // Before the labels: a deletion the shell moves to the archive takes nothing away, whatever Undo could have restored.
  if (input.permission === "bash") {
    const removal = classifyDeletion(input)
    if (removal) return removal
    // 1.2.6 row 37b (U6): before the labels too. A checkpoint made first takes away the reason "nothing could undo it";
    // what a checkpoint cannot hold (I-N) is refused with that reason. Anything else keeps the rules below.
    const saved = classifyCheckpoint(input)
    if (saved) return saved
  }

  // A label only ever raises a class. Nothing below may read its absence as safe. A push is the one way out the shell labels
  // that rule 3 can let through; a force push is labelled "irreversible" and is held as that.
  // Row 202: a file tool's write outside the project, which `classifyOutside` let through for its folder prompt.
  const outsideEdit = classifyOutsideEdit(input)
  if (outsideEdit) return outsideEdit
  if (input.metadata.risk === "remote" && input.permission === "bash") return classifyPush(input)
  if (input.metadata.risk) return held(riskCategory(input.metadata.risk))
  if (input.harmless) return QUIET
  if (input.permission === "task") return QUIET
  if (input.permission === "question") return { class: "A", decidedBy: "gate" }
  if (input.permission === "external_directory") {
    const verdict = classifyOutside(input)
    // A copy into the folder is a write there, which the plan agent does not do (rule 8), and neither is a copy away.
    return input.plan === true &&
      (verdict.category === "outside_copy" || verdict.category === "outside_edit" || verdict.via === "outward")
      ? refused("plan_mode")
      : verdict
  }
  if (input.permission === "webfetch" || input.permission === "websearch") return classifyFetch(input)
  // 1.2.6 (U12, R2/R3): the read tool asks only for a file it would not show unasked. It reads; the values stay masked (U16).
  if (input.permission === "read") {
    const targets = editTargets(input)
    return targets.length === 0 ||
      targets.some((file) => Reach.secret(file) || !Reach.readable(file) || protectedOutside(file, "read"))
      ? PROTECTED_READ
      : { class: "A", decidedBy: "gate" }
  }
  if (input.permission === "edit") return classifyEdit(input)
  if (input.permission === "bash") return classifyBash(input, checkClass)
  const mcp = input.metadata.mcp
  if (typeof mcp === "object" && mcp !== null) {
    const source = mcp as Readonly<Record<string, unknown>>
    // Rule 8 (C100): the table cannot tell what an MCP tool does, so the plan agent uses only the servers known to read.
    return input.plan === true && !readOnlyServer(input, source) ? refused("plan_mode") : classifyMcp(input, source)
  }
  // A tool that says nothing about itself has nothing to judge. No name is excepted, `graft_*` included.
  const opaque = input.patterns.every((pattern) => pattern === "*") && Object.keys(input.metadata).length === 0
  return held(opaque ? "external_tool" : "not_routine")
}

/**
 * The class of one request. Without the person's consent to the bypass this is `classifyBase`, unchanged since 1.1.0. With
 * it, the overlay of S1.13 (as decision P8 reads it) is laid over that answer. The plan agent keeps rule 8: no bypass for a
 * plan lineage. Steps of a compound text reach this again from `classifySteps` with the same `bypass`, so each is overlaid.
 */
export function classify(input: Input, checkClass: CheckClass = CHECK_CLASS): Verdict {
  if (!input.bypass) return classifyBase(input, checkClass)
  // 1.1.3 (T3): under consent no verdict waits, the plan lineage's included; rule 8 still refuses what it refused.
  if (input.plan === true) return noWait(input, classifyBase(input, checkClass))
  // 1.2.7 U-7 (C21 b): `sh|bash|zsh -c '<literal>'` is judged as the command line it runs, for root and subagent alike.
  const inner = shellTextCall(input)
  if (inner) return classify(inner, checkClass)
  // 1.1.1 F12b (Perf P2): one classify asks git about a file once, however many steps or scripts write it. 1.1.1 F14
  // (G5-P1): the one scope covers the whole consented classify, the steps' own overlays (reached from `classifySteps`,
  // whose nested scopes share this one), the call-level check and the kept path's `classifyBase` included.
  return Reach.snapshotScope(() => {
    const base = classifyBase(input, checkClass)
    const verdict = underConsent(input, base)
    // 1.1.1 F12a (S4-1): a step that changes the tree beside one that runs a project script does not open the call; it
    // keeps its 1.1.0 verdict. Refusals and held answers stand as they are (1.1.3: also one carrying `bypassed`).
    if (verdict.class === "A" && verdict.bypassed !== undefined && BypassScreen.sequenceKeeps(input)) {
      const kept = noWait(input, classifyBase({ ...input, bypass: undefined }, checkClass))
      // 1.1.3 (T7 F2): the kept call runs too, so its line names the step that would have waited (`classifySteps` chose
      // it, a send first) rather than the whole text's `not_routine`: a send stays under "Sent outside the computer".
      const waited = OPENED_BY_NO_WAIT.has(verdict) || OUTWARD_HELD.has(verdict.bypassed)
      if (kept.class !== "A" || kept.bypassed === undefined || !waited) return kept
      const { destination: _, ...rest } = kept
      return openedByNoWait({ ...rest, bypassed: verdict.bypassed, ...(verdict.destination && { destination: verdict.destination }) })
    }
    return noWait(input, verdict)
  })
}
