// Row 49a (Swarm 1.2.0, decision C104 H1 + M1), HTML/PDF engine. Twin of classification-docx.test.ts.
// H1: Manual Rev A DT-28d (WAJIB, research/manual_rev_a/manual_id.txt:667-669, :5093): classification text in seal
// #6E1420, bold, never alert #9B1C1C (:3947). Before row 49a the HTML took `color.classificationInk`
// {SR: alert, R: alert, T: ink900, B: ink900}, so RAHASIA printed #9B1C1C and TERBATAS #101418, and a bold {kelas}
// in the screen register took `.reg b` ink900.
// "Computed" here = the colour the cascade gives each element, resolved from the engine's own CSS in the rendered
// artefact (no browser is launched): the PDF is Chromium's print of this same HTML, so the @page margin boxes are
// the PDF running head and register, and `.runhead` / `.reg` are the screen twins.
// M1: seal band text 6,5 pt (Tab A.2 "pita segel 6,4", :4920; C54 half-point rule); was 6pt.
import { describe, expect, test } from "bun:test";
import type { StudioDocV1 } from "../../../vendor/src/lib/studio/contract";
import { cssOf, loadFixture, renderHtml } from "../html/_kit";

const SEAL = "#6E1420";
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

/** Rules as [selector, body] in source order (flat rules; @page bodies are taken whole). */
const rules = (css: string): Array<[string, string]> => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);

/** Last value of `prop` in a declaration body. */
const declOf = (body: string, prop: string): string | undefined => [...body.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "g"))].map((m) => m[1].trim()).at(-1);

/** `var(--x)` -> the last `:root` value of --x (the shell's per-document :root comes after the base CSS). */
function resolveVar(css: string, v: string): string {
  const m = /^var\((--[\w-]+)\)$/.exec(v);
  if (!m) return v;
  const values = rules(css).filter(([s]) => s === ":root").map(([, b]) => declOf(b, m[1])).filter((x): x is string => x !== undefined);
  return values.at(-1) ?? v;
}

/**
 * Cascade for one element: of the candidate selectors that match it, the one with the highest specificity wins,
 * later in source order on a tie. Returns the resolved colour of the winning `color` declaration.
 */
function cascadeColour(css: string, candidates: ReadonlyArray<{ selector: string; specificity: number }>): string | undefined {
  const all = rules(css);
  let best: { spec: number; idx: number; value: string } | undefined;
  for (const c of candidates) {
    all.forEach(([s, b], idx) => {
      if (!s.split(",").map((x) => x.trim()).includes(c.selector)) return;
      const value = declOf(b, "color");
      if (value === undefined) return;
      if (!best || c.specificity > best.spec || (c.specificity === best.spec && idx > best.idx)) best = { spec: c.specificity, idx, value };
    });
  }
  return best ? resolveVar(css, best.value) : undefined;
}

/** The @page margin box declaration `@<box>{content:"<mark>";...}` (PDF running head / register). */
const marginBoxes = (css: string, box: string, mark: string): string[] =>
  [...css.matchAll(new RegExp(`@${box}\\{content:"${mark}";([^}]*)\\}`, "g"))].map((m) => m[1]);

describe("H1 HTML/PDF classification text is seal #6E1420 bold at every level (Rev A DT-28d)", () => {
  for (const level of LEVELS) {
    test(`${level.label}: PDF margin boxes, screen running head and register, cover line`, async () => {
      const r = await renderHtml(withLevel(level.label));
      const css = cssOf(r.html);
      // PDF (print): running head top-right and register bottom-right margin boxes.
      for (const box of ["top-right", "bottom-right"]) {
        const decls = marginBoxes(css, box, level.mark);
        expect(decls.length).toBeGreaterThan(0);
        for (const d of decls) {
          expect(resolveVar(css, declOf(d, "color") ?? "")).toBe(SEAL);
          expect(declOf(d, "font-weight")).toBe("600"); // bold slot = Plex SemiBold (fonts.ts R-08), as DOCX <w:b/>
        }
      }
      // Screen running head: <span class="cls"> inside .runhead.
      expect(r.html).toContain(`<span class="cls">${level.mark}</span>`);
      expect(cascadeColour(css, [{ selector: ".runhead .cls", specificity: 20 }, { selector: ".runhead > span", specificity: 11 }])).toBe(SEAL);
      // Screen register: the {kelas} element is <b class="cls"> in the last cell; rules matching a b.cls in .reg.
      const kelas = new RegExp(`<div class="reg[^"]*">(?:(?!</div></div>)[\\s\\S])*<b class="cls">${level.mark}</b></div></div>`);
      expect(r.html).toMatch(kelas);
      expect(cascadeColour(css, [{ selector: ".reg b", specificity: 11 }, { selector: ".reg .cls", specificity: 20 }])).toBe(SEAL);
      // Cover: the line under the document number (row 123, DT-28c) is seal as well.
      expect(r.unit("cover")).toMatch(new RegExp(`<span[^>]*style="[^"]*color:${SEAL}[^"]*"[^>]*>${level.mark}</span>`));
      // The per-document class ink is seal; alert never appears as the class ink.
      const roots = rules(css).filter(([s]) => s === ":root").map(([, b]) => declOf(b, "--class-ink")).filter(Boolean);
      expect(roots.length).toBeGreaterThan(0);
      for (const v of roots) expect(v).toBe(SEAL);
    });
  }

  test("RAHASIA is not alert #9B1C1C in any classification declaration", async () => {
    const css = cssOf((await renderHtml(withLevel("RAHASIA"))).html);
    for (const box of ["top-right", "bottom-right"]) for (const d of marginBoxes(css, box, "RAHASIA")) expect(declOf(d, "color")).not.toBe("#9B1C1C");
    expect(css).not.toContain("--class-ink:#9B1C1C");
  });
});

describe("M1 HTML seal band text 6,5 pt (Rev A Tab A.2 pita segel 6,4)", () => {
  test("the band on cover, control sheet and contents prints at 6.5pt, #F4F5F6", async () => {
    const r = await renderHtml();
    for (const kind of ["cover", "controlSheet", "toc"]) {
      const band = /<div class="st-device st-seal-band[^>]*>/.exec(r.unit(kind))?.[0] ?? "";
      expect(band).not.toBe("");
      const style = /style="([^"]*)"/.exec(band)?.[1] ?? "";
      expect(style).toContain("font-size:6.5pt");
      expect(style).toContain("color:#F4F5F6");
    }
  });
});
