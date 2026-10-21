import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"

// Mechanical proof for referral #1 (F-D1-1 / D6 F-1), blueprint row 168, applied exactly as the
// row 163 ruling specifies:
// docs/2026-10-19_opencode_swarm_rebrand/verification/s5_promotions/r1_mark_ruling.md §4.
//
// WHAT THIS FILE PROVES, AND WHAT IT DELIBERATELY DOES NOT.
// The defect was found by pixels and was invisible to four text instruments: `svg_text_count=0`
// and `svg_image_count=0` on all five `en` dumps and all eight `id` screens (11_jury_brand.md
// ADDENDUM A2), because the leaked lettering lives only in eight inline <path> `d` attributes
// (wordmark-v2.tsx:17,:22,:27,:32,:37,:42,:47,:52) and painted 19,723 glyph pixels
// (11_jury_brand.md:79). Rule P6 (delegation_progress/driver_rules_s5.md:29-32) forbids the
// instrument that missed a defect from being the one that closes it, so nothing here may be read
// as closure. These tests pin the wiring: which module the composer imports, which element it
// renders, what class string that element carries, and which geometry the chosen component draws.
// They do NOT prove that pixels changed on a built artifact — no build, serve, capture or glyph
// census runs here, and none can: rendering a Solid component is unavailable in this lane because
// `packages/app/tsconfig.json:14` sets `"jsx": "preserve"` and the Solid JSX transform lives only
// in the Vite build, so `bun -e 'import("@opencode-ai/ui/logo").then(m => m.Logo({class:"a"}))'`
// from packages/app throws `ReferenceError: React is not defined` even though the import itself
// resolves. Pixel closure belongs to row 184's census on rebuilt bytes (ruling §6.2-§6.3).
//
// It also does not close the accessible-name half of the finding. See the last describe block.

const viewPath = new URL("./new-session-view.tsx", import.meta.url)
const logoPath = new URL("../../../../ui/src/components/logo.tsx", import.meta.url)
const upstreamWordmarkPath = new URL("../../../../ui/src/v2/components/wordmark-v2.tsx", import.meta.url)

const viewSource = readFileSync(fileURLToPath(viewPath), "utf8")
const logoSource = readFileSync(fileURLToPath(logoPath), "utf8")
const upstreamWordmark = readFileSync(fileURLToPath(upstreamWordmarkPath), "utf8")

// Geometry prefixes measured by row 160 (§8): the Swarm wordmark opens `M16.20 0.00h33.60`
// (logo.tsx:144) and the upstream one opens `M55.3846 36.4286H18.4615` (wordmark-v2.tsx:19).
// Comparing drawings by their ink rather than by an identifier is the point: identifiers were
// exactly what every earlier text instrument read.
const SWARM_WORDMARK_PATH_PREFIX = "M16.20 0.00h33.60"
const UPSTREAM_WORDMARK_PATH_PREFIX = "M55.3846 36.4286H18.4615"

// Product sources only: this file names the identifier it forbids elsewhere, so test sources are
// out of the scanned set by definition rather than by an exception added after a red run.
function sourceFilesUnder(dir: URL): string[] {
  const files: string[] = []
  for (const entry of readdirSync(fileURLToPath(dir), { withFileTypes: true })) {
    const child = new URL(entry.name, dir.href.endsWith("/") ? dir.href : `${dir.href}/`)
    if (entry.isDirectory()) {
      files.push(...sourceFilesUnder(child))
      continue
    }
    if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(fileURLToPath(child))
  }
  return files
}

describe("composer call site points at the Swarm wordmark seam", () => {
  test("imports Logo from the v1 logo seam and never names WordmarkV2 again", () => {
    // Ruling §4 row 1. The specifier matters as much as the symbol: `packages/ui/package.json:37`
    // maps "./*" to "./src/components/*.tsx", so `@opencode-ai/ui/logo` reaches the Swarm drawing
    // with no export-map change and no new file under packages/ui.
    expect(viewSource).toContain('import { Logo } from "@opencode-ai/ui/logo"')
    expect(viewSource).not.toContain("WordmarkV2")
    expect(viewSource).not.toContain("@opencode-ai/ui/v2/wordmark-v2")
  })

  test("the mark element is the imported Logo, rendered exactly once", () => {
    expect(viewSource.match(/<Logo\b/g) ?? []).toHaveLength(1)
    expect(viewSource).not.toMatch(/<WordmarkV2\b/)
  })

  test("the class string keeps the geometry and theme tokens and adds the watermark token", () => {
    // Ruling §4 row 2. `h-auto w-full` and `text-v2-background-bg-inverse` are kept verbatim: the
    // two canvases differ in aspect by ~0.2% (234/42 against 720/129), and both marks paint
    // fill="currentColor" (logo.tsx:143, wordmark-v2.tsx:20), so the existing theme token is what
    // keeps the replacement theme-aware. `opacity-12` is the treatment moved to the call site.
    const element = /<Logo\s+class="([^"]*)"\s*\/>/.exec(viewSource)
    expect(element).not.toBeNull()
    expect(element![1].trim().split(/\s+/)).toEqual([
      "h-auto",
      "w-full",
      "opacity-12",
      "text-v2-background-bg-inverse",
    ])
  })

  test("no other file in packages/app still reaches the upstream v2 wordmark", () => {
    // After this row the vendor component has no consumer inside the app package, which is why it
    // becomes dead code left at pin bytes rather than a live surface (ruling §2, DR2).
    const referencing = sourceFilesUnder(new URL("../../", import.meta.url)).filter((path) => {
      const text = readFileSync(path, "utf8")
      return text.includes("WordmarkV2") || text.includes("@opencode-ai/ui/v2/wordmark-v2")
    })
    expect(referencing).toEqual([])
  })
})

describe("the watermark treatment is carried by the class, not by the component", () => {
  test("the upstream component self-dims, which is why a bare swap would regress", () => {
    // Trap witness, ruling §3 closing paragraph: opacity="0.6" on the outer group
    // (wordmark-v2.tsx:14), opacity="0.16" on the inner group (:16), opacity="0.7" per path (:18),
    // plus a bottom-fading gradient mask (:61-67) — an effective ink near 6.7%.
    const bakedOpacities = upstreamWordmark.match(/\sopacity="/g) ?? []
    expect(bakedOpacities.length).toBeGreaterThanOrEqual(3)
    expect(upstreamWordmark).toContain("<mask")
  })

  test("Logo bakes no opacity and no mask, so removing the class token would paint full strength", () => {
    // If `opacity-12` ever leaves the call site, the token test above fails; if someone instead
    // "restores" the dimming by editing the vendor file, this test fails and DR2's empty diff for
    // that file is the second witness. Both directions are covered by design.
    expect(logoSource).not.toMatch(/\sopacity="/)
    expect(logoSource).not.toContain("<mask")
  })

  test("both seams apply the caller's class through the same single-key classList pattern", () => {
    // Prop-surface parity (ruling §3.4): Logo takes `props: { class?: string }` (logo.tsx:133) and
    // WordmarkV2 takes Pick<ComponentProps<"svg">, "class"> (wordmark-v2.tsx:3); the call site
    // passes one class string, and both components forward it identically.
    const pattern = 'classList={{ [props.class ?? ""]: !!props.class }}'
    expect(logoSource).toContain(pattern)
    expect(upstreamWordmark).toContain(pattern)
    expect(logoSource).toContain("export const Logo = (props: { class?: string }) =>")
  })
})

describe("the chosen component draws the Swarm lettering, not the upstream lettering", () => {
  test("Logo carries the Swarm grid path and the upstream geometry appears nowhere in it", () => {
    expect(logoSource).toContain(SWARM_WORDMARK_PATH_PREFIX)
    expect(logoSource).not.toContain(UPSTREAM_WORDMARK_PATH_PREFIX)
    expect(logoSource).toContain('viewBox="0 0 234 42"')
    // One wordmark path element, against the upstream component's eight letterforms.
    const logoBody = logoSource.slice(logoSource.indexOf("export const Logo"))
    expect(logoBody).not.toBe(logoSource)
    expect(logoBody.match(/<path\b/g) ?? []).toHaveLength(1)
    expect(logoBody).toContain('data-slot="logo-wordmark"')
    expect(logoBody).toContain('fill="currentColor"')
  })

  test("the upstream component still holds its own geometry, untouched by this row", () => {
    // Read-only witness that this row changed a call site and not the asset: the vendor drawing is
    // present exactly as pinned, and this row never opened it for write. Byte identity to the pin
    // is proved by sha256 in implementation/s5_r168_mark.md, not here.
    expect(upstreamWordmark).toContain(UPSTREAM_WORDMARK_PATH_PREFIX)
    expect(upstreamWordmark).toContain('viewBox="0 0 720 129"')
    expect(upstreamWordmark.match(/<path\b/g) ?? []).toHaveLength(8)
  })
})

describe("a11y residue stays open — recorded so row 189 cannot claim it closed", () => {
  test("Logo exposes only class and renders an unlabelled svg, as F-D5-7 recorded", () => {
    // Ruling §9: the swap does not fix the anonymous role=image node (15_jury_a11y.md:359, node
    // 8866 of AX_COMPOSER.ax.json; addendum A-24 at 23_session4_addendum.md:462-466). This block is
    // a fence, not a fix: it fails loudly on the day the component gains a label, which is the only
    // day the claim below would need rewriting.
    expect(logoSource).not.toContain("aria-label")
    expect(logoSource).not.toMatch(/role="/)
    expect(logoSource).not.toContain("<title")
  })
})
