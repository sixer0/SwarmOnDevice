import { describe, expect, it } from "bun:test";
import { LINT_REGISTRY, getLintDef, isLintImplemented } from "./lint";
import { lintLanguage, LANGUAGE_LINT_DEFS } from "../engine/lint/language";

// Swarm 1.3.3 row 27: register 03 section 7. Staged rules report NOT_RUN until their scanner row lands.
// Row 129: all three scanners have landed (C-35 row 84, C-36 row 85/86, C-37 row 103); none is staged any more.
describe("lint registry rows of Swarm 1.3.3 (row 27)", () => {
  for (const id of ["C-35", "C-36", "C-37"]) {
    it(`${id} is registered once, as a warning ("lapor") in group C, module language`, () => {
      expect(LINT_REGISTRY.filter((d) => d.id === id)).toHaveLength(1);
      const d = getLintDef(id)!;
      expect(d.group).toBe("C");
      expect(d.module).toBe("language");
      expect(d.limit).toBe("lapor");
      expect(d.blocksIngest).toBe(false);
      expect(isLintImplemented(d)).toBe(true); // row 84 landed C-35, row 85/86 C-36, row 103 C-37
      expect(LANGUAGE_LINT_DEFS.map((x) => x.id)).toContain(id);
    });
  }
  it("C-36 and C-37 run (rows 85/86, 103): PASS on a snapshot without a top-level blocks list (prose.ts guard), no notRunReason", () => {
    const out = lintLanguage({ doc: { meta: { language: "ID" }, blocks: [] } } as never, {});
    for (const id of ["C-36", "C-37"]) {
      expect(out.filter((i) => i.checkId === id).map((i) => i.status)).toEqual(["PASS"]);
      expect(getLintDef(id)!.notRunReason).toBeUndefined();
    }
  });
  it("C-35 runs (row 84): PASS on a document without prose, and its registry row carries no notRunReason key value", () => {
    const out = lintLanguage({ doc: { meta: { language: "ID" } }, blocks: [] } as never, {});
    expect(out.filter((i) => i.checkId === "C-35").map((i) => i.status)).toEqual(["PASS"]);
    expect(getLintDef("C-35")!.notRunReason).toBeUndefined();
  });
  it("ids stay unique", () => {
    expect(new Set(LINT_REGISTRY.map((d) => d.id)).size).toBe(LINT_REGISTRY.length);
  });
});
