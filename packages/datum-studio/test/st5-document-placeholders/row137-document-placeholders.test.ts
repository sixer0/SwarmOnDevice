// @ts-nocheck fixtures are loose records (same convention as the ported suites); checked at run time.
// Swarm 1.3.3 row 137 (ST-5, decision C19): an unfilled `{{key}}` that would PRINT in document text (prose, headings,
// table cells, captions, front matter) is caught in document lint and in the lint report of a render, under the same
// id as row 52's figure-spec refusal (`PLACEHOLDER_UNFILLED`, register 03 s7).
//
// Tier rule: a token in document text is FAIL at TERBIT and SERAH (release FAIL) and REPORT at NOTA (the draft tier:
// a warning, release not failed). A token in a diagram spec stays FAIL at every tier (row 52, unchanged).
//
// Template slots: a slot filled through the slot path (`studio.slot/v2`, R13 / `studio_slot_fill` -> mergeSubmission ->
// composeV2) holds its value when the check runs, so a filled slot never reaches it; a slot that would print a token
// (filled with a token, or a draft placeholder text that is a token) is caught like any other text.
import { useStudioEnv } from "../ported/_env"; useStudioEnv();
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";

const L = path.resolve(import.meta.dir, "..", "..", "vendor", "src", "lib", "studio");
const S = await import("../ported/structure/_kit");
const K = await import("../ported/renderers/_kit");
const { composeV2, mergeSubmission, seededPidAllocator } = await import("@/lib/studio/services/compose");
const { lintStructureWith, STRUCTURE_CHECKS, structureCoverageGaps } = await import("@/lib/studio/engine/lint/structure");
const { lintAfterRender, releaseFor } = await import("@/lib/studio/services/render/lint");
const { renderSnapshot } = await import("@/lib/studio/services/render/pure/render");
const { LINT_REGISTRY } = await import("@/lib/studio/registry/lint");
const runtime = await import(path.join(L, "engine", "browser", "runtime.ts"));

const ID = "PLACEHOLDER_UNFILLED";
const TOKEN = "{{nama_proyek}}";
const LOG = { info() {}, warn() {}, error() {} } as never;
const t = (text: string) => ({ text });

/** E1 (seven-slot GSP DATUM document) with optional edits to the submission before the slot merge. */
function source(edit?: (doc: any) => void) {
  const doc = S.e1();
  edit?.(doc);
  const { template: _t, ...sub } = doc;
  return sub;
}
function composeOf(sub: any, opts: { draft?: boolean; slotParams?: any; slots?: any } = {}) {
  const slots = opts.slots ?? S.datumSlots();
  return composeV2({
    source: S.merge(sub, undefined, { slots }).doc,
    skeleton: S.skeletonInput(slots),
    params: S.defaultParams(),
    ...(opts.draft ? { draft: true } : {}),
    ...(opts.slotParams ? { slotParams: opts.slotParams } : {}),
  }).snapshot;
}
const chapter2 = (doc: any) => doc.sections.content.chapters[1].sections[0].blocks;
/** The ST-5 fixture: `{{nama_proyek}}` left in a paragraph and in a table cell. */
const unfilled = () =>
  source((d) => {
    chapter2(d).push({ type: "paragraph", text: `Proyek ${TOKEN} dimulai pada 2026.` });
    chapter2(d)[1].rows[1].cells[0] = t(TOKEN);
  });
const filled = () =>
  source((d) => {
    chapter2(d).push({ type: "paragraph", text: "Proyek Gardu Induk Cikupa dimulai pada 2026." });
    chapter2(d)[1].rows[1].cells[0] = t("TD-1 Cikupa");
  });

let KAN: any;
beforeAll(async () => {
  KAN = await K.canonicalTemplate();
});
const lintOf = (snap: any, tier: string) => lintStructureWith(snap, KAN, tier as never, { only: [ID] });

describe("row 137: one id, one registry row, one check", () => {
  test("PLACEHOLDER_UNFILLED stays one registry row (all tiers: the check sets the status per tier) and has its check", () => {
    const rows = LINT_REGISTRY.filter((d) => d.id === ID);
    expect(rows).toHaveLength(1);
    expect([...rows[0].tiers]).toEqual(["NOTA", "TERBIT", "SERAH"]);
    expect(rows[0].limit).toBe("0 {{kunci}} belum terisi");
    expect(typeof STRUCTURE_CHECKS[ID]).toBe("function");
    expect(structureCoverageGaps()).toEqual([]);
  });
});

describe("row 137: a paragraph and a table cell with {{nama_proyek}}", () => {
  for (const tier of ["TERBIT", "SERAH"] as const) {
    test(`${tier}: FAIL for the paragraph and the cell, each naming the location and the token; release FAIL`, () => {
      const out = lintOf(composeOf(unfilled()), tier);
      expect(out.map((i) => `${i.checkId}:${i.status}`)).toEqual([`${ID}:FAIL`, `${ID}:FAIL`]);
      const [cell, para] = [out.find((i) => i.detail.includes("sel tabel")), out.find((i) => i.detail.includes(" di teks ("))];
      expect(cell?.detail).toContain(TOKEN);
      expect(cell?.detail).toContain("Tabel 2.1");
      expect(cell?.pointer).toMatch(/\/rows\/1\/cells\/0\/text$/);
      expect(para?.detail).toContain(TOKEN);
      expect(para?.pointer).toMatch(/\/blocks\/2\/text$/);
      expect(para?.address).toBeDefined();
      expect(releaseFor(out, tier)).toBe("FAIL");
    });
  }

  test("NOTA (draft): the same two findings are REPORT, a warning; release is not failed", () => {
    const out = lintOf(composeOf(unfilled()), "NOTA");
    expect(out.map((i) => i.status)).toEqual(["REPORT", "REPORT"]);
    expect(out.every((i) => i.detail.includes(TOKEN) && i.detail.includes("NOTA: dilaporkan saja"))).toBe(true);
    expect(releaseFor(out, "NOTA")).toBe("PASS");
  });

  test("filled values pass at every tier (the PASS detail is row 52's, unchanged)", () => {
    for (const tier of ["NOTA", "TERBIT", "SERAH"]) {
      expect(lintOf(composeOf(filled()), tier)).toEqual([{ checkId: ID, status: "PASS", detail: "0 diagram tanpa penanda {{kunci}} yang belum terisi" }]);
    }
  });

  test("headings, captions, sources, inline runs and front matter fields are read too", () => {
    const sub = source((d) => {
      d.meta.subject = `Survei ${TOKEN}`;
      d.sections.content.chapters[0].title = t(`Lingkup ${TOKEN}`);
      chapter2(d)[1].caption = t(`Suhu minyak ${TOKEN}`);
      chapter2(d)[0].runs[0].t = `Suhu ${TOKEN} `;
    });
    const out = lintOf(composeOf(sub), "TERBIT");
    const kinds = out.map((i) => i.detail.split(":")[0]);
    expect(out.every((i) => i.status === "FAIL" && i.detail.includes(TOKEN))).toBe(true);
    expect(out.some((i) => i.pointer === "/meta/subject")).toBe(true);
    expect(out.some((i) => /^\/chapters\/0\/title\/text$/.test(String(i.pointer)))).toBe(true);
    expect(out.some((i) => /\/caption\/(inline\/)?text$/.test(String(i.pointer)) && i.detail.includes("caption"))).toBe(true);
    expect(out.some((i) => /\/runs\/0\/t$/.test(String(i.pointer)))).toBe(true);
    expect(kinds.length).toBeGreaterThanOrEqual(4);
  });

  test("not a placeholder, never reported: single braces, spaced braces, empty and non-key contents", () => {
    const sub = source((d) => {
      chapter2(d).push({ type: "paragraph", text: "Teks {nama}, { {kunci} }, {{}}, {{a b}}, {{#each x}} dan ${nama} dicetak apa adanya." });
    });
    expect(lintOf(composeOf(sub), "TERBIT").map((i) => i.status)).toEqual(["PASS"]);
  });
});

describe("row 137: template slots", () => {
  const slotFill = (current: any, slot: string, payload: any) =>
    mergeSubmission(current, { $schema: "studio.slot/v2", target: { documentId: "d" }, slot, payload } as never, {
      skeleton: S.skeletonInput(),
      tier: "TERBIT",
      pids: seededPidAllocator("row137"),
    }).doc;
  const withCover = (titleLine: string) => {
    const sub = source((d) => {
      delete d.sections.cover;
    });
    const base = S.merge(sub, undefined, { slots: S.datumSlots() }).doc;
    const doc = slotFill(base, "cover", { type: "cover", titleLines: [t(titleLine), t("Kondisi Peralatan 150 kV")], standfirst: t("Kondisi peralatan primer.") });
    return composeV2({ source: doc, skeleton: S.skeletonInput(), params: S.defaultParams() }).snapshot;
  };

  test("a slot filled through the slot path (studio.slot/v2 -> merge -> compose) never reaches the check", () => {
    const snap = withCover("Proyek Gardu Induk Cikupa");
    expect(JSON.stringify(snap.doc.front.cover)).toContain("Proyek Gardu Induk Cikupa");
    expect(lintOf(snap, "TERBIT").map((i) => i.status)).toEqual(["PASS"]);
  });

  test("the same slot filled with the token would print it: FAIL at TERBIT, pointer in the cover", () => {
    const out = lintOf(withCover(TOKEN), "TERBIT");
    expect(out.map((i) => i.status)).toEqual(["FAIL"]);
    expect(out[0].pointer).toMatch(/^\/front\/cover\//);
    expect(out[0].detail).toContain("halaman depan");
  });

  test("an empty required slot whose draft placeholder text is a token is caught (the slotPlaceholder block prints it)", () => {
    const sub = source((d) => {
      delete d.sections.controlSheet;
    });
    const slotParams = { controlSheet: { ...S.defaultParams(), "slot.placeholderText": "{{lembar_kendali}}" } };
    const snap = composeOf(sub, { draft: true, slotParams });
    expect(snap.blocks.some((b: any) => b.type === "slotPlaceholder" && b.content.text === "{{lembar_kendali}}")).toBe(true);
    const nota = lintOf(snap, "NOTA");
    expect(nota.map((i) => i.status)).toEqual(["REPORT"]);
    expect(nota[0].detail).toContain("{{lembar_kendali}}");
    expect(nota[0].address).toBe("F:controlSheet");
    expect(lintOf(snap, "TERBIT").map((i) => i.status)).toEqual(["FAIL"]);
  });
});

// Fake render bridge (no Electron), as test/st4-offpage-pairing.
const HELLO = { ok: true, electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 20, scripts: ["studio.measure"] };
const fakeBridge = async (req: any) => {
  if (req.op === "hello") return HELLO;
  if (req.op === "png") {
    writeFileSync(String(req.dst), K.makePng(Number(req.width), Number(req.height)));
    return { ok: true, electron: "42.3.3", dst: req.dst, width: req.width, height: req.height };
  }
  return { ok: false, code: "UNKNOWN_OP", message: "?" };
};

describe("row 137: render", () => {
  beforeAll(() => runtime.setRenderBridgeTransport(fakeBridge));
  afterAll(() => runtime.setRenderBridgeTransport(null));

  test("lint report of the render: FAIL rows and release FAIL at TERBIT; REPORT and release not failed at NOTA", () => {
    const snap = composeOf(unfilled());
    const terbit = lintAfterRender({ snapshot: snap, tpl: KAN, tier: "TERBIT", svgs: [], log: LOG } as never);
    expect(terbit.checks.filter((c) => c.checkId === ID).map((c) => c.status)).toEqual(["FAIL", "FAIL"]);
    expect(terbit.releaseStatus).toBe("FAIL");
    const nota = lintAfterRender({ snapshot: snap, tpl: KAN, tier: "NOTA", svgs: [], log: LOG } as never);
    expect(nota.checks.filter((c) => c.checkId === ID).map((c) => c.status)).toEqual(["REPORT", "REPORT"]);
  });

  test("a real document render at TERBIT reports the token in its lint (release FAIL); the filled document has no row FAIL", async () => {
    const bad = await renderSnapshot(composeOf(unfilled()) as never, KAN, { formats: ["HTML"], measureLayout: false, tier: "TERBIT" });
    const rows = (bad.lint?.checks ?? []).filter((c) => c.checkId === ID);
    expect(rows.map((c) => c.status)).toEqual(["FAIL", "FAIL"]);
    expect(rows.every((c) => c.detail.includes(TOKEN))).toBe(true);
    expect(bad.lint?.releaseStatus).toBe("FAIL");
    const good = await renderSnapshot(composeOf(filled()) as never, KAN, { formats: ["HTML"], measureLayout: false, tier: "TERBIT" });
    expect((good.lint?.checks ?? []).filter((c) => c.checkId === ID).map((c) => c.status)).toEqual(["PASS"]);
  }, 120_000);
});
