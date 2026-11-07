/**
 * Modul engine/lint/scan (I34, 01_specs.md §8.2), diisi S44.
 *
 * - `runLint`: runner lint (status PASS / FAIL / NOT_RUN / REPORT, banner,
 *   status rilis per tier P16-01; tidak menahan berkas, A10). Menjalankan
 *   pemindai teks X dan guard B milik modul ini, lalu modul struktur (S46) dan
 *   bahasa (S47); modul yang belum tersedia atau gagal dilaporkan NOT_RUN
 *   dengan alasannya. Cek render R (S45) butuh metrik tata letak: pada tahap
 *   `post` ditambahkan pemanggil (S51), pada tahap `ingest` dilaporkan NOT_RUN.
 * - `scanText`: pemindai teks lepas (DATUM-03 laju, 16, 17, 19, 31, 39).
 * - `byConstructionChecks`: cek ingest pemblokir milik modul scan (G1-G3 dengan
 *   sub-cek G4, N1, DATUM-04, 19, 31, 38; `blocksIngest` registri), disaring
 *   keputusan penahan seragam `ingestPolicy` (./enforcement; IP-06): override
 *   penegakan profil/dokumen (S46) dan aturan pengaman D-34 benchmark.
 * - Override penegakan "report"/"off" profil templat juga diterapkan ke temuan
 *   scan dan bahasa di `runLint` (struktur menerapkannya sendiri), sehingga
 *   satu override berlaku sama di semua modul.
 *
 * Acuan perilaku (read-only): HS scripts/datum_lint.py, datumcheck.py.
 * Guard tabel G1-G4 memakai implementasi I06 `tableGuards` (S17, port
 * datumcheck.table_guards) agar satu sumber kebenaran.
 */
import type {
  LintIssue,
  LintReport,
  NormDocSnapshot,
  ParamMap,
  ResolvedTemplate,
  StudioDocV1,
  StudioTier,
} from "../../../contract";
import { okWidthsMm, tableGuards } from "../../docx/tables";
import { lintLanguage } from "../language";
import { applyEnforcement, lintStructure, resolveEnforcement } from "../structure";
import { LINT_REGISTRY } from "../../../registry/lint";
import {
  check03,
  check04,
  check16,
  check17,
  check19,
  check31,
  check39,
  checkNames,
  joinSegments,
  paramNumber,
  type Finding,
} from "./checks";
import { assembleLintReport, collapseIssues, type LintModule } from "./runner";
import { ingestPolicy } from "./enforcement";
import { documentNames, walkDocument, type TextSegment } from "./walk";

export {
  assembleLintReport,
  aggregateStatus,
  appliesToTier,
  collapseIssues,
  releaseStatusFor,
  notRunReasonFor,
  type AssembleInput,
  type LintModule,
  type LintStage,
} from "./runner";
export { emDashLimits, emDashRate, questionHeading, find16, find39, paramValue } from "./checks";
export { walkDocument, documentNames, type NameRef, type TextSegment, type TableRef, type DocWalk } from "./walk";
export { D34_NOTE, INTEGRITY_CHECKS, ingestPolicy, isBenchmarkDoc, type IngestDecision, type IngestPolicy } from "./enforcement";

/** Cek teks X modul scan yang dijalankan atas dokumen. */
export const SCAN_TEXT_CHECKS = ["DATUM-03", "DATUM-04", "DATUM-16", "DATUM-17", "DATUM-19", "DATUM-31", "DATUM-38", "DATUM-39"] as const;
/** Guard titik panggil grup B. */
export const SCAN_GUARD_CHECKS = ["G1", "G2", "G3", "N1"] as const;

/** Semua cek registri milik modul scan. */
export const SCAN_REGISTRY_CHECKS: readonly string[] = LINT_REGISTRY.filter((d) => d.module === "scan").map((d) => d.id);

/** Cek modul scan yang menolak ingest menurut default registri (`blocksIngest`; override: `ingestPolicy`). */
export const SCAN_BLOCKING_CHECKS: readonly string[] = LINT_REGISTRY.filter((d) => d.module === "scan" && d.blocksIngest).map(
  (d) => d.id,
);

function toIssues(ids: readonly string[], findings: readonly Finding[], passDetail?: Partial<Record<string, string>>): LintIssue[] {
  const out: LintIssue[] = [];
  for (const id of ids) {
    const f = findings.filter((x) => x.checkId === id);
    if (f.length === 0) {
      const d = passDetail?.[id];
      out.push({ checkId: id, status: "PASS", ...(d ? { detail: d } : {}) });
      continue;
    }
    for (const x of f) {
      out.push({
        checkId: id,
        status: "FAIL",
        detail: x.detail,
        ...(x.address ? { address: x.address } : {}),
        ...(x.pointer ? { pointer: x.pointer } : {}),
      });
    }
  }
  return out;
}

/** Pemindaian teks X atas segmen dokumen (DATUM-03, 04, 16, 17, 19, 31, 39). */
function textFindings(segments: readonly TextSegment[], params: ParamMap): Finding[] {
  const body = joinSegments(segments);
  return [
    ...check03(body, params),
    ...check04(segments),
    ...check16(segments),
    ...check17(body),
    ...check19(body, params),
    ...check31(body),
    ...check39(segments),
  ];
}

/** Guard G1-G3 (+G4 sub G3) atas setiap blok tabel, dan N1 atas nama dokumen. */
function guardIssues(doc: StudioDocV1, tables: ReturnType<typeof walkDocument>["tables"], params: ParamMap): LintIssue[] {
  const out: LintIssue[] = [];
  const numeralsPt = paramNumber(params, "type.scale.tableNumerals.size", 7.8);
  // G2: lebar sah turunan kertas (D-245 H1), bukan konstanta A4.
  const okWidths = okWidthsMm(params["grid.allowedFigureWidthsMm"]);
  // P5-14 turunan; absen = lebar sah pertama turunan (kolom teks), lalu bawaan registri di tableGuards (tanpa literal A4).
  const sum = params["table.columnWidthSumMm"];
  const totalMm = typeof sum === "number" && Number.isFinite(sum) && sum > 0 ? sum : okWidths?.[0];
  for (const t of tables) {
    for (const g of tableGuards(t.block, { ...(totalMm !== undefined ? { totalMm } : {}), numeralsPt, ...(okWidths ? { okWidthsMm: okWidths } : {}) })) {
      out.push({
        ...g,
        address: g.address ?? t.address,
        pointer: g.pointer ? `${t.pointer}${g.pointer}` : t.pointer,
      });
    }
  }
  if (tables.length === 0) {
    for (const id of ["G1", "G2", "G3"]) out.push({ checkId: id, status: "PASS", detail: "0 tabel" });
  }
  out.push(...toIssues(["N1"], checkNames("N1", documentNames(doc), params)));
  return out;
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.name === "StudioNotImplemented" ? `${e.name} (${e.message})` : `${e.name}: ${e.message}`;
  return String(e);
}

/** Semua cek milik modul scan atas satu dokumen (X + B), belum diringkas. */
function scanDocument(doc: StudioDocV1, params: ParamMap, snapshot?: NormDocSnapshot): LintIssue[] {
  const walk = walkDocument(doc, snapshot);
  const findings = [...textFindings(walk.segments, params), ...checkNames("DATUM-38", documentNames(doc), params)];
  const textIds = SCAN_TEXT_CHECKS as readonly string[];
  return [...toIssues(textIds, findings), ...guardIssues(doc, walk.tables, params)];
}

export function runLint(i: {
  snapshot: NormDocSnapshot;
  tpl: ResolvedTemplate;
  tier: StudioTier;
  stage: "ingest" | "post";
}): LintReport {
  const params = i.tpl?.params ?? {};
  const issues: LintIssue[] = [];
  const moduleErrors: Partial<Record<LintModule, string>> = {};
  // Override penegakan S46 (profil + dokumen); struktur menerapkannya sendiri.
  const enforcement = resolveEnforcement(i.tpl, i.snapshot?.doc);
  const enforce = (xs: LintIssue[]): LintIssue[] =>
    Object.keys(enforcement.overrides).length > 0 ? applyEnforcement(xs, enforcement) : xs;

  try {
    issues.push(...enforce(scanDocument(i.snapshot.doc, params, i.snapshot)));
  } catch (e) {
    // Cacat instrumen dilaporkan, bukan disembunyikan (datum_lint.py ERROR -> NOT_RUN di sini).
    moduleErrors.scan = errMessage(e);
  }
  try {
    issues.push(...lintStructure(i.snapshot, i.tpl, i.tier));
  } catch (e) {
    moduleErrors.structure = errMessage(e);
  }
  try {
    issues.push(...enforce(lintLanguage(i.snapshot, params)));
  } catch (e) {
    moduleErrors.language = errMessage(e);
  }

  return assembleLintReport({
    tier: i.tier,
    stage: i.stage,
    issues,
    params,
    external: i.stage === "post" ? ["render"] : [],
    moduleErrors,
  });
}

export function scanText(text: string, params: ParamMap): LintIssue[] {
  const seg: TextSegment = { address: "", pointer: "", heading: false, text };
  const body = joinSegments([seg]);
  const findings = [...check03(body, params), ...check16([seg]), ...check17(body), ...check19(body, params), ...check31(body), ...check39([seg])];
  return toIssues(["DATUM-03", "DATUM-16", "DATUM-17", "DATUM-19", "DATUM-31", "DATUM-39"], findings);
}

/**
 * Cek by-construction modul scan untuk ingest/revisi (422, A10): hanya cek
 * modul scan yang MENAHAN dokumen ini menurut `ingestPolicy` (IP-06): mode
 * efektif "block" (default registri `blocksIngest`, ditimpa
 * `lint.enforcementOverride` profil `tpl` dan `doc.x.lintEnforcement`) dan
 * berlaku untuk tier dokumen (G1 semua tier). Dokumen benchmark D-34
 * (`x.benchmark`, `x.enforcement="report"`, atau `opts.benchmark`) tidak
 * menahan apa pun: temuannya tetap FAIL di `runLint` (status rilis).
 *
 * Parameter = `tpl.params` (bila ada) ditimpa `doc.overrides` (hak override
 * sudah divalidasi layanan). Grup S struktur (mis. DATUM-10, 26) milik
 * engine/lint/structure (S46). Tanpa `tpl` hanya override dokumen yang berlaku.
 */
export function byConstructionChecks(
  doc: StudioDocV1,
  tpl?: Pick<ResolvedTemplate, "params">,
  opts?: { benchmark?: boolean },
): LintIssue[] {
  const params: ParamMap = { ...(tpl?.params ?? {}), ...(doc.overrides ?? {}) };
  const policy = ingestPolicy(doc, tpl, opts);
  if (policy.benchmark) return [];
  const tier = doc.meta?.tier;
  const blocking = new Set(SCAN_REGISTRY_CHECKS.filter((id) => policy.blocks(id, tier)));
  return collapseIssues(scanDocument(doc, params).filter((x) => blocking.has(x.checkId)));
}
