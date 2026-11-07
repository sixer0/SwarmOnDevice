/**
 * Orkestrasi pemeriksaan draf bersama CLI `scripts/studio/draft-check.ts --remote` (DC-22) dan
 * route R23 `POST /api/studio/drafts/check` (DC-23), agar keluaran `--json` CLI identik dengan
 * respons R23 untuk berkas yang sama (AC-19, KS-8; aturan D-373). Murni: transport (HTTP R08/R05
 * di CLI, panggilan layanan di proses pada R23) disuntikkan lewat {@link DraftCheckDeps}.
 *
 * Aturan bersama (D-373):
 * - hanya blok tanpa isu galat ekstraksi (DR-02..DR-05) yang di-dry-run R08;
 * - DR-08 `DRAFT_BASIS_STALE` membawa baris `basis:` kepala (kolom 1);
 * - penolakan R08 4xx selain 401/429 = satu isu blok `{ pointer: "", keyword: <code>, message,
 *   details? }` (badan galat `{ error, code, details }` apa adanya);
 * - `valid` = tanpa isu error dan setiap blok `valid`;
 * - identitas dry-run (FIX-C2, D-392): agentId efektif blok = `agentId` payload bila blok
 *   memuatnya (medan ada: dipakai apa adanya), selain itu agentId bawaan pemanggil (CLI
 *   `--agent-id`, badan R23 `agentId`; bawaan keduanya = tanpa agentId). Bila blok tanpa medan
 *   `agentId` dan bawaan ada, payload dry-run = blok + `agentId` bawaan (medan ditambahkan di
 *   akhir objek); selain itu teks blok dikirim persis seperti tertulis. Dengan demikian R08 melihat
 *   identitas yang sama di kedua jalur (`completenessPreview.lastFilledBy`).
 * - simulasi berurutan (U-05a, D-419): blok bab/slot sesudah blok buat-dokumen yang menarget
 *   `mission.folder` + `docKey` yang sama menarget dokumen yang AKAN dibuat blok itu. Bila dry-run
 *   blok tersebut menjawab `META_REQUIRED_FOR_CREATE` (dokumen belum ada), blok di-dry-run ulang
 *   dengan `template` dan `meta` blok buat ditambahkan (medan yang belum ada saja), sehingga isu
 *   yang dilaporkan adalah isu isi blok sendiri. Satu aturan untuk CLI `--remote` dan R23 (AC-19).
 */
import { DRAFT_LIMITS } from "../../contract/env";
import type { DraftLimitReason } from "../../contract/enums";
import type { DraftBlockResultV2, DraftCheckResultV2, DraftIssueV2 } from "../../contract/types/v2/contract";
import { extractDraft, parseDraftBasis, toDraftCheckResult, type ExtractedDraft, type ExtractedDraftBlock } from "./extract";

/** Hasil dry-run R08 satu blok yang relevan untuk T2-71. */
export interface DraftDryRunOutcome {
  valid: boolean;
  issues: unknown[];
  submitPreview?: unknown;
  completenessPreview?: unknown;
}

/** Masukan dry-run satu blok (FIX-C2): payload efektif dan agentId efektif yang dilihat R08. */
export interface DraftDryRunInput {
  block: ExtractedDraftBlock;
  /** Payload yang di-dry-run: nilai blok, plus `agentId` bawaan bila blok tanpa medan itu. */
  value: Record<string, unknown>;
  /** Teks JSON payload: `block.text` apa adanya, atau serialisasi `value` bila `agentId` ditambahkan. */
  text: string;
  /** agentId efektif (string payload, atau bawaan); undefined = tanpa agentId. */
  agentId: string | undefined;
}

/** Transport pemeriksaan: revisi terkini dokumen (null = tidak ditemukan) dan dry-run R08 per blok. */
export interface DraftCheckDeps {
  currentRevisionNo(documentId: string): Promise<number | null>;
  dryRun(input: DraftDryRunInput): Promise<DraftDryRunOutcome>;
  /**
   * Dipanggil tepat SEBELUM setiap dry-run ulang bersimulasi (U-05a), yaitu dry-run kedua untuk
   * blok yang sama. R23 menagih bucket `validate` di sini (R2-F2 #7: satu tagihan per dry-run yang
   * benar-benar dijalankan, KD-43); melempar = pemeriksaan dihentikan tanpa dry-run ulang. CLI tidak
   * memerlukannya karena setiap dry-run-nya adalah panggilan R08 yang ditagih R08 sendiri.
   */
  beforeSimulatedDryRun?(input: DraftDryRunInput): void | Promise<void>;
}

export interface PreparedDraftCheck {
  extracted: ExtractedDraft;
  result: DraftCheckResultV2;
  /** Blok yang akan di-dry-run (tanpa isu galat ekstraksi), urut indeks. */
  dryRunBlocks: ExtractedDraftBlock[];
}

/** Pesan galat batas C54 (DR-09/DR-10) bersama CLI dan R23 (Bahasa Indonesia, D-340). */
export function draftLimitMessage(reason: DraftLimitReason): string {
  return reason === "DRAFT_TOO_LONG"
    ? `draf melebihi batas (${DRAFT_LIMITS.bodyBytes} bita atau ${DRAFT_LIMITS.maxChars} karakter)`
    : `draf memuat lebih dari ${DRAFT_LIMITS.maxBlocks} blok json`;
}

/** I63 + hasil T2-70 awal + daftar blok yang akan di-dry-run. Pemanggil memeriksa batas C54 lebih dulu. */
export function prepareDraftCheck(markdown: string): PreparedDraftCheck {
  const extracted = extractDraft(markdown);
  const result = toDraftCheckResult(extracted);
  const dryRunBlocks = result.blocks.filter((b) => b.valid).map((b) => extracted.blocks[b.index - 1]);
  return { extracted, result, dryRunBlocks };
}

/**
 * Jumlah tagihan bucket `validate` di MUKA untuk satu permintaan R23 (KD-43 + FIX-SEC L-2, D-402):
 * satu per blok yang akan di-dry-run (dry-run pertamanya), minimal satu, sehingga draf tanpa blok
 * dry-run (parse, DR-08 lookup DB, echo respons) tetap berbatas laju; tidak pernah ganda bila ada
 * blok. Dry-run ulang bersimulasi (U-05a) ditagih terpisah, satu per dry-run ulang yang benar-benar
 * dijalankan, lewat {@link DraftCheckDeps.beforeSimulatedDryRun} (R2-F2 #7).
 */
export function draftValidateCharges(prepared: Pick<PreparedDraftCheck, "dryRunBlocks">): number {
  return Math.max(1, prepared.dryRunBlocks.length);
}

/** Baris pertama `basis:` di kepala (sebelum blok pertama); 0 bila tidak ada. */
export function basisLineOf(markdown: string, ex: ExtractedDraft): number {
  const lines = markdown.split(/\r\n|\n/);
  const end = ex.blocks.length > 0 ? ex.blocks[0].line - 1 : lines.length;
  for (let i = 0; i < end; i++) if (/^basis:/.test(lines[i])) return i + 1;
  return 0;
}

/** Basis `<documentId>@rev<n>` yang dapat dibandingkan (DR-08); null untuk `baru`, kosong, atau tidak sah. */
export function draftBasisRevision(ex: ExtractedDraft): { documentId: string; revisionNo: number } | null {
  const basis = ex.header.basis === null ? null : parseDraftBasis(ex.header.basis);
  return basis !== null && basis.kind === "revision" ? { documentId: basis.documentId, revisionNo: basis.revisionNo } : null;
}

/**
 * DR-08: `rev<n>` < `currentRevisionNo`. `current` null = dokumen tidak ditemukan (tidak dapat
 * dicek; blok R08 melaporkannya sendiri).
 */
export function staleBasisIssue(
  markdown: string,
  ex: ExtractedDraft,
  basis: { documentId: string; revisionNo: number },
  current: number | null,
): DraftIssueV2 | null {
  if (current === null || basis.revisionNo >= current) return null;
  const line = basisLineOf(markdown, ex);
  return {
    code: "DRAFT_BASIS_STALE",
    severity: "warning",
    ...(line > 0 ? { line, column: 1 } : {}),
    message: `basis rev${basis.revisionNo} sudah tertinggal: revisi terkini dokumen ${basis.documentId} adalah rev${current}`,
  };
}

/** Penolakan R08 4xx (selain 401/429) -> hasil blok tidak valid dengan satu isu (D-373). */
export function rejectedDryRun(code: string, message: string, details?: unknown): DraftDryRunOutcome {
  const isObj = details !== null && typeof details === "object" && !Array.isArray(details);
  return { valid: false, issues: [{ pointer: "", keyword: code, message, ...(isObj ? { details } : {}) }] };
}

/**
 * Aturan agentId dry-run bersama CLI dan R23 (D-392): medan `agentId` payload menang (tak diubah);
 * selain itu `defaultAgentId` (string tidak kosong) ditambahkan ke payload dry-run.
 */
export function dryRunInputOf(block: ExtractedDraftBlock, defaultAgentId?: string): DraftDryRunInput {
  const value = block.value as Record<string, unknown>;
  const own = typeof value.agentId === "string" ? value.agentId : undefined;
  if ("agentId" in value || defaultAgentId === undefined || defaultAgentId === "") return { block, value, text: block.text, agentId: own };
  const withAgent = { ...value, agentId: defaultAgentId };
  return { block, value: withAgent, text: JSON.stringify(withAgent), agentId: defaultAgentId };
}

/** Timpakan hasil dry-run ke blok T2-71 (urutan medan tetap: submitPreview lalu completenessPreview). */
export function applyDryRun(block: DraftBlockResultV2, outcome: DraftDryRunOutcome): void {
  block.valid = outcome.valid;
  block.issues = Array.isArray(outcome.issues) ? outcome.issues : [];
  if (outcome.submitPreview !== undefined) block.submitPreview = outcome.submitPreview;
  if (outcome.completenessPreview !== undefined) block.completenessPreview = outcome.completenessPreview;
}

/** `valid` T2-70 = tanpa isu error dan setiap blok valid. */
export function finalizeDraftResult(result: DraftCheckResultV2): DraftCheckResultV2 {
  result.valid = !result.issues.some((i) => i.severity === "error") && result.blocks.every((b) => b.valid);
  return result;
}

/** DR-08 lalu dry-run R08 per blok (urut indeks), lalu `valid`. `defaultAgentId`: lihat aturan agentId di kepala berkas. */
export async function completeDraftCheck(
  markdown: string,
  prepared: PreparedDraftCheck,
  deps: DraftCheckDeps,
  defaultAgentId?: string,
): Promise<DraftCheckResultV2> {
  const { extracted, result } = prepared;
  const basis = draftBasisRevision(extracted);
  if (basis !== null) {
    const stale = staleBasisIssue(markdown, extracted, basis, await deps.currentRevisionNo(basis.documentId));
    if (stale) result.issues.push(stale);
  }
  const sources = sequentialCreateSources(extracted);
  for (const b of result.blocks) {
    if (!b.valid) continue;
    const input = dryRunInputOf(extracted.blocks[b.index - 1], defaultAgentId);
    let outcome = await deps.dryRun(input);
    const src = sources.get(b.index);
    if (src !== undefined && needsCreateEnvelope(outcome)) {
      const simulated = simulatedCreateInput(input, extracted.blocks[src - 1].value as Record<string, unknown>);
      await deps.beforeSimulatedDryRun?.(simulated);
      outcome = await deps.dryRun(simulated);
    }
    applyDryRun(b, outcome);
  }
  return finalizeDraftResult(result);
}

// ── Simulasi berurutan (U-05a, D-419) ───────────────────────────────────

/** Kode R08 untuk kiriman bab/slot ke dokumen yang belum ada tanpa `template` + `meta.title`. */
export const META_REQUIRED_FOR_CREATE = "META_REQUIRED_FOR_CREATE";

/** Target buat-dokumen: folder misi + docKey efektif (bawaan C23 = slug templat). */
export interface DraftCreateTarget {
  folder: string;
  docKey: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** Target misi blok bab/slot (`target.mission.folder`, tanpa documentId/docNumber); docKey null = tidak ditulis. */
export function draftMissionTargetOf(value: Record<string, unknown>): { folder: string; docKey: string | null } | null {
  if (value.$schema !== "studio.slot/v2" && value.$schema !== "studio.chapter/v2") return null;
  const t = value.target;
  if (!isObj(t) || t.documentId !== undefined || t.docNumber !== undefined) return null;
  if (!isObj(t.mission) || !nonEmpty(t.mission.folder)) return null;
  return { folder: t.mission.folder, docKey: nonEmpty(t.docKey) ? t.docKey : null };
}

/**
 * Blok buat-dokumen: bab/slot bertarget misi dengan `template.slug` dan `meta.title`, atau
 * `studio.doc/v2` dengan `mission.folder`. null bila bukan blok buat.
 */
export function draftCreateTargetOf(value: Record<string, unknown>): DraftCreateTarget | null {
  const slug = isObj(value.template) && nonEmpty(value.template.slug) ? value.template.slug : null;
  const title = isObj(value.meta) && nonEmpty(value.meta.title);
  if (slug === null || !title) return null;
  if (value.$schema === "studio.doc/v2") {
    if (!isObj(value.mission) || !nonEmpty(value.mission.folder)) return null;
    return { folder: value.mission.folder, docKey: nonEmpty(value.docKey) ? value.docKey : slug };
  }
  const t = draftMissionTargetOf(value);
  return t === null ? null : { folder: t.folder, docKey: t.docKey ?? slug };
}

/**
 * Peta indeks blok (1-based) -> indeks blok buat-dokumen SEBELUMNYA yang ditargetnya: folder misi
 * sama dan docKey sama (docKey blok kosong = docKey efektif blok buat). Blok buat terdekat menang.
 * Blok dengan JSON tidak sah diabaikan.
 */
export function sequentialCreateSources(ex: ExtractedDraft): Map<number, number> {
  const out = new Map<number, number>();
  const creates: Array<{ index: number; target: DraftCreateTarget }> = [];
  ex.blocks.forEach((block, i) => {
    const index = i + 1;
    if (!isObj(block.value)) return;
    const own = draftMissionTargetOf(block.value);
    if (own !== null) {
      for (let k = creates.length - 1; k >= 0; k--) {
        const c = creates[k];
        if (c.target.folder === own.folder && (own.docKey ?? c.target.docKey) === c.target.docKey) {
          out.set(index, c.index);
          break;
        }
      }
    }
    const created = draftCreateTargetOf(block.value);
    if (created !== null) creates.push({ index, target: created });
  });
  return out;
}

/** Dry-run menjawab dokumen belum ada (`META_REQUIRED_FOR_CREATE`, isu blok atau penolakan). */
export function needsCreateEnvelope(outcome: DraftDryRunOutcome): boolean {
  return !outcome.valid && Array.isArray(outcome.issues) && outcome.issues.some((i) => isObj(i) && (i.keyword === META_REQUIRED_FOR_CREATE || i.code === META_REQUIRED_FOR_CREATE));
}

/** Masukan dry-run ulang: payload + `template`/`meta` blok buat (hanya medan yang belum ada). */
export function simulatedCreateInput(input: DraftDryRunInput, createValue: Record<string, unknown>): DraftDryRunInput {
  const value: Record<string, unknown> = { ...input.value };
  if (value.template === undefined && createValue.template !== undefined) value.template = createValue.template;
  if (value.meta === undefined && createValue.meta !== undefined) value.meta = createValue.meta;
  return { ...input, value, text: JSON.stringify(value) };
}
