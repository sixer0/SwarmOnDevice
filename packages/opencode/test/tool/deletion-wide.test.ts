// Swarm 1.1.1 F1b: the wide launcher reader and deletion check in `tool/deletion.ts`, which only the consented bypass
// reads. `deletes` and `WRAPPERS` (the shell's and U11 rule 4's reading) are unchanged and tested in
// `test/permission/u11-single-source.test.ts`.

import { describe, expect, test } from "bun:test"
import { commandWords } from "../../src/permission/autonomy-table"
import { DeletionWords } from "../../src/tool/deletion"

const words = (command: string) => command.split(" ")
const wide = (command: string) => DeletionWords.deletesOrReplacesWide(words(command), commandWords)
const program = (command: string) => {
  const found = DeletionWords.launched(words(command))
  return found.kind === "program" ? [found.name, ...found.args].join(" ") : found.kind
}

describe("launched: the program past every launcher", () => {
  test("environment, priority, timeout, keep-awake, buffering, profiling, rtk, repeat, feeders, package runners", () => {
    const cases: [string, string][] = [
      ["env -u HOME A=1 B=2 make build", "make build"],
      ["cross-env NODE_ENV=test bun test", "bun test"],
      ["nice -n 5 make", "make"],
      ["ionice -c 3 make", "make"],
      ["timeout -s 9 5 bun test", "bun test"],
      ["gtimeout 10s bun test", "bun test"],
      ["caffeinate -t 60 bun test", "bun test"],
      ["stdbuf -oL bun test", "bun test"],
      ["stdbuf -o L bun test", "bun test"],
      ["time -f %e bun test", "bun test"],
      ["perf stat -e cycles bun test", "bun test"],
      ["strace -o out.txt bun test", "bun test"],
      ["rtk bun test", "bun test"],
      ["rtk recall abc", "rtk recall abc"],
      ["repeat 3 bun test", "bun test"],
      ["xargs -n 1 echo", "echo"],
      ["npx -y rimraf dist", "rimraf dist"],
      ["npm exec -- rimraf dist", "rimraf dist"],
      ["pnpm dlx rimraf dist", "rimraf dist"],
      ["bun x prettier --check .", "prettier --check ."],
      ["uv run --with x pytest", "pytest"],
      ["poetry run pytest -q", "pytest -q"],
      ["direnv exec . make", "make"],
      ["sudo -u root make", "make"],
    ]
    for (const [command, expected] of cases) expect([command, program(command)]).toEqual([command, expected])
  })

  test("a launcher that runs a shell text gives that text; an unreadable split is unreadable", () => {
    for (const command of ["watch -n 1 make", "hyperfine make", "parallel echo ::: a", "bun exec make", "npx -c make", "su -c make"])
      expect([command, DeletionWords.launched(words(command)).kind]).toEqual([command, "code"])
    expect(DeletionWords.launched(words("watch -x make")).kind).toBe("program")
    expect(DeletionWords.launched(words("env -S make")).kind).toBe("unreadable")
    expect(DeletionWords.launched(words("env A=1")).kind).toBe("none")
  })

  test("not a launcher: the program is the first word", () => {
    for (const command of ["bun run build", "npm install", "git status", "make build"])
      expect([command, program(command)]).toEqual([command, command])
  })
})

describe("deletesOrReplacesWide", () => {
  test("positive: deleters, replacers and every shell family's text", () => {
    const cases = [
      "rm -rf dist",
      "rimraf dist",
      "truncate -s 0 a.ts",
      "shred a.ts",
      "caffeinate rm a.ts",
      "stdbuf -oL rm a.ts",
      "rtk rm a.ts",
      "npx rimraf dist",
      "xargs rm",
      "cp a.ts b.ts",
      "mv a.ts b.ts",
      "ln -sf a.ts b.ts",
      "git clean -fd",
      "git rm a.ts",
      "find . -name x -delete",
      "find . -exec rm {} ;",
      "sh -c rm",
      "bash -lc rm",
      "dash -c rm",
      "ksh -c rm",
      "fish --command=rm",
      "csh -c rm",
      "tcsh -c rm",
      "watch rm a",
      "bash build.sh",
      "env -S rm",
    ]
    for (const command of cases) expect([command, wide(command)]).toEqual([command, true])
  })

  test("near miss: ordinary dev commands neither delete nor replace", () => {
    const cases = [
      "bun test",
      "bun run build",
      "git status",
      "git diff",
      "git commit -m x",
      "git rm --cached a.ts",
      "ln -s a.ts b.ts",
      "caffeinate make",
      "perf stat bun test",
      "sh -c ls",
      "prettier --write .",
      "find . -name x",
    ]
    for (const command of cases) expect([command, wide(command)]).toEqual([command, false])
  })

  test("the existing `deletes` and `WRAPPERS` are unchanged", () => {
    expect([...DeletionWords.WRAPPERS]).toEqual(["sudo", "doas", "command", "builtin", "exec", "env", "nice", "nohup", "time", "xargs", "timeout"])
    expect(DeletionWords.deletes(words("caffeinate rm a"))).toBe(false)
    expect(DeletionWords.deletes(words("nice rm a"))).toBe(true)
  })
})
