/**
 * Modul services/ingest (I38, 01_specs.md §8.2), diisi S48; ingest v2 SR-12.
 *
 * SR-12 (refaktor struktur): `ingestDocument` mendispatch per `$schema`:
 * `studio.doc/v2` langsung ke pipeline v2 (v2.ts), `studio.doc/v1` lewat adaptor
 * SR-09 ke pipeline yang sama (REPORT SCHEMA_V1_ADAPTED). Pipeline v2: gerbang
 * kepercayaan, templat terpatok + kerangka (SR-06), meta bawaan dari templat,
 * aset (SR-19), compose (SR-08), by-construction, kelengkapan (SR-11) di hasil;
 * kiriman parsial diterima (INCOMPLETE, `renderRefused`). Simpan: v1 lewat
 * repositori struktur SR-10 (repository.ts `persistAdaptedV1`), v2 lewat layanan
 * kiriman SR-13. Alur S48 di bawah tetap berlaku untuk `ingestDocumentV1Legacy`.
 *
 * Alur `ingestDocument` (R04 POST dan R08 dry-run):
 *  1. Validasi badan (`agentId` maks 80) + skema `studio.doc/v1` (ajv dari
 *     `STUDIO_SCHEMA_LOAD_ORDER`/`STUDIO_AJV_OPTIONS` kontrak) + batas C11-C14.
 *  2. Templat (`resolveTemplate` S49), hak override (`checkOverrideRights`,
 *     KT-16), override dokumen diterapkan (`applyDocOverrides`), kode jenis
 *     tertutup P3-20 dari parameter templat.
 *  3. Normalisasi ke `studio.norm/v1` (normalize.ts): unit, blok struktural,
 *     alamat bab.seksi.paragraf, label artefak per bab, halaman depan `F:`.
 *     Teks tidak pernah diubah (A9).
 *  4. Aset raster: byte diresolusi dan sha256 diverifikasi (assets.ts).
 *  5. Pengikatan register (bind S12) + cek intrinsik (G1, DATUM-10, DATUM-11).
 *  6. Gerbang by-construction (gate.ts): 422 hanya untuk FAIL bermode efektif
 *     "block" (`ingestPolicy` engine/lint/scan di atas override penegakan S46:
 *     profil `lint.enforcementOverride`, `doc.x.lintEnforcement`); ATURAN
 *     PENGAMAN D-34 untuk benchmark (`x.benchmark`, `x.enforcement`, opsi
 *     `enforcement: "report"`): diturunkan ke status rilis.
 *  D-98 (F-047): `doc.x.lintEnforcement` hanya dari pemanggil tepercaya
 *     (dibuang + `ENFORCEMENT_OVERRIDE_STRIPPED` untuk lainnya); templat yang
 *     profilnya melepas cek penolak = TERBATAS: pemanggil tidak tepercaya ->
 *     403 FORBIDDEN (juga dryRun: otorisasi, bukan ketidaksahan masukan).
 *  7. Bukan dryRun: rujukan misi (S52), aset ke penyimpanan beralamat-isi,
 *     transaksi StudioDocument + revisi 1 + StudioBlock (repository.ts).
 *
 * Kontrak galat: `dryRun` TIDAK PERNAH melempar untuk masukan tidak sah
 * (R08: 200 `valid:false`); bukan dryRun melempar `StudioEngineError` dengan
 * kode §6.3 dan `details` = ValidationIssue[] (route memetakan via
 * `studioErrorFrom`). Pointer isu relatif badan permintaan (`/document/...`).
 *
 * Render TIDAK dijalankan di sini: `outputs` = [], `job` = null; route S55
 * memanggil `renderRevision(revision.id, ...)` (S51) sesudah ingest.
 */
import type {
  IngestResult,
  LintIssue,
  NormDocSnapshot,
  ResolvedTemplate,
  StudioDocV1,
  StudioDocV2,
  StudioIngestRequest,
  StudioReleaseStatus,
  ValidationIssue,
} from "../../contract";
import type { StudioCaller } from "../../contract/auth";
import { StudioEngineError } from "../../contract/errors";
import { normalizeRegisterEntry } from "../../engine/bind";
import { checkOverrideRights, resolveParamsWith } from "../../engine/tokens";
import { ALL_PARAMS } from "../../params";
import { assertMissionRefs } from "../storage";
import { assertTemplateUsable, resolveTemplate } from "../templates";
import {
  ASSET_TOO_LARGE_KEYWORD,
  contentAddressAssets,
  loadAssetIndex,
  resolveDocAssets,
  storeResolvedAssets,
  type IngestAssetSource,
} from "./assets";
import { bindRegister, renderFeasibilityBlockers, tableChecks } from "./checks";
import { resolveIngestEnforcement, runGate, type IngestEnforcement } from "./gate";
import { ingestLog, newIngestCorrelationId } from "./log";
import { archivedTemplateSlug, TEMPLATE_ARCHIVED_CODE, templateArchivedMessage } from "./archived";
import { normalizeDocument } from "./normalize";
import { docNumberPattern, persistIngest } from "./repository";
import {
  BENCHMARK_MARKER_STRIPPED,
  ENFORCEMENT_OVERRIDE_STRIPPED,
  enforcementStrippedNotice,
  isBenchmarkTrusted,
  stripBenchmarkMarkers,
  stripEnforcementOverride,
  strippedNotice,
} from "./trust";
import { sha256Hex, stableStringify } from "./util";
import { limitIssues, validateAgainst, validateRequestEnvelope } from "./validate";
import { isObject } from "./util";
import { ingestDocV1Adapted, ingestDocV2, validateDocV1, type IngestResultV2, type V2Context } from "./v2";
import type { SkeletonInput } from "../compose";
import type { DocV2Targeting } from "../submit/targeting";

export {
  ADAPT_REPORT_X_KEY,
  completenessInputOf,
  issuesFromEngineError,
  stampRevisionOne,
  type IngestResultV2,
  type IngestSchemaId,
} from "./v2";
export { validateV2Against } from "./validate";
export { persistAdaptedV1 } from "./repository";
export { effectiveTier, jakartaDate, resolveMetaDefaults, type MetaDefaultsContext } from "./meta";

export { normalizeDocument, type NormalizeOptions, type NormalizeResult } from "./normalize";
export { loadAssetIndex, resolveDocAssets, storeResolvedAssets, assetStoreRoot, type IngestAssetSource, type ResolvedAsset } from "./assets";
export { isBenchmarkDoc, resolveIngestEnforcement, D34_NOTE, type IngestEnforcement } from "./gate";
export { bindRegister, renderFeasibilityBlockers, RENDER_FEASIBILITY_KEYWORD, tableChecks } from "./checks";
export {
  assertByConstruction,
  byConstructionError,
  COMPLETENESS_DEPENDENT_CHECKS,
  evaluateByConstruction,
  typeCodeIssue,
  type ByConstructionInput,
  type ByConstructionResult,
} from "./by-construction";
export { formatDocNumber, docNumberPattern, documentSummary } from "./repository";
export { plainText, stableStringify } from "./util";
export { setIngestLogSink } from "./log";
export {
  BENCHMARK_MARKER_KEYS,
  BENCHMARK_MARKER_STRIPPED,
  ENFORCEMENT_OVERRIDE_KEYS,
  ENFORCEMENT_OVERRIDE_STRIPPED,
  isBenchmarkTrusted,
  stripBenchmarkMarkers,
  stripEnforcementOverride,
  stripTrustMarkersForWriter,
} from "./trust";
export { studioAjv, studioValidator } from "./validate";

const DOC_PTR = "/document";

/** Opsi `ingestDocument`: `dryRun` kontrak + ekstensi opsional (kompatibel tanda tangan §8.2). */
export interface IngestOptions {
  dryRun: boolean;
  /**
   * "report" = aturan pengaman D-34 (benchmark/profil): penahan menjadi status
   * rilis. Hanya dihormati dalam konteks tepercaya (ADMIN atau `trustedHarness`).
   */
  enforcement?: IngestEnforcement;
  /**
   * IP-31/F-042: konteks harness/CLI server tanpa sesi HTTP. Hanya kode server
   * yang memanggil `ingestDocument` langsung yang boleh menyetel `true`; route
   * API TIDAK PERNAH menyalinnya dari body/header. Tanpa flag ini (dan bukan
   * ADMIN_SESSION) penanda `doc.x.benchmark`/`doc.x.enforcement` dan
   * `doc.x.lintEnforcement` dibuang, dan templat terbatas ditolak 403 (D-98).
   */
  trustedHarness?: boolean;
  /** Sumber byte aset di luar dokumen (path absolut). */
  assetSources?: readonly IngestAssetSource[];
  /** Berkas indeks aset (mis. `benchmark/manual000/figures/index.json` S94). */
  assetIndexPath?: string;
  correlationId?: string;
  /**
   * Templat yang sudah diresolusi (harness benchmark tanpa DB, atau templat
   * draf `roleFormats` dari route validate R08). Gerbang templat terbatas
   * (`guardTemplate`) tetap berlaku atas templat ini. Wajib `dryRun` bila
   * `versionId` tidak ada di DB.
   */
  template?: ResolvedTemplate;
  /**
   * SR-12: kerangka siap pakai untuk jalur v2 (harness/CLI tanpa baris DB templat).
   * Absen = SR-06 `resolveSlotsForVersion` (DB), atau kerangka implisit dari
   * `sectionPlan` bila `template` di memori tidak punya baris versi.
   */
  skeleton?: SkeletonInput;
  /**
   * SR-12: kiriman `studio.doc/v1` memakai jalur norm/v1 lama (tanpa adaptor).
   * Hanya dihormati untuk pemanggil tepercaya (ADMIN atau `trustedHarness`);
   * route API tidak pernah menyetelnya.
   */
  legacyV1?: boolean;
  /**
   * IP-64 (SR-55 M1, D-235): penargetan R04 `studio.doc/v2` ke dokumen yang ADA
   * (`target.documentId` + `baseRevisionNo`), amplop transport yang dipisah route
   * sebelum skema SID01; diteruskan eksplisit ke `submitDocumentV2`.
   */
  submitTargeting?: DocV2Targeting;
}

/** ajv 2020 dengan STUDIO_AJV_OPTIONS; galat -> ValidationIssue berpointer. */
export function validateSchema(schemaId: string, data: unknown): ValidationIssue[] {
  return validateAgainst(schemaId, data);
}

/**
 * Normalisasi murni (dipakai layanan revisi S50 dan render). Melempar
 * `StudioEngineError` SCHEMA_INVALID bila struktur tidak konsisten (kunci bab
 * ganda, blockId ganda, rujukan bagian) dan BY_CONSTRUCTION_FAILED (DATUM-11)
 * bila entri register cacat. Normalisasi v1 tidak bergantung parameter templat.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function normalize(doc: StudioDocV1, tpl: ResolvedTemplate): NormDocSnapshot {
  const r = normalizeDocument(doc);
  if (r.issues.length > 0) {
    throw new StudioEngineError("SCHEMA_INVALID", "Dokumen tidak dapat dinormalisasi", r.issues);
  }
  const register: NormDocSnapshot["register"] = {};
  for (const [k, e] of Object.entries(r.snapshot.register)) {
    try {
      register[k] = normalizeRegisterEntry(k, e);
    } catch (err) {
      throw new StudioEngineError("BY_CONSTRUCTION_FAILED", err instanceof Error ? err.message : String(err), [
        { pointer: `/register/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`, keyword: "byConstruction", message: String(err), checkId: "DATUM-11" },
      ]);
    }
  }
  r.snapshot.register = register;
  return r.snapshot;
}

/**
 * Terapkan `doc.overrides` di atas parameter templat (urutan resolusi I01:
 * registri <- profil templat <- override dokumen; turunan dihitung ulang
 * dengan konteks dokumen). Hak kelas K/T diperiksa terpisah
 * (`checkOverrideRights`). Dipakai juga render (S51) untuk konteks yang sama.
 */
export function applyDocOverrides(tpl: ResolvedTemplate, doc: StudioDocV1): { tpl: ResolvedTemplate; issues: ValidationIssue[] } {
  const overrides = doc.overrides ?? {};
  if (Object.keys(overrides).length === 0) return { tpl, issues: [] };
  const r = resolveParamsWith(
    { base: tpl.params, overrides, registry: ALL_PARAMS },
    { issueDate: doc.meta.issueDate, issueNumber: doc.meta.issueNumber },
  );
  const issues: ValidationIssue[] = r.errors
    .filter((e) => (e.pointer ?? "").startsWith("/overrides"))
    .map((e) => ({ pointer: `${DOC_PTR}${e.pointer ?? ""}`, keyword: e.code, message: e.message }));
  return { tpl: { ...tpl, params: r.params }, issues };
}

/**
 * P3-20: kode jenis dalam daftar tertutup parameter templat `doc.typeCode`.
 * Sumber daftar SATU-SATUNYA = parameter versi templat yang di-resolve
 * (`resolvedParams` versi yang dipin `doc.template.version`, default terbaru;
 * setelah override dokumen), tidak ada daftar statis. IP-24/F-036: versi
 * kanonik v1 (sebelum R01) tidak memuat STD, v2 memuatnya; pesan menyebut
 * versi agar penolakan karena versi lama/terpin dapat didiagnosis.
 */
function typeCodeIssue(doc: StudioDocV1, tpl: ResolvedTemplate): ValidationIssue | null {
  const allowed = tpl.params["doc.typeCode"];
  if (!Array.isArray(allowed) || allowed.length === 0) return null;
  if (allowed.includes(doc.meta.typeCode)) return null;
  return {
    pointer: `${DOC_PTR}/meta/typeCode`,
    keyword: "enum",
    message: `typeCode "${doc.meta.typeCode}" tidak dalam daftar tertutup templat ${doc.template.slug} v${tpl.versionNo} (P3-20): ${allowed.join(", ")}`,
    checkId: "P3-20",
  };
}

const RIGHTS_RANK = { PARAM_CLASS_K_FORBIDDEN: 0, PARAM_CLASS_T_READONLY: 1, PARAM_UNKNOWN_KEY: 2, SCHEMA_INVALID: 3 } as const;

function invalidResult(issues: ValidationIssue[], lint: IngestResult["lint"] = null): IngestResult {
  return { valid: false, issues, lint, document: null, revision: null, outputs: [], job: null, releaseStatus: "FAIL" };
}

/** Badan masukan ingest: amplop v1/v2 (`{ agentId?, document, render? }`) atau `studio.doc/v2` langsung. */
export type IngestInput = StudioIngestRequest | { agentId?: string; document: StudioDocV2; render?: StudioIngestRequest["render"] } | StudioDocV2;

/**
 * SR-12: titik masuk ingest (R04 POST, R08 dry-run, harness, seed). Dispatch per
 * `$schema` dokumen:
 *  - `studio.doc/v2` -> `ingestDocV2` (v2.ts);
 *  - `studio.doc/v1` -> skema v1 -> adaptor SR-09 -> pipeline v2 (`ingestDocV1Adapted`),
 *    atau jalur norm/v1 lama (`ingestDocumentV1Legacy`) bila `opts.legacyV1` DAN
 *    pemanggil tepercaya (alat server: paritas/benchmark v1; tidak dapat diset dari HTTP).
 * Gerbang kepercayaan D-98/D-134 dijalankan di sini untuk kedua versi SEBELUM
 * adaptasi/validasi isi: penanda `x.benchmark`/`x.enforcement`/`x.lintEnforcement`
 * dari pemanggil tidak tepercaya dibuang + log + temuan REPORT.
 * Kontrak galat sama dengan S48: dryRun tidak pernah melempar untuk masukan
 * tidak sah (`valid:false`); bukan dryRun melempar `StudioEngineError`.
 */
export async function ingestDocument(req: IngestInput, caller: StudioCaller, opts: IngestOptions): Promise<IngestResultV2> {
  const cid = opts.correlationId ?? newIngestCorrelationId();
  const dryRun = opts.dryRun === true;
  const reject = (code: StudioEngineError["code"], message: string, issues: ValidationIssue[], lint: IngestResult["lint"] = null): IngestResultV2 => {
    ingestLog({ level: "warn", message: `ingest ditolak: ${message}`, correlationId: cid, code, context: { dryRun, issues: issues.length } });
    if (dryRun) return invalidResult(issues, lint);
    throw new StudioEngineError(code, message, issues);
  };

  // Bentuk badan: v2 langsung (pointer "") atau amplop (pointer "/document").
  const direct = isObject(req) && (req as { $schema?: unknown }).$schema === "studio.doc/v2";
  let document: unknown;
  let agentId: string | undefined;
  let ptr: string;
  if (direct) {
    document = req;
    ptr = "";
    const a = (req as unknown as StudioDocV2).agentId;
    agentId = typeof a === "string" ? a : undefined;
  } else {
    const envelope = validateRequestEnvelope(req);
    if (envelope.length > 0) return reject("SCHEMA_INVALID", "Badan permintaan tidak sah", envelope);
    const env = req as { agentId?: string; document: unknown };
    document = env.document;
    ptr = DOC_PTR;
    const inner = isObject(document) && typeof document.agentId === "string" ? document.agentId : undefined;
    agentId = env.agentId ?? inner;
  }
  const schemaId = isObject(document) ? document.$schema : undefined;
  const trusted = isBenchmarkTrusted(caller, opts);

  if (schemaId !== "studio.doc/v2" && opts.legacyV1 === true && trusted) {
    return ingestDocumentV1Legacy(req as StudioIngestRequest, caller, { ...opts, correlationId: cid });
  }
  if (schemaId !== "studio.doc/v1" && schemaId !== "studio.doc/v2") {
    return reject("SCHEMA_INVALID", "$schema dokumen harus studio.doc/v2 (atau studio.doc/v1 lewat adaptor)", [
      { pointer: `${ptr}/$schema`, keyword: "const", message: "$schema harus \"studio.doc/v2\" atau \"studio.doc/v1\"" },
    ]);
  }

  // Gerbang kepercayaan (D-98/D-134), sebelum adaptasi dan validasi isi.
  const notices: LintIssue[] = [];
  const stripped: string[] = [];
  if (!trusted) {
    const a = stripBenchmarkMarkers(document, ptr);
    const b = stripEnforcementOverride(a.doc, ptr);
    document = b.doc;
    const markers = [...a.stripped];
    if (opts.enforcement === "report") markers.push("opts.enforcement");
    if (markers.length > 0) {
      notices.push(strippedNotice(markers, caller));
      ingestLog({ level: "warn", message: "penanda benchmark dibuang dari pemanggil tidak tepercaya (F-042)", correlationId: cid, code: BENCHMARK_MARKER_STRIPPED, context: { callerKind: caller?.kind ?? null, requester: caller?.requester ?? null, agentId: agentId ?? null, stripped: markers, dryRun, schemaId } });
    }
    if (b.stripped.length > 0) {
      notices.push(enforcementStrippedNotice(b.stripped, caller));
      ingestLog({ level: "warn", message: "override penegakan dokumen dibuang dari pemanggil tidak tepercaya (F-047, D-98)", correlationId: cid, code: ENFORCEMENT_OVERRIDE_STRIPPED, context: { callerKind: caller?.kind ?? null, requester: caller?.requester ?? null, agentId: agentId ?? null, stripped: b.stripped, dryRun, schemaId } });
    }
    stripped.push(...markers, ...b.stripped);
  }

  const ctx: V2Context = {
    caller,
    opts: {
      dryRun,
      ...(opts.enforcement ? { enforcement: opts.enforcement } : {}),
      ...(opts.trustedHarness !== undefined ? { trustedHarness: opts.trustedHarness } : {}),
      ...(opts.assetSources ? { assetSources: opts.assetSources } : {}),
      ...(opts.assetIndexPath ? { assetIndexPath: opts.assetIndexPath } : {}),
      ...(opts.template ? { template: opts.template } : {}),
      ...(opts.skeleton ? { skeleton: opts.skeleton } : {}),
      ...(opts.submitTargeting ? { submitTargeting: opts.submitTargeting } : {}),
    },
    cid,
    dryRun,
    trusted,
    ptr,
    ...(agentId ? { agentId } : {}),
    notices,
    stripped,
    reject,
  };
  if (schemaId === "studio.doc/v2") return ingestDocV2(document, ctx);

  const v1Issues = validateDocV1(document, ptr);
  if (v1Issues.length > 0) return reject("SCHEMA_INVALID", "Dokumen tidak lolos skema studio.doc/v1", v1Issues);
  const env = req as StudioIngestRequest;
  return ingestDocV1Adapted(
    { ...(agentId ? { agentId } : {}), document: document as StudioDocV1, ...(env.render ? { render: env.render } : {}) },
    ctx,
  );
}

/**
 * Jalur ingest `studio.doc/v1` lama (S48, snapshot `studio.norm/v1`). Sejak SR-12
 * hanya dipakai lewat `ingestDocument(..., { legacyV1: true })` oleh pemanggil
 * tepercaya; revisi lama tetap dirender jalur lama (§2.8 butir 2).
 */
export async function ingestDocumentV1Legacy(
  req: StudioIngestRequest,
  caller: StudioCaller,
  opts: IngestOptions,
): Promise<IngestResult> {
  const cid = opts.correlationId ?? newIngestCorrelationId();
  const dryRun = opts.dryRun === true;
  /** Tolak: dryRun -> hasil valid:false; selain itu lempar kode §6.3. */
  const reject = (code: StudioEngineError["code"], message: string, issues: ValidationIssue[], lint: IngestResult["lint"] = null): IngestResult => {
    ingestLog({ level: "warn", message: `ingest ditolak: ${message}`, correlationId: cid, code, context: { dryRun, issues: issues.length } });
    if (dryRun) return invalidResult(issues, lint);
    throw new StudioEngineError(code, message, issues);
  };

  // 1) Badan + skema + batas.
  const envelope = validateRequestEnvelope(req);
  if (envelope.length > 0) return reject("SCHEMA_INVALID", "Badan permintaan tidak sah", envelope);

  // 1b) IP-31/F-042: penanda benchmark hanya dari ADMIN atau harness server.
  const trusted = isBenchmarkTrusted(caller, opts);
  let stripped: string[] = [];
  if (!trusted) {
    const s = stripBenchmarkMarkers(req.document, DOC_PTR);
    stripped = s.stripped;
    if (opts.enforcement === "report") stripped.push("opts.enforcement");
    if (stripped.length > 0) {
      req = { ...req, document: s.doc };
      ingestLog({
        level: "warn",
        message: "penanda benchmark dibuang dari pemanggil tidak tepercaya (F-042)",
        correlationId: cid,
        code: BENCHMARK_MARKER_STRIPPED,
        context: { callerKind: caller?.kind ?? null, requester: caller?.requester ?? null, agentId: req.agentId ?? null, stripped, dryRun },
      });
    }
  }
  // 1c) D-98/F-047: override penegakan dokumen hanya dari ADMIN atau harness server.
  let strippedEnf: string[] = [];
  if (!trusted) {
    const s = stripEnforcementOverride(req.document, DOC_PTR);
    strippedEnf = s.stripped;
    if (strippedEnf.length > 0) {
      req = { ...req, document: s.doc };
      ingestLog({
        level: "warn",
        message: "override penegakan dokumen dibuang dari pemanggil tidak tepercaya (F-047, D-98)",
        correlationId: cid,
        code: ENFORCEMENT_OVERRIDE_STRIPPED,
        context: { callerKind: caller?.kind ?? null, requester: caller?.requester ?? null, agentId: req.agentId ?? null, stripped: strippedEnf, dryRun },
      });
    }
  }
  const enforcementOpt: IngestEnforcement | undefined = trusted ? opts.enforcement : undefined;

  const schemaIssues = validateAgainst("studio.doc/v1", req.document, DOC_PTR);
  if (schemaIssues.length > 0) return reject("SCHEMA_INVALID", "Dokumen tidak lolos skema studio.doc/v1", schemaIssues);
  const doc = req.document;
  const limits = limitIssues(doc, DOC_PTR);
  if (limits.length > 0) return reject("SCHEMA_INVALID", "Dokumen melampaui batas masukan", limits);

  const enforcement = resolveIngestEnforcement(doc, enforcementOpt);
  const tier = doc.meta.tier;
  const ctxLog = { templateSlug: doc.template.slug, docNumber: doc.meta.docNumber ?? null, tier, enforcement, dryRun, benchmarkTrusted: trusted };

  // 2) Templat dan override.
  let baseTpl: ResolvedTemplate;
  try {
    baseTpl = opts.template ?? (await resolveTemplate(doc.template.slug, doc.template.version));
  } catch (e) {
    if (e instanceof StudioEngineError && e.code === "TEMPLATE_NOT_FOUND") {
      return reject("TEMPLATE_NOT_FOUND", `Templat ${doc.template.slug} tidak ditemukan`, [
        { pointer: `${DOC_PTR}/template`, keyword: "reference", message: e.message },
      ]);
    }
    ingestLog({ level: "error", message: "resolveTemplate gagal", correlationId: cid, code: "TEMPLATE_RESOLVE_FAILED", stack_trace: e instanceof Error ? e.stack : undefined, context: ctxLog });
    throw e;
  }
  // 2a) D-98: templat terbatas (profil melepas cek penolak) hanya untuk ADMIN/harness.
  //     Dilempar juga pada dryRun: ini otorisasi (403), bukan masukan tidak sah.
  const guardTemplate = (t: ResolvedTemplate, stage: string): void => {
    try {
      assertTemplateUsable(t, { kind: caller.kind, requester: caller.requester, agentId: req.agentId }, {
        trustedHarness: opts.trustedHarness === true,
        slug: doc.template.slug,
        purpose: dryRun ? "validate" : "ingest",
        correlationId: cid,
      });
    } catch (e) {
      ingestLog({ level: "warn", message: `templat terbatas ditolak (${stage})`, correlationId: cid, code: "TEMPLATE_RESTRICTED_DENIED", context: { ...ctxLog, callerKind: caller.kind, requester: caller.requester, agentId: req.agentId ?? null } });
      throw e;
    }
  };
  guardTemplate(baseTpl, "templat");
  // Swarm patch (row 69a, C78; templates spec §4): the legacy v1 path always creates a NEW document, so an archived
  // template is refused here too (an in-memory opts.template has no store row).
  if (!opts.template) {
    const archived = await archivedTemplateSlug(baseTpl, cid);
    if (archived !== null) {
      ingestLog({ level: "warn", message: "dokumen baru pada templat terarsip ditolak (v1 lama)", correlationId: cid, code: TEMPLATE_ARCHIVED_CODE, context: { ...ctxLog, templateId: baseTpl.templateId, callerKind: caller.kind } });
      return reject(TEMPLATE_ARCHIVED_CODE, templateArchivedMessage(archived), [{ pointer: `${DOC_PTR}/template`, keyword: TEMPLATE_ARCHIVED_CODE, message: templateArchivedMessage(archived) }]);
    }
  }
  const rights = checkOverrideRights(doc.overrides ?? {}, caller.kind, ALL_PARAMS);
  if (rights.length > 0) {
    const first = [...rights].sort((a, b) => RIGHTS_RANK[a.code] - RIGHTS_RANK[b.code])[0];
    return reject(
      first.code,
      first.message,
      rights.map((r) => ({ pointer: `${DOC_PTR}${r.pointer ?? `/overrides/${r.key}`}`, keyword: r.code, message: r.message })),
    );
  }
  const applied = applyDocOverrides(baseTpl, doc);
  if (applied.issues.length > 0) return reject("SCHEMA_INVALID", "Override dokumen tidak sah", applied.issues);
  const tpl = applied.tpl;
  if (tpl !== baseTpl) guardTemplate(tpl, "setelah override dokumen");

  // 3) Normalisasi (nomor sementara bila dari sekuens).
  const norm = normalizeDocument(doc, { pointerPrefix: DOC_PTR });
  const hard: ValidationIssue[] = [...norm.issues];

  // 4) Aset.
  let sources: IngestAssetSource[] = [...(opts.assetSources ?? [])];
  if (opts.assetIndexPath) {
    try {
      sources = sources.concat(loadAssetIndex(opts.assetIndexPath));
    } catch (e) {
      ingestLog({ level: "error", message: "indeks aset tidak terbaca", correlationId: cid, code: "ASSET_INDEX_UNREADABLE", stack_trace: e instanceof Error ? e.stack : undefined, context: ctxLog });
      hard.push({ pointer: `${DOC_PTR}/assets`, keyword: "asset", message: `Indeks aset tidak terbaca: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  const assetRes = resolveDocAssets(doc, tpl, sources, DOC_PTR);
  hard.push(...assetRes.issues);

  // P3-20: penahan biasa; mode report (D-34) -> temuan status rilis.
  const intrinsic: LintIssue[] = [];
  const tc = typeCodeIssue(doc, tpl);
  if (tc) {
    if (enforcement === "report") intrinsic.push({ checkId: "P3-20", status: "FAIL", detail: tc.message, pointer: tc.pointer });
    else hard.push(tc);
  }
  // S87 M-02: aset melewati batas ukuran/piksel -> 413 ASSET_TOO_LARGE (bukan 400).
  if (assetRes.issues.some((i) => i.keyword === ASSET_TOO_LARGE_KEYWORD)) {
    return reject("ASSET_TOO_LARGE", "Aset dokumen melewati batas ukuran/piksel", hard);
  }
  if (hard.length > 0) return reject("SCHEMA_INVALID", "Dokumen tidak konsisten secara struktur", hard);

  // 5) Bind + cek intrinsik.
  const bind = bindRegister(norm.snapshot, norm.pointers, tier, `${DOC_PTR}/register`);
  norm.snapshot.register = bind.register;
  intrinsic.push(...tableChecks(norm.snapshot, norm.pointers), ...bind.issues);

  // 6) Gerbang by-construction (A10, D-34).
  const gate = runGate({ doc, snapshot: norm.snapshot, tpl, tier, intrinsic, enforcement, correlationId: cid });
  if (stripped.length > 0) {
    // Temuan REPORT (bukan penahan, tidak mengubah status rilis) agar pemanggil melihat penanda dibuang.
    const notice = strippedNotice(stripped, caller);
    gate.lint.checks.push(notice);
    const msg = notice.detail ?? BENCHMARK_MARKER_STRIPPED;
    gate.lint.banner = gate.lint.banner ? `${gate.lint.banner} ${msg}` : msg;
  }
  if (strippedEnf.length > 0) {
    const notice = enforcementStrippedNotice(strippedEnf, caller);
    gate.lint.checks.push(notice);
    const msg = notice.detail ?? ENFORCEMENT_OVERRIDE_STRIPPED;
    gate.lint.banner = gate.lint.banner ? `${gate.lint.banner} ${msg}` : msg;
  }
  // 6b) FIX-1 (S85 R-03, F-053): prasyarat renderer turunan = penahan integritas
  //     (tidak dilepas override/D-34): tanpa ini dokumen diterima 201 lalu job FAILED.
  const feasibility = renderFeasibilityBlockers(norm.snapshot, norm.pointers, doc);
  const blocking = [...gate.blocking, ...feasibility];
  if (blocking.length > 0) {
    if (feasibility.length > 0) {
      ingestLog({ level: "warn", message: "turunan tidak dapat dirender (R-03)", correlationId: cid, code: "RENDER_FEASIBILITY_FAILED", context: { ...ctxLog, derivations: feasibility.length } });
    }
    return reject("BY_CONSTRUCTION_FAILED", `${blocking.length} pelanggaran by-construction`, blocking, gate.lint);
  }
  if (gate.downgraded.length > 0) {
    ingestLog({
      level: "warn",
      message: "penahan by-construction diturunkan (D-34)",
      correlationId: cid,
      code: "D34_DOWNGRADED",
      context: { ...ctxLog, checks: gate.downgraded.map((d) => `${d.checkId}@${d.address ?? d.pointer ?? ""}`) },
    });
  }
  const releaseStatus: StudioReleaseStatus = gate.lint.releaseStatus === "FAIL" ? "FAIL" : "PENDING";

  if (dryRun) {
    return {
      valid: true,
      issues: [],
      lint: gate.lint,
      document: null,
      revision: null,
      outputs: [],
      job: null,
      releaseStatus,
      snapshot: norm.snapshot,
    };
  }

  // 7) Simpan.
  try {
    await assertMissionRefs(doc.mission);
    storeResolvedAssets(assetRes.assets);
    const finalize = (s: NormDocSnapshot): NormDocSnapshot => {
      s.register = bind.register;
      contentAddressAssets(s.doc, assetRes.assets);
      return s;
    };
    const persisted = await persistIngest({
      snapshot: finalize(norm.snapshot),
      docNumber: doc.meta.docNumber ?? null,
      renormalize: (n) => finalize(normalizeDocument(doc, { docNumber: n, pointerPrefix: DOC_PTR }).snapshot),
      numberPattern: docNumberPattern(tpl.params),
      templateId: tpl.templateId,
      templateVersionId: tpl.versionId,
      tier,
      inputSha256: sha256Hex(stableStringify(doc)),
      snapshotSha256: (s) => sha256Hex(stableStringify(s)),
      releaseStatus,
      lint: gate.lint,
      createdBy: caller.requester,
      agentId: req.agentId,
    });
    ingestLog({
      level: "info",
      message: "dokumen di-ingest",
      correlationId: cid,
      context: {
        ...ctxLog,
        documentId: persisted.document.id,
        revisionId: persisted.revision.id,
        docNumber: persisted.document.docNumber,
        blocks: persisted.snapshot.blocks.length,
        units: persisted.snapshot.units.length,
        releaseStatus,
      },
    });
    return {
      valid: true,
      issues: [],
      lint: gate.lint,
      document: persisted.document,
      revision: persisted.revision,
      outputs: [],
      job: null,
      releaseStatus,
      snapshot: persisted.snapshot,
    };
  } catch (e) {
    const code = e instanceof StudioEngineError ? e.code : "INGEST_PERSIST_FAILED";
    ingestLog({
      level: e instanceof StudioEngineError && e.httpStatus < 500 ? "warn" : "error",
      message: `penyimpanan ingest gagal: ${e instanceof Error ? e.message : String(e)}`,
      correlationId: cid,
      code,
      stack_trace: e instanceof Error ? e.stack : undefined,
      context: ctxLog,
    });
    throw e;
  }
}
