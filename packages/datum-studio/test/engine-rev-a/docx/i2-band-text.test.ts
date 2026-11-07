// Integration pass I-2 (Swarm 1.2.0, decisions C69 / CP-07): the DOCX seal band text is #F4F5F6 (Manual Rev A
// ID p.49 Tabel 8.1, p.89), the same value the HTML engine prints since row 123 (texts.ts SEAL_BAND_TEXT_HEX).
// Before I-2 the role carried the wrapper cream #F6E9E9 (engine/docx/wrapper/formats.ts wrapper.sealBand).
import { describe, expect, test } from "bun:test";
import { renderDocx, runs } from "./_kit";

const texts = await import("../../../vendor/src/lib/studio/engine/front/texts");

/** Cells shaded with the seal colour (the band: KT-01/02 fill #6E1420). */
function sealBandCells(docXml: string): string[] {
  return [...docXml.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((m) => m[0]).filter((c) => /<w:shd [^>]*w:fill="6E1420"/.test(c));
}

describe("I-2 CP-07 DOCX seal band text colour (ID p.49 Tabel 8.1)", () => {
  test("every text run in the seal band is #F4F5F6, none is cream #F6E9E9", async () => {
    expect(texts.SEAL_BAND_TEXT_HEX).toBe("F4F5F6");
    const r = await renderDocx();
    const cells = sealBandCells(r.doc);
    expect(cells.length).toBeGreaterThan(0);
    const rs = cells.flatMap((c) => runs(c)).filter((x) => x.text.trim() !== "");
    expect(rs.length).toBeGreaterThan(0);
    for (const x of rs) {
      expect(x.rPr).toContain('<w:color w:val="F4F5F6"/>');
      expect(x.rPr).not.toContain("F6E9E9");
    }
  });
});
