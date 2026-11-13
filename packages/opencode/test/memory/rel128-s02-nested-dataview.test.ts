// 1.2.8 row 43i (row 64 security finding S-02 Low, C149; SR8-13): a report copied into the vault cannot carry an
// executable plugin block (dataviewjs, dataview, button, ...) inside a container. Before this row `neutraliseReport`
// rewrote the info string of top-level fences only; a fence opened inside a block quote, a callout, a list item or a
// list continuation kept `dataviewjs` and Obsidian would run it with Dataview JS enabled.
// Red at the pre-fix HEAD (ccb44bb756): the nested openers come back unchanged. BASE e1f9673772 has no vault mirror
// (red by module-missing). Pure function: no HOME, no disk, no vault.
// Run targeted: cd packages/opencode && bun test test/memory/rel128-s02-nested-dataview.test.ts

import { describe, expect, test } from "bun:test"
import { VaultMirror } from "../../src/memory/vault-mirror"

const n = (text: string) => VaultMirror.neutraliseReport(text)

describe("S-02 nested executable fences become text", () => {
  test("block quote and callout openers", () => {
    expect(n("> ```dataviewjs\n> dv.x()\n> ```")).toBe("> ```text\n> dv.x()\n> ```")
    expect(n(">```dataviewjs\n>dv.x()\n>```")).toBe(">```text\n>dv.x()\n>```")
    expect(n("> [!note]\n> ```dataviewjs\n> dv.x()\n> ```")).toBe("> [!note]\n> ```text\n> dv.x()\n> ```")
    expect(n("> > ~~~dataview\n> > LIST\n> > ~~~")).toBe("> > ~~~text\n> > LIST\n> > ~~~")
    expect(n("> ````{dataviewjs}\n> x\n> ````")).toBe("> ````text\n> x\n> ````")
  })

  test("list item and continuation openers", () => {
    expect(n("- ```dataviewjs\n  dv.x()")).toBe("- ```text\n  dv.x()")
    expect(n("* ```button\n  name x")).toBe("* ```text\n  name x")
    expect(n("1. ```dataviewjs\n   dv.x()")).toBe("1. ```text\n   dv.x()")
    expect(n("2) ~~~dataviewjs\n   dv.x()")).toBe("2) ~~~text\n   dv.x()")
    expect(n("- item\n\n    ```dataviewjs\n    dv.x()")).toBe("- item\n\n    ```text\n    dv.x()")
    expect(n("- item\n\t```dataviewjs\n\tdv.x()")).toBe("- item\n\t```text\n\tdv.x()")
    expect(n("> - ```dataviewjs\n>   dv.x()")).toBe("> - ```text\n>   dv.x()")
    expect(n("- > ```dataviewjs\n  > dv.x()")).toBe("- > ```text\n  > dv.x()")
  })

  test("no nested opener keeps a non-plain info string", () => {
    const input = [
      "> ```DataviewJS",
      "- ~~~ dataviewjs extra",
      "    > 10. ```js-engine",
      "  - + ```mermaid",
    ].join("\n")
    for (const line of n(input).split("\n")) expect(/(`{3,}|~{3,})\s*text$/.test(line)).toBe(true)
  })

  test("plain nested fences, text and inline code stay as they were", () => {
    const keep = [
      "> ```ts\n> const a = 1\n> ```",
      "- ```\n  plain",
      "> ```text\n> x\n> ```",
      "- item `a = b`\n> quote",
      "> uses ```inline``` code",
      "- ```js `x`",
    ]
    for (const text of keep) expect(n(text)).toBe(text)
  })

  test("inline Dataview queries inside containers still get the leading space", () => {
    expect(n("> nilai `= this.file.name`")).toBe("> nilai ` = this.file.name`")
    expect(n("- `$= dv.pages().length`")).toBe("- ` $= dv.pages().length`")
  })

  test("the line count is kept", () => {
    const text = "> ```dataviewjs\n> a\n> ```\n- ```dataview\n  b\n\ntail"
    expect(n(text).split("\n")).toHaveLength(text.split("\n").length)
  })
})
