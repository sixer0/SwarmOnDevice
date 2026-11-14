// 1.2.9 row 41, AC-B02 (N9-118, rule N9-058, S9-09; 01b AT-B02): a report copied into the vault cannot carry a
// Templater opener. Templater reads the raw note text, so `<%` inside a code span, a fence body (backtick or tilde, any
// length, nested in a callout), a fence info string, or a generated frontmatter value (the hub `aliases`) would run as a
// template. Each `<%` becomes `<` U+200B `%`, after the secret masking; everything else stays byte-identical.
// Red at BASE d4282fcfd8: the `<%` openers come back unchanged (G1-G4, G6, G7, G9 second line, G10 alias). G5 (a fence
// nested in a callout: its body lines are text, `<` is already `&lt;`) and the first G9 line (hidden whole) carry no
// `<%` at BASE either; they are pinned as goldens. Pure functions: no HOME, no disk, no vault. Inputs are synthetic.
// Run targeted: cd packages/opencode && bun test test/memory/rel129-b02-templater-code.test.ts

import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { VaultMirror } from "../../src/memory/vault-mirror"

const n = (text: string) => VaultMirror.neutraliseReport(text)
const B = "<\u200b%"
const count = (text: string, part: string) => text.split(part).length - 1
const html = (text: string) => Bun.markdown.html(text)
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

interface Case {
  readonly id: string
  readonly name: string
  readonly input: string
  readonly golden: string
  /** `<\u200b%` expected in the output. Equals the openers of the input unless masking hid a line first (G9). */
  readonly breaks: number
}

const CASES: readonly Case[] = [
  {
    id: "G1",
    name: "span in a sentence",
    input: "Pakai `<%* tR += 1 %>` di templat.",
    golden: "Pakai `" + B + "* tR += 1 %>` di templat.",
    breaks: 1,
  },
  {
    id: "G2",
    name: "fence text",
    input: "```text\n<% tp.file.title %>\n```",
    golden: "```text\n" + B + " tp.file.title %>\n```",
    breaks: 1,
  },
  {
    id: "G3",
    name: "fence json",
    input: '```json\n{"a": "<%+ x %>"}\n```',
    golden: '```json\n{"a": "' + B + '+ x %>"}\n```',
    breaks: 1,
  },
  {
    id: "G4",
    name: "tilde fence",
    input: "~~~\n<%_ y _%>\n~~~",
    golden: "```\n" + B + "_ y _%>\n```",
    breaks: 1,
  },
  {
    id: "G5",
    name: "fence nested in a callout",
    input: "> [!note]\n> ```text\n> <% z %>\n> ```",
    golden: "> [!note]\n> ```text\n> &lt;% z %>\n> ```",
    breaks: 0,
  },
  {
    id: "G6",
    name: "4-backtick fence holding a 3-backtick fence",
    input: "````md\n```\n<% tp.date.now() %>\n```\n````",
    golden: "````md\n```\n" + B + " tp.date.now() %>\n```\n````",
    breaks: 1,
  },
  {
    id: "G7",
    name: "two tags on one line",
    input: "`<% a %>` dan `<%- b %>`",
    golden: "`" + B + " a %>` dan `" + B + "- b %>`",
    breaks: 2,
  },
  {
    id: "G8",
    name: "already broken (idempotent, no double break)",
    input: "`" + B + " x %>`",
    golden: "`" + B + " x %>`",
    breaks: 1,
  },
  {
    id: "G9",
    name: "secret in a fence: masked first, then broken",
    input: "```text\npassword=hunter2x9 <% x %>\n<% x %> password=hunter2x9\n```",
    golden: "```text\n[hidden]\n" + B + " x %> password=[hidden:password]\n```",
    breaks: 1,
  },
]

describe("AC-B02 (N9-118) Templater openers in report copies are broken in code spans and fences", () => {
  for (const c of CASES) {
    test(`${c.id} ${c.name}`, () => {
      const out = n(c.input)
      // (1) no opener is left
      expect(out.includes("<%")).toBe(false)
      expect(out).toBe(c.golden)
      // (2) one break per opener, and no other new U+200B
      expect(count(out, B)).toBe(c.breaks)
      expect(count(out, "\u200b")).toBe(count(c.input, "\u200b") - count(c.input, B) + c.breaks)
      // (3) reads the same in Markdown: the rendered HTML differs only by the invisible character
      expect(html(out).replaceAll("\u200b", "")).toBe(html(out.replaceAll(B, "<%")))
    })
  }

  test("every opener of the input is broken where masking kept the line (G1-G4, G6-G8)", () => {
    for (const c of CASES.filter((c) => c.id !== "G5" && c.id !== "G9"))
      expect(c.breaks).toBe(count(c.input, "<%") + count(c.input, B))
  })

  test("G8 a broken opener next to an unbroken one: each is broken exactly once", () => {
    expect(n("`" + B + " x %> <% y %>`")).toBe("`" + B + " x %> " + B + " y %>`")
    expect(n("```text\n" + B + "" + B + "<%%\n```")).toBe("```text\n" + B + B + B + "%\n```")
  })

  test("G10 a project named `<% tp.file.title %>` gives no `<%` in the hub file (S9-09)", () => {
    const result = VaultMirror.render({ key: "syn129-b02", folder: "syn129-b02", projectName: "<% tp.file.title %>", items: [] })
    const hub = result.files.find((f) => f.path === "index.md")!.content
    expect(hub.includes("<%")).toBe(false)
    expect(hub).toBe(
      [
        "---",
        "swarm-mirror: true",
        'swarm-key: "syn129-b02"',
        'swarm-id: "index"',
        'swarm-source: "index"',
        'swarm-hash: "f78d59b86e6e1c9b"',
        'swarm-lang: "id"',
        "tags:",
        '  - "swarm-memory/index"',
        "aliases:",
        '  - "' + B + ' tp.file.title %>"',
        "---",
        "# \\<\\% tp\\.file\\.title \\%\\>: memori Swarm",
        "",
        "Dibuat oleh Swarm dari memori proyek. Ubah memorinya di Swarm, bukan catatan ini: catatan yang diubah tidak diperbarui lagi.",
        "",
      ].join("\n"),
    )
    for (const file of result.files) expect(file.content.includes("<%")).toBe(false)
  })
})

// (4) Other content byte-identical: the inputs of `rel128-obs-c-note-golden.test.ts:272-345` (N8-359) hold no `<%`;
// their outputs are pinned to the sha256 of the BASE d4282fcfd8 output, recorded in the red step (row 41).
const CORPUS: readonly string[] = [
  "```dataviewjs\ndv.x()\n```",
  "```dataview\nLIST\n```",
  "```mermaid\ngraph TD\n```",
  "~~~{dataviewjs}\nx\n~~~",
  "```ts\nconst a = 1\n```",
  "```\nplain\n```",
  "```ts title=x\na\n```",
  ...VaultMirror.MIRROR_PLAIN_FENCE_LANGS.map((lang) => "```" + lang + "\nx\n```"),
  "````md\n```js\n<img>\n```\n````",
  "```html\n<b>ok</b>\n```\n<b>not ok</b>",
  "- a\n  ```js\n<img src=x onerror=y>\n```\n<i>after</i>",
  "nilai `= this.file.name` di sini",
  "`$= dv.pages().length`",
  "` = x `",
  "`= x `",
  "`a = b` dan `<T>`",
  "`= 1+1`",
  "`$= 1`",
  "`  $= x`",
  "``= x``",
  "x `=y` `$=z`",
  "[ok](https://example.invalid/a)",
  "[m](mailto:a@example.invalid)",
  "[rel](docs/a.md)",
  ...[
    "obsidian://open?vault=a",
    "javascript:alert(1)",
    "file:///etc/hosts",
    "JavaScript:alert(1)",
    "javascript&#58;alert(1)",
    "java&#x73;cript:alert(1)",
    "<javascript:alert(1)>",
    "data:text/html,x",
  ].map((target) => `[x](${target})`),
  "[r]: javascript:alert(1)\n\n[x][r]",
  "[x](\njavascript:alert(1))",
  "[a [b] c](obsidian://open?x)",
  "buka obsidian://open?vault=x",
  "lihat https://example.invalid",
  '<iframe src="https://e.invalid"></iframe>',
  "![img](https://e.invalid/a.png)",
  "![[rahasia.png]]",
  "\\`<img src=x onerror=y>` ok`",
  "a ` b\nc ` <img src=x onerror=y> `",
  "a ` b\n\n`<T>`",
]

const BASE_SHA256: readonly string[] = [
  "887a7f57e5fbc11a60691bcaf71bdf3fd286daed5d64a69a43db0f8f84b349e6",
  "f41f8ffc323f462f0ec7230a268756bf78c1422b6828127c61531cd8bb1b1960",
  "cc5d11e3fcdfa97aba00faeb40070377f192aaa628f30a3b6fa3d7f1215354a5",
  "10f7e26a326c392a6d8a94991a32084b5112ab0676bb353f5dd50a9c9039a1d4",
  "fec094137bd06665880c3c92450581991e17037c9eadf66d5e62f072d3086cef",
  "b22df5cae0107c85655ae33b15eb36dd31fa29aafc4ba8b20108ef3296f5adcc",
  "3f052419329290476d80fc320f9d20d10a346b25d5aa2b89c69631f6e2e2be5a",
  "a7cc9733bfc37e729c17889589aeeb7771a0b95d05977dbcee1ca1107d38a1ee",
  "10f7e26a326c392a6d8a94991a32084b5112ab0676bb353f5dd50a9c9039a1d4",
  "8cddb3e3c3c9e4f9f8d57b215c1f609f5b0ae866e32129e91e478bf236581b5e",
  "57c5c53534e1a83517d5a4bb6fe4e7b05cd8fa71754d762c5d4af7f3de5b82ad",
  "9f9c461753b67c6159eae17c1048c6543805f4c1808fedc443447cf800ea6beb",
  "73ca92939178a4e6abfcc061464e71f2609fce6a2177f67d0bfc1d16dda9eb8a",
  "1e3a9b7497336153967bda7acb4363cfc7a2421266111b5331c4755ef00bbb2a",
  "1cb53e95653d3f394619094c78ce80c84ec3d1e3277a152377ee4220e3057d32",
  "f3faee651174cb83b31d9845055b11d2b73238aba87d1f3b8fda10fe4086d083",
  "b898f40675d670f0f79a9d1f62e0ce13f434a51fcec239744ad17722f428aeda",
  "4dfca76dd33d2ce1a7d53ef977563e2eb6e87f1d1ce57083f4edd36634f8bc91",
  "16eed2fd7cc07fffff5ac2f0c3f6f87a58f3c5e43fc7a625ae2d93d711acf242",
  "99b46aaf4567f4a7fe900201d05894fa4ba94af254380729f4933e320a01dd1f",
  "c964b09fb52ea91f97a70ea9e3701673837d10424ecb59f22e09684429e4b855",
  "be39dbe0cb784f878feb16012c3a7ebd8d0f3ae85584151341a8fdc7f237c496",
  "20f1f39340e732bedaa5a3e819c9316f7c86233967034966e4a438710aef33eb",
  "85351a7e6056fad92d3a9894b8a63013b3065c6175bc0d354a661160729b1c23",
  "a62bfd332ecabfbb5c0ddaaa25525500470200e496cde06088167757c2e618ed",
  "799339d7ed6df7eb929459a5b3c077e8d80b417d4b181e9388c38024c4ff897f",
  "13d39f8ef1b341b5aa595aacd3b6a4f678117c34c24310b2d7fd200bebdbbf14",
  "09af29bfebab3a414136d096a80f9ecdb97f06796c8f629cf499ea308e50018e",
  "8de0fef9fb91c724532b1c106c19c215498d5cc4acae81e3c2f50b297e9035fa",
  "34e639ec1a2614c7518ca4203096384b7d4b474780bfc71aae1ee30167ba7030",
  "3112ba612a2a0919f991d2b1291d8baa5badac344b3ee636a33ff1b4af377723",
  "9b61fcb4b896918e8d6f562dd0e9d6a3e7f8a605a7fa67e30e39ef2af5f17387",
  "53d4387094c67bf20c94d39e1b0f9edec02296f26ddfd565e1f542d5de4d8c47",
  "c9218dcdf375e92ec3c8536290c8fcfece1e8f2434acc7463eca7cc4ed59901b",
  "f926e7aa0df1550bb0f5a7e52f1c840df18cd45b3b43ee361a9c2032adb0b452",
  "a2748448b2bf077ba637ab0a7e3ab7deed5b52e62518b30b82b23ad3c9a1455e",
  "fabfe1c51ff32905590f7f7123f9a8769a5f1728dad1df8d6731113b5739514e",
  "f56e7a2e98f82f07d2a1a4b015f37c3c0aa59fe7579d567f0a34e264829f3ff4",
  "1c0bbfba6512ce6c1b3046c9cbd0184d368a1dd8f09f8f330e79a71435201af6",
  "93f4990fc631051eba9fd2be88aafd23c68951f0a66a27bfe244e616e6e946a2",
  "4c1b71fe5d736eba0fe520d38aed9e489cd3390e1c1a1c0204e36f824dca067b",
  "376df7d510be8fcb18bf48ceea623f8c3843b8c63068ac73c4ceaf9691a40f1a",
  "bb8afa1474975f329d7d8b2f8543bde73195833d42c93aa1551d8ead37db5c87",
  "354cb6e8164a0de90e51ec77c5bae17ad3b5b5e43c47ed89afd2f8adaf516eeb",
  "8daca663d536219586a215ee3aa4770bc37ccde954693248eba7d5b2de2b0906",
  "a84a5ed9b3e2b0addfdc9a3950b3e9652666ab4479297d835472f368a1eea9ef",
  "a87f85a89642d95397029cca1f86d6892fd9993fad146845108b60924fa00148",
  "5b8b814269180406130962cc7517cfafd20e266619b717d499d78d9aa1108d15",
  "d84ba92049cea50ea316adf6821d3d4a03b29777b8232cf255eb65adc83de523",
  "5e82c914bfe08e78bdacdd0b21135a668b29ea77d11202e7918b85181ea45fcc",
  "9d36b765afb394c7fb5322da9f0c2a2ca8d797756498af26c4ebc909f301a5e1",
  "dbd79108d0672ca2e6ee6f059a5997c71a4e80aa164bea7bec1c110192f76f92",
  "1ea396bcba87948fee4b2a5a8780bbc8ffbae2a1229cc3b0e7aaa2157167ff28",
  "6d524893681529572420e2c496bec058d7b3cfc09fe768664deaad9fe9f7b67d",
  "6e1e03a79a1cc0e5cdf5b3ea80126e17fe418115303475da25cf8f5cfa8c8a96",
  "eb7f25c462f4254faeece968b5a68a453afaf93774a7d2bcbf0c490f48b252cd",
  "4aaba3ecab3feffa952bafe08965d0cf264e642a2a3ab264df870c80f5cf5b84",
  "ec4c0aa53e1a129dcc7b91a55dfe46717870144f933729ed82d77cc754ac2129",
  "2aa41c1e225023b2af152ee1fbf3979662cf391fe773c1376e1431e8bca02b14",
  "0fa0d730acd9ede5d16587d5c6b96233ca52dced1dffa984c392d8da6d0eb5b8",
  "e77d8e1f2b16856a488d9da47d74905d83ba976b8e37039569e26be3a4d5dd3e",
  "b5cfa751551e47b67a12763dcb1290ebf8037506d875b6a0c63e448ec2e2d883",
  "7ee9c6a0af3dd188d8ba1167fe228f2b1e225bdb3b3da73c1f3f0eb7123b50fd",
  "c152782d3422096e9c81081aaae26d2851fee3aafb18160ef59f3a6ceeb6fd87",
  "f043063846bdac513abe6e36eb5164da5c929b58e322502cfa54ff330c564ab6",
  "14768338f683536421eea16a33b8dfab6b39fe683a16803176d795e0a98a8213",
  "7b361dfcd7c2a017a2eb77cba1c60fd7f89380aeb64476745393d990693b2626",
  "fe8d6a4f64425ed692e85a6ed8bb7a8e21c26dd4287bd19edd962ca716858aa6",
  "2d352c4dbe486035de63939cf174df66956cb8196391790adbf6fea443b1ea0a",
  "b16345bcf3b1a56c2cafc70e683b100f590e66bfe19390a521919e77f5c31581",
  "c355adfbdb1a93fc577d3e2f9cbec2e234434fdaa228073e09c387803bba0e47",
  "763b32e07e7c305747f714b08c460ad9bdf800fcd60d269df0704080af856693",
  "05a0ae0983d84f92c41cd4e50a6359e58df568342837f616c1e8b9ee3589f589",
  "10e0ef462e8a674d932873275f4bfe0a6550db35148042fbbf47a00a0b5b407b",
  "32b0be27f77ee0218a5434bc6cb1a219d105449c64863b0a1d0f6ba8c28e4ff4",
  "fb1b1a1a9fc6171f3788114210496233c58c9722ba762ec8b9d90f550e388bdf",
]

describe("AC-B02 (N9-118) reports without `<%` stay byte-identical", () => {
  test("corpus holds no opener", () => {
    for (const input of CORPUS) expect(input.includes("<%")).toBe(false)
  })

  test("each output equals the BASE output (sha256 pinned)", () => {
    expect(CORPUS.map((input) => sha256(n(input)))).toEqual([...BASE_SHA256])
  })
})
