/**
 * Gerbang by-construction BERSAMA untuk setiap penulisan konten v2 (SR-55 H1 /
 * F-065, FIX-S; D-34, D-98, D-131, D-134, A10).
 *
 * Satu fungsi, dipanggil atas snapshot norm/v2 HASIL GABUNG sebelum revisi
 * ditulis:
 *  - R04 ingest (`ingest/v2.ts` `runPipeline`, juga dryRun/validate);
 *  - R12/R13 kiriman bab/slot dan R04 bertarget/misi (`submit/pipeline.ts`
 *    `applyInLock`, di dalam transaksi berkunci sebelum `studioRevision.create`);
 *  - R16 sunting pid, R06 PATCH alamat dokumen v2, dan R14 op struktur
 *    (`revisions/v2/commit.ts` `commitV2Revision`, di dalam transaksi).
 *
 * Isi gerbang (sama dengan R04 sejak S48/INT-C/FIX-1):
 *  1. intrinsik: G1 + DATUM-10 (`tableChecks`), cacat entri register DATUM-11 dan
 *     audit turunan D03 (`bindRegister`; rujukan kunci tak terdaftar dinilai lint
 *     struktur DATUM-11 + kelayakan render, seperti R04);
 *  2. `runGate`: 32 cek `blocksIngest` registri (28 DATUM + G1-G3, N1) lewat
 *     `byConstructionChecks` + `runLint({ stage: "ingest" })`, keputusan penahan
 *     satu sumber `ingestPolicy` (override profil, `x.lintEnforcement` tepercaya,
 *     D-34 benchmark tepercaya);
 *  3. `renderFeasibilityBlockers` (D03 turunan tak terbangun; integritas).
 *
 * Kepercayaan: pemanggil membuang penanda tersimpan/terkirim untuk penulis tidak
 * tepercaya SEBELUM memanggil (D-134 R-01), jadi mode "report" (D-34) hanya dapat
 * berasal dari penanda/opsi milik pemanggil tepercaya.
 *
 * D-131 (kiriman parsial selalu diterima): cek yang FAIL-nya bergantung pada
 * kelengkapan dokumen (`COMPLETENESS_DEPENDENT_CHECKS`: LD-01 slot wajib kosong,
 * LD-02 celah kunci bab) TIDAK PERNAH menahan selama dokumen belum lengkap, juga
 * bila profil templat menaikkannya ke "block"; temuannya tetap tercatat di
 * laporan lint (peringatan) dan menentukan status rilis/render penuh. Semua cek
 * lain menilai sifat elemen yang ADA (ketiadaan isi = tanpa temuan), sehingga
 * berlaku penuh pada kiriman parsial.
 *
 * Ukuran figur medan v1 (D-271, FIX-X): `v1FigureSizeIssues` menilai lebar/tinggi
 * figur `studio.doc/v1` terhadap grid TURUNAN templat terpatok saat ingest, sebelum
 * adaptor SR-09 membuang medan ukuran (lebar v2 milik templat), sehingga lebar di luar
 * himpunan turunan ditolak dini dengan kode yang sama (422 `BY_CONSTRUCTION_FAILED`).
 *
 * Kontrak dokumen (DC-08; register 05 §5.6, §13.1): HANYA dokumen bertemplat ber-contractKind
 * (MX08 / konteks compose, selain itu entri C58 per slug templat) dengan slot aktif bertipe
 * `contractRecord` (slot `record`) yang terisi. Dokumen lain: nol target, nol isu, perilaku sama.
 *  - langkah 6b, murni (`evaluateByConstruction` -> `contract`): I54 `checkContractRecord`;
 *    isu CH-01..CH-04 -> 400 `SCHEMA_INVALID` (checkId register, `keyword` = checkId), bila
 *    kosong `items[].key` ganda -> 422 EC27 `CONTRACT_ITEM_KEY_DUPLICATE` (details register);
 *  - langkah 9a (`assertByConstructionAsync` dengan `contractRefs`): I55 `resolveContractRefs`
 *    lewat reader BACA SAJA milik pemanggil (klien transaksi / R08 READ ONLY) -> 422 EC25/EC26,
 *    pid pensiun = peringatan CW-01 di `contract.warnings`;
 *  - langkah 9: penahan by-construction yang ada (422 `BY_CONSTRUCTION_FAILED`).
 * `assertByConstruction` (sinkron) menegakkan 6b lalu 9; I55 butuh I/O sehingga hanya lewat
 * varian async. EC28 `CHART_CUSTOM_FORM_UNSUPPORTED` dilempar compose (D-374) SEBELUM gerbang;
 * `withChartCustomPointer` melengkapi `details.pointer` dari sumber kiriman (pemanggil compose).
 */
import type {
  ChartDataShape,
  DocMeta,
  LintIssue,
  LintReport,
  NormDocSnapshot,
  NormDocSnapshotV2,
  ParamMap,
  ResolvedTemplate,
  StudioTier,
  ValidationIssue,
} from "../../contract";
import type { ContractKind } from "../../contract/enums";
import { StudioEngineError } from "../../contract/errors";
import type { ChartCustomFormV2, ContractRecordPayloadV2, SubmitWarningV2 } from "../../contract/types/v2/contract";
import { allowedWidthsText, figureLimits, isAllowedWidth, type FigureLimits } from "../../engine/chart/core/guards";
import { CHART_CUSTOM_FORM_IDS, resolveChartCustom } from "../../registry/charts";
import { CONTRACT_KIND_DEFS, CONTRACT_RECORD_SECTION_TYPE, isContractKind } from "../../registry/contracts";
import { checkContractRecord, resolveContractRefs, summarizeContractChecks, type ContractRefReader, type ResolvedContractRef } from "../contracts";
import { bindRegister, renderFeasibilityBlockers, tableChecks } from "./checks";
import { resolveIngestEnforcement, runGate, type IngestEnforcement } from "./gate";
import { isObject, joinPointer } from "./util";

/** Cek lint yang FAIL-nya hanya karena isi belum dikirim (D-131): tidak menahan selama INCOMPLETE. */
export const COMPLETENESS_DEPENDENT_CHECKS: ReadonlySet<string> = new Set(["SLOT_CONTENT_MISSING", "CONTENT_CHAPTER_GAP"]);

/** Catatan detail untuk cek bergantung kelengkapan yang ditunda. */
export const DEFERRED_UNTIL_COMPLETE_NOTE = "ditunda sampai dokumen lengkap (D-131)";

export interface ByConstructionInput {
  /** Snapshot norm/v2 hasil gabung (keluaran `composeV2`). */
  snapshot: NormDocSnapshotV2;
  /** Templat terpatok dokumen (versi yang juga dipakai render). */
  tpl: ResolvedTemplate;
  tier: StudioTier;
  /** true bila kelengkapan revisi yang akan ditulis = COMPLETE. */
  complete: boolean;
  /** Opsi penegakan pemanggil TEPERCAYA (D-34); pemanggil tidak tepercaya: undefined. */
  enforcement?: IngestEnforcement;
  /** Temuan intrinsik tambahan pemanggil (mis. P3-20 mode report ingest). */
  intrinsic?: readonly LintIssue[];
  /** Temuan REPORT gerbang kepercayaan untuk ditempel ke laporan lint. */
  notices?: readonly LintIssue[];
  /** Prefiks pointer register (bawaan `/register`). */
  registerPointer?: string;
  /**
   * DC-08: jenis kontrak templat (MX08 `StudioTemplate.contractKind`) bila pemanggil
   * mengetahuinya; absen = konteks compose snapshot, lalu entri C58 per slug templat.
   */
  contractKind?: string | null;
  /**
   * DC-08: pointer payload slot `contractRecord` di badan kiriman (mis. kiriman slot:
   * `/payload`); bawaan `/sections/<slotKey>` (bentuk `studio.doc/v2`).
   */
  contractPointer?: (slotKey: string) => string;
  correlationId: string;
}

/** Payload `contractRecord` yang dinilai gerbang (satu per slot aktif terisi). */
export interface ContractRecordTarget {
  slotKey: string;
  kind: ContractKind;
  payload: ContractRecordPayloadV2;
  /** Pointer payload di badan kiriman (prefiks isu I54/I55). */
  pointer: string;
}

/** Hasil langkah kontrak gerbang (§5.6). Dokumen non-kontrak: `targets` kosong, sisanya kosong. */
export interface ContractGateResult {
  targets: ContractRecordTarget[];
  /** I54 CH-01..CH-04 -> 400 `SCHEMA_INVALID` (didahulukan). */
  issues: ValidationIssue[];
  /** I54 EC27 (hanya bila `issues` kosong). */
  error?: StudioEngineError;
  /** I55 per slot (hanya varian async dengan reader). */
  refs: Array<{ slotKey: string; resolved: ResolvedContractRef[] }>;
  /** CW-01 `CONTRACT_REF_PID_RETIRED` (KD-46; non-penahan). */
  warnings: SubmitWarningV2[];
}

export interface ByConstructionResult {
  lint: LintReport;
  /** Penahan (422 `BY_CONSTRUCTION_FAILED`). */
  blocking: ValidationIssue[];
  /** Penahan yang diturunkan D-34 (pemanggil tepercaya, benchmark). */
  downgraded: LintIssue[];
  /** Penahan bergantung kelengkapan yang ditunda selama INCOMPLETE (D-131). */
  deferred: LintIssue[];
  enforcement: IngestEnforcement;
  /** DC-08: langkah kontrak (6b; 9a pada varian async). */
  contract: ContractGateResult;
}

/** Jalankan gerbang by-construction atas snapshot hasil gabung (tanpa I/O, tanpa lempar). */
export function evaluateByConstruction(i: ByConstructionInput): ByConstructionResult {
  // Lint scan membaca bentuk v1 (doc/units/blocks); struktur SR-18 membaca norm/v2 apa adanya.
  const view = i.snapshot as unknown as NormDocSnapshot;
  const enforcement = resolveIngestEnforcement(i.snapshot.doc, i.enforcement);
  const registerPointer = i.registerPointer ?? "/register";
  const bind = bindRegister(view, new Map(), i.tier, registerPointer);
  // DATUM-11 rujukan kunci dinilai lint struktur (a11) + kelayakan render; DATUM-11 cacat
  // entri (pointer di bawah register) tetap di sini karena jalur bab/slot tidak menormalisasi register lebih dulu.
  const entryPrefix = joinPointer(registerPointer, "");
  const bindIssues = bind.issues.filter((x) => x.checkId !== "DATUM-11" || (x.pointer ?? "").startsWith(entryPrefix));
  const intrinsic: LintIssue[] = [...(i.intrinsic ?? []), ...tableChecks(view, new Map()), ...bindIssues];
  const gate = runGate({ doc: i.snapshot.doc, snapshot: view, tpl: i.tpl, tier: i.tier, intrinsic, enforcement, correlationId: i.correlationId });
  for (const n of i.notices ?? []) {
    gate.lint.checks.push(n);
    gate.lint.banner = gate.lint.banner ? `${gate.lint.banner} ${n.detail ?? n.checkId}` : (n.detail ?? n.checkId);
  }

  const deferred: LintIssue[] = [];
  let blocking = gate.blocking;
  if (!i.complete) {
    blocking = gate.blocking.filter((b) => !COMPLETENESS_DEPENDENT_CHECKS.has(b.checkId ?? ""));
    for (const c of gate.lint.checks) {
      if (c.status !== "FAIL" || !COMPLETENESS_DEPENDENT_CHECKS.has(c.checkId)) continue;
      c.detail = c.detail ? `${c.detail} [${DEFERRED_UNTIL_COMPLETE_NOTE}]` : DEFERRED_UNTIL_COMPLETE_NOTE;
      deferred.push(c);
    }
  }
  const feasibility = renderFeasibilityBlockers(view, new Map(), i.snapshot.doc);
  const contract = checkContractTargets(contractRecordTargets(i.snapshot, { contractKind: i.contractKind, contractPointer: i.contractPointer }));
  return { lint: gate.lint, blocking: [...blocking, ...feasibility], downgraded: gate.downgraded, deferred, enforcement, contract };
}

// ── Kontrak dokumen (DC-08) ─────────────────────────────────────────────

/**
 * Jenis kontrak snapshot: `explicit` (MX08 pemanggil), konteks compose tersimpan
 * (`compose.contractKind`, DC-10), lalu entri C58 yang `templateSlug`-nya = slug templat.
 * `null` = bukan dokumen kontrak, atau jenis tak terdaftar (compose sudah menolaknya
 * 422 `CONTRACT_KIND`, sehingga gerbang tidak menebak).
 */
export function contractKindOfSnapshot(snapshot: NormDocSnapshotV2, explicit?: string | null): ContractKind | null {
  const stored = (snapshot.compose as { contractKind?: unknown } | undefined)?.contractKind;
  return contractKindFor(snapshot.source?.template?.slug, explicit ?? (typeof stored === "string" ? stored : undefined));
}

/** Jenis kontrak dari nama eksplisit (harus terdaftar C58) atau entri C58 per slug templat. */
function contractKindFor(slug: string | undefined, named: string | null | undefined): ContractKind | null {
  if (named !== undefined && named !== null) return isContractKind(named) ? named : null;
  const def = CONTRACT_KIND_DEFS.find((d) => d.templateSlug === slug);
  return def && isContractKind(def.kind) ? def.kind : null;
}

/** Opsi penentuan target kontrak (jenis MX08 pemanggil, pointer badan kiriman). */
export interface ContractTargetOptions {
  contractKind?: string | null;
  contractPointer?: (slotKey: string) => string;
}

/**
 * Target dari dokumen v2 SUMBER (kiriman atau tergabung) + slot kerangka bertipe
 * `contractRecord` yang terisi payload `type: "contractRecord"`. Tanpa slot seperti itu
 * -> [] TANPA menyelesaikan jenis (dokumen non-kontrak tak tersentuh).
 */
function targetsOf(
  source: unknown,
  slots: ReadonlyArray<{ slotKey: string; sectionType: string }>,
  kindOf: () => ContractKind | null,
  opts: ContractTargetOptions,
): ContractRecordTarget[] {
  const recordSlots = slots.filter((s) => s.sectionType === CONTRACT_RECORD_SECTION_TYPE);
  if (recordSlots.length === 0) return [];
  const sections = isObject(source) && isObject(source.sections) ? source.sections : {};
  const payloadOf = (k: string): Record<string, unknown> | undefined => {
    const p = sections[k];
    return isObject(p) && p.type === CONTRACT_RECORD_SECTION_TYPE ? p : undefined;
  };
  const filled = recordSlots.filter((s) => payloadOf(s.slotKey) !== undefined);
  if (filled.length === 0) return [];
  const kind = kindOf();
  if (kind === null) return [];
  const pointerOf = opts.contractPointer ?? ((k: string) => joinPointer("/sections", k));
  return filled.map((s) => ({ slotKey: s.slotKey, kind, payload: payloadOf(s.slotKey) as unknown as ContractRecordPayloadV2, pointer: pointerOf(s.slotKey) }));
}

/** Target gerbang atas snapshot hasil gabung: slot kerangka aktif (tidak OMITTED). */
export function contractRecordTargets(snapshot: NormDocSnapshotV2, opts: ContractTargetOptions = {}): ContractRecordTarget[] {
  const slots = (snapshot.skeleton?.slots ?? []).filter((s) => s.active && !s.omitted);
  return targetsOf(snapshot.source, slots, () => contractKindOfSnapshot(snapshot, opts.contractKind), opts);
}

/**
 * Langkah 6b SEBELUM compose (§5.6 "struktur, murni, sebelum kunci"): compose kontrak
 * (DC-10) mengandaikan payload sudah lolos I54 (tanggal tak sah = galat compose tanpa
 * pointer). Pemanggil compose menjalankan ini atas dokumen v2 kiriman/tergabung + slot
 * kerangka templat terpatok; hasil sama bentuknya dengan `evaluateByConstruction().contract`
 * (galat via `contractCheckError`). Dokumen non-kontrak: hasil kosong, tanpa efek.
 */
export function checkContractSource(
  source: { template?: { slug?: string }; sections?: unknown } | null | undefined,
  slots: ReadonlyArray<{ slotKey: string; sectionType: string }>,
  opts: ContractTargetOptions = {},
): ContractGateResult {
  return checkContractTargets(targetsOf(source, slots, () => contractKindFor(source?.template?.slug, opts.contractKind), opts));
}

/**
 * I54 atas target (urutan slot, lalu urutan medan). Pemeta + aturan EC27 = `summarizeContractChecks`
 * (satu sumber dengan draf lokal CLI, FIX-R40-3): EC27 hanya bila tidak ada isu CH di target mana pun.
 */
export function checkContractTargets(targets: readonly ContractRecordTarget[]): ContractGateResult {
  const s = summarizeContractChecks(targets.map((t) => checkContractRecord(t.payload, t.kind, { pointer: t.pointer })));
  const out: ContractGateResult = { targets: [...targets], issues: s.issues, refs: [], warnings: [] };
  if (s.duplicate) out.error = new StudioEngineError(s.duplicate.code, s.duplicate.message, { ...s.duplicate.details });
  return out;
}

/** Galat langkah 6b: 400 `SCHEMA_INVALID` (details = isu ber-checkId) lalu 422 EC27; null bila lolos. */
export function contractCheckError(c: ContractGateResult): StudioEngineError | null {
  if (c.issues.length > 0) return new StudioEngineError("SCHEMA_INVALID", `${c.issues.length} pelanggaran catatan kontrak`, [...c.issues]);
  return c.error ?? null;
}

/**
 * I55 per target lewat reader BACA SAJA pemanggil (§5.6 langkah 9a). Melempar EC25/EC26
 * (`StudioEngineError`, details register); CW-01 dikumpulkan. Target tanpa `refs` tidak kueri.
 */
export async function resolveContractTargetRefs(
  targets: readonly ContractRecordTarget[],
  reader: ContractRefReader,
): Promise<Pick<ContractGateResult, "refs" | "warnings">> {
  const refs: ContractGateResult["refs"] = [];
  const warnings: SubmitWarningV2[] = [];
  for (const t of targets) {
    const list = Array.isArray(t.payload.refs) ? t.payload.refs : [];
    if (list.length === 0) continue;
    const r = await resolveContractRefs(list, reader, { pointer: joinPointer(t.pointer, "refs") });
    refs.push({ slotKey: t.slotKey, resolved: r.resolved });
    warnings.push(...r.warnings);
  }
  return { refs, warnings };
}

/**
 * EC28 (D-374): compose melempar `CHART_CUSTOM_FORM_UNSUPPORTED` tanpa pointer karena blok
 * sudah lepas dari sumbernya. Lengkapi `details.pointer` dengan blok chart `code = "custom"`
 * di `source` (dokumen v2 kiriman/tergabung) yang kombinasinya tidak terselesaikan I68 dan
 * cocok dengan `details` (form, dataShape), selain itu blok tak terselesaikan pertama.
 * Galat lain (atau pointer sudah ada / blok tidak ditemukan) dikembalikan apa adanya.
 * `sectionsPointer` = pointer `sections` di badan kiriman (bawaan `/sections`).
 */
export function withChartCustomPointer(err: unknown, source: unknown, sectionsPointer = "/sections"): unknown {
  if (!(err instanceof StudioEngineError) || err.code !== "CHART_CUSTOM_FORM_UNSUPPORTED") return err;
  const d = isObject(err.details) ? err.details : {};
  if (typeof d.pointer === "string") return err;
  const sections = isObject(source) && isObject(source.sections) ? source.sections : undefined;
  if (!sections) return err;
  const wantForm = JSON.stringify(d.form ?? null);
  let first: string | undefined;
  let exact: string | undefined;
  const visit = (node: unknown, p: string): void => {
    if (exact !== undefined) return;
    if (Array.isArray(node)) {
      node.forEach((x, i) => visit(x, joinPointer(p, i)));
      return;
    }
    if (!isObject(node)) return;
    if (node.type === "chart" && node.code === "custom") {
      const shape = isObject(node.data) && typeof node.data.shape === "string" ? (node.data.shape as ChartDataShape) : null;
      const resolved = isObject(node.form) && shape !== null && resolveChartCustom(node.form as unknown as ChartCustomFormV2, shape) !== null;
      if (!resolved) {
        first ??= p;
        if (JSON.stringify(node.form ?? null) === wantForm && shape === (d.dataShape ?? null)) exact = p;
      }
      return;
    }
    for (const [k, v] of Object.entries(node)) visit(v, joinPointer(p, k));
  };
  for (const [k, v] of Object.entries(sections)) visit(v, joinPointer(sectionsPointer, k));
  const pointer = exact ?? first;
  if (pointer === undefined) return err;
  const supported = Array.isArray(d.supported) ? d.supported : [...CHART_CUSTOM_FORM_IDS];
  return new StudioEngineError(err.code, err.message, { pointer, ...d, supported });
}

/**
 * P3-20: kode jenis dokumen dalam daftar tertutup parameter templat `doc.typeCode`
 * (cek meta pembuatan; R04 dan pembuatan lewat kiriman bab/slot). Mode reject:
 * pemanggil menolak 400 `SCHEMA_INVALID`; mode report (D-34 tepercaya): temuan FAIL.
 */
export function typeCodeIssue(meta: Pick<DocMeta, "typeCode">, slug: string, tpl: Pick<ResolvedTemplate, "params" | "versionNo">, ptr: string): ValidationIssue | null {
  const allowed = tpl.params["doc.typeCode"];
  if (!Array.isArray(allowed) || allowed.length === 0 || allowed.includes(meta.typeCode)) return null;
  return {
    pointer: `${ptr}/meta/typeCode`,
    keyword: "enum",
    message: `typeCode "${meta.typeCode}" tidak dalam daftar tertutup templat ${slug} v${tpl.versionNo} (P3-20): ${allowed.join(", ")}`,
    checkId: "P3-20",
  };
}

function mmText(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/**
 * D-271 (FIX-X): ukuran figur medan v1 terhadap grid TURUNAN templat terpatok
 * (D-158/D-245 H1), dinilai saat ingest SEBELUM adaptor membuang medan ukuran v1.
 * Cek dan kode sama dengan penjaga mesin yang menolak spec yang sama saat render:
 *  - chart `spec.widthMm` anggota `grid.allowedFigureWidthsMm` (G2, `assertChartSpec`);
 *  - chart `spec.heightMm` dan `spec.composite.panels[].spec.heightMm` dalam
 *    (0, `grid.textBlockHeightMm`] (DATUM-33; skema v1 hanya `exclusiveMinimum 0`);
 *  - diagram `spec.width_mm` anggota himpunan yang sama (P1-width_mm, `validateSpec`).
 * Rujukan artefak (`spec.artifactId`) dan aset raster (`image`, K-2) tidak dinilai.
 * Batas dari `figureLimits` (nilai turunan templat; kunci absen = bawaan registri,
 * pola evaluator lint FIX-FIG keputusan 3; tak terbaca = BY_CONSTRUCTION_FAILED).
 * Tanpa I/O; pemanggil menolak 422 `BY_CONSTRUCTION_FAILED` (`details` = hasil ini).
 */
export function v1FigureSizeIssues(doc: unknown, params: ParamMap, ptr: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let limits: FigureLimits | undefined;
  const lim = (): FigureLimits => (limits ??= figureLimits(params));
  const push = (pointer: string, checkId: string, detail: string): void => {
    issues.push({ pointer, keyword: "byConstruction", message: `${checkId}: ${detail}`, checkId });
  };
  const height = (spec: Record<string, unknown>, p: string, fid: string): void => {
    const h = spec.heightMm;
    if (typeof h !== "number" || (h > 0 && h <= lim().maxHeightMm)) return;
    push(joinPointer(p, "heightMm"), "DATUM-33", `${fid} — tinggi ${h} mm di luar (0, ${mmText(lim().maxHeightMm)}] mm (grid.textBlockHeightMm templat)`);
  };
  const visit = (node: unknown, p: string): void => {
    if (Array.isArray(node)) {
      node.forEach((x, i) => visit(x, joinPointer(p, i)));
      return;
    }
    if (!isObject(node)) return;
    const spec = node.spec;
    const figure = (node.type === "chart" || node.type === "diagram") && isObject(spec) && !("artifactId" in spec);
    if (figure) {
      const sp = joinPointer(p, "spec");
      if (node.type === "chart") {
        const fid = typeof spec.id === "string" ? spec.id : "(tanpa nomor)";
        const w = spec.widthMm;
        if (typeof w === "number" && !isAllowedWidth(w, lim())) {
          push(joinPointer(sp, "widthMm"), "G2", `${fid} — lebar ${w} mm bukan ${allowedWidthsText(lim())} (grid.allowedFigureWidthsMm templat)`);
        }
        height(spec, sp, fid);
        const panels = isObject(spec.composite) && Array.isArray(spec.composite.panels) ? spec.composite.panels : [];
        panels.forEach((panel, i) => {
          if (isObject(panel) && isObject(panel.spec)) height(panel.spec, joinPointer(sp, "composite", "panels", i, "spec"), `${fid} panel ${i + 1}`);
        });
      } else {
        const w = spec.width_mm;
        if (typeof w === "number" && !isAllowedWidth(w, lim())) {
          const fid = typeof spec.id === "string" ? spec.id : "(tanpa nomor)";
          push(joinPointer(sp, "width_mm"), "P1-width_mm", `${fid} — width_mm ${w} bukan ${allowedWidthsText(lim())} (grid.allowedFigureWidthsMm templat)`);
        }
      }
    }
    for (const [k, v] of Object.entries(node)) if (!(figure && k === "spec")) visit(v, joinPointer(p, k));
  };
  visit(doc, ptr);
  return issues;
}

/** Galat 422 kontrak untuk penahan gerbang (bentuk sama dengan R04: `details` = daftar issue). */
export function byConstructionError(blocking: readonly ValidationIssue[]): StudioEngineError {
  return new StudioEngineError("BY_CONSTRUCTION_FAILED", `${blocking.length} pelanggaran by-construction`, [...blocking]);
}

/**
 * `evaluateByConstruction` lalu lempar 422 `BY_CONSTRUCTION_FAILED` bila ada
 * penahan. Dipanggil jalur tulis di dalam transaksi sebelum commit; `onDowngrade`
 * mencatat penurunan D-34 ke log tahan lama pemanggil.
 */
export function assertByConstruction(
  i: ByConstructionInput,
  onDowngrade?: (r: ByConstructionResult) => void,
): ByConstructionResult {
  const r = evaluateByConstruction(i);
  // DC-08 §5.6: langkah 6b (400 / EC27) mendahului penahan langkah 9.
  const contractErr = contractCheckError(r.contract);
  if (contractErr) throw contractErr;
  if (r.blocking.length > 0) throw byConstructionError(r.blocking);
  if (r.downgraded.length > 0) onDowngrade?.(r);
  return r;
}

/**
 * Varian async gerbang tunggal (DC-08): urutan §5.6 = 6b (I54: 400 / EC27) -> 9a (I55 lewat
 * `contractRefs`, BACA SAJA: EC25/EC26; CW-01 ke `contract.warnings`) -> 9 (422
 * `BY_CONSTRUCTION_FAILED`). Tanpa `contractRefs` setara `assertByConstruction`. Dokumen
 * non-kontrak: tanpa kueri, hasil sama dengan varian sinkron. Pemanggil di dalam transaksi
 * memberi reader berklien transaksi (`createPrismaContractRefReader({ db: tx })`).
 */
export async function assertByConstructionAsync(
  i: ByConstructionInput & { contractRefs?: ContractRefReader },
  onDowngrade?: (r: ByConstructionResult) => void,
): Promise<ByConstructionResult> {
  const r = evaluateByConstruction(i);
  const contractErr = contractCheckError(r.contract);
  if (contractErr) throw contractErr;
  if (i.contractRefs && r.contract.targets.length > 0) {
    const refs = await resolveContractTargetRefs(r.contract.targets, i.contractRefs);
    r.contract.refs = refs.refs;
    r.contract.warnings = refs.warnings;
  }
  if (r.blocking.length > 0) throw byConstructionError(r.blocking);
  if (r.downgraded.length > 0) onDowngrade?.(r);
  return r;
}
