import { expect, test } from "bun:test"

// This package has no component test bench, so this reads the source, as parity-exemption-guard.test.ts does. It guards the two
// things that matter here: the item text only ever goes through Solid's text binding, and the list is the server's.
const source = await Bun.file(new URL("./session-trust-dock.tsx", import.meta.url)).text()

test("the folder's words are bound as text and never as markup", () => {
  expect(source).toContain("{item.label}")
  expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|createMarkdown|Markdown/)
})

test("the list and its count come from the server", () => {
  expect(source).not.toMatch(/\.slice\(|SHOWN|moreCount/)
})
