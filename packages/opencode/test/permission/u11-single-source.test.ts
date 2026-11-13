// Row 252 (U11 review M1, M3, M4, M6): what the shell, the gate, the task tool and the audit must read alike. Each of these
// has one source in `src`; the tests hold the readers to it, so a copy that drifts fails here instead of in a run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "../../src/permission"
import type { Autonomy } from "../../src/permission/autonomy"
import { AutonomyDecider } from "../../src/permission/autonomy-decider"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { AutonomyTexts } from "../../src/permission/autonomy-texts"
import { ScriptScreen } from "../../src/permission/script-screen"
import type { InstanceContext } from "../../src/project/instance-context"
import { readDeletion, SCRIPT_CHANGED_TEXT } from "../../src/tool/shell"
import { SUBAGENT_STOPPED, subagentStoppedMessage } from "../../src/tool/task"
import { tmpdir } from "../fixture/fixture"
import { CREDENTIAL_CHANGE, DELETE_COMPOUND } from "./consented-literals"

let fixture: Awaited<ReturnType<typeof tmpdir>>
let dir: string

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  dir = fixture.path
  // As in `autonomy-table.test.ts`: `GitGuard` refuses the fixture's quiet-git settings, which `git init` never writes.
  await $`git config --unset core.fsmonitor && git config --unset commit.gpgsign`.cwd(dir).quiet()
  fs.mkdirSync(path.join(dir, "src"), { recursive: true })
  fs.writeFileSync(path.join(dir, "src/a.ts"), "x\n")
})

afterAll(async () => {
  await fixture[Symbol.asyncDispose]()
})

describe("M1: the shell and the table read a deletion alike", () => {
  // The forms of `autonomy-table.test.ts` rule 4, plain, compound and not a deletion, all of safe paths in the folder.
  const CORPUS = [
    "rm -rf build",
    "rm src/a.ts",
    "rm -r -f build dist",
    "rm -- src/a.ts",
    "rm 'src/a b.ts'",
    'rm "src/a.ts"',
    "rm  src/a.ts",
    "rm --recursive --force build",
    "rm -d empty",
    "rmdir build",
    "rmdir -v build",
    "unlink src/a.ts",
    "git rm src/a.ts",
    "git rm -r -- src",
    "git rm --ignore-unmatch -q x",
    "rm '-rf' build",
    "rm a && bun test",
    "bun test; rm -rf src",
    "ls | xargs rm",
    "xargs rm < list",
    "rm -rf src && git push",
    "cd src && rm a.ts",
    "rm src/*",
    "rm *.log",
    "rm $FILE",
    "rm ${X}",
    "rm `cat list`",
    "rm a > log",
    "rm a 2>&1",
    "echo $(rm a)",
    'echo "$(rm a)"',
    "(rm a)",
    "{ rm a; }",
    "sudo rm a",
    "env rm a",
    "command rm a",
    "nice rm a",
    "/bin/rm a",
    "'rm' a",
    "rm --no-preserve-root a",
    "rm -x a",
    "rmdir -p a/b",
    "unlink a b",
    "git -C . rm a",
    "git rm -n2 a",
    "rm",
    "rm -rf",
    "rm a\\ b",
    "find . -delete",
    "git rm --cached src/a.ts",
    "git rm -n src/a.ts",
    'echo "a; rm b"',
    "cat rm.txt",
    "grep -n rm src",
    'git commit -m "rm old files"',
    "mv rm src/x",
    "ls",
    "bun test",
  ]
  // Where the two differ today, each toward holding: the table refuses what the shell would move. Listed so a change to
  // either reading shows up here, not as a wait in a run.
  const KNOWN: Record<string, { shell: string; table: string }> = {
    "git 'rm' src/a.ts": { shell: "moved", table: "refused" },
  }

  const tableReads = (command: string, archive: boolean) => {
    const verdict = AutonomyTable.classify({
      permission: "bash",
      patterns: [command],
      metadata: { command, archive },
      instance: { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext,
      cwd: dir,
      canUndo: true,
      folder: "clean",
    })
    if (verdict.category === "archived") return "moved"
    if (verdict.category === "delete_compound") return "refused"
    return "not a deletion"
  }
  const shellReads = async (command: string) => {
    const found = await readDeletion(command)
    return found === undefined ? "not a deletion" : found === "compound" ? "refused" : "moved"
  }

  test("every form of the corpus gets the same answer from both", async () => {
    const answers = await Promise.all(
      CORPUS.map(async (command) => {
        const shell = await shellReads(command)
        // The shell says it moves exactly when it read one plain deletion, which is what it sends as `metadata.archive`.
        return { command, shell, table: tableReads(command, shell === "moved") }
      }),
    )
    expect(answers.filter((item) => item.shell !== item.table)).toEqual([])
    // The corpus reaches all three answers.
    expect(new Set(answers.map((item) => item.shell))).toEqual(new Set(["moved", "refused", "not a deletion"]))
  })

  test("the known differences stay as listed, and each holds rather than runs", async () => {
    for (const [command, expected] of Object.entries(KNOWN)) {
      const shell = await shellReads(command)
      expect({ command, shell, table: tableReads(command, shell === "moved") }).toEqual({ command, ...expected })
    }
  })
})

describe("M3: the register's texts have one source", () => {
  test("the texts are the register's, word for word", () => {
    expect(AutonomyTexts.OUTSIDE_WRITE_TEXT).toBe(
      "This call did not run. Autonomous mode only reads outside the project folder. Copy the file into the project first (read it, then write the copy inside the project) and change the copy. The original stays as it is.",
    )
    // 1.2.6 row 39 (P-01d, INTENT): both name the way on now; the words are pinned in consented-literals.ts.
    expect(AutonomyTexts.DELETE_COMPOUND_TEXT).toBe(DELETE_COMPOUND)
    expect(AutonomyTexts.CREDENTIAL_CHANGE_TEXT).toBe(CREDENTIAL_CHANGE.replace(" Continue the task without this step.", ""))
    expect(AutonomyTexts.SCRIPT_CHANGED_TEXT).toBe(
      "This call did not run. A script it runs changed after autonomous mode checked it, so what would run is not what was checked. Run the command again to have the script checked as it is now.",
    )
    expect(AutonomyTexts.SUBAGENT_STOPPED).toBe("Stopped by autonomous mode:")
    expect(AutonomyTexts.subagentStoppedMessage("read")).toBe("Stopped by autonomous mode: repeated calls to `read`.")
    expect(AutonomyTexts.SPEND_STOPPED_TEXT).toBe("Stopped by autonomous mode: the spend limit was reached.")
  })

  test("the shell, the task tool and the gate give out those texts and no copy of them", () => {
    expect(SCRIPT_CHANGED_TEXT).toBe(AutonomyTexts.SCRIPT_CHANGED_TEXT)
    expect(SUBAGENT_STOPPED).toBe(AutonomyTexts.SUBAGENT_STOPPED)
    expect(subagentStoppedMessage).toBe(AutonomyTexts.subagentStoppedMessage)
    for (const [category, text] of Object.entries(AutonomyTexts.REFUSED_TEXT))
      expect([category, Permission.refusedByMode(category).message]).toEqual([category, text])
    // An X with no category, and a name only an object's prototype has, gets the general refusal. 1.2.6 row 39 (P-01d,
    // INTENT): plan_mode and app_state have their own texts now (REFUSED_TEXT, checked by the loop above).
    for (const category of ["toString", "hasOwnProperty", undefined])
      expect(Permission.refusedByMode(category).message).toStartWith(
        "This call did not run. Autonomous mode never allows",
      )
  })
})

describe("M4, M6: the register's names", () => {
  test("the decider's retry count and the screen's limits carry the register's names and values", () => {
    expect(AutonomyDecider.DECIDER_TIMEOUT_RETRIES).toBe(3)
    expect(ScriptScreen.SCRIPT_MAX_BYTES).toBe(65_536)
    expect(ScriptScreen.INLINE_MAX_BYTES).toBe(4_096)
  })

  test("the table's and the audit's categories are the schema's", () => {
    type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
    const held: Same<AutonomyTable.HeldCategory, PermissionV1.DeferredCategory> = true
    const audit: Same<
      NonNullable<Autonomy.OpenDecision["category"]>,
      AutonomyTable.HeldCategory | AutonomyTable.AllowedCategory
    > = true
    expect([held, audit]).toEqual([true, true])
    // The register's 21 held and 6 allowed names, as the review counted them, plus the 1.1.1 bypass register (S0.2):
    // six held (irreversible, admin_rights, outside_write_held, system_service, process_not_own, unreadable_command)
    // and one allowed (by_main_agent). Row 202: one held (protected_path) and one allowed (outside_edit).
    // 1.2.6 row 36 (U6, U12; register N-073..N-075, INTENT 01g 3.6 :193): one held (checkpoint_failed) and two allowed
    // (protected_read, checkpointed). 1.2.7 row 31 (F-4, N7-051, INTENT): one held X (own_api).
    expect(PermissionV1.DeferredCategory.literals).toHaveLength(30)
    expect(PermissionV1.AllowedCategory.literals).toHaveLength(10)
  })
})
