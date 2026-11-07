/**
 * Layanan revisi Studio (S50; I40, 01_specs.md §8.2; D-06, §4.2).
 *
 * - Sunting blok per alamat (`C.S.P`, label artefak `Tabel/Gambar/Turunan`,
 *   sel `Tabel C.n/r.c`) selalu membuat revisi BARU dengan apa/mengapa/dampak
 *   wajib; revisi lama tidak pernah diubah (alamat stabil per revisi).
 * - Setiap revisi menyimpan snapshot penuh ternormalisasi + indeks StudioBlock
 *   beralamat (KD-03), template version dipin sama dengan revisi induk.
 * - Konkurensi optimis: `baseRevisionNo` wajib = `currentRevisionNo`; selisih
 *   atau balapan di transaksi -> 409 REVISION_CONFLICT.
 * - Normalisasi lewat services/ingest (S48), templat lewat services/templates
 *   (S49), render lewat services/render (S51) — hanya antarmuka kontrak.
 *
 * Tanda tangan ekspor I40 dipertahankan; `rerenderRevision` menerima argumen
 * ke-4 opsional `caller` (kontrak tidak memuatnya; tanpa itu dipakai pemanggil
 * internal anonim). Ekspor tambahan: `openRevision`, `diffRevisions`, `diffSnapshots`.
 *
 * Swarm patch (row 31b, Prisma cut as row 109; 01_specs_studio.md §1.2): every Prisma read is a bridge
 * function or SQL over the row 8 tables, in a read job of its own (`readWith`); the v1 PATCH
 * transaction is one store job (`withStudioTx`) with the same optimistic guard (current_revision_no
 * re-read inside the job) and the same M06 `block` rows. Render: row 31c vendored services/render
 * (decisions C60/C65) and replaced the row 31b local stubs with the clone's own
 * `import { assertPdfRenderReady, renderRevision } from "../render"`.
 * Exported names, signatures and results are unchanged.
 */
import {
  findDocumentById,
  findRevisionByNo,
  findTemplateVersionById,
  insertRevision,
  isUniqueViolation as isStoreUniqueViolation,
  newId,
  parseJson,
  readWith,
  revisionOf,
  withStudioTx,
  type StudioRevision,
} from "../_swarm-store";
import {
  formatAddress,
  parseAddress,
  STUDIO_MAX_BLOCKS_PER_DOC,
  STUDIO_OUTPUT_FORMATS,
  type BlockDto,
  type Cell,
  type FlowItem,
  type NormBlock,
  type NormDocSnapshot,
  type ParsedAddress,
  type PatchBlockInput,
  type PatchResult,
  type RerenderResult,
  type RevisionSummary,
  type StudioDocV1,
  type StudioOutputFormat,
  type ValidationIssue,
} from "../../contract";
import { ANONYMOUS_INTERNAL_REQUESTER, type StudioCaller } from "../../contract/auth";
import { StudioEngineError } from "../../contract/errors";
import { byConstructionChecks } from "../../engine/lint/scan";
import {
  applyDocOverrides,
  BENCHMARK_MARKER_STRIPPED,
  ENFORCEMENT_OVERRIDE_STRIPPED,
  normalize,
  renderFeasibilityBlockers,
  stripTrustMarkersForWriter,
  validateSchema,
} from "../ingest";
import { assertPdfRenderReady, renderRevision } from "../render";
import { assertNoActiveRenderJob } from "../render/job";
import { assertTemplateUsable, resolveTemplate } from "../templates";
import { canonicalSha256, cloneJson, sha256Hex } from "./canonical";
import { changedAddressesOf, diffSnapshots, type RevisionDiff } from "./diff";
import { artifactSub, blockItems, isAddressable, isTableBlock, locateCell, stampBlockIds, walkDoc } from "./locate";
import { logError, newCorrelationId, revisionLog } from "./log";
import { blockRowsFromSnapshot, revisionSummary, toJson } from "./rows";
import { isV2Document, patchAddressV2 } from "./v2/service";

export { diffSnapshots, changedAddressesOf } from "./diff";
export type { BlockDiffEntry, RevisionDiff, SnapshotDiff } from "./diff";
export { setRevisionLogSink } from "./log";
// SR-14 (I50): sunting v2 per pid, struktur, riwayat pid.
export { patchPid, patchStructure, patchAddressV2, isV2Document } from "./v2/service";
export type { PatchPidResult, StructureResult, RevisionV2Summary, AddressEditInput, EditOptions } from "./v2/service";
export { pidHistory } from "./v2/history";
export type { PidHistoryEntry } from "./v2/history";
export type { PatchPidBody, PatchStructureBody, PidMoveTarget } from "./v2/body";

const PATCH_OPS = ["replace", "insertBefore", "insertAfter", "delete"] as const;
/** Batas panjang per medan apa/mengapa/dampak (karakter; D-57, satu sumber untuk route R06). */
export const CHANGE_FIELD_MAX = 4000;
const TX_OPTIONS = { timeoutMs: 60_000 } as const;
const INTERNAL_CALLER: StudioCaller = {
  kind: "INTERNAL_AGENT",
  requester: ANONYMOUS_INTERNAL_REQUESTER,
  canWriteClassK: false,
};

// ── Pembantu ─────────────────────────────────────────────────────────────

function fail(code: ConstructorParameters<typeof StudioEngineError>[0], message: string, details?: unknown): never {
  throw new StudioEngineError(code, message, details);
}

function issue(pointer: string, keyword: string, message: string): ValidationIssue {
  return { pointer, keyword, message };
}

/** Swarm: Prisma P2002 on `(documentId, revisionNo)` = the store's unique violation on `revision_no`. */
function isUniqueViolation(e: unknown): boolean {
  return isStoreUniqueViolation(e, "revision_no");
}


type BlockRow = { blockId: string; address: string; type: string; content: unknown };
const BLOCK_COLS = "block_id, address, type, content";
function blockRowOf(r: Record<string, unknown>): BlockRow {
  return { blockId: String(r.block_id), address: String(r.address), type: String(r.type), content: parseJson(r.content) };
}

/** M06 `block` row by (revision, address) (was `studioBlock.findUnique({ revisionId_address })`). */
async function findBlockRow(revisionId: string, address: string): Promise<BlockRow | null> {
  return readWith(undefined, (q) => {
    const r = q.get<Record<string, unknown>>(`SELECT ${BLOCK_COLS} FROM block WHERE revision_id = ? AND address = ?`, [revisionId, address]);
    return r ? blockRowOf(r) : null;
  });
}

function asSnapshot(r: StudioRevision): NormDocSnapshot {
  const s = r.snapshot as unknown as NormDocSnapshot | null;
  if (!s || typeof s !== "object" || !s.doc || !Array.isArray(s.blocks)) {
    throw new Error(`revision ${r.id} has no valid snapshot`);
  }
  return s;
}

async function findDocument(docId: string) {
  if (typeof docId !== "string" || !docId) fail("DOCUMENT_NOT_FOUND", "Document not found");
  const doc = await readWith(undefined, (q) => findDocumentById(q, docId));
  if (!doc) fail("DOCUMENT_NOT_FOUND", "Document not found", { documentId: docId });
  return doc;
}

async function findRevision(documentId: string, revisionNo: number): Promise<StudioRevision> {
  if (!Number.isInteger(revisionNo) || revisionNo < 1) fail("REVISION_NOT_FOUND", "Revision not found", { revisionNo });
  const rev = await readWith(undefined, (q) => findRevisionByNo(q, documentId, revisionNo));
  if (!rev) fail("REVISION_NOT_FOUND", "Revision not found", { documentId, revisionNo });
  return rev;
}

/** Baris StudioBlock untuk alamat artefak: `artifactLabel` (atau alamat sama, toleransi). */
async function findBlockRowByLabel(revisionId: string, label: string): Promise<BlockRow | null> {
  return readWith(undefined, (q) => {
    const r = q.get<Record<string, unknown>>(
      `SELECT ${BLOCK_COLS} FROM block WHERE revision_id = ? AND (artifact_label = ? OR address = ?) ORDER BY ordinal ASC LIMIT 1`,
      [revisionId, label, label],
    );
    return r ? blockRowOf(r) : null;
  });
}

function artifactLabelOf(p: Extract<ParsedAddress, { kind: "artifactSub" | "artifact" | "cell" }>): string {
  if (p.kind === "cell") return `Tabel ${p.chap}.${p.n}`;
  return formatAddress({ kind: "artifact", artifact: p.artifact, chap: p.chap, n: p.n, suffix: p.suffix });
}

function primaryFormats(outputs: ReadonlyArray<{ format: string; role: string }>): StudioOutputFormat[] {
  const seen = new Set<StudioOutputFormat>();
  for (const o of outputs) {
    if (o.role === "PRIMARY" && (STUDIO_OUTPUT_FORMATS as readonly string[]).includes(o.format)) {
      seen.add(o.format as StudioOutputFormat);
    }
  }
  return [...seen];
}

function docFormats(doc: StudioDocV1): StudioOutputFormat[] {
  const out = new Set<StudioOutputFormat>();
  for (const f of doc.outputs ?? []) {
    const up = String(f).toUpperCase();
    if ((STUDIO_OUTPUT_FORMATS as readonly string[]).includes(up)) out.add(up as StudioOutputFormat);
  }
  return [...out];
}

function pickFormats(doc: StudioDocV1, previous: StudioOutputFormat[]): StudioOutputFormat[] {
  const fromDoc = docFormats(doc);
  if (fromDoc.length) return fromDoc;
  if (previous.length) return previous;
  return ["DOCX"];
}

/** 400 CHANGE_FIELDS_REQUIRED bila apa/mengapa/dampak kosong (setelah trim). */
function requireChange(input: PatchBlockInput): { what: string; why: string; impact: string } {
  const c = (input?.change ?? {}) as Partial<Record<"what" | "why" | "impact", unknown>>;
  const missing: ValidationIssue[] = [];
  const val = (k: "what" | "why" | "impact") => {
    const v = typeof c[k] === "string" ? (c[k] as string).trim() : "";
    if (!v) missing.push(issue(`/change/${k}`, "required", `change.${k} must be a non-empty string`));
    return v;
  };
  const out = { what: val("what"), why: val("why"), impact: val("impact") };
  if (missing.length) fail("CHANGE_FIELDS_REQUIRED", "change.what, change.why and change.impact are required", missing);
  const tooLong = (["what", "why", "impact"] as const).filter((k) => out[k].length > CHANGE_FIELD_MAX);
  if (tooLong.length) {
    fail(
      "SCHEMA_INVALID",
      "Invalid PATCH body",
      tooLong.map((k) => issue(`/change/${k}`, "maxLength", `must be at most ${CHANGE_FIELD_MAX} characters`)),
    );
  }
  return out;
}

function requireShape(input: PatchBlockInput): void {
  const issues: ValidationIssue[] = [];
  if (!input || typeof input !== "object") fail("SCHEMA_INVALID", "Patch body must be an object", [issue("", "type", "object expected")]);
  if (!Number.isInteger(input.baseRevisionNo) || input.baseRevisionNo < 1) {
    issues.push(issue("/baseRevisionNo", "type", "baseRevisionNo must be a positive integer"));
  }
  if (!(PATCH_OPS as readonly string[]).includes(input.op)) {
    issues.push(issue("/op", "enum", `op must be one of ${PATCH_OPS.join(", ")}`));
  }
  if (input.block !== undefined && (!input.block || typeof input.block !== "object" || typeof input.block.type !== "string")) {
    issues.push(issue("/block", "type", "block must be an object with a string type"));
  }
  if (input.cell !== undefined && (!input.cell || typeof input.cell !== "object")) {
    issues.push(issue("/cell", "type", "cell must be an object"));
  }
  if (issues.length) fail("SCHEMA_INVALID", "Invalid patch body", issues);
}

function newBlockId(seed: string, taken: Set<string>): string {
  for (let i = 0; ; i++) {
    const id = `b_${sha256Hex(i === 0 ? seed : `${seed}#${i}`).slice(0, 16)}`;
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

// ── Sunting dokumen (mutasi salinan doc) ─────────────────────────────────

interface EditContext {
  address: string;
  parsed: ParsedAddress;
  input: PatchBlockInput;
  snapshot: NormDocSnapshot;
  seed: string;
}

/** Terapkan PATCH ke `doc` (salinan); mengembalikan alamat target blok di revisi dasar. */
function applyEdit(doc: StudioDocV1, ctx: EditContext): string {
  const { parsed: p, input, snapshot } = ctx;
  let target: NormBlock | undefined;

  if (p.kind === "block") {
    target = snapshot.blocks.find((b) => b.address === ctx.address);
  } else if (p.kind === "artifact" || p.kind === "cell") {
    const label = artifactLabelOf(p);
    target = snapshot.blocks.find((b) => b.artifactLabel === label) ?? snapshot.blocks.find((b) => b.address === label);
  } else {
    fail("SCHEMA_INVALID", `Address kind "${p.kind}" cannot be patched`, [
      issue("/address", "addressKind", "patchable addresses: C.S.P block, Tabel/Gambar/Turunan label, Tabel C.n/r.c cell"),
    ]);
  }
  if (!target || !target.address) fail("ADDRESS_NOT_FOUND", "Address not found in revision", { address: ctx.address });

  const loc = walkDoc(doc).blocks.find((l) => l.address === target!.address);
  if (!loc) throw new Error(`snapshot address ${target.address} has no counterpart in snapshot.doc`);
  if (loc.item.type !== target.type) {
    throw new Error(`type mismatch at ${target.address}: doc=${loc.item.type} snapshot=${target.type}`);
  }

  if (p.kind === "cell") {
    if (input.op !== "replace") fail("SCHEMA_INVALID", "Cell addresses only support op replace", [issue("/op", "enum", "replace")]);
    if (!input.cell) fail("SCHEMA_INVALID", "cell is required for a cell replace", [issue("/cell", "required", "cell required")]);
    if (!isTableBlock(loc.item)) fail("ADDRESS_NOT_FOUND", "Address is not a table", { address: ctx.address });
    const hit = locateCell(loc.item, p.row, p.col);
    if (!hit) fail("ADDRESS_NOT_FOUND", "Cell not addressable (absent or covered by a merge)", { address: ctx.address });
    const next = cloneJson(input.cell) as Cell;
    if (Math.max(1, next.gridSpan ?? 1) !== Math.max(1, hit.cell.gridSpan ?? 1) || (next.vMerge ?? null) !== (hit.cell.vMerge ?? null)) {
      fail("SCHEMA_INVALID", "Cell replace must keep gridSpan and vMerge", [
        issue("/cell/gridSpan", "const", "gridSpan/vMerge must equal the replaced cell"),
      ]);
    }
    loc.item.rows[hit.rowIdx].cells[hit.cellIdx] = next;
    return target.address;
  }

  if (input.cell !== undefined) fail("SCHEMA_INVALID", "cell is only valid for a cell address", [issue("/cell", "not", "unexpected")]);

  const taken = new Set(snapshot.blocks.map((b) => b.blockId));
  switch (input.op) {
    case "delete":
      loc.container.splice(loc.index, 1);
      break;
    case "replace": {
      if (!input.block) fail("SCHEMA_INVALID", "block is required for replace", [issue("/block", "required", "block required")]);
      if (!isAddressable(input.block)) {
        fail("SCHEMA_INVALID", "replace requires a content block (not spacer/device)", [issue("/block/type", "not", "spacer/device")]);
      }
      const next = cloneJson(input.block) as FlowItem & { blockId?: string };
      next.blockId = target.blockId; // identitas dipertahankan (§4.2 butir 2)
      loc.container[loc.index] = next;
      break;
    }
    case "insertBefore":
    case "insertAfter": {
      if (!input.block) fail("SCHEMA_INVALID", `block is required for ${input.op}`, [issue("/block", "required", "block required")]);
      const next = cloneJson(input.block) as FlowItem & { blockId?: string };
      if (isAddressable(next)) next.blockId = newBlockId(ctx.seed, taken); // blok sisipan = blockId baru
      loc.container.splice(input.op === "insertBefore" ? loc.index : loc.index + 1, 0, next);
      break;
    }
  }
  return target.address;
}

// ── API I40 ──────────────────────────────────────────────────────────────

/** GET blok per alamat pada revisi `rev` (default revisi terkini). */
export async function getBlock(docId: string, address: string, rev?: number): Promise<BlockDto> {
  const parsed = parseAddress(address);
  if (!parsed) fail("ADDRESS_INVALID", "Address does not match the address grammar", { address });
  const doc = await findDocument(docId);
  const revision = await findRevision(doc.id, rev ?? doc.currentRevisionNo);
  const notFound = (): never => fail("ADDRESS_NOT_FOUND", "Address not found in revision", { address, revisionNo: revision.revisionNo });
  const dto = (blockId: string, type: string, content: unknown): BlockDto => ({
    address,
    blockId,
    type,
    content,
    revisionNo: revision.revisionNo,
  });

  switch (parsed.kind) {
    case "item": {
      const parent = await findBlockRow(revision.id, `${parsed.chap}.${parsed.section}.${parsed.para}`);
      const items = parent ? blockItems(parent.content) : null;
      const item = items?.[parsed.item - 1];
      if (!parent || item === undefined) return notFound();
      return dto(parent.blockId, "item", item);
    }
    case "cell": {
      const row = await findBlockRowByLabel(revision.id, artifactLabelOf(parsed));
      if (!row || !isTableBlock(row.content)) return notFound();
      const hit = locateCell(row.content, parsed.row, parsed.col);
      if (!hit) return notFound();
      return dto(row.blockId, "cell", hit.cell);
    }
    case "artifactSub": {
      const row = await findBlockRowByLabel(revision.id, artifactLabelOf(parsed));
      const sub = row ? artifactSub(row.content, parsed.sub) : undefined;
      if (!row || sub === undefined) return notFound();
      return dto(row.blockId, parsed.sub, sub);
    }
    case "artifact": {
      const row = await findBlockRowByLabel(revision.id, address);
      if (!row) return notFound();
      return dto(row.blockId, row.type, row.content);
    }
    default: {
      const row = await findBlockRow(revision.id, address);
      if (!row) return notFound();
      return dto(row.blockId, row.type, row.content);
    }
  }
}

/** PATCH blok per alamat -> revisi baru (D-06). */
export async function patchBlock(
  docId: string,
  address: string,
  input: PatchBlockInput,
  caller: StudioCaller,
): Promise<PatchResult> {
  const cid = newCorrelationId();
  const ctxLog = { documentId: docId, address, op: input?.op, baseRevisionNo: input?.baseRevisionNo, requester: caller?.requester };
  try {
    requireShape(input);
    const change = requireChange(input);
    const parsed = parseAddress(address);
    if (!parsed) fail("ADDRESS_INVALID", "Address does not match the address grammar", { address });

    const doc = await findDocument(docId);
    // SR-14 (KD-23): dokumen v2 -> alamat dipetakan ke pid di revisi dasar, cek
    // lingkup pid (SCOPE_CONFLICT), gerbang by-construction bersama (SR-55 H1), tulis
    // baris ternormalisasi (SR-10). Tanpa REVISION_CONFLICT global; tanpa render (D-247).
    if (await isV2Document(doc.id)) {
      const r = await patchAddressV2(caller, doc.id, address, parsed, {
        baseRevisionNo: input.baseRevisionNo,
        op: input.op,
        block: input.block,
        cell: input.cell,
        change,
      });
      return { ...r, revision: r.revision, addressMap: r.addressMap, job: null, outputs: [] };
    }
    if (input.baseRevisionNo !== doc.currentRevisionNo) {
      fail("REVISION_CONFLICT", "baseRevisionNo is not the current revision", {
        baseRevisionNo: input.baseRevisionNo,
        currentRevisionNo: doc.currentRevisionNo,
      });
    }
    const base = await findRevision(doc.id, doc.currentRevisionNo);
    const baseSnap = asSnapshot(base);
    const newRevNo = base.revisionNo + 1;

    // 1) Sunting salinan doc dengan blockId snapshot terpasang (identitas lintas revisi).
    //    FIX-1 (S85 R-01 = S87 M-04; revisi D-98 butir 2): kepercayaan melekat pada
    //    PEMBUAT KONTEN. Pemanggil tidak tepercaya menyunting salinan TANPA penanda
    //    benchmark (`x.benchmark`, `x.enforcement`) dan tanpa `x.lintEnforcement`;
    //    gerbang dan snapshot revisi baru memakai salinan itu (render tidak lagi
    //    memakai reproduksi verbatim / pelonggaran D-34 untuk konten campuran).
    // Fungsi bersama SR-55 M5 (`stripTrustMarkersForWriter`), sama dengan kiriman dan sunting v2.
    const trust = stripTrustMarkersForWriter(cloneJson(baseSnap.doc), caller, "/doc");
    const nextDoc = trust.doc;
    if (trust.stripped.length > 0) {
      revisionLog({
        level: "warn",
        message: "trust markers ignored for untrusted editor (R-01/M-04)",
        correlationId: cid,
        code: trust.benchmarkStripped.length > 0 ? BENCHMARK_MARKER_STRIPPED : ENFORCEMENT_OVERRIDE_STRIPPED,
        context: { ...ctxLog, callerKind: caller?.kind ?? null, stripped: trust.stripped },
      });
    }
    const unmatched = stampBlockIds(nextDoc, baseSnap);
    if (unmatched > 0) {
      revisionLog({ level: "warn", message: "blocks without snapshot blockId before edit", correlationId: cid, context: { ...ctxLog, unmatched } });
    }
    const targetAddress = applyEdit(nextDoc, {
      address,
      parsed,
      input,
      snapshot: baseSnap,
      seed: `${doc.docNumber}|rev${newRevNo}|${input.op}|${address}`,
    });

    // 2) Validasi skema + by-construction (S48 / S44 lewat antarmuka kontrak).
    const schemaIssues = validateSchema("studio.doc/v1", nextDoc);
    if (schemaIssues.length) fail("SCHEMA_INVALID", "Edited document does not satisfy studio.doc/v1", schemaIssues);
    // 3) Versi templat yang dipin revisi induk (IP-30: dipakai juga gerbang by-construction).
    const tv = await readWith(undefined, (q) => findTemplateVersionById(q, base.templateVersionId));
    if (!tv) fail("TEMPLATE_NOT_FOUND", "Pinned template version not found", { templateVersionId: base.templateVersionId });
    const pinnedTpl = await resolveTemplate(tv.template.slug, tv.versionNo);
    if (pinnedTpl.versionId !== tv.id) {
      revisionLog({ level: "warn", message: "resolved template version differs from pinned version", correlationId: cid, context: { ...ctxLog, pinned: tv.id, resolved: pinnedTpl.versionId } });
    }
    // D-98 (INT-R): dokumen berpin templat TERBATAS hanya dapat disunting ADMIN/harness (403 FORBIDDEN).
    assertTemplateUsable(pinnedTpl, caller, { slug: tv.template.slug, purpose: "revision", correlationId: cid });
    // FIX-1 (S85 R-02): templat efektif = templat terpin + override dokumen, SAMA
    // dengan ingest dan render (`applyDocOverrides`). Override yang tidak lagi sah
    // (registri berubah sejak ingest) dilewati seperti render (`templateForDoc`).
    const applied = applyDocOverrides(pinnedTpl, nextDoc);
    if (applied.issues.length > 0) {
      revisionLog({ level: "warn", message: "document overrides partly invalid at revision; invalid keys ignored", correlationId: cid, code: "DOC_OVERRIDES_INVALID", context: { ...ctxLog, issues: applied.issues.length } });
    }
    const tpl = applied.tpl;
    if (tpl !== pinnedTpl) {
      assertTemplateUsable(tpl, caller, { slug: tv.template.slug, purpose: "revision (document overrides)", correlationId: cid });
    }

    // IP-30 (D-90): penegakan per tier/profil templat (`lint.enforcementOverride`) berlaku saat sunting.
    const bc = byConstructionChecks(nextDoc, tpl).filter((i) => i.status === "FAIL");
    if (bc.length) {
      fail(
        "BY_CONSTRUCTION_FAILED",
        "Edited document fails by-construction checks",
        bc.map((i) => ({ pointer: i.pointer ?? "", keyword: "byConstruction", message: i.detail ?? i.checkId, checkId: i.checkId })),
      );
    }

    // Normalisasi ulang dengan versi templat yang dipin.
    const nextSnap = normalize(nextDoc, pinnedTpl);
    if (nextSnap.blocks.length > STUDIO_MAX_BLOCKS_PER_DOC) {
      fail("PAYLOAD_TOO_LARGE", `Document exceeds ${STUDIO_MAX_BLOCKS_PER_DOC} blocks`, { blocks: nextSnap.blocks.length });
    }
    // FIX-1 (S85 R-03, F-053): prasyarat renderer turunan sama dengan ingest; revisi
    // yang pasti gagal dirender tidak di-commit (422, bukan 200 + job FAILED).
    const feasibility = renderFeasibilityBlockers(nextSnap);
    if (feasibility.length) {
      fail("BY_CONSTRUCTION_FAILED", "Edited document has derivations that cannot be rendered", feasibility);
    }

    // 4) Diff, alamat berubah, indeks blok.
    const diff = diffSnapshots(baseSnap, nextSnap);
    if (!diff.added.length && !diff.removed.length && !diff.changed.length) {
      fail("SCHEMA_INVALID", "Edit produces no change", [issue("/block", "noChange", "content identical to the current revision")]);
    }
    const changedAddresses = changedAddressesOf(diff);
    if (input.op === "replace" && !changedAddresses.includes(address)) changedAddresses.unshift(address);
    const rows = blockRowsFromSnapshot(nextSnap);
    const inputSha256 = canonicalSha256(nextDoc);
    const snapshotSha256 = canonicalSha256(nextSnap);

    // 5) Transaksi: kunci optimis currentRevisionNo -> revisi + blok.
    let created: StudioRevision;
    try {
      created = await withStudioTx(async (tx) => {
        const bumped = tx.run("UPDATE document SET current_revision_no = ?, time_updated = ? WHERE id = ? AND current_revision_no = ?", [
          newRevNo,
          tx.now,
          doc.id,
          base.revisionNo,
        ]);
        if (Number(bumped.changes) !== 1) {
          fail("REVISION_CONFLICT", "Document was changed concurrently", { baseRevisionNo: base.revisionNo });
        }
        const rev = insertRevision(tx, {
            documentId: doc.id,
            revisionNo: newRevNo,
            parentRevisionNo: base.revisionNo,
            templateVersionId: base.templateVersionId,
            snapshot: toJson(nextSnap),
            snapshotSha256,
            inputSha256,
            docRev: nextSnap.doc.meta?.rev ?? base.docRev,
            changeWhat: change.what,
            changeWhy: change.why,
            changeImpact: change.impact,
            changedAddresses,
            createdBy: caller?.requester || ANONYMOUS_INTERNAL_REQUESTER,
        });
        for (const r of rows) {
          tx.run(
            `INSERT INTO block (id, revision_id, block_id, address, artifact_label, ordinal, chapter_key, section_no, para_no, type, content, text_plain, content_sha256)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [newId(), rev.id, r.blockId, r.address, r.artifactLabel, r.ordinal, r.chapterKey, r.sectionNo, r.paraNo, r.type, JSON.stringify(r.content ?? null), r.textPlain, r.contentSha256],
          );
        }
        return rev;
      }, TX_OPTIONS);
    } catch (e) {
      if (isUniqueViolation(e)) fail("REVISION_CONFLICT", "Revision number already taken", { revisionNo: newRevNo });
      throw e;
    }

    revisionLog({
      level: "info",
      message: "revision created",
      correlationId: cid,
      context: { ...ctxLog, revisionId: created.id, revisionNo: newRevNo, targetAddress, changed: changedAddresses.length, moved: Object.keys(diff.addressMap).length },
    });

    // 6) Tanpa render otomatis (D-247): build lewat POST /api/studio/documents/{id}/render.
    return { revision: revisionSummary(created), addressMap: diff.addressMap, job: null, outputs: [] };
  } catch (e) {
    if (e instanceof StudioEngineError && e.httpStatus < 500) {
      revisionLog({ level: "warn", message: `patch rejected: ${e.message}`, correlationId: cid, code: e.code, context: ctxLog });
    } else {
      logError(cid, "patchBlock failed", e, ctxLog);
    }
    throw e;
  }
}

/** Butir R07 GET (register 03 §12): `RevisionSummary` + status kelengkapan, lingkup ubahan, skema asal. */
export type RevisionListItem = RevisionSummary & {
  /** `StudioRevision.completeness` (COMPLETE | INCOMPLETE). */
  completeness: StudioRevision["completeness"];
  /** Tata bahasa 03 §9.5; null untuk revisi sebelum MX04 / tanpa lingkup. */
  changeScope: string | null;
  /** Skema permintaan asal revisi (KD-10), mis. `studio.doc/v1` | `studio.doc/v2`. */
  schemaId: string;
};

/** Riwayat revisi dokumen, terbaru lebih dulu (R07 GET; medan v2 aditif, SR-30/IP-52). */
export async function listRevisions(docId: string): Promise<RevisionListItem[]> {
  const doc = await findDocument(docId);
  const revs = await readWith(undefined, (q) => q.all("SELECT * FROM revision WHERE document_id = ? ORDER BY revision_no DESC", [doc.id]).map(revisionOf));
  return revs.map((r) => ({ ...revisionSummary(r), completeness: r.completeness, changeScope: r.changeScope, schemaId: r.schemaId }));
}

/**
 * Render ulang revisi lama TANPA revisi baru (snapshot + versi templat dipin).
 * `identical` = semua keluaran baru yang punya padanan render pertama revisi
 * itu (format, peran, label figur) ber-sha256 sama, minimal satu dibandingkan,
 * dan job tanpa galat.
 */
export async function rerenderRevision(
  docId: string,
  revNo: number,
  formats?: readonly StudioOutputFormat[],
  caller?: StudioCaller,
): Promise<RerenderResult> {
  const cid = newCorrelationId();
  const ctxLog = { documentId: docId, revisionNo: revNo, formats, requester: caller?.requester };
  try {
    const doc = await findDocument(docId);
    const rev = await findRevision(doc.id, revNo);
    if (formats?.some((f) => !(STUDIO_OUTPUT_FORMATS as readonly string[]).includes(f))) {
      fail("SCHEMA_INVALID", "Unknown output format", [issue("/formats", "enum", STUDIO_OUTPUT_FORMATS.join(", "))]);
    }
    // FIX-1 (S85 R-04): penjaga RENDER_IN_PROGRESS satu sumber (job.ts, jendela job
    // basi C08, sama dengan `createRenderJob`); dulu cek lokal tanpa jendela -> 409 permanen.
    await assertNoActiveRenderJob({ documentId: doc.id, revisionId: rev.id });

    const prior = await readWith(undefined, (q) =>
      q
        .all<{ format: string; role: string; figure_label: string | null; sha256: string }>(
          "SELECT format, role, figure_label, sha256 FROM output_file WHERE revision_id = ? ORDER BY time_created ASC, rowid ASC",
          [rev.id],
        )
        .map((o) => ({ format: o.format, role: o.role, figureLabel: o.figure_label ?? null, sha256: o.sha256 })),
    );
    const key = (o: { format: string; role: string; figureLabel: string | null }) => `${o.format}|${o.role}|${o.figureLabel ?? ""}`;
    const firstSha = new Map<string, string>();
    for (const o of prior) if (!firstSha.has(key(o))) firstSha.set(key(o), o.sha256);

    const fmts = formats?.length ? [...new Set(formats)] : pickFormats(asSnapshot(rev).doc, primaryFormats(prior));
    // FIX-HZ1 (D-325): gerbang PDF yang sama dengan R17 (503 PDF_ENGINE_UNAVAILABLE tahap
    // preflight, tanpa job) SETELAH 404/409 RENDER_IN_PROGRESS. Revisi INCOMPLETE dilewati
    // agar 409 DOCUMENT_INCOMPLETE dari `renderRevision` tetap didahulukan (urutan R17).
    if (rev.completeness !== "INCOMPLETE") await assertPdfRenderReady(fmts);
    const outcome = await renderRevision(rev.id, fmts, caller ?? INTERNAL_CALLER);

    let compared = 0;
    let same = true;
    for (const o of outcome.outputs) {
      const was = firstSha.get(key(o));
      if (was === undefined) continue;
      compared += 1;
      if (was !== o.sha256) same = false;
    }
    const identical = same && compared > 0 && outcome.errors.length === 0;
    revisionLog({
      level: identical || compared === 0 ? "info" : "warn",
      message: "revision re-rendered",
      correlationId: cid,
      context: { ...ctxLog, revisionId: rev.id, jobId: outcome.job.id, compared, identical, errors: outcome.errors.map((x) => x.code) },
    });
    return { job: outcome.job, outputs: outcome.outputs, identical };
  } catch (e) {
    if (e instanceof StudioEngineError && e.httpStatus < 500) {
      revisionLog({ level: "warn", message: `rerender rejected: ${e.message}`, correlationId: cid, code: e.code, context: ctxLog });
    } else {
      logError(cid, "rerenderRevision failed", e, ctxLog);
    }
    throw e;
  }
}

// ── Ekspor tambahan (bukan I40) ──────────────────────────────────────────

/** Buka revisi (lama atau terkini): ringkasan, snapshot penuh, blok beralamat. */
export async function openRevision(
  docId: string,
  revNo?: number,
): Promise<{ revision: RevisionSummary; snapshot: NormDocSnapshot; blocks: BlockDto[] }> {
  const doc = await findDocument(docId);
  const rev = await findRevision(doc.id, revNo ?? doc.currentRevisionNo);
  const rows = await readWith(undefined, (q) => q.all<Record<string, unknown>>(`SELECT ${BLOCK_COLS} FROM block WHERE revision_id = ? ORDER BY ordinal ASC`, [rev.id]).map(blockRowOf));
  return {
    revision: revisionSummary(rev),
    snapshot: asSnapshot(rev),
    blocks: rows.map((r) => ({ address: r.address, blockId: r.blockId, type: r.type, content: r.content, revisionNo: rev.revisionNo })),
  };
}

/** Diff blok antar dua revisi dokumen yang sama (tambah/hapus/ubah/geser per alamat). */
export async function diffRevisions(docId: string, fromRev: number, toRev: number): Promise<RevisionDiff> {
  const doc = await findDocument(docId);
  const [a, b] = await Promise.all([findRevision(doc.id, fromRev), findRevision(doc.id, toRev)]);
  return { documentId: doc.id, fromRevisionNo: a.revisionNo, toRevisionNo: b.revisionNo, ...diffSnapshots(asSnapshot(a), asSnapshot(b)) };
}
