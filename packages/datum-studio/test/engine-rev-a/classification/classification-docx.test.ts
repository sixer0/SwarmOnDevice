// Row 49a (Swarm 1.2.0, decision C104 H1 + M1), DOCX engine.
// H1: Manual Rev A DT-28d (WAJIB, research/manual_rev_a/manual_id.txt:667-669, table :5093) sets classification text
// in seal #6E1420, bold, "bukan alert" (alert #9B1C1C named as forbidden at :3947); the file test is RGB 110,20,32.
// DT-28c (:660-664) places it under the number (cover), right of the running head and in the right register cell.
// The seal band label stays #F4F5F6 on the seal fill (Tab 8.1, :4878 "Teks pita segel #F4F5F6").
// Before row 49a the running head and register printed it ink900 #101418 (header-footer.ts RUNNING_HEAD_RIGHT_RUN,
// REGISTER_VALUE_RUN).
// M1: seal band text 6,5 pt = w:sz 13 (Tab A.2 "pita segel 6,4", :4920; nearest Word half point, C54); was w:sz 12.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ResolvedTemplate, StudioDocV1 } from "../../../vendor/src/lib/studio/contract";
import { loadFixture, PKG, renderDocx, runs, textOf } from "../docx/_kit";

const SEAL = "6E1420";
const LEVELS = [
  { label: "TERBATAS", mark: "TERBATAS" },
  { label: "RAHASIA", mark: "RAHASIA" },
  { label: "Sangat Rahasia", mark: "SANGAT RAHASIA" },
  { label: "Biasa", mark: "BIASA" },
];

function withLevel(level: string): StudioDocV1 {
  const doc = JSON.parse(JSON.stringify(loadFixture())) as StudioDocV1;
  (doc.meta as { classification: string }).classification = level;
  return doc;
}

const colourOf = (rPr: string): string | undefined => /<w:color w:val="([0-9A-Fa-f]{6})"\/>/.exec(rPr)?.[1]?.toUpperCase();
const szOf = (rPr: string): string | undefined => /<w:sz w:val="(\d+)"\/>/.exec(rPr)?.[1];

/** Every run, in every header/footer part, whose text is exactly the classification mark. */
function furnitureRuns(r: Awaited<ReturnType<typeof renderDocx>>, kind: "header" | "footer", mark: string) {
  return Object.keys(r.files)
    .filter((f) => new RegExp(`^word/${kind}\\d+\\.xml$`).test(f))
    .flatMap((f) => runs(r.part(f)).map((x) => ({ ...x, part: f })))
    .filter((x) => x.text.trim() === mark);
}

/** Cells shaded with the seal colour (the band: KT-01/02 fill #6E1420). */
const sealBandCells = (docXml: string): string[] =>
  [...docXml.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((m) => m[0]).filter((c) => /<w:shd [^>]*w:fill="6E1420"/.test(c));

describe("H1 DOCX classification text is seal #6E1420 bold at every level (Rev A DT-28d)", () => {
  for (const level of LEVELS) {
    test(`${level.label}: running head, register cell and cover line`, async () => {
      const r = await renderDocx(withLevel(level.label));
      const head = furnitureRuns(r, "header", level.mark);
      const foot = furnitureRuns(r, "footer", level.mark);
      expect(head.length).toBeGreaterThan(0);
      expect(foot.length).toBeGreaterThan(0);
      for (const x of [...head, ...foot]) {
        expect({ part: x.part, colour: colourOf(x.rPr) }).toEqual({ part: x.part, colour: SEAL });
        expect(x.rPr).toContain("<w:b/>");
      }
      // Cover: the line under the document number (row 122, DT-28c) is seal bold as well.
      const cover = runs(r.doc).filter((x) => x.text === level.mark);
      expect(cover.length).toBeGreaterThan(0);
      for (const x of cover) expect(colourOf(x.rPr)).toBe(SEAL);
      // Never alert, never ink900, anywhere the mark is printed outside the band.
      for (const x of [...head, ...foot, ...cover]) expect(["9B1C1C", "101418"]).not.toContain(colourOf(x.rPr));
    });
  }

  test("the colour follows color.wrapper.seal (the template's seal token)", async () => {
    const r = await renderDocx(withLevel("RAHASIA"), { "color.wrapper.seal": "701522" });
    for (const x of [...furnitureRuns(r, "header", "RAHASIA"), ...furnitureRuns(r, "footer", "RAHASIA")]) expect(colourOf(x.rPr)).toBe("701522");
  });

  test("{kelas} stays seal bold when the template does not list it in P4S-13 boldFields", async () => {
    const r = await renderDocx(withLevel("TERBATAS"), { "device.registerBlock.boldFields": ["nomor dokumen"] });
    const foot = furnitureRuns(r, "footer", "TERBATAS");
    expect(foot.length).toBeGreaterThan(0);
    for (const x of foot) {
      expect(colourOf(x.rPr)).toBe(SEAL);
      expect(x.rPr).toContain("<w:b/>");
    }
  });

  test("the seal band label keeps #F4F5F6 on the seal fill (Tab 8.1)", async () => {
    const r = await renderDocx(withLevel("RAHASIA"));
    const band = sealBandCells(r.doc).flatMap((c) => runs(c)).filter((x) => x.text.trim() !== "");
    expect(band.some((x) => x.text.includes("RAHASIA"))).toBe(true);
    for (const x of band) expect(colourOf(x.rPr)).toBe("F4F5F6");
  });
});

describe("M1 DOCX seal band text 6,5 pt (Rev A Tab A.2 pita segel 6,4; C54 half-point rule)", () => {
  test("engine role (datum-kanonik family): every band run is w:sz 13", async () => {
    const r = await renderDocx();
    const band = sealBandCells(r.doc).flatMap((c) => runs(c)).filter((x) => x.text.trim() !== "");
    expect(band.length).toBeGreaterThan(0);
    for (const x of band) expect(szOf(x.rPr)).toBe("13");
    expect(textOf(sealBandCells(r.doc).join(""))).toContain("KLASIFIKASI");
  });

  test("shipped GSP family (datum-gsp-preset own band role): w:sz 13", async () => {
    const preset = JSON.parse(readFileSync(path.join(PKG, "templates", "datum-gsp-preset.json"), "utf8")) as { roleFormats: Record<string, { run: { szHalfPt: number } }> };
    expect(preset.roleFormats["wrapper.sealBand"].run.szHalfPt).toBe(13);
    const r = await renderDocx(undefined, {}, (tpl: ResolvedTemplate) => ({
      ...tpl,
      roleFormats: { ...tpl.roleFormats, "wrapper.sealBand": preset.roleFormats["wrapper.sealBand"] as never },
    }));
    const band = sealBandCells(r.doc).flatMap((c) => runs(c)).filter((x) => x.text.trim() !== "");
    expect(band.length).toBeGreaterThan(0);
    for (const x of band) expect(szOf(x.rPr)).toBe("13");
  });
});
