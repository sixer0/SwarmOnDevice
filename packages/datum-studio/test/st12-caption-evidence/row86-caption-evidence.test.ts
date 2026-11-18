// @ts-nocheck fixtures are loose records (same convention as the ported suites); checked at run time.
// Swarm 1.3.3 row 86 (ST-12, register 03 s7): D23, a warning when a number or name of a figure caption is not found in
// the figure, its key, or the table block directly below it. Registry row and check land together (decision C10).
import { useStudioEnv } from "../ported/_env"; useStudioEnv();
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LINT_REGISTRY } from "@/lib/studio/registry/lint";
import { defaultEnforcement } from "@/lib/studio/engine/lint/structure/enforcement";
import { STRUCTURE_CHECKS, lintStructureWith, structureCoverageGaps } from "@/lib/studio/engine/lint/structure";
import { captionClaims, judgeCaption, numberReadings } from "@/lib/studio/engine/lint/structure/checks-caption";
import { canonicalTemplate, makeDoc, snapshotOf } from "../ported/engine-core/fixtures";

const ID = "D23";
// Row 38's transcription of the manual's master schedule (sheet 347): 14 tasks, 5 milestones, status week 10, CP 27.
const SCHED = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "st2-w07-schedule", "fixtures", "r8_p347_master_schedule.json"), "utf8")).block;
const chartSpec = (data: any, title = "Jadwal induk.") => ({ $schema: "studio.chart/v1", kind: "W-07", title, source: "Uji row 86", widthMm: 128, data });
const GOOD = "Jadwal 14 tugas dan 5 milestone dengan status minggu ke-10; jalur kritis 27 minggu.";
const BAD = "Jadwal 15 tugas dan 5 milestone dengan status minggu ke-10; jalur kritis 27 minggu.";

const diagram = (caption: string, extra: any = {}) => ({
  type: "diagram",
  caption: { inline: { text: caption } },
  source: { inline: { text: "SUMBER uji internal." } },
  spec: {
    $schema: "studio.diagram/v1", family: "flow", id: "9.1", title: caption, classification: "BIASA", width_mm: 166, apparatus: "page",
    labels_verified: true, sources: ["Uji row 86"],
    nodes: [
      { id: "a", label: "Switch SW-01", sub: "48 port", class: { col: 0, row: 0 } },
      { id: "b", label: "Server", sub: "3,5 kW", class: { col: 0, row: 1 } },
    ],
    edges: [{ from: "a", to: "b", kind: "data", label: "10G" }],
    ...extra,
  },
});
const table = (cells: string[][]) => ({
  type: "table",
  caption: { inline: { text: "Jadwal kabel." } },
  source: { inline: { text: "SUMBER uji internal." } },
  columns: [{ widthMm: 96, role: "text", align: "left" }, { widthMm: 32, role: "numeral", align: "right" }],
  rows: [{ kind: "header", cells: [{ text: "Butir" }, { text: "Nilai" }] }, ...cells.map((r) => ({ kind: "body", cells: r.map((t) => ({ text: t })) }))],
});
let KAN: any;
beforeAll(() => { KAN = canonicalTemplate(); });
const lint = (blocks: any[], tier = "TERBIT") => lintStructureWith(snapshotOf(makeDoc({ tier, blocks })), KAN, tier, { only: [ID] });

describe("row 86: registry row and check land together", () => {
  test("D23 once, group D, structure, TERBIT and SERAH, limit lapor (REPORT, never FAIL), partial", () => {
    const rows = LINT_REGISTRY.filter((d) => d.id === ID);
    expect(rows).toHaveLength(1);
    const d = rows[0];
    expect([d.group, d.module, [...d.tiers], d.limit, d.partial, d.blocksIngest, d.notRunReason]).toEqual(["D", "structure", ["TERBIT", "SERAH"], "lapor", true, false, undefined]);
    expect(defaultEnforcement(d)).toBe("report");
  });
  test("the check exists, no coverage gap", () => {
    expect(typeof STRUCTURE_CHECKS[ID]).toBe("function");
    expect(structureCoverageGaps()).toEqual([]);
  });
  test("C-36 staged marker removed (controller add-on): scanner present, notRunReason gone", () => {
    expect(LINT_REGISTRY.find((d) => d.id === "C-36")?.notRunReason).toBeUndefined();
  });
});

describe("row 86: claim grammar", () => {
  test("numbers with units and separators, codes, acronyms, capitalised names; figure number and units ignored", () => {
    const c = captionClaims("Gambar 3.2 menunjukkan 27 minggu, 128 mm, 3,5 kW dan 80 % pada SW-01 milik UPS di gedung Discern.");
    expect(c.map((x) => `${x.kind}:${x.text}`)).toEqual(["number:27", "number:128", "number:3,5", "number:80 %", "name:SW-01", "name:UPS", "name:Discern"]);
  });
  test("count words map to element kinds; digits inside codes are not numbers; ke-27 is 27", () => {
    const c = captionClaims("Ada 14 tugas, tujuh zona, 4 wadah pada lajur L2 dan SHA-256 sampai minggu ke-27.");
    expect(c.map((x) => `${x.kind}:${x.text}`)).toEqual(["count:14 tugas", "count:4 wadah", "number:27", "count:tujuh zona", "name:L2", "name:SHA-256"]);
  });
  test("readings tolerate Indonesian and English separators", () => {
    expect(numberReadings("1 000")).toEqual([1000]);
    expect(numberReadings("22,06")).toEqual([22.06]);
    expect(numberReadings("1.000").sort()).toEqual([1, 1000]);
    expect(numberReadings("40.8")).toEqual([40.8]);
  });
  test("a caption with no checkable claim has no claims and is quiet", () => {
    expect(captionClaims("Bukti masuk buku custody hanya setelah hash cocok; ketidakcocokan berujung karantina.")).toEqual([]);
    expect(lint([diagram("Aliran data berjalan dari switch ke server.")]).map((i) => i.status)).toEqual(["PASS"]);
  });
});

describe("row 86: the manual's schedule (row 38 fixture)", () => {
  test("pure judge: 14 tasks, 5 milestones, week 10, 27 weeks all found; 15 tasks is not", () => {
    expect(judgeCaption(GOOD, SCHED.data && chartSpec(SCHED.data)).filter((r) => !r.found)).toEqual([]);
    const bad = judgeCaption(BAD, chartSpec(SCHED.data)).filter((r) => !r.found);
    expect(bad.map((r) => r.claim.text)).toEqual(["15 tugas"]);
    expect(bad[0].how).toBe("count task = 14");
  });
  test("document lint: the chart block passes with the true caption and warns (REPORT) with 15 tugas", () => {
    const blk = (cap: string) => ({ type: "chart", caption: { inline: { text: cap } }, source: { inline: { text: "SUMBER manual." } }, widthMm: 128, spec: chartSpec(SCHED.data, cap) });
    expect(lint([blk(GOOD)]).map((i) => i.status)).toEqual(["PASS"]);
    const out = lint([blk(BAD)]);
    expect(out.map((i) => `${i.checkId}:${i.status}`)).toEqual(["D23:REPORT"]);
    expect(out[0].detail).toContain('"15 tugas"');
    expect(out[0].detail).toContain(BAD);
    expect(out[0].pointer!.endsWith("/caption")).toBe(true);
  });
});

describe("row 86: diagram, key and companion table", () => {
  test("found in labels and sub lines (3,5 kW written 3.5 in the caption, code SW-01)", () => {
    expect(lint([diagram("Server 3.5 kW menerima data dari SW-01.")]).map((i) => i.status)).toEqual(["PASS"]);
  });
  test("not found: names the claim and the caption; REPORT at TERBIT and SERAH, not run at NOTA", () => {
    for (const tier of ["TERBIT", "SERAH"]) {
      const out = lint([diagram("Server 7 kW menerima data dari SW-09.")], tier);
      expect(out.map((i) => i.status)).toEqual(["REPORT"]);
      expect(out[0].detail).toContain('"7", "SW-09"');
    }
    expect(lint([diagram("Server 7 kW menerima data dari SW-09.")], "NOTA")).toEqual([]);
  });
  test("found in the key row of the block", () => {
    const b = { ...diagram("Rak R07 memakai 42 U."), keyRow: { text: "Rak R07, tinggi 42 U." } };
    expect(lint([b]).map((i) => i.status)).toEqual(["PASS"]);
  });
  test("found in the table directly below; not in a table further down", () => {
    const cap = "Ring 384 m lewat kabel C-10.";
    expect(lint([diagram(cap), table([["C-10", "384 m"]])]).map((i) => i.status)).toEqual(["PASS"]);
    const out = lint([diagram(cap), { type: "paragraph", text: "Paragraf antara." }, table([["C-10", "384 m"]])]);
    expect(out.map((i) => i.status)).toEqual(["REPORT"]);
  });
  test("counts: zones counted, a wrong count warns", () => {
    const zones = { zones: [{ id: "z1", label: "Zona A", members: ["a"] }, { id: "z2", label: "Zona B", members: ["b"] }] };
    expect(lint([diagram("Dua zona memisahkan switch dan server.", zones)]).map((i) => i.status)).toEqual(["PASS"]);
    expect(lint([diagram("Tiga zona memisahkan switch dan server.", zones)]).map((i) => i.status)).toEqual(["REPORT"]);
  });
});
