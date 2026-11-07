// Row 122c (Swarm 1.2.0, decision C96 O1): DOCX cover title leading follows the manual. Manual Rev A ID p.47 butir 7
// and p.90 Tabel A.2 give the title 24-26 pt Cond 600 and no leading; the manual's own cover (ID p.1) sets its two
// 24 pt title lines 28 pt apart (PDF baselines 287.1 and 315.1 pt), as does the DATUM sample report (w:line 560 for
// w:sz 48). Rule (engine/docx/wrapper/formats.ts coverTitleLineTw): leading = title size + 4 pt, exact. The HTML
// twin is cover-title-html.test.ts. Before: 580 tw (29 pt) at every size.
import { describe, expect, test } from "bun:test";
import { paragraphs, renderDocx, textOf } from "../docx/_kit";

const TITLE_LINES = ["Pemantauan Iklim Ruang Simpan", "Arsip Statis Gedung B"];

describe("cover title leading, DOCX (Manual Rev A ID p.1 cover, p.47 butir 7, p.90 Tabel A.2)", () => {
  test("24 pt title on 28 pt exact (manual), 26 pt on 30 pt; a template's own line height wins", async () => {
    const titleSpacing = async (overrides: Record<string, unknown>, mutate?: Parameters<typeof renderDocx>[2]) => {
      const r = await renderDocx(undefined, overrides, mutate);
      const ps = paragraphs(r.doc).filter((p) => TITLE_LINES.includes(textOf(p)));
      expect(ps.length).toBe(2);
      return ps.map((p) => ({ sz: /<w:sz w:val="(\d+)"/.exec(p)?.[1], line: /w:line="(\d+)"/.exec(p)?.[1], rule: /w:lineRule="(\w+)"/.exec(p)?.[1] }));
    };
    // Canonical profile = 24 pt (w:sz 48): the manual's own cover pitch.
    expect(await titleSpacing({})).toEqual([
      { sz: "48", line: "560", rule: "exact" },
      { sz: "48", line: "560", rule: "exact" },
    ]);
    expect((await titleSpacing({ "cover.title.sizePt": 26 })).map((l) => [l.sz, l.line])).toEqual([["52", "600"], ["52", "600"]]);
    const own = await titleSpacing({}, (tpl) => ({
      ...tpl,
      roleFormats: { ...tpl.roleFormats, "cover.titleFirst": { ...tpl.roleFormats["cover.titleFirst"], para: { lineTw: 640, lineRule: "exact" } } },
    }));
    expect(own[0].line).toBe("640");
    expect(own[1].line).toBe("560");
  });
});
