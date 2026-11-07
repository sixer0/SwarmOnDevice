/**
 * Seed Studio (baris S70; diperbarui INT-I / IP-12, F-029; 01_specs.md §1.2 M01-M03, §5.1, §5.2, §5.5).
 *
 * Menulis, secara idempoten:
 *   1. 52 baris `StudioSectionType` (berdasarkan `key`) dari `registry/sections.ts`;
 *      isi disamakan dengan registri, hanya baris baru/berbeda yang ditulis (DC-29:
 *      jalan ulang tanpa perubahan = 0 tulis, `updatedAt` tidak bergeser). Baris DB
 *      yang `key`-nya tidak ada di registri DILAPORKAN (warn + hitungan di log
 *      selesai) dan TIDAK dihapus (KD-02; S85 R-22, baris IP-43c).
 *   2. Profil DATUM-kanonik lewat `ensureCanonicalTemplate` (layanan templat S49):
 *      templat baru -> versi 1; versi kanonik TERBARU dibandingkan dengan
 *      registri saat ini dan, bila berbeda, dibuat versi baru
 *      (`syncRegistry: true`; versi lama tidak pernah disentuh, D-06).
 *      Hasil: `created` | `synced` | `unchanged`.
 *   3. Opsional `--import-benchmark`: impor `benchmark/manual000/template.json`
 *      sebagai templat `datum-manual-000` (pemanggil ADMIN_SESSION, KT-16) lewat
 *      `importTemplateProfile`; run ulang tanpa perubahan = `unchanged`.
 *   4. Opsional `--import-datum-gsp` (baris UT-01): templat `datum-gsp`
 *      ("DATUM GSP (profil Manual DATUM 2.6.0)") untuk uji manual dari UI —
 *      profil visual yang sama dengan `benchmark/manual000/template.json`
 *      (overrides + roleFormats; rencana section = rencana dasar kanonik karena
 *      profil itu tidak memuat `sectionPlan`) TANPA pelepas penegakan
 *      `lint.enforcementOverride` (D-98/D-102: kalau ada, templat TERBATAS) dan
 *      tanpa identitas/metadata benchmark (lihat `DATUM_GSP_DROPPED_META`).
 *      Lewat `importTemplateProfile` (validasi kunci/nilai + hak kelas K,
 *      versi berversi), pemanggil ADMIN_SESSION karena profil memuat override
 *      kelas K; hasil wajib `restricted=false` (dicek ulang, galat bila tidak).
 *      Run ulang tanpa perubahan = `unchanged`; isi berubah = versi baru.
 *
 *   5. Opsional `--presets-and-skeletons` (baris SR-36; blueprint §2.3 "Migrasi templat
 *      lama ke preset + override", §2.13; research/09 §8; D-165, D-194): preset gaya
 *      "DATUM Kanonik" (`datum-kanonik-preset`) dan "GSP DATUM" (`datum-gsp-preset`)
 *      dari versi lama terbaru (`skeletonSha256` null) `datum-kanonik` / `datum-gsp`
 *      (nilai baseline disematkan pada setiap kunci lama yang berbeda dari bawaan
 *      registri; GSP DATUM + P4S-13 BM D-151 + `symbol.sheet.fit` true KT-7 +
 *      `table.widthClass` full + `render.rail.renderer` framePr D-327), lalu versi
 *      baru kedua templat = rujukan preset + kenop esensial global (nilai dibaca dari
 *      preset) + kerangka 7 slot (register §6.1; kenop slot dari preset). Satu
 *      transaksi; penjaga §8.2: `paramsSha256` terproyeksi ke kunci versi lama sama
 *      (Kanonik persis, GSP di luar Δ beralasan = {P4S-13, symbol.sheet.fit,
 *      table.widthClass, render.rail.renderer}; nilai Δ wajib = keputusan);
 *      gagal = rollback + exit 1. Run ulang tanpa perubahan = `unchanged`. FIX-SEED
 *      (D-258 N2): deterministik di DB segar maupun berisi — baseline GSP dari profil
 *      berkas memakai nilai terukur kunci yang kini kelas T bila sumbernya terbukti
 *      (`measuredBaselineCorrections`); turunan tidak pernah masuk Δ.
 *   6. Opsional `--import-manual000-v2` (dijalankan SR-38): preset "DATUM Manual 000"
 *      (`datum-manual-000-preset`, terbatas) dari profil preset yang dirujuk
 *      `benchmark/manual000/template.v2.json` (SR-32) + versi berkerangka
 *      `datum-manual-000`; berkas belum ada = galat jelas. Penjaga §8.2: Δ = kunci
 *      `meta.intendedDelta` profil preset (SR-38; sama dengan `verify_v2.ts` G4). Selisih
 *      baris DB lama vs baseline berkas di luar Δ dilaporkan `legacyRowDrift` (D-258 N3).
 *      Revisi baru dokumen 000 TIDAK dibuat di sini (baris dokumen di luar area seed
 *      templat; dibuat lewat layanan revisi R14 `templateVersion`).
 *   7. Opsional `--contract-templates` (DC-29; register 05 §6.1, §6.3, BA-29): templat jenis
 *      kontrak dari registri C58 (`registry/contracts.ts`), tahap 1 = `laporan-kerja-agen`
 *      (`contractKind` agentWorkReport, kerangka NOTA SL-08..SL-10, preset GSP DATUM, lapis
 *      `doc.defaultTier` NOTA / `doc.defaultTypeCode` LAP / `doc.typeCode` bawaan + LAP), lewat
 *      layanan templat v2 (CH-06 ditegakkan layanan). Satu transaksi; penjaga: templat lain
 *      (latestVersionNo, updatedAt, paramsSha256, skeletonSha256, jumlah versi) dan section type
 *      lain tidak berubah, gagal = rollback + exit 1. Run ulang tanpa perubahan = `unchanged`.
 *      S09: dijalankan lewat helper bersama `prisma/seed-studio-templates.ts` (tabel spec templat turunan-preset,
 *      runner transaksi berpenjaga; cek tersimpan + AC-2: tidak terbatas, tidak terarsip, basis = versi preset terbaru).
 *   8. Opsional `--doc-type-templates` (S26/S27; blueprint 02_structured_datum_rev_a.md RQ-1, AC-1, AC-2): 10 templat
 *      jenis dokumen DATUM Rev A (PT, LAP, VER, STD, NOT; ID dan EN) dari tabel spec data murni
 *      `prisma/seed-doc-type-templates.ts` (lapis jenis x lapis bahasa di atas versi terbaru `datum-gsp-preset`,
 *      kerangka datum-gsp, STD + `ruleIndex` AUTO), lewat helper bersama yang sama dengan butir 7. Satu transaksi;
 *      penjaga: templat lain tidak berubah/bertambah, section type tidak tersentuh sama sekali, setiap templat
 *      restricted=false, contractKind null, archived=false, basis = versi preset terbaru; gagal = rollback + exit 1.
 *      Run ulang tanpa perubahan = `unchanged`. Tanpa kode per slug.
 *      C21 (GF-08, M2; research/35 §6 M2, research/38 §4.4): di transaksi yang sama, SEBELUM templat, preset turunan dari
 *      tabel spec data murni `prisma/seed-derived-presets.ts` (preset GSP DATUM Rev A = versi terbaru `datum-gsp-preset`
 *      + sematan Tabel 8.2, pemanggil ADMIN, `isPreset`); slug preset ikut sasaran penjaga, `datum-gsp-preset` bukan
 *      sasaran sehingga wajib tidak berubah. Idempoten (`unchanged` pada jalan ulang).
 *   `--dry-run` (bersama 5/6/7/8): seluruh transaksi preset/kerangka/kontrak di-rollback setelah
 *      laporan dan penjaga dihitung; tidak ada yang di-commit (FIX-SEED): penulisan section type
 *      di luar transaksi itu dan sinkron kanonik dilewati (rencana section type tetap dilaporkan),
 *      dan tidak dapat digabung dengan 3/4/`--import-samples`.
 *
 * Pemakaian: `npx tsx prisma/seed-studio.ts [--import-benchmark] [--import-datum-gsp] [--import-samples] [--presets-and-skeletons] [--import-manual000-v2] [--contract-templates] [--doc-type-templates] [--dry-run]`.
 * Boleh dijalankan dari cwd mana pun (IP-43c, S85 R-22): path profil, sampel,
 * dan indeks aset diresolusi dari lokasi skrip (`REPO_ROOT`), dan cwd proses
 * dipindah ke `REPO_ROOT` agar default pustaka yang relatif cwd (akar
 * `STUDIO_WORKSPACE_ROOT`, aset kanonik) sama dengan run dari akar repo.
 * (`--refresh-v1` lama dihentikan: ditolak dengan galat agar tidak diam-diam diabaikan.)
 * Penjaga DB: hanya `gsp_agent_hq_v21`, `gsp_agent_hq_v21_uji` atau `gsp_agent_hq_v21_seedtest`; DB lain
 * (termasuk produksi `gsp_agent_hq`) ditolak sebelum menulis apa pun.
 * Galat ditulis sebagai satu baris JSON terstruktur ke stderr, exit 1.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import {
  CONTENT_BLOCK_TYPES,
  STUDIO_MAX_JSON_BYTES,
  type ParamValue,
  type StudioCaller,
  type StudioDocV1,
  type StudioOutputFormat,
  type StudioTemplateV2,
  type TemplateSlotDef,
} from "../src/lib/studio/contract";
import { resolveParams, validateParamValue } from "../src/lib/studio/engine/tokens";
import { effectiveClass } from "../src/lib/studio/engine/tokens/merge";
import { closeBrowser } from "../src/lib/studio/engine/browser";
import { ingestDocument, stableStringify } from "../src/lib/studio/services/ingest";
import { renderRevision } from "../src/lib/studio/services/render";
import { ALL_PARAMS, CATALOG_PARAMS, PARAMS_BY_KEY, PARAMS_STRUCTURE } from "../src/lib/studio/params";
import { SECTION_REGISTRY, SECTION_REGISTRY_COUNT, SECTION_REGISTRY_VERSION } from "../src/lib/studio/registry/sections";
import { CONTRACT_KIND_DEFS } from "../src/lib/studio/registry/contracts";
import { skeletonSha256, validateSkeleton } from "../src/lib/studio/services/skeleton";
import {
  canonicalVersionPayload,
  createTemplateV2InTx,
  createTemplateVersionV2InTx,
  ensureCanonicalTemplate,
  importTemplateProfile,
  loadResolvedProfileFile,
  loadResolvedTemplateV2File,
  MANUAL000_SLUG,
  type ParamRecord,
  type ParsedTemplateProfile,
  readTemplateProfileFile,
  resolveTemplate,
  sha256Hex,
  splitBySurface,
  templateRestriction,
} from "../src/lib/studio/services/templates";
import {
  ADMIN_CALLER,
  asRecord,
  DATUM_SKELETON_SLOTS,
  type DerivedTemplateSpec,
  DryRunRollback,
  ensureSkeletonVersion,
  knobValues,
  latestVersionOf,
  PRESET_TX_TIMEOUT_MS,
  presetSlotEssentials,
  runGuardedTemplateTx,
  SEED_ACTOR,
  stable,
  TEMPLATE_V2_SCHEMA_ID,
  type Tx,
  type VersionRow,
} from "./seed-studio-templates";
import { withDerivedPresets } from "./seed-derived-presets";
import { docTypeTemplateTxOptions } from "./seed-doc-type-templates";

const SOURCE = "prisma/seed-studio.ts";
const RUN_ID = randomUUID();
/** `_seedtest` = DB segar sementara uji determinisme seed (FIX-SEED, D-258 N2; dibuat dari migrasi lalu dihapus). */
const ALLOWED_DATABASES = new Set(["gsp_agent_hq_v21", "gsp_agent_hq_v21_uji", "gsp_agent_hq_v21_seedtest"]);
const CANONICAL_SLUG = "datum-kanonik";
/** Akar repo dari lokasi skrip (`prisma/` -> induk); tsx menjalankan berkas ini sebagai CJS (package tanpa `"type": "module"`). */
const REPO_ROOT = path.resolve(__dirname, "..");
/** Path relatif repo (tampilan/log) -> path absolut dari `REPO_ROOT`, tidak pernah dari cwd. */
function repoPath(rel: string): string {
  return path.resolve(REPO_ROOT, ...rel.split(/[\\/]+/));
}
async function isReadableFile(abs: string): Promise<boolean> {
  try {
    await access(abs, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}
const BENCHMARK_PROFILE = path.join("benchmark", "manual000", "template.json");

/** Templat uji manual UT-01: profil visual Manual 000 tanpa pelepas penegakan (tidak terbatas). */
const DATUM_GSP_SLUG = "datum-gsp";
const DATUM_GSP_NAME = "DATUM GSP (profil Manual DATUM 2.6.0)";
// UI-02 (UA-M07): teks tampilan awam (satu kalimat); rincian teknis ada di changeNote/kode.
const DATUM_GSP_DESCRIPTION = "Dokumen resmi GSP mengikuti Manual DATUM 2.6.0; semua pemeriksaan standar berlaku.";
/**
 * Override yang DIBUANG: pelepas penegakan lint. `lint.enforcementOverride`
 * profil benchmark me-release DATUM-04/DATUM-09/G3 khusus agar doc.json
 * benchmark (reproduksi verbatim BM) lolos; menyimpannya membuat templat
 * TERBATAS (hanya ADMIN, D-98/D-102). Prefiks dipakai agar kunci pelepas
 * sejenis di masa depan ikut terbuang.
 */
const DATUM_GSP_DROPPED_OVERRIDE_PREFIX = "lint.enforcement";
/**
 * Medan `meta` benchmark yang DIBUANG: identitas templat benchmark (slug, name,
 * row S95, date), kepemilikan impor benchmark (owner, ownerCallerKind), path
 * lokal berkas acuan BM.docx (profileOf) dan dokumen pengukuran (measuredFrom),
 * register celah/klaster pengukuran BM (gaps, clusters). Dipertahankan:
 * `decisions` dan `notes` (menjelaskan nilai format), `classKOverrides`
 * (kunci kelas K yang memang ditimpa profil).
 */
const DATUM_GSP_DROPPED_META = ["slug", "name", "kind", "owner", "ownerCallerKind", "profileOf", "measuredFrom", "row", "date", "gaps", "clusters"] as const;

// ── Utilitas ────────────────────────────────────────────────────────────

function log(level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}, err?: unknown): void {
  const row = {
    timestamp: new Date().toISOString(),
    level,
    source: SOURCE,
    correlationId: RUN_ID,
    message,
    stack_trace: err instanceof Error ? (err.stack ?? null) : null,
    context,
  };
  (level === "error" ? process.stderr : process.stdout).write(`${JSON.stringify(row)}\n`);
}

function toJson(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
}

// ── Penulisan ───────────────────────────────────────────────────────────

async function assertDatabase(db: PrismaClient): Promise<string> {
  const rows = await db.$queryRaw<{ db: string }[]>`select current_database() as db`;
  const name = rows[0]?.db ?? "";
  if (!ALLOWED_DATABASES.has(name)) throw new Error(`DB '${name}' ditolak; seed Studio hanya untuk ${[...ALLOWED_DATABASES].join(", ")}`);
  return name;
}

type SectionTypeData = Omit<Prisma.StudioSectionTypeUncheckedCreateInput, "key" | "updatedAt">;

function sectionTypeData(s: (typeof SECTION_REGISTRY)[number]): SectionTypeData {
  return {
    catalogId: s.catalogId,
    group: s.group,
    register: s.register,
    name: s.name,
    elements: toJson(s.elements),
    paramRefs: [...s.paramRefs],
    ruleRefs: [...s.ruleRefs],
    activeTiers: [...s.activeTiers],
    renderable: s.renderable,
    sourceRef: s.sourceRef,
    registryVersion: SECTION_REGISTRY_VERSION,
  };
}

/** Rencana section type (baca saja): kunci registri yang belum ada (`create`) atau berbeda dari registri (`update`). */
async function planSectionTypes(db: PrismaClient | Prisma.TransactionClient): Promise<{ registry: number; create: string[]; update: string[]; unchanged: number }> {
  if (SECTION_REGISTRY.length !== SECTION_REGISTRY_COUNT) {
    throw new Error(`Registri section ${SECTION_REGISTRY.length}, diharapkan ${SECTION_REGISTRY_COUNT}`);
  }
  const rows = new Map((await db.studioSectionType.findMany()).map((r) => [r.key, r]));
  const create: string[] = [];
  const update: string[] = [];
  for (const s of SECTION_REGISTRY) {
    const row = rows.get(s.key);
    if (!row) {
      create.push(s.key);
      continue;
    }
    const { updatedAt: _u, key: _k, ...stored } = row;
    void _u;
    void _k;
    if (stable(stored) !== stable(sectionTypeData(s))) update.push(s.key);
  }
  return { registry: SECTION_REGISTRY.length, create, update, unchanged: SECTION_REGISTRY.length - create.length - update.length };
}

/** Section type idempoten (DC-29): hanya baris baru/berbeda yang ditulis; tanpa perubahan = 0 tulis. */
async function seedSectionTypes(tx: Prisma.TransactionClient): Promise<{ registry: number; created: string[]; updated: string[]; unchanged: number }> {
  const plan = await planSectionTypes(tx);
  const byKey = new Map(SECTION_REGISTRY.map((s) => [s.key, s]));
  for (const key of plan.create) await tx.studioSectionType.create({ data: { key, ...sectionTypeData(byKey.get(key)!) } });
  for (const key of plan.update) await tx.studioSectionType.update({ where: { key }, data: sectionTypeData(byKey.get(key)!) });
  return { registry: plan.registry, created: plan.create, updated: plan.update, unchanged: plan.unchanged };
}

/**
 * Baris `StudioSectionType` di DB yang `key`-nya tidak ada di registri saat ini
 * (mis. jenis yang sudah dikeluarkan). Hanya dilaporkan, tidak pernah dihapus
 * (KD-02: dokumen/templat lama bisa masih merujuknya).
 */
async function findUnregisteredSectionTypes(db: PrismaClient): Promise<Array<{ key: string; group: string; registryVersion: string }>> {
  const keys = SECTION_REGISTRY.map((s) => s.key);
  const rows = await db.studioSectionType.findMany({ where: { key: { notIn: keys } }, select: { key: true, group: true, registryVersion: true }, orderBy: { key: "asc" } });
  return rows.map((r) => ({ key: r.key, group: r.group, registryVersion: r.registryVersion }));
}

/** Profil kanonik via layanan S49: bandingkan versi terbaru dengan registri; beda -> versi baru (v lama tak disentuh). */
async function seedCanonicalTemplate(): Promise<{ outcome: "created" | "synced" | "unchanged" | "stale"; versionNo: number; paramsSha256: string }> {
  const r = await ensureCanonicalTemplate({ createdBy: SEED_ACTOR, syncRegistry: true });
  const outcome = r.created ? "created" : r.synced ? "synced" : r.stale ? "stale" : "unchanged";
  return { outcome, versionNo: r.version.versionNo, paramsSha256: r.version.paramsSha256 };
}

/** Impor opsional profil benchmark Manual 000 sebagai `datum-manual-000` (admin); idempoten. */
async function importBenchmarkProfile(): Promise<{ outcome: "created" | "unchanged" | "new-version"; slug: string; versionNo: number; droppedDerived: number; ignoredFields: string[] }> {
  const r = await importTemplateProfile(repoPath(BENCHMARK_PROFILE), { caller: ADMIN_CALLER, slug: MANUAL000_SLUG });
  const outcome = r.created ? "created" : r.unchanged ? "unchanged" : "new-version";
  return { outcome, slug: r.template.slug, versionNo: r.version.versionNo, droppedDerived: r.droppedDerived.length, ignoredFields: r.ignoredFields };
}

/** Profil benchmark -> profil `datum-gsp` (murni; pelepas penegakan + metadata benchmark dibuang). */
function toDatumGspProfile(parsed: ParsedTemplateProfile, sourceSha256: string): { profile: ParsedTemplateProfile; droppedOverrides: string[]; droppedMeta: string[] } {
  const src = parsed.profile;
  const droppedOverrides = Object.keys(src.overrides).filter((k) => k.startsWith(DATUM_GSP_DROPPED_OVERRIDE_PREFIX)).sort();
  const overrides = Object.fromEntries(Object.entries(src.overrides).filter(([k]) => !droppedOverrides.includes(k)));
  const srcMeta = src.meta ?? {};
  const droppedMeta = DATUM_GSP_DROPPED_META.filter((k) => k in srcMeta);
  const keptMeta = Object.fromEntries(Object.entries(srcMeta).filter(([k]) => !(DATUM_GSP_DROPPED_META as readonly string[]).includes(k)));
  const meta = {
    ...keptMeta,
    row: "UT-01",
    purpose: "uji manual dari UI Studio; tidak terbatas (D-98/D-102)",
    derivedFrom: { file: BENCHMARK_PROFILE.replaceAll("\\", "/"), sha256: sourceSha256, profileSlug: src.slug ?? MANUAL000_SLUG },
    stripped: { overrides: droppedOverrides, meta: droppedMeta },
  };
  return {
    profile: {
      ...parsed,
      profile: {
        ...src,
        slug: DATUM_GSP_SLUG,
        name: DATUM_GSP_NAME,
        description: DATUM_GSP_DESCRIPTION,
        kind: "DOCUMENT",
        overrides,
        changeNote: `UT-01: profil Manual DATUM 2.6.0 dari ${BENCHMARK_PROFILE.replaceAll("\\", "/")} tanpa ${droppedOverrides.join(", ") || "pelepas penegakan"}`,
        meta,
      },
    },
    droppedOverrides,
    droppedMeta,
  };
}

/** Impor opsional templat uji manual `datum-gsp` (UT-01); idempoten; wajib tidak terbatas. */
async function importDatumGspProfile(): Promise<Record<string, unknown>> {
  const file = repoPath(BENCHMARK_PROFILE);
  const sourceSha256 = createHash("sha256").update(await readFile(file)).digest("hex");
  const parsed = await readTemplateProfileFile(file);
  const { profile, droppedOverrides, droppedMeta } = toDatumGspProfile(parsed, sourceSha256);
  const r = await importTemplateProfile(profile, { caller: ADMIN_CALLER, slug: DATUM_GSP_SLUG });
  const outcome = r.created ? "created" : r.unchanged ? "unchanged" : "new-version";
  // Pertahanan: status terbatas dihitung dari parameter efektif versi tersimpan.
  const tpl = await resolveTemplate(DATUM_GSP_SLUG, r.version.versionNo);
  const restriction = templateRestriction(tpl.params);
  if (restriction.restricted) {
    throw new Error(`Templat ${DATUM_GSP_SLUG} v${r.version.versionNo} terbatas (melepas ${restriction.releasedChecks.join(", ")}); seharusnya tidak`);
  }
  return {
    outcome,
    slug: r.template.slug,
    versionNo: r.version.versionNo,
    paramsSha256: r.version.paramsSha256,
    restricted: restriction.restricted,
    sourceSha256,
    droppedOverrides,
    droppedMeta,
    droppedDerived: r.droppedDerived.length,
    ignoredFields: r.ignoredFields,
  };
}

// ── Dokumen sampel uji manual (UT-01, `--import-samples`) ───────────────

/** Pemanggil sampel: ADMIN_SESSION (jalur tepercaya), requester berlabel agar baris sampel mudah dikenali. */
const SAMPLE_CALLER: StudioCaller = { kind: "ADMIN_SESSION", requester: "seed-studio-sampel-uji", canWriteClassK: true };
const SAMPLE_FORMATS: StudioOutputFormat[] = ["DOCX", "PDF", "HTML"];
/** Penanda dokumen yang hanya sah untuk benchmark (D-34/D-98): dibuang dari sampel non-benchmark. */
const SAMPLE_STRIP_X = ["benchmark", "enforcement", "lintEnforcement"] as const;

interface SampleSpec {
  key: string;
  file: string;
  /** Urutan coba: templat pertama yang lolos dryRun dipakai; aturan tidak pernah dilonggarkan. */
  templates: string[];
  /** true = dokumen benchmark: penanda `x.*` dipertahankan (jalur tepercaya ADMIN). */
  benchmark: boolean;
  assetIndexPath?: string;
}

const SAMPLES: readonly SampleSpec[] = [
  { key: "nota-memo", file: "tests/parity/fixtures/doc/doc_nota_memo.json", templates: [DATUM_GSP_SLUG, CANONICAL_SLUG], benchmark: false },
  { key: "nota-tables", file: "tests/parity/fixtures/doc/doc_nota_tables.json", templates: [DATUM_GSP_SLUG, CANONICAL_SLUG], benchmark: false },
  { key: "serah-handover", file: "tests/parity/fixtures/doc/doc_serah_handover.json", templates: [DATUM_GSP_SLUG, CANONICAL_SLUG], benchmark: false },
  { key: "terbit-report", file: "tests/parity/fixtures/doc/doc_terbit_report.json", templates: [DATUM_GSP_SLUG, CANONICAL_SLUG], benchmark: false },
  {
    key: "manual-000",
    file: "benchmark/manual000/doc.json",
    templates: [MANUAL000_SLUG],
    benchmark: true,
    assetIndexPath: "benchmark/manual000/figures/index.json",
  },
];

type SampleOutcome = Record<string, unknown> & { key: string; outcome: "created" | "unchanged" | "rendered" | "stale" | "rejected" | "failed" };

/** Sama dengan `inputSha256` ingest: sha256(stableStringify(dokumen permintaan)). */
function inputSha256Of(doc: StudioDocV1): string {
  return createHash("sha256").update(stableStringify(doc)).digest("hex");
}

async function readSampleDoc(spec: SampleSpec): Promise<StudioDocV1> {
  const file = repoPath(spec.file);
  const text = await readFile(file, "utf8");
  if (Buffer.byteLength(text) > STUDIO_MAX_JSON_BYTES) throw new Error(`Sampel ${spec.file} melebihi ${STUDIO_MAX_JSON_BYTES} byte`);
  const doc = JSON.parse(text.replace(/^﻿/, "")) as StudioDocV1;
  if (!spec.benchmark) {
    const x = (doc as { x?: Record<string, unknown> }).x;
    if (x) for (const k of SAMPLE_STRIP_X) delete x[k];
    // Tautan misi opsional (I42); fixture menunjuk folder misi ilustratif yang tidak ada -> dilepas, tidak ada data IL disentuh.
    delete (doc as { mission?: unknown }).mission;
  }
  return doc;
}

/** Revisi terkini punya job SUCCEEDED dengan semua format sampel? */
async function hasCompleteRender(db: PrismaClient, revisionId: string): Promise<boolean> {
  const jobs = await db.studioRenderJob.findMany({ where: { revisionId, status: "SUCCEEDED" }, select: { formats: true } });
  return jobs.some((j) => SAMPLE_FORMATS.every((f) => j.formats.includes(f)));
}

async function renderSample(revisionId: string): Promise<Record<string, unknown>> {
  const r = await renderRevision(revisionId, SAMPLE_FORMATS, SAMPLE_CALLER);
  return {
    jobId: r.job.id,
    jobStatus: r.job.status,
    errors: r.errors.map((e) => `${e.code}: ${e.message}`.slice(0, 300)),
    outputs: r.outputs.filter((o) => o.role === "PRIMARY").map((o) => ({ format: o.format, role: o.role, bytes: o.bytes, sha256: o.sha256, relPath: o.relPath })),
    releaseStatus: r.lint?.releaseStatus ?? null,
  };
}

/**
 * Satu sampel: idempoten berdasarkan (judul, templat kandidat). Dokumen ada +
 * render lengkap = `unchanged`; dokumen ada tanpa render lengkap = render ulang
 * (`rendered`). Dokumen baru: dryRun per templat kandidat lalu ingest normal
 * dengan templat pertama yang lolos; semua ditolak = `rejected` (cek dicatat).
 */
async function importSample(db: PrismaClient, spec: SampleSpec): Promise<SampleOutcome> {
  const doc = await readSampleDoc(spec);
  const existing = await db.studioDocument.findFirst({
    where: { title: doc.meta.title, template: { slug: { in: spec.templates } } },
    include: { template: { select: { slug: true } } },
  });
  if (existing) {
    const rev = await db.studioRevision.findFirst({ where: { documentId: existing.id, revisionNo: existing.currentRevisionNo }, select: { id: true, inputSha256: true } });
    if (!rev) throw new Error(`Dokumen sampel ${existing.id} tanpa revisi ${existing.currentRevisionNo}`);
    const base = { key: spec.key, documentId: existing.id, docNumber: existing.docNumber, template: existing.template.slug, revisionId: rev.id };
    // Isi berkas sumber berubah (mis. doc.json ditulis ulang): dokumen tersimpan TIDAK diubah/dihapus
    // otomatis (nomor dokumen unik); dilaporkan agar penggantian diputuskan controller.
    const currentSha = inputSha256Of({ ...doc, template: { slug: existing.template.slug } } as StudioDocV1);
    if (rev.inputSha256 !== currentSha) return { ...base, outcome: "stale", storedInputSha256: rev.inputSha256, fileInputSha256: currentSha };
    if (await hasCompleteRender(db, rev.id)) return { ...base, outcome: "unchanged" };
    return { ...base, outcome: "rendered", render: await renderSample(rev.id) };
  }

  const rejections: Array<{ template: string; checks: string[] }> = [];
  for (const slug of spec.templates) {
    const candidate = { ...doc, template: { slug } } as StudioDocV1;
    const opts = { assetIndexPath: spec.assetIndexPath ? repoPath(spec.assetIndexPath) : undefined, correlationId: RUN_ID };
    const dry = await ingestDocument({ document: candidate }, SAMPLE_CALLER, { dryRun: true, ...opts });
    if (!dry.valid) {
      rejections.push({ template: slug, checks: dry.issues.map((i) => `${i.checkId ?? i.keyword} ${i.pointer}`.slice(0, 200)) });
      continue;
    }
    const res = await ingestDocument({ document: candidate }, SAMPLE_CALLER, { dryRun: false, ...opts });
    if (!res.document || !res.revision) throw new Error(`Ingest sampel ${spec.key} valid tetapi tanpa dokumen/revisi`);
    const render = await renderSample(res.revision.id);
    return {
      key: spec.key,
      outcome: "created",
      documentId: res.document.id,
      docNumber: res.document.docNumber,
      template: slug,
      templateVersionId: res.revision.templateVersionId,
      revisionId: res.revision.id,
      rejectedBefore: rejections,
      render,
    };
  }
  return { key: spec.key, outcome: "rejected", rejections };
}

async function importSamples(db: PrismaClient): Promise<SampleOutcome[]> {
  const results: SampleOutcome[] = [];
  for (const spec of SAMPLES) {
    try {
      const r = await importSample(db, spec);
      const level = r.outcome === "rejected" || r.outcome === "stale" ? "warn" : "info";
      const message =
        r.outcome === "rejected"
          ? "Sampel ditolak semua templat kandidat (aturan tidak dilonggarkan)"
          : r.outcome === "stale"
            ? "Sampel tersimpan berbeda dari berkas sumber; dibiarkan (tidak ditimpa)"
            : "Sampel dokumen";
      log(level, message, r);
      results.push(r);
    } catch (err) {
      // Satu sampel gagal tidak menghentikan sampel lain; exit code tetap 1 (lihat main).
      log("error", `Sampel ${spec.key} gagal: ${err instanceof Error ? err.message : String(err)}`, { key: spec.key, file: spec.file }, err);
      results.push({ key: spec.key, outcome: "failed" });
    }
  }
  return results;
}

// ── Preset gaya + kerangka (SR-36, `--presets-and-skeletons` / `--import-manual000-v2`) ──

const MANUAL000_V2_TEMPLATE = path.join("benchmark", "manual000", "template.v2.json");
/** P4S-13 nilai BM (D-151; research/09 §8.1): nomor dokumen, huruf revisi, PAGE, NUMPAGES, klasifikasi. */
const REGISTER_BOLD_KEY = "device.registerBlock.boldFields";
const BM_REGISTER_BOLD_FIELDS = ["nomor dokumen", "revisi", "nomor lembar", "jumlah lembar", "klasifikasi"];
/** R-12 perender rel bukti: GSP DATUM = chip `framePr` HS rev B (D-327); Manual 000 tetap `table3col` (BM T013). */
const RAIL_RENDERER_KEY = "render.rail.renderer";
/** Batas iterasi penyematan (sematan bisa mengubah kunci turunan beracuan lain). */
const PIN_PASSES_MAX = 4;

/** Satu kunci Δ beralasan (research/09 §8.2): boleh berbeda dari baseline, nilai baru wajib = `decided[key]`. */
interface DeltaEntry {
  key: string;
  reason: string;
}

interface PresetMigrationSpec {
  templateSlug: string;
  presetSlug: string;
  presetName: string;
  presetDescription: string;
  /** Nilai preset yang disahkan keputusan, di atas nilai baseline. */
  decided: ParamRecord;
  /**
   * Δ: kunci lama yang boleh berbeda dari baseline, masing-masing dengan alasan keputusan. Hanya kunci
   * keputusan (bukan turunan kelas T-nya): turunan tetap dibandingkan dengan baseline terukur.
   */
  delta: readonly DeltaEntry[];
  /** Prefiks kunci baseline yang tidak disematkan ke preset. */
  dropPrefixes: readonly string[];
  /**
   * Berkas profil sumber versi baseline (`provenance.meta.derivedFrom.file`). Bila sha berkas kini = sha
   * yang tercatat di versi itu, nilai terukur override yang kini kelas T menjadi baseline kunci itu
   * (lihat `measuredBaselineCorrections`).
   */
  sourceProfile?: string;
}

const deltaKeys = (spec: Pick<PresetMigrationSpec, "delta">): string[] => spec.delta.map((d) => d.key);

const PRESET_MIGRATIONS: readonly PresetMigrationSpec[] = [
  {
    templateSlug: CANONICAL_SLUG,
    presetSlug: "datum-kanonik-preset",
    presetName: "DATUM Kanonik",
    presetDescription: "Gaya DATUM dengan nilai bawaan standar; pilihan aman untuk templat baru.",
    decided: {},
    delta: [],
    dropPrefixes: [],
  },
  // Δ GSP (FIX-SEED, D-258 N2): di v21 baseline v1 (721 kunci) belum memuat `symbol.sheet.fit` /
  // `table.widthClass`, jadi kedua keputusan tidak pernah dibandingkan; baseline dari registri kini memuatnya
  // (nilai bawaan false / text) sehingga keputusan itu wajib dinyatakan sebagai Δ beralasan.
  {
    templateSlug: DATUM_GSP_SLUG,
    presetSlug: "datum-gsp-preset",
    presetName: "GSP DATUM",
    presetDescription: "Gaya GSP DATUM: format terukur Manual DATUM untuk dokumen resmi GSP.",
    // D-151 (P4S-13 BM), D-165 KT-7 (fit true), research/09 §8.1 (`table.widthClass` full menggantikan override P5-14 = 166),
    // D-327 (rel framePr HS rev B; baseline v1 mewarisi table3col dari profil Manual 000).
    decided: { [REGISTER_BOLD_KEY]: BM_REGISTER_BOLD_FIELDS, "symbol.sheet.fit": true, "table.widthClass": "full", [RAIL_RENDERER_KEY]: "framePr" },
    delta: [
      { key: REGISTER_BOLD_KEY, reason: "D-151 / D-165 KT-6: P4S-13 nilai BM (nomor dokumen, revisi, nomor lembar, jumlah lembar, klasifikasi)" },
      { key: "symbol.sheet.fit", reason: "D-165 KT-7: lembar simbol isi-pas = gaya manual (RL datum_symbols.py --sheet)" },
      {
        key: "table.widthClass",
        reason:
          "research/09 §8.1, D-162: kenop kelas lebar menggantikan override P5-14 = 166 (kini kelas T); turunan table.columnWidthSumMm BUKAN Δ, dibandingkan dengan nilai terukur baseline (166)",
      },
      {
        key: RAIL_RENDERER_KEY,
        reason:
          "D-327 (FIX-H4 C4, Hermes): templat GSP mencerminkan datum-house-style fleet, HS rev B / G-RAIL rev B = chip rel w:framePr; baseline v1 table3col warisan profil Manual 000 (BM.docx T013). Manual 000 tetap table3col. Turunan render.rail.colsTw (kelas T) BUKAN Δ, tetap dibandingkan dengan baseline",
      },
    ],
    dropPrefixes: [DATUM_GSP_DROPPED_OVERRIDE_PREFIX],
    sourceProfile: BENCHMARK_PROFILE,
  },
];

/** Kerangka bawaan 7 slot (register 03 §6.1 SL-01..SL-07; blueprint §2.3); satu sumber di helper bersama (S26). */
const SKELETON_SLOTS = DATUM_SKELETON_SLOTS;

/** sha256(stableStringify(pick(P, keys))) — proyeksi kunci research/09 §8.2. */
function projSha(p: ParamRecord, keys: readonly string[]): string {
  const picked: ParamRecord = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(p, k)) picked[k] = p[k];
  return sha256Hex(stableStringify(picked));
}

/** Hitungan kunci satu lapis per lapis permukaan registri. */
function surfaceCounts(layer: ParamRecord): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(layer)) {
    const s = PARAMS_BY_KEY.get(k)?.surface ?? "unknown";
    out[s] = (out[s] ?? 0) + 1;
  }
  return out;
}

/** Kerangka 7 slot; `effective` = nilai kenop slot dibaca dari preset (null = tanpa kenop, mis. kerangka preset). */
function buildSkeletonSlots(effective: ParamRecord | null): { slots: TemplateSlotDef[]; skipped: Record<string, string[]> } {
  return presetSlotEssentials(SKELETON_SLOTS, effective);
}

/** Lipat override rantai `baseVersionId` (akar -> daun), seperti `baseLayerFor` layanan templat. */
async function foldChain(tx: Tx, versionId: string | null): Promise<{ overrides: ParamRecord; roleFormats: Record<string, unknown> }> {
  const chain: Array<{ overrides: ParamRecord; roleFormats: Record<string, unknown> }> = [];
  const seen = new Set<string>();
  let next = versionId;
  while (next) {
    if (seen.has(next) || seen.size > 32) throw new Error(`Rantai versi dasar melingkar/terlalu panjang di ${next}`);
    seen.add(next);
    const v = await tx.studioTemplateVersion.findUnique({ where: { id: next }, select: { baseVersionId: true, overrides: true, roleFormats: true } });
    if (!v) throw new Error(`Versi dasar ${next} tidak ditemukan`);
    chain.unshift({ overrides: asRecord(v.overrides), roleFormats: asRecord(v.roleFormats) as Record<string, unknown> });
    next = v.baseVersionId;
  }
  const roleFormats = chain.length > 0 ? chain[chain.length - 1].roleFormats : {};
  return { overrides: Object.assign({}, ...chain.map((c) => c.overrides)) as ParamRecord, roleFormats };
}

/** Versi terkini dikelola preset/kerangka (`skeletonSha256` terisi). */
async function isSkeletonManaged(db: PrismaClient | Tx, slug: string): Promise<boolean> {
  const t = await db.studioTemplate.findUnique({ where: { slug }, select: { id: true, latestVersionNo: true } });
  if (!t) return false;
  const v = await db.studioTemplateVersion.findUnique({ where: { templateId_versionNo: { templateId: t.id, versionNo: t.latestVersionNo } }, select: { skeletonSha256: true } });
  return Boolean(v?.skeletonSha256);
}

/**
 * Lapis preset dari baseline: keputusan + sematan nilai baseline pada setiap kunci lama
 * (di luar Δ, bukan kelas T) yang nilai efektifnya berbeda tanpa sematan; diulang sampai
 * stabil. Sisa beda (kelas T, nilai tidak sah) dikembalikan sebagai `unresolved`.
 */
function computePresetLayer(baseline: ParamRecord, baseOverrides: ParamRecord, spec: Pick<PresetMigrationSpec, "decided" | "delta" | "dropPrefixes">) {
  const delta = deltaKeys(spec);
  const legacy = Object.keys(baseline).filter((k) => !delta.includes(k));
  const layer: ParamRecord = JSON.parse(JSON.stringify(spec.decided)) as ParamRecord;
  let effective: ParamRecord = {};
  let diffs: string[] = [];
  for (let pass = 0; pass < PIN_PASSES_MAX; pass++) {
    const r = resolveParams({ base: baseOverrides, overrides: layer, registry: ALL_PARAMS });
    if (r.errors.length > 0) throw new Error(`Resolusi lapis preset gagal: ${r.errors.slice(0, 3).map((e) => `${e.key}: ${e.message}`).join("; ")}`);
    effective = { ...r.params } as ParamRecord;
    diffs = legacy.filter((k) => stable(effective[k]) !== stable(baseline[k]));
    let added = 0;
    for (const k of diffs) {
      const def = PARAMS_BY_KEY.get(k);
      if (!def || k in layer || spec.dropPrefixes.some((p) => k.startsWith(p))) continue;
      if (effectiveClass(def, baseline[k], undefined) === "T" || validateParamValue(def, baseline[k]) !== null) continue;
      layer[k] = JSON.parse(JSON.stringify(baseline[k])) as ParamValue;
      added++;
    }
    if (added === 0) break;
  }
  return { layer, effective, unresolved: diffs };
}

/** Pastikan templat preset (isPreset) berisi lapis/roleFormats/kerangka yang diminta; idempoten. */
async function ensurePreset(
  tx: Tx,
  p: { slug: string; name: string; description: string; layer: ParamRecord; ownRoleFormats: Record<string, unknown>; skeletonSlots: TemplateSlotDef[]; changeNote: string },
): Promise<{ outcome: "created" | "new-version" | "unchanged"; version: VersionRow; restricted: boolean }> {
  const split = splitBySurface(p.layer);
  const definition: StudioTemplateV2 = {
    $schema: TEMPLATE_V2_SCHEMA_ID,
    essentials: split.essentials,
    ...(Object.keys(split.advanced).length > 0 ? { advanced: split.advanced } : {}),
    roleFormats: p.ownRoleFormats as StudioTemplateV2["roleFormats"],
    skeleton: { slots: p.skeletonSlots },
  };
  const wantSk = skeletonSha256(validateSkeleton({ slots: p.skeletonSlots }));
  const t = await tx.studioTemplate.findUnique({ where: { slug: p.slug } });
  let outcome: "created" | "new-version" | "unchanged";
  if (!t) {
    await createTemplateV2InTx(tx, { slug: p.slug, name: p.name, kind: "DOCUMENT", description: p.description, isPreset: true, changeNote: p.changeNote, template: definition }, ADMIN_CALLER);
    outcome = "created";
  } else {
    if (!t.isPreset) throw new Error(`Slug ${p.slug} sudah dipakai templat non-preset; preset tidak dibuat`);
    const latest = await latestVersionOf(tx, t.id, t.latestVersionNo);
    const base = await foldChain(tx, latest.baseVersionId);
    const sameRoles = stable(asRecord(latest.roleFormats)) === stable({ ...base.roleFormats, ...p.ownRoleFormats });
    if (stable(asRecord(latest.overrides)) === stable(p.layer) && sameRoles && latest.skeletonSha256 === wantSk) {
      outcome = "unchanged";
    } else {
      await createTemplateVersionV2InTx(tx, t.id, { baseVersionNo: t.latestVersionNo, changeNote: p.changeNote, template: definition }, ADMIN_CALLER);
      outcome = "new-version";
    }
  }
  const t2 = await tx.studioTemplate.findUniqueOrThrow({ where: { slug: p.slug } });
  const version = await latestVersionOf(tx, t2.id, t2.latestVersionNo);
  if (version.skeletonSha256 !== wantSk) log("warn", "Sidik kerangka preset tersimpan berbeda dari hitungan seed (idempotensi diperiksa run ulang)", { slug: p.slug, stored: version.skeletonSha256, computed: wantSk });
  return { outcome, version, restricted: templateRestriction(asRecord(version.resolvedParams)).restricted };
}

/**
 * Penjaga research/09 §8.2 + hitungan lapis (laporan per templat). `expected` (opsional) = nilai keputusan
 * per kunci Δ: Δ bukan pengecualian bebas, nilai baru kunci Δ yang diputuskan wajib sama dengan keputusannya.
 */
function guardReport(i: {
  baseline: ParamRecord;
  baselineSha: string;
  legacyKeys: readonly string[];
  delta: readonly string[];
  next: VersionRow;
  exact: boolean;
  expected?: ParamRecord;
  reasons?: Readonly<Record<string, string>>;
}) {
  const next = asRecord(i.next.resolvedParams);
  const keys = i.legacyKeys.filter((k) => !i.delta.includes(k));
  const missing = i.legacyKeys.filter((k) => !Object.prototype.hasOwnProperty.call(next, k));
  const diffOutsideDelta = keys.filter((k) => stable(next[k]) !== stable(i.baseline[k]));
  const projOld = projSha(i.baseline, keys);
  const projNew = projSha(next, keys);
  const projNewAll = projSha(next, i.legacyKeys);
  const legacySet = new Set(i.legacyKeys);
  const newKeys = Object.keys(next).filter((k) => !legacySet.has(k));
  const newKeysNonDefault = newKeys.filter((k) => stable(next[k]) !== stable(PARAMS_BY_KEY.get(k)?.default)).sort();
  const expected = i.expected ?? {};
  const has = (o: ParamRecord, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  const deltaValueMismatch = i.delta.filter((k) => has(expected, k) && stable(next[k]) !== stable(expected[k]));
  const ok =
    missing.length === 0 && diffOutsideDelta.length === 0 && deltaValueMismatch.length === 0 && projOld === projNew && (!i.exact || projNewAll === i.baselineSha);
  return {
    ok,
    legacyKeys: i.legacyKeys.length,
    baselineParamsSha256: i.baselineSha,
    projectedNewSha256: projNewAll,
    projectedExactMatch: projNewAll === i.baselineSha,
    projectedOutsideDelta: { old: projOld, new: projNew, equal: projOld === projNew },
    delta: i.delta.map((k) => ({
      key: k,
      old: i.baseline[k] ?? null,
      new: next[k] ?? null,
      ...(i.reasons?.[k] ? { reason: i.reasons[k] } : {}),
      ...(has(expected, k) ? { decided: expected[k], matchesDecision: !deltaValueMismatch.includes(k) } : {}),
    })),
    deltaValueMismatch,
    diffOutsideDelta: diffOutsideDelta.slice(0, 50),
    missingLegacyKeys: missing.slice(0, 50),
    newFullParamsSha256: i.next.paramsSha256,
    newKeys: newKeys.length,
    newKeysNonDefault,
  };
}

async function templateLayerCounts(tx: Tx, version: VersionRow) {
  const layer = asRecord(version.overrides);
  const counts = surfaceCounts(layer);
  const slots = await tx.studioTemplateSlot.findMany({ where: { templateVersionId: version.id }, orderBy: { position: "asc" }, select: { slotKey: true, params: { select: { paramKey: true, surface: true } } } });
  const slotEssentials = slots.reduce((n, s) => n + s.params.filter((x) => x.surface === "essential").length, 0);
  const slotAdvanced = slots.reduce((n, s) => n + s.params.filter((x) => x.surface !== "essential").length, 0);
  return {
    templateEssentials: counts.essential ?? 0,
    templateAdvancedRemaining: Object.keys(layer).length - (counts.essential ?? 0),
    slots: slots.length,
    slotEssentials,
    slotAdvancedRemaining: slotAdvanced,
  };
}

interface BaselineCorrections {
  status: "no-source-profile" | "no-provenance" | "other-source" | "source-changed" | "applied";
  sourceSha256?: string | null;
  recordedSha256?: string | null;
  corrections: Array<{ key: string; stored: unknown; declared: unknown }>;
}

/**
 * Baseline terukur (FIX-SEED, D-258 N2; analog KT-5 `prepareManual000V2`). Versi baseline yang diimpor dari
 * profil berkas dengan registri kini kehilangan nilai terukur override yang kini kelas T: pembaca membuang
 * override T, nilai tersimpan = turunan dari kenop bawaan (mis. P5-14 `table.columnWidthSumMm` 166 -> 128 dari
 * `table.widthClass` text). Di DB lama (registri waktu itu: P5-14 kelas K) nilai tersimpan = 166, jadi penjaga
 * dua DB berbeda. Koreksi HANYA bila `provenance.meta.derivedFrom.file` = berkas sumber spec DAN sha berkas kini
 * = sha tercatat (isi sumber versi itu terbukti): nilai yang dinyatakan profil untuk kunci yang dibuang menjadi
 * baseline kunci itu. Selain itu tanpa koreksi (penjaga memakai nilai tersimpan apa adanya; tidak melonggarkan).
 */
async function measuredBaselineCorrections(baseline: VersionRow, baselineParams: ParamRecord, sourceProfile: string | undefined): Promise<BaselineCorrections> {
  if (!sourceProfile) return { status: "no-source-profile", corrections: [] };
  const derivedFrom = asRecord(asRecord(asRecord(baseline.provenance).meta).derivedFrom);
  const recordedFile = typeof derivedFrom.file === "string" ? derivedFrom.file : null;
  const recordedSha256 = typeof derivedFrom.sha256 === "string" ? derivedFrom.sha256 : null;
  if (!recordedFile || !recordedSha256) return { status: "no-provenance", recordedSha256, corrections: [] };
  if (recordedFile.replaceAll("\\", "/") !== sourceProfile.replaceAll("\\", "/")) return { status: "other-source", recordedSha256, corrections: [] };
  const file = repoPath(sourceProfile);
  const bytes = await readFile(file);
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  if (sourceSha256 !== recordedSha256) return { status: "source-changed", sourceSha256, recordedSha256, corrections: [] };
  const parsed = await readTemplateProfileFile(file);
  const raw = asRecord(asRecord(JSON.parse(bytes.toString("utf8").replace(/^﻿/, ""))).overrides);
  const corrections = parsed.droppedDerived
    .filter((k) => Object.prototype.hasOwnProperty.call(raw, k) && Object.prototype.hasOwnProperty.call(baselineParams, k) && stable(raw[k]) !== stable(baselineParams[k]))
    .sort()
    .map((k) => ({ key: k, stored: baselineParams[k], declared: raw[k] }));
  return { status: "applied", sourceSha256, recordedSha256, corrections };
}

/** SR-36: preset Kanonik + GSP DATUM dan versi berkerangka `datum-kanonik` / `datum-gsp` (satu transaksi). */
async function seedPresetsAndSkeletons(tx: Tx): Promise<Record<string, unknown>[]> {
  // Fase A: semua preset dulu (dasar preset = versi kanonik terbaru sebelum kanonik berkerangka).
  const prepared: Array<{
    spec: PresetMigrationSpec;
    baseline: VersionRow;
    guardBaseline: ParamRecord;
    corrections: BaselineCorrections;
    preset: Awaited<ReturnType<typeof ensurePreset>>;
    unresolved: string[];
    presetLayer: ParamRecord;
  }> = [];
  for (const spec of PRESET_MIGRATIONS) {
    const t = await tx.studioTemplate.findUnique({ where: { slug: spec.templateSlug } });
    if (!t) throw new Error(`Templat ${spec.templateSlug} tidak ada; jalankan seed dasar${spec.templateSlug === DATUM_GSP_SLUG ? " + --import-datum-gsp" : ""} lebih dulu`);
    const baseline = await tx.studioTemplateVersion.findFirst({ where: { templateId: t.id, skeletonSha256: null }, orderBy: { versionNo: "desc" } });
    if (!baseline) throw new Error(`Templat ${spec.templateSlug} tanpa versi lama (skeletonSha256 null) sebagai baseline`);
    const baselineParams = asRecord(baseline.resolvedParams);
    const recomputed = sha256Hex(stableStringify(baselineParams));
    if (recomputed !== baseline.paramsSha256) throw new Error(`Integritas baseline ${spec.templateSlug} v${baseline.versionNo}: sha tersimpan ${baseline.paramsSha256} != hitung ulang ${recomputed}`);
    const corrections = await measuredBaselineCorrections(baseline, baselineParams, spec.sourceProfile);
    const guardBaseline: ParamRecord = { ...baselineParams };
    for (const c of corrections.corrections) guardBaseline[c.key] = JSON.parse(JSON.stringify(c.declared)) as ParamValue;

    const existingPreset = await tx.studioTemplate.findUnique({ where: { slug: spec.presetSlug } });
    const presetBaseId = existingPreset
      ? (await latestVersionOf(tx, existingPreset.id, existingPreset.latestVersionNo)).baseVersionId
      : await (async () => {
          const c = await tx.studioTemplate.findUniqueOrThrow({ where: { slug: CANONICAL_SLUG } });
          return (await latestVersionOf(tx, c.id, c.latestVersionNo)).id;
        })();
    const base = await foldChain(tx, presetBaseId);
    const computed = computePresetLayer(guardBaseline, base.overrides, spec);
    const baseRoles = base.roleFormats;
    const ownRoleFormats = Object.fromEntries(Object.entries(asRecord(baseline.roleFormats)).filter(([role, f]) => stable(f) !== stable(baseRoles[role])));
    const preset = await ensurePreset(tx, {
      slug: spec.presetSlug,
      name: spec.presetName,
      description: spec.presetDescription,
      layer: computed.layer,
      ownRoleFormats,
      skeletonSlots: buildSkeletonSlots(null).slots,
      changeNote: `SR-36: preset ${spec.presetName} dari ${spec.templateSlug} v${baseline.versionNo} (sha ${baseline.paramsSha256.slice(0, 16)})`,
    });
    if (preset.restricted) throw new Error(`Preset ${spec.presetSlug} terbatas (melepas cek penolak); seharusnya tidak`);
    prepared.push({ spec, baseline, guardBaseline, corrections, preset, unresolved: computed.unresolved, presetLayer: computed.layer });
  }

  // Fase B: versi templat berkerangka + penjaga.
  const reports: Record<string, unknown>[] = [];
  for (const { spec, baseline, guardBaseline, corrections, preset, unresolved, presetLayer } of prepared) {
    const presetEffective = asRecord(preset.version.resolvedParams);
    const global = knobValues("global", presetEffective);
    const sk = buildSkeletonSlots(presetEffective);
    const t = await tx.studioTemplate.findUniqueOrThrow({ where: { slug: spec.templateSlug } });
    const r = await ensureSkeletonVersion(tx, {
      slug: spec.templateSlug,
      name: t.name,
      description: t.description ?? "",
      preset: { slug: spec.presetSlug, version: preset.version },
      essentials: global.values,
      skeletonSlots: sk.slots,
      changeNote: `SR-36: preset ${spec.presetSlug} v${preset.version.versionNo} + esensial + kerangka 7 slot (baseline v${baseline.versionNo} sha ${baseline.paramsSha256.slice(0, 16)})`,
    });
    const guard = guardReport({
      baseline: guardBaseline,
      baselineSha: baseline.paramsSha256,
      legacyKeys: Object.keys(guardBaseline),
      delta: deltaKeys(spec),
      next: r.version,
      // Penjaga persis (Kanonik) hanya tanpa Δ dan tanpa koreksi baseline terukur.
      exact: spec.delta.length === 0 && corrections.corrections.length === 0,
      expected: Object.fromEntries(deltaKeys(spec).filter((k) => k in spec.decided).map((k) => [k, spec.decided[k]])) as ParamRecord,
      reasons: Object.fromEntries(spec.delta.map((d) => [d.key, d.reason])),
    });
    reports.push({
      slug: spec.templateSlug,
      baseline: { versionNo: baseline.versionNo, paramsSha256: baseline.paramsSha256, measuredCorrections: corrections },
      preset: {
        slug: spec.presetSlug,
        outcome: preset.outcome,
        versionNo: preset.version.versionNo,
        paramsSha256: preset.version.paramsSha256,
        baseVersionId: preset.version.baseVersionId,
        restricted: preset.restricted,
        layerKeys: Object.keys(presetLayer).length,
        layerBySurface: surfaceCounts(presetLayer),
        roleFormats: Object.keys(asRecord(preset.version.roleFormats)).length,
        unresolvedBeforeWrite: unresolved,
      },
      template: {
        outcome: r.outcome,
        versionNo: r.version.versionNo,
        baseVersionId: r.version.baseVersionId,
        skeletonSha256: r.version.skeletonSha256,
        skeletonShaMatchesSeed: r.version.skeletonSha256 === r.computedSkeletonSha256,
        skippedKnobKeys: { global: global.skipped, slots: sk.skipped },
        ...(await templateLayerCounts(tx, r.version)),
      },
      guard,
    });
  }
  return reports;
}

/** Bahan `--import-manual000-v2` dibaca di luar transaksi (berkas SR-32 + baseline KT-5). */
async function prepareManual000V2(): Promise<{
  loaded: Awaited<ReturnType<typeof loadResolvedTemplateV2File>>;
  preset: ParsedTemplateProfile;
  baselineFile: ParamRecord;
}> {
  const file = repoPath(MANUAL000_V2_TEMPLATE);
  if (!(await isReadableFile(file))) {
    throw new Error(
      `--import-manual000-v2: berkas ${MANUAL000_V2_TEMPLATE.replaceAll("\\", "/")} belum ada (keluaran SR-32, benchmark v2). Jalankan flag ini (SR-38) setelah SR-32 menulis berkas itu; tidak ada yang ditulis.`,
    );
  }
  const loaded = await loadResolvedTemplateV2File(file, { repoRoot: REPO_ROOT });
  if (!loaded.preset.file) throw new Error(`--import-manual000-v2: ${MANUAL000_V2_TEMPLATE} merujuk preset "${loaded.preset.slug}" tanpa berkas profil preset (Manual 000 wajib preset berprofil)`);
  const preset = await readTemplateProfileFile(loaded.preset.file);
  // KT-5 (D-165): baseline Manual 000 = template.json pasca-RT-01 (profil konten-saja), resolusi di memori.
  // Override yang kini kelas T dibuang pembaca (mis. P5-14 = 166 -> turunan 128 dari kenop bawaan);
  // nilai terukur yang dinyatakan profil dipakai sebagai baseline kunci itu (= nilai versi DB lama).
  const baselineProfile = await loadResolvedProfileFile(repoPath(BENCHMARK_PROFILE), { repoRoot: REPO_ROOT });
  const baselineFile = { ...asRecord(baselineProfile.template.params) };
  if (baselineProfile.droppedDerived.length > 0) {
    const raw = asRecord(asRecord(JSON.parse((await readFile(repoPath(BENCHMARK_PROFILE), "utf8")).replace(/^﻿/, ""))).overrides);
    for (const k of baselineProfile.droppedDerived) if (k in raw) baselineFile[k] = raw[k];
  }
  return { loaded, preset, baselineFile };
}

/**
 * Δ penjaga Manual 000 = `meta.intendedDelta` profil preset (SR-32/RQ-8, D-216/D-224; sumber yang
 * sama dengan `verify_v2.ts` G4), bukan daftar tertanam. Entri wajib `{ key }` kunci registri;
 * daftar kosong/tak sah = galat (penjaga tanpa Δ berbukti tidak dijalankan).
 */
function intendedDeltaOf(preset: ParsedTemplateProfile, file: string): string[] {
  const rel = path.relative(REPO_ROOT, file).replaceAll("\\", "/");
  const list = preset.profile.meta?.intendedDelta;
  if (!Array.isArray(list) || list.length === 0) throw new Error(`--import-manual000-v2: ${rel} tanpa meta.intendedDelta (daftar Δ berbukti BM wajib; D-216)`);
  const keys = list.map((d: unknown, i: number) => {
    const key = asRecord(d).key;
    if (typeof key !== "string" || !PARAMS_BY_KEY.has(key)) throw new Error(`--import-manual000-v2: ${rel} meta.intendedDelta[${i}].key bukan kunci registri (${String(key)})`);
    return key;
  });
  return [...new Set(keys)].sort();
}

/**
 * Kunci LAMA penjaga Manual 000 = definisi `verify_v2.ts` G4 (research/09 §8.2): registri dikurangi 21 kunci
 * struktur (SR-01/SR-59) ditambah `grid.marginBottomMm` (promosi kunci bayangan lama). Tidak bergantung isi DB
 * (FIX-SEED, D-258 N2): sebelumnya = kunci baris DB lama (v21) atau SEMUA kunci (DB segar, tanpa baris lama),
 * sehingga di DB segar kunci struktur yang disematkan preset (nilai BM) dibandingkan dengan bawaan registri.
 * Kunci struktur tetap terkunci oleh syarat `equalsFileMode` (semua kunci = mode berkas template.v2.json).
 */
function manual000LegacyKeys(): string[] {
  const structure = new Set(PARAMS_STRUCTURE.map((p) => p.key));
  const keys = ALL_PARAMS.map((p) => p.key).filter((k) => !structure.has(k));
  keys.push("grid.marginBottomMm");
  return [...new Set(keys)].sort();
}

/** SR-38: preset DATUM Manual 000 (terbatas) + versi berkerangka `datum-manual-000`, di dalam transaksi pemanggil. */
async function importManual000V2(tx: Tx, prep: Awaited<ReturnType<typeof prepareManual000V2>>): Promise<Record<string, unknown>> {
  const presetSlug = `${MANUAL000_SLUG}-preset`;
  const { loaded, preset: presetProfile, baselineFile } = prep;
  const def = loaded.definition;
  const presetSkeleton = loaded.skeleton.slots.map((s) => {
    const { advanced: _a, roleFormats: _r, ...rest } = s;
    void _a;
    void _r;
    return { ...rest, essentials: {} };
  });
  const preset = await ensurePreset(tx, {
    slug: presetSlug,
    name: "DATUM Manual 000",
    description: "Gaya acuan Manual 000 untuk pengujian format terukur (khusus admin).",
    layer: presetProfile.profile.overrides,
    ownRoleFormats: (presetProfile.profile.roleFormats ?? {}) as Record<string, unknown>,
    skeletonSlots: presetSkeleton,
    changeNote: `SR-38: preset DATUM Manual 000 dari ${path.relative(REPO_ROOT, loaded.preset.file!).replaceAll("\\", "/")}`,
  });
  // Lapis templat tanpa kunci kelas T (dibuang pembaca berkas; layanan v2 menolak 400).
  const droppedT = new Set(loaded.droppedDerived.filter((k) => !k.startsWith("preset:")));
  const keep = (o: ParamRecord | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !droppedT.has(k))) as ParamRecord;
  const existing = await tx.studioTemplate.findUnique({ where: { slug: MANUAL000_SLUG } });
  const legacy = existing ? await tx.studioTemplateVersion.findFirst({ where: { templateId: existing.id, skeletonSha256: null }, orderBy: { versionNo: "desc" } }) : null;
  const r = await ensureSkeletonVersion(tx, {
    slug: MANUAL000_SLUG,
    name: existing?.name ?? "DATUM Manual 000",
    description: existing?.description ?? "Templat acuan Manual 000 untuk pengujian format terukur (khusus admin).",
    preset: { slug: presetSlug, version: preset.version },
    essentials: keep(def.essentials),
    advanced: keep(def.advanced),
    roleFormats: def.roleFormats as Record<string, unknown> | undefined,
    skeletonSlots: loaded.skeleton.slots,
    changeNote: `SR-38: preset ${presetSlug} v${preset.version.versionNo} + esensial + kerangka ${loaded.skeleton.slots.length} slot dari ${MANUAL000_V2_TEMPLATE.replaceAll("\\", "/")}`,
  });
  const fileSha = sha256Hex(stableStringify(asRecord(loaded.template.params)));
  const legacyKeys = manual000LegacyKeys().filter((k) => k in baselineFile);
  // Kunci baris DB lama (bila ada) di luar kunci lama G4: kosong untuk baris pra-struktur (v21, 721 kunci);
  // baris yang diimpor dengan registri kini memuat 21 kunci struktur (tercakup `equalsFileMode`).
  const legacyRowKeysOutsideG4 = legacy ? Object.keys(asRecord(legacy.resolvedParams)).filter((k) => k in baselineFile && !legacyKeys.includes(k)) : [];
  const delta = intendedDeltaOf(presetProfile, loaded.preset.file!);
  const guard = guardReport({ baseline: baselineFile, baselineSha: projSha(baselineFile, legacyKeys), legacyKeys, delta, next: r.version, exact: false });
  // FIX-SEED (D-258 N3): baseline penjaga = berkas (KT-5, D-165), bukan baris DB lama. Selisih baris lama vs
  // baseline berkas di luar Δ dilaporkan (informasi, tidak menggagalkan): perubahan baseline yang sudah
  // diputuskan (RT-01 D-119, P4S-13 D-151/D-216) sesudah baris lama diimpor, bukan Δ preset.
  const legacyParams = legacy ? asRecord(legacy.resolvedParams) : null;
  const nextParams = asRecord(r.version.resolvedParams);
  const legacyRowDrift = legacyParams
    ? legacyKeys
        .filter((k) => Object.prototype.hasOwnProperty.call(legacyParams, k) && !delta.includes(k) && stable(legacyParams[k]) !== stable(baselineFile[k]))
        .map((k) => ({ key: k, legacyRow: legacyParams[k] ?? null, baseline: baselineFile[k] ?? null, next: nextParams[k] ?? null }))
    : [];
  // Registri bertambah sesudah versi tersimpan dibuat (mis. R-65 `image.rasterDpi`, D-257): versi `unchanged`
  // tidak memuat kunci baru, sehingga `equalsFileMode` gagal. Dilaporkan terpisah (penjaga TIDAK dilonggarkan;
  // versi baru vs terima = keputusan controller).
  const fileParams = asRecord(loaded.template.params);
  const storedKeys = Object.keys(nextParams);
  const registryAddedSinceVersion = Object.keys(fileParams)
    .filter((k) => !Object.prototype.hasOwnProperty.call(nextParams, k))
    .sort()
    .map((k) => ({ key: k, fileMode: fileParams[k] ?? null, registryDefault: PARAMS_BY_KEY.get(k)?.default ?? null }));
  const registryDrift = {
    addedSinceVersion: registryAddedSinceVersion,
    equalsFileModeOnStoredKeys: storedKeys.every((k) => Object.prototype.hasOwnProperty.call(fileParams, k)) && projSha(fileParams, storedKeys) === r.version.paramsSha256,
  };
  return {
    slug: MANUAL000_SLUG,
    baseline: {
      source: BENCHMARK_PROFILE.replaceAll("\\", "/"),
      legacyVersionNo: legacy?.versionNo ?? null,
      legacyKeysBasis: "verify_v2.ts G4: registri - 21 kunci struktur + grid.marginBottomMm",
      legacyRowKeysOutsideG4,
      legacyRowDrift: { basis: "KT-5 (D-165): baseline = template.json pasca-RT-01; bukan Δ, tidak menggagalkan penjaga", count: legacyRowDrift.length, keys: legacyRowDrift.slice(0, 50) },
    },
    preset: { slug: presetSlug, outcome: preset.outcome, versionNo: preset.version.versionNo, restricted: preset.restricted, layerBySurface: surfaceCounts(asRecord(preset.version.overrides)) },
    template: {
      outcome: r.outcome,
      versionNo: r.version.versionNo,
      skeletonSha256: r.version.skeletonSha256,
      skeletonShaMatchesFile: r.version.skeletonSha256 === loaded.skeletonSha256,
      paramsSha256: r.version.paramsSha256,
      fileModeParamsSha256: fileSha,
      equalsFileMode: fileSha === r.version.paramsSha256,
      registryDrift,
      ...(await templateLayerCounts(tx, r.version)),
    },
    guard: { ...guard, ok: guard.ok && fileSha === r.version.paramsSha256 },
    documentRevision: "tidak dibuat oleh seed (baris dokumen di luar area seed templat; SR-38)",
  };
}

/** Jalankan flag preset/kerangka dalam SATU transaksi; penjaga gagal = rollback + galat. */
async function runPresetFlags(db: string, opts: { presets: boolean; manual000: boolean; dryRun: boolean }): Promise<void> {
  const m000 = opts.manual000 ? await prepareManual000V2() : null;
  try {
    await prisma.$transaction(
      async (tx) => {
        const current = (await tx.$queryRaw<{ db: string }[]>`select current_database() as db`)[0]?.db;
        if (current !== db) throw new Error(`DB transaksi '${current}' berbeda dari DB yang diperiksa '${db}'`);
        const reports: Record<string, unknown>[] = [];
        if (opts.presets) reports.push(...(await seedPresetsAndSkeletons(tx)));
        if (m000) reports.push(await importManual000V2(tx, m000));
        for (const r of reports) log((r.guard as { ok: boolean }).ok ? "info" : "error", `Preset + kerangka ${String(r.slug)}`, { database: db, dryRun: opts.dryRun, ...r });
        const failed = reports.filter((r) => !(r.guard as { ok: boolean }).ok).map((r) => String(r.slug));
        if (failed.length > 0) throw new Error(`Penjaga paramsSha256 terproyeksi gagal untuk ${failed.join(", ")}; transaksi di-rollback (tidak ada yang ditulis)`);
        if (opts.dryRun) throw new DryRunRollback(reports.map((r) => ({ slug: r.slug, ok: (r.guard as { ok: boolean }).ok })));
      },
      { timeout: PRESET_TX_TIMEOUT_MS, maxWait: 10_000 },
    );
  } catch (err) {
    if (err instanceof DryRunRollback) {
      log("info", "Dry-run preset/kerangka selesai; transaksi di-rollback", { database: db, summary: err.report });
      return;
    }
    throw err;
  }
}

// ── Templat jenis kontrak (DC-29, `--contract-templates`; register 05 §6.1, §6.3, BA-29) ──

interface ContractTemplateSpec {
  /** Jenis kontrak C58 (`registry/contracts.ts`). */
  kind: string;
  slug: string;
  name: string;
  description: string;
  presetSlug: string;
  /** Kerangka register (kenop slot dibaca dari preset saat seed, seperti kerangka 7 slot SR-36). */
  slots: ReadonlyArray<Omit<TemplateSlotDef, "essentials">>;
}

const DOC_DEFAULT_TIER_KEY = "doc.defaultTier";
const DOC_DEFAULT_TYPE_CODE_KEY = "doc.defaultTypeCode";
const DOC_TYPE_CODE_KEY = "doc.typeCode";

/** CK-01 `laporan-kerja-agen` (§6.3): SL-08..SL-10, semua tier (`tiers: []`), `admits` SL-09 = 21 jenis blok konten. */
const CONTRACT_TEMPLATES: readonly ContractTemplateSpec[] = [
  {
    kind: "agentWorkReport",
    slug: "laporan-kerja-agen",
    name: "Laporan Kerja Agen",
    description: "Laporan kerja tiap agen: catatan laporan, isi laporan (bab 1-5), dan referensi.",
    presetSlug: "datum-gsp-preset",
    slots: [
      { slotKey: "record", sectionType: "contractRecord", label: "Catatan Laporan", position: 1, required: true, positionLocked: true, repeatable: false, contentMode: "INPUT", tiers: [], admits: [] },
      { slotKey: "content", sectionType: "chapter", label: "Isi Laporan", position: 2, required: true, positionLocked: false, repeatable: true, minItems: 1, contentMode: "INPUT", tiers: [], admits: [...CONTENT_BLOCK_TYPES] },
      { slotKey: "references", sectionType: "sourceRegister", label: "Referensi", position: 3, required: false, positionLocked: false, repeatable: false, contentMode: "INPUT", tiers: [], admits: [] },
    ],
  },
];

/**
 * Spesifikasi seed dicocokkan dengan registri C58 sebelum menulis: setiap jenis terdaftar punya
 * spesifikasi (jenis baru tanpa templat = galat), slug dan kerangka ringkas (slotKey, sectionType,
 * label, required, repeatable) sama dengan entri registri.
 */
function contractTemplateSpecs(): Array<{ spec: ContractTemplateSpec; def: (typeof CONTRACT_KIND_DEFS)[number] }> {
  const out: Array<{ spec: ContractTemplateSpec; def: (typeof CONTRACT_KIND_DEFS)[number] }> = [];
  for (const def of CONTRACT_KIND_DEFS) {
    const spec = CONTRACT_TEMPLATES.find((s) => s.kind === def.kind);
    if (!spec) throw new Error(`Jenis kontrak ${def.kind} terdaftar di C58 tanpa spesifikasi templat seed`);
    if (spec.slug !== def.templateSlug) throw new Error(`Slug templat ${def.kind}: seed ${spec.slug} != registri ${def.templateSlug}`);
    const short = (s: { slotKey: string; sectionType: string; label: string; required: boolean; repeatable: boolean }) =>
      stable({ slotKey: s.slotKey, sectionType: s.sectionType, label: s.label, required: s.required, repeatable: s.repeatable });
    const seedShort = spec.slots.map(short);
    const regShort = def.skeleton.map(short);
    if (stable(seedShort) !== stable(regShort)) throw new Error(`Kerangka seed ${spec.slug} berbeda dari kerangka registri ${def.kind}`);
    out.push({ spec, def });
  }
  const orphan = CONTRACT_TEMPLATES.filter((s) => !CONTRACT_KIND_DEFS.some((d) => d.kind === s.kind)).map((s) => s.kind);
  if (orphan.length > 0) throw new Error(`Spesifikasi templat kontrak tanpa jenis terdaftar: ${orphan.join(", ")}`);
  return out;
}

/** Lapis templat (§6.3): tier bawaan (R-49), kode jenis bawaan (R-48), daftar kode jenis = bawaan P3-20 + kode jenis kontrak (CQ-1). */
function contractTemplateLayer(def: (typeof CONTRACT_KIND_DEFS)[number]): ParamRecord {
  const typeCodes = PARAMS_BY_KEY.get(DOC_TYPE_CODE_KEY)?.default;
  if (!Array.isArray(typeCodes)) throw new Error(`Bawaan ${DOC_TYPE_CODE_KEY} bukan daftar`);
  const list = (typeCodes as string[]).includes(def.typeCode) ? [...(typeCodes as string[])] : [...(typeCodes as string[]), def.typeCode];
  return { [DOC_DEFAULT_TIER_KEY]: def.tier, [DOC_DEFAULT_TYPE_CODE_KEY]: def.typeCode, [DOC_TYPE_CODE_KEY]: list };
}

/** Spesifikasi seed kontrak -> baris tabel spec helper bersama (S09): lapis dari registri C58, CH-06 lewat `contractKind`. */
function contractDerivedSpec(spec: ContractTemplateSpec, def: (typeof CONTRACT_KIND_DEFS)[number]): DerivedTemplateSpec {
  return {
    slug: spec.slug,
    name: spec.name,
    description: spec.description,
    presetSlug: spec.presetSlug,
    slots: spec.slots,
    layer: contractTemplateLayer(def),
    contractKind: spec.kind,
    changeNote: (c) =>
      `DC-29: templat jenis kontrak ${spec.kind} (register 05 §6.3) = preset ${spec.presetSlug} v${c.presetVersionNo} + esensial global + tier ${def.tier} / kode ${def.typeCode} + kerangka ${c.slotCount} slot`,
  };
}

/** `--contract-templates` dalam SATU transaksi lewat runner berpenjaga bersama; penjaga gagal = rollback + galat. */
async function runContractTemplates(db: string, opts: { dryRun: boolean }): Promise<void> {
  await runGuardedTemplateTx(
    prisma,
    {
      label: "Templat jenis kontrak",
      guardFailMessage: "Penjaga templat jenis kontrak gagal (templat lain/section type berubah atau isi tersimpan tidak sesuai); transaksi di-rollback (tidak ada yang ditulis)",
      dryRunDoneMessage: "Dry-run templat jenis kontrak selesai; transaksi di-rollback (0 tulis)",
      database: db,
      dryRun: opts.dryRun,
      specs: contractTemplateSpecs().map(({ spec, def }) => contractDerivedSpec(spec, def)),
      counts: async (tx) => ({
        sectionTypes: await tx.studioSectionType.count(),
        contractTemplates: await tx.studioTemplate.count({ where: { contractKind: { not: null } } }),
        templates: await tx.studioTemplate.count(),
      }),
    },
    { log, seedSectionTypes },
  );
}

/**
 * `--doc-type-templates` (S27): tabel spec S26 dalam SATU transaksi lewat runner berpenjaga bersama; gagal = rollback + galat.
 * C21: preset turunan tabel `seed-derived-presets.ts` ditulis lebih dulu di transaksi yang sama (sasaran penjaga tambahan).
 */
async function runDocTypeTemplates(db: string, opts: { dryRun: boolean }): Promise<void> {
  await runGuardedTemplateTx(prisma, withDerivedPresets(docTypeTemplateTxOptions(db, opts.dryRun)), { log, seedSectionTypes });
}

/** Kanonik dikelola preset: sinkron registri lewat versi baru tanpa kerangka dihentikan (akan menimpa kerangka). */
async function describeCanonical(outcome: "preset-managed" | "deferred-to-presets" | "dry-run-not-synced"): Promise<Record<string, unknown>> {
  const t = await prisma.studioTemplate.findUniqueOrThrow({ where: { slug: CANONICAL_SLUG } });
  const v = await prisma.studioTemplateVersion.findUniqueOrThrow({ where: { templateId_versionNo: { templateId: t.id, versionNo: t.latestVersionNo } } });
  const fresh = canonicalVersionPayload();
  const registryInSync = v.paramsSha256 === fresh.paramsSha256;
  if (outcome === "preset-managed" && !registryInSync) {
    log("warn", "Profil kanonik berkerangka berbeda dari registri saat ini; sinkron otomatis dihentikan (perbarui preset DATUM Kanonik lewat --presets-and-skeletons / keputusan controller)", {
      versionNo: v.versionNo,
      paramsSha256: v.paramsSha256,
      registryParamsSha256: fresh.paramsSha256,
    });
  }
  return { outcome, versionNo: v.versionNo, paramsSha256: v.paramsSha256, registryInSync };
}

// ── Hitungan dari DB (bukti) ────────────────────────────────────────────

async function reportCounts(db: PrismaClient): Promise<void> {
  const sections = await db.$queryRaw<{ total: bigint; grp: string; n: bigint }[]>`
    select (select count(*) from "StudioSectionType") as total, "group"::text as grp, count(*) as n
    from "StudioSectionType" group by "group" order by "group"`;
  const templates = await db.$queryRaw<{ slug: string; versions: bigint; latest: number; keys: bigint; sha: string; preset: boolean; skeleton: boolean; contract: string | null }[]>`
    select t.slug, (select count(*) from "StudioTemplateVersion" y where y."templateId" = t.id) as versions,
           t."latestVersionNo" as latest, t."isPreset" as preset, (v."skeletonSha256" is not null) as skeleton, t."contractKind" as contract,
           (select count(*) from jsonb_object_keys(v."resolvedParams")) as keys, v."paramsSha256" as sha
    from "StudioTemplate" t join "StudioTemplateVersion" v on v."templateId" = t.id and v."versionNo" = t."latestVersionNo"
    order by t.slug`;
  const catalogKeys = CATALOG_PARAMS.map((d) => d.key);
  const renderKeys = ALL_PARAMS.filter((d) => d.origin === "contract").map((d) => d.key);
  const present = await db.$queryRaw<{ catalog: bigint; render: bigint }[]>`
    select (select count(*) from unnest(${catalogKeys}::text[]) k where v."resolvedParams" ? k) as catalog,
           (select count(*) from unnest(${renderKeys}::text[]) k where v."resolvedParams" ? k) as render
    from "StudioTemplate" t join "StudioTemplateVersion" v on v."templateId" = t.id and v."versionNo" = t."latestVersionNo"
    where t.slug = ${CANONICAL_SLUG}`;
  const num = (x: bigint | number | undefined) => (x === undefined ? null : Number(x));
  log("info", "Hitungan DB", {
    sectionTypes: { total: num(sections[0]?.total), byGroup: Object.fromEntries(sections.map((r) => [r.grp, num(r.n)])) },
    templates: templates.map((r) => ({ slug: r.slug, isPreset: r.preset, contractKind: r.contract, versions: num(r.versions), latestVersionNo: r.latest, skeleton: r.skeleton, resolvedParamKeys: num(r.keys), paramsSha256: r.sha })),
    contractTemplates: templates.filter((r) => r.contract !== null).length,
    canonicalLatest: { catalogKeysPresent: num(present[0]?.catalog), renderKeysPresent: num(present[0]?.render) },
  });
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--refresh-v1")) {
    throw new Error("--refresh-v1 dihentikan (F-029): seed kini membuat versi kanonik baru bila registri berubah; v lama tidak pernah ditulis ulang");
  }
  const importBenchmark = argv.includes("--import-benchmark");
  const importDatumGsp = argv.includes("--import-datum-gsp");
  const importSamplesFlag = argv.includes("--import-samples");
  const presetsFlag = argv.includes("--presets-and-skeletons");
  const manual000V2Flag = argv.includes("--import-manual000-v2");
  const contractFlag = argv.includes("--contract-templates");
  const docTypeFlag = argv.includes("--doc-type-templates");
  const dryRun = argv.includes("--dry-run");
  if (dryRun && !presetsFlag && !manual000V2Flag && !contractFlag && !docTypeFlag) {
    throw new Error("--dry-run hanya berlaku bersama --presets-and-skeletons / --import-manual000-v2 / --contract-templates / --doc-type-templates");
  }
  // FIX-SEED: --dry-run tidak meng-commit apa pun (dry-run v21). Impor lain menulis di luar transaksi preset.
  if (dryRun && (importBenchmark || importDatumGsp || importSamplesFlag)) {
    throw new Error("--dry-run tidak dapat digabung dengan --import-benchmark / --import-datum-gsp / --import-samples (impor itu menulis di luar transaksi preset)");
  }
  // Default pustaka yang relatif cwd (akar workspace Studio, aset kanonik) harus sama dengan run dari akar repo.
  const invokedFrom = process.cwd();
  if (path.resolve(invokedFrom) !== REPO_ROOT) {
    process.chdir(REPO_ROOT);
    log("info", "cwd dipindah ke akar repo (lokasi skrip)", { invokedFrom, repoRoot: REPO_ROOT });
  }
  try {
    const db = await assertDatabase(prisma);
    // Temuan data (D-19, tidak menghentikan seed): default registri yang tidak lolos validasi ParamDef-nya sendiri.
    const defaultFindings = ALL_PARAMS.flatMap((d) => {
      const bad = validateParamValue(d, d.default as ParamValue);
      return bad ? [{ key: d.key, reason: bad }] : [];
    });
    if (defaultFindings.length > 0) log("warn", "Default registri tidak lolos validasi ParamDef-nya sendiri (temuan, seed lanjut)", { count: defaultFindings.length, findings: defaultFindings });
    // --dry-run: penulisan section type dilewati agar tidak ada yang di-commit; rencananya tetap dilaporkan.
    const sectionTypes = dryRun
      ? { skipped: "dry-run", plan: await planSectionTypes(prisma) }
      : await prisma.$transaction(async (tx) => seedSectionTypes(tx), { timeout: 60_000, maxWait: 10_000 });
    const unregistered = await findUnregisteredSectionTypes(prisma);
    if (unregistered.length > 0) {
      log("warn", "Section type di DB tidak ada di registri (dilaporkan, tidak dihapus; KD-02)", { count: unregistered.length, registryVersion: SECTION_REGISTRY_VERSION, rows: unregistered });
    }
    // SR-36: kanonik berkerangka (rujukan preset) tidak disinkron lewat `ensureCanonicalTemplate`
    // (sinkron membuat versi tanpa kerangka di atasnya); `--presets-and-skeletons` pertama memakai
    // versi DB terbaru apa adanya sebagai baseline (D-165 KT-5), jadi sinkron juga ditunda.
    const canonicalExists = (await prisma.studioTemplate.count({ where: { slug: CANONICAL_SLUG } })) > 0;
    const canonical = !canonicalExists
      ? dryRun
        ? { outcome: "absent-dry-run-not-created" }
        : await seedCanonicalTemplate()
      : (await isSkeletonManaged(prisma, CANONICAL_SLUG))
        ? await describeCanonical("preset-managed")
        : presetsFlag
          ? await describeCanonical("deferred-to-presets")
          : dryRun
            ? await describeCanonical("dry-run-not-synced")
            : await seedCanonicalTemplate();
    // Bukti resolusi path (tanpa menulis): profil benchmark dicari dari REPO_ROOT, bukan cwd pemanggil.
    const benchmarkProfile = { path: repoPath(BENCHMARK_PROFILE), found: await isReadableFile(repoPath(BENCHMARK_PROFILE)) };
    log("info", "Seed Studio selesai", {
      database: db,
      repoRoot: REPO_ROOT,
      invokedFrom,
      benchmarkProfile,
      sectionTypes,
      unregisteredSectionTypes: unregistered.length,
      canonical,
      registryVersion: SECTION_REGISTRY_VERSION,
    });
    // Impor profil v1 ke templat yang sudah berkerangka akan menumpuk versi berdasar kanonik di atas
    // versi preset (SR-36/SR-38): dilewati dengan peringatan.
    if (importBenchmark) {
      if (await isSkeletonManaged(prisma, MANUAL000_SLUG)) {
        log("warn", "--import-benchmark dilewati: datum-manual-000 dikelola preset + kerangka (pakai --import-manual000-v2)", { database: db });
      } else {
        const imported = await importBenchmarkProfile();
        log("info", "Impor profil benchmark selesai", { database: db, profile: BENCHMARK_PROFILE, ...imported });
      }
    }
    if (importDatumGsp) {
      if (await isSkeletonManaged(prisma, DATUM_GSP_SLUG)) {
        log("warn", "--import-datum-gsp dilewati: datum-gsp dikelola preset GSP DATUM + kerangka (SR-36)", { database: db });
      } else {
        const imported = await importDatumGspProfile();
        log("info", "Impor templat datum-gsp selesai", { database: db, profile: BENCHMARK_PROFILE, ...imported });
      }
    }
    if (presetsFlag || manual000V2Flag) await runPresetFlags(db, { presets: presetsFlag, manual000: manual000V2Flag, dryRun });
    if (contractFlag) await runContractTemplates(db, { dryRun });
    if (docTypeFlag) await runDocTypeTemplates(db, { dryRun });
    if (importSamplesFlag) {
      const samples = await importSamples(prisma);
      log("info", "Impor sampel selesai", { database: db, summary: samples.map((s) => ({ key: s.key, outcome: s.outcome, documentId: s.documentId ?? null })) });
      if (samples.some((s) => s.outcome === "failed")) process.exitCode = 1;
    }
    await reportCounts(prisma);
  } finally {
    // Render sampel membuka Chromium (HTML/PNG); tanpa ditutup proses seed tidak pernah keluar.
    if (importSamplesFlag) await closeBrowser().catch((err: unknown) => log("warn", "closeBrowser gagal", {}, err));
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  log("error", err instanceof Error ? err.message : String(err), { argv: process.argv.slice(2) }, err);
  process.exitCode = 1;
});
