/**
 * Repositori struktur (SR-10, I47): tulis/baca baris M14-M17 per revisi
 * (salinan penuh, R6), identitas pid per dokumen M18 (buat/pensiun), dan tulis
 * ganda `StudioBlock` (M06, register §10).
 *
 * Semua penulisan berjalan di klien transaksi milik pemanggil (submit/revisi/
 * backfill) yang sudah memegang kunci advisory dokumen (§9.1); modul ini tidak
 * membuka transaksi sendiri.
 *
 * Swarm patch (row 109, Prisma cut): the Prisma delegate calls are SQL over the store
 * transaction (row 8 tables doc_identity, doc_section, doc_chapter, doc_subsection, doc_block,
 * block, asset). `templateSlotId` is stored as `doc_section.template_slot_key` (M10 folded, C5).
 * The doc_block FTS5 rows are kept by the schema's triggers.
 */
import { inList, jsonCol, msOf, parseJson, readWith, bool, type SqlParam } from "../_swarm-store";
import type { InlineV2, StudioIdentityKind } from "../../contract";
import { StudioEngineError } from "../../contract/errors";
import { logStructureError, newCorrelationId, structureLog } from "./log";
import { newRowId } from "./pid";
import { validateRows } from "./rows";
import {
  StructureRowsInvalidError,
  type StructureBlockRow,
  type StructureDb,
  type StructureRows,
} from "./types";

export interface WriteRevisionRowsOptions {
  /** Pensiunkan identitas aktif dokumen yang tidak ada di baris revisi ini (bawaan true). */
  retire?: boolean;
  /**
   * Pid pensiun yang muncul lagi: `reject` (bawaan) -> 422 PID_CONFLICT;
   * `revive` (khusus backfill SR-37) -> identitas diaktifkan ulang.
   */
  onRetiredPid?: "reject" | "revive";
  /** Tulis ganda M06 `StudioBlock` (bawaan true). */
  dualWriteLegacy?: boolean;
  correlationId?: string;
}

export interface WriteRevisionRowsResult {
  documentId: string;
  revisionNo: number;
  counts: { sections: number; chapters: number; subsections: number; blocks: number; legacyBlocks: number };
  identities: { created: number; retired: number; revived: number };
}

interface NeededIdentity {
  pid: string;
  kind: StudioIdentityKind;
}

/**
 * Pastikan setiap pid baris punya identitas M18 dokumen; pensiunkan identitas
 * aktif yang hilang. Mengembalikan peta pid -> id identitas.
 */
export async function syncIdentities(
  db: StructureDb,
  doc: { documentId: string; revisionNo: number; createdBy: string },
  needed: readonly NeededIdentity[],
  opts: Pick<WriteRevisionRowsOptions, "retire" | "onRetiredPid"> = {},
): Promise<{ ids: Map<string, string>; created: number; retired: number; revived: number }> {
  const existing = db
    .all<{ id: string; pid: string; kind: string; created_revision_no: number; retired_revision_no: number | null }>(
      "SELECT id, pid, kind, created_revision_no, retired_revision_no FROM doc_identity WHERE document_id = ?",
      [doc.documentId],
    )
    .map((e) => ({ id: e.id, pid: e.pid, kind: e.kind, createdRevisionNo: Number(e.created_revision_no), retiredRevisionNo: e.retired_revision_no === null ? null : Number(e.retired_revision_no) }));
  const byPid = new Map(existing.map((e) => [e.pid, e]));
  const ids = new Map<string, string>();
  const toCreate: Array<{ id: string; documentId: string; pid: string; kind: string; createdRevisionNo: number; createdBy: string }> = [];
  const toRevive: string[] = [];
  for (const n of needed) {
    const e = byPid.get(n.pid);
    if (!e) {
      const id = newRowId();
      ids.set(n.pid, id);
      toCreate.push({
        id,
        documentId: doc.documentId,
        pid: n.pid,
        kind: n.kind,
        createdRevisionNo: doc.revisionNo,
        createdBy: doc.createdBy,
      });
      continue;
    }
    if (e.kind !== n.kind) {
      throw new StudioEngineError("PID_CONFLICT", `Pid "${n.pid}" sudah dipakai untuk jenis lain (${e.kind}) di dokumen ini`, {
        pid: n.pid,
        kind: n.kind,
        existingKind: e.kind,
      });
    }
    if (e.retiredRevisionNo !== null && e.retiredRevisionNo <= doc.revisionNo) {
      if (opts.onRetiredPid !== "revive") {
        throw new StudioEngineError("PID_CONFLICT", `Pid "${n.pid}" sudah dipensiunkan pada revisi ${e.retiredRevisionNo} dan tidak dapat dipakai ulang`, {
          pid: n.pid,
          retiredRevisionNo: e.retiredRevisionNo,
        });
      }
      toRevive.push(e.id);
    }
    ids.set(n.pid, e.id);
  }
  for (const c of toCreate) {
    db.run(
      "INSERT INTO doc_identity (id, document_id, pid, kind, created_revision_no, retired_revision_no, created_by, time_created) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
      [c.id, c.documentId, c.pid, c.kind, c.createdRevisionNo, c.createdBy, db.now],
    );
  }
  if (toRevive.length > 0) {
    db.run(`UPDATE doc_identity SET retired_revision_no = NULL WHERE id IN (${inList(toRevive)})`, toRevive);
  }
  let retired = 0;
  if (opts.retire !== false) {
    const keep = new Set(needed.map((n) => n.pid));
    const stale = existing
      .filter((e) => e.retiredRevisionNo === null && e.createdRevisionNo <= doc.revisionNo && !keep.has(e.pid))
      .map((e) => e.id);
    if (stale.length > 0) {
      const r = db.run(`UPDATE doc_identity SET retired_revision_no = ? WHERE id IN (${inList(stale)})`, [doc.revisionNo, ...stale]);
      retired = r.changes;
    }
  }
  return { ids, created: toCreate.length, retired, revived: toRevive.length };
}

function legacyChapterKey(b: StructureBlockRow): string {
  return b.chapterKey ?? "F";
}

/**
 * I47 — tulis baris M14-M17 revisi (salinan penuh) + identitas M18 + M06.
 * Revisi harus belum punya baris struktur (melempar bila sudah ada).
 */
export async function writeRevisionRows(
  tx: StructureDb,
  revisionId: string,
  rows: StructureRows,
  opts: WriteRevisionRowsOptions = {},
): Promise<WriteRevisionRowsResult> {
  const correlationId = opts.correlationId ?? newCorrelationId();
  try {
    const issues = validateRows(rows);
    if (issues.length > 0) throw new StructureRowsInvalidError(issues);

    const revRow = tx.get<{ id: string; document_id: string; revision_no: number; created_by: string }>(
      "SELECT id, document_id, revision_no, created_by FROM revision WHERE id = ?",
      [revisionId],
    );
    const rev = revRow ? { id: revRow.id, documentId: revRow.document_id, revisionNo: Number(revRow.revision_no), createdBy: revRow.created_by } : null;
    if (!rev) throw new StudioEngineError("REVISION_NOT_FOUND", `Revisi ${revisionId} tidak ditemukan`, { revisionId });
    const already = Number(tx.get<{ n: number }>("SELECT count(*) AS n FROM doc_section WHERE revision_id = ?", [revisionId])?.n ?? 0);
    if (already > 0) throw new StructureRowsInvalidError([`revision ${revisionId} already has ${already} section rows`]);

    // Identitas (M18).
    const needed: NeededIdentity[] = [
      ...rows.chapters.map((c) => ({ pid: c.pid, kind: "CHAPTER" as const })),
      ...rows.subsections.map((s) => ({ pid: s.pid, kind: "SUBSECTION" as const })),
      ...rows.blocks.map((b) => ({ pid: b.pid, kind: "BLOCK" as const })),
    ];
    const ident = await syncIdentities(
      tx,
      { documentId: rev.documentId, revisionNo: rev.revisionNo, createdBy: rev.createdBy },
      needed,
      opts,
    );
    const identityId = (pid: string): string => {
      const id = ident.ids.get(pid);
      if (!id) throw new StructureRowsInvalidError([`identity missing for pid ${pid}`]);
      return id;
    };

    // Aset (M13) per sha.
    const shas = [...new Set(rows.blocks.map((b) => b.assetSha256).filter((s): s is string => !!s))];
    const assetIdBySha = new Map<string, string>();
    if (shas.length > 0) {
      const assets = tx.all<{ id: string; sha256: string }>(`SELECT id, sha256 FROM asset WHERE sha256 IN (${inList(shas)})`, shas);
      for (const a of assets) assetIdBySha.set(a.sha256, a.id);
      const missing = shas.filter((s) => !assetIdBySha.has(s));
      if (missing.length > 0) {
        throw new StudioEngineError("ASSET_NOT_FOUND", `Aset tidak ditemukan: ${missing.map((s) => `sha256:${s}`).join(", ")}`, {
          assetRefs: missing.map((s) => `sha256:${s}`),
        });
      }
    }

    // M14
    const sectionId = new Map<string, string>();
    const sectionData = rows.sections.map((s) => {
      const id = newRowId();
      sectionId.set(s.slotKey, id);
      return {
        id,
        revisionId,
        templateSlotId: s.templateSlotId,
        slotKey: s.slotKey,
        sectionTypeKey: s.sectionTypeKey,
        position: s.position,
        filled: s.filled,
        payload: s.payload === null || s.payload === undefined ? undefined : (JSON.parse(JSON.stringify(s.payload)) as unknown),
        payloadSha256: s.payloadSha256,
        lastFilledBy: s.lastFilledBy,
        lastFilledAt: s.lastFilledAt ? new Date(s.lastFilledAt) : null,
        lastFilledRevisionNo: s.lastFilledRevisionNo,
      };
    });
    for (const d of sectionData) {
      tx.run(
        `INSERT INTO doc_section (id, revision_id, template_slot_key, slot_key, section_type_key, position, filled, payload, payload_sha256,
           last_filled_by, last_filled_at, last_filled_revision_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.id, d.revisionId, d.templateSlotId, d.slotKey, d.sectionTypeKey, d.position, d.filled, jsonCol(d.payload), d.payloadSha256, d.lastFilledBy, msOf(d.lastFilledAt), d.lastFilledRevisionNo],
      );
    }

    // M15
    const chapterId = new Map<string, string>();
    const chapterData = rows.chapters.map((c) => {
      const id = newRowId();
      chapterId.set(c.chapterKey, id);
      return {
        id,
        revisionId,
        docSectionId: sectionId.get(c.slotKey)!,
        identityId: identityId(c.pid),
        chapterKey: c.chapterKey,
        position: c.position,
        partKey: c.partKey,
        title: (c.title ?? null) as unknown,
        shortTitle: c.shortTitle,
        contentSha256: c.contentSha256,
        lastFilledBy: c.lastFilledBy,
        lastFilledAt: c.lastFilledAt ? new Date(c.lastFilledAt) : null,
        lastFilledRevisionNo: c.lastFilledRevisionNo,
      };
    });
    for (const d of chapterData) {
      tx.run(
        `INSERT INTO doc_chapter (id, revision_id, doc_section_id, identity_id, chapter_key, position, part_key, title, short_title, content_sha256,
           last_filled_by, last_filled_at, last_filled_revision_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.id, d.revisionId, d.docSectionId, d.identityId, d.chapterKey, d.position, d.partKey, JSON.stringify(d.title), d.shortTitle, d.contentSha256, d.lastFilledBy, msOf(d.lastFilledAt), d.lastFilledRevisionNo],
      );
    }

    // M16
    const subId = new Map<string, string>();
    const subData = rows.subsections.map((s) => {
      const id = newRowId();
      subId.set(`${s.chapterKey}\u0000${s.sectionNo}`, id);
      return {
        id,
        revisionId,
        chapterId: chapterId.get(s.chapterKey)!,
        identityId: identityId(s.pid),
        sectionNo: s.sectionNo,
        title: s.title === null ? undefined : (s.title as unknown),
        contentSha256: s.contentSha256,
      };
    });
    for (const d of subData) {
      tx.run(
        "INSERT INTO doc_subsection (id, revision_id, chapter_id, identity_id, section_no, title, content_sha256) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [d.id, d.revisionId, d.chapterId, d.identityId, d.sectionNo, jsonCol(d.title), d.contentSha256],
      );
    }

    // M17 + M06
    const blockData = rows.blocks.map((b) => ({
      id: newRowId(),
      revisionId,
      docSectionId: sectionId.get(b.slotKey)!,
      chapterId: b.chapterKey === null ? null : chapterId.get(b.chapterKey)!,
      subsectionId: b.chapterKey === null || b.sectionNo === null ? null : subId.get(`${b.chapterKey}\u0000${b.sectionNo}`)!,
      identityId: identityId(b.pid),
      pid: b.pid,
      address: b.address,
      artifactLabel: b.artifactLabel,
      ordinal: b.ordinal,
      paraNo: b.paraNo,
      type: b.type,
      content: b.content as unknown,
      textPlain: b.textPlain,
      contentSha256: b.contentSha256,
      assetId: b.assetSha256 ? assetIdBySha.get(b.assetSha256)! : null,
    }));
    for (const d of blockData) {
      tx.run(
        `INSERT INTO doc_block (id, revision_id, doc_section_id, chapter_id, subsection_id, identity_id, pid, address, artifact_label, ordinal, para_no,
           type, content, text_plain, content_sha256, asset_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.id, d.revisionId, d.docSectionId, d.chapterId, d.subsectionId, d.identityId, d.pid, d.address, d.artifactLabel, d.ordinal, d.paraNo, d.type, JSON.stringify(d.content ?? null), d.textPlain, d.contentSha256, d.assetId],
      );
    }

    let legacyBlocks = 0;
    if (opts.dualWriteLegacy !== false && rows.blocks.length > 0) {
      let fallback = 0;
      const legacy = rows.blocks.map((b) => {
        if (!b.internal) fallback++;
        return {
          revisionId,
          blockId: b.pid,
          address: b.address,
          artifactLabel: b.artifactLabel,
          ordinal: b.ordinal,
          chapterKey: legacyChapterKey(b),
          sectionNo: b.sectionNo,
          paraNo: b.paraNo,
          type: b.internal?.type ?? b.type,
          content: (b.internal ? b.internal.content : b.content) as unknown,
          textPlain: b.internal?.textPlain ?? b.textPlain,
          contentSha256: b.internal ? b.internal.contentSha256 : b.contentSha256,
        };
      });
      for (const d of legacy) {
        tx.run(
          `INSERT INTO block (id, revision_id, block_id, address, artifact_label, ordinal, chapter_key, section_no, para_no, type, content, text_plain, content_sha256)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [newRowId(), d.revisionId, d.blockId, d.address, d.artifactLabel, d.ordinal, d.chapterKey, d.sectionNo, d.paraNo, d.type, JSON.stringify(d.content ?? null), d.textPlain, d.contentSha256] as SqlParam[],
        );
      }
      legacyBlocks = legacy.length;
      if (fallback > 0) {
        structureLog({
          level: "warn",
          message: "StudioBlock dual-write used v2 content (no internal content attached)",
          correlationId,
          context: { revisionId, blocks: fallback },
        });
      }
    }

    const result: WriteRevisionRowsResult = {
      documentId: rev.documentId,
      revisionNo: rev.revisionNo,
      counts: {
        sections: sectionData.length,
        chapters: chapterData.length,
        subsections: subData.length,
        blocks: blockData.length,
        legacyBlocks,
      },
      identities: { created: ident.created, retired: ident.retired, revived: ident.revived },
    };
    structureLog({ level: "info", message: "structure rows written", correlationId, context: { revisionId, ...result } });
    return result;
  } catch (err) {
    logStructureError(correlationId, "writeRevisionRows failed", err, { revisionId });
    throw err;
  }
}

/** I47 — baca baris M14-M17 revisi (urut deterministik) + isi internal M06. */
export async function readRows(revisionId: string, db?: StructureDb): Promise<StructureRows> {
  return readWith(db, (q) => readRowsIn(q, revisionId));
}

const dateOrNull = (v: unknown): Date | null => (v === null || v === undefined ? null : new Date(Number(v)));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function readRowsIn(db: StructureDb, revisionId: string): StructureRows {
  type R = Record<string, unknown>;
  const sections = db.all<R>("SELECT * FROM doc_section WHERE revision_id = ? ORDER BY position ASC", [revisionId]).map((r) => ({
    id: String(r.id),
    templateSlotId: (r.template_slot_key ?? null) as string | null,
    slotKey: String(r.slot_key),
    sectionTypeKey: String(r.section_type_key),
    position: Number(r.position),
    filled: bool(r.filled),
    payload: r.payload === null || r.payload === undefined ? null : parseJson<unknown>(r.payload),
    payloadSha256: String(r.payload_sha256),
    lastFilledBy: (r.last_filled_by ?? null) as string | null,
    lastFilledAt: dateOrNull(r.last_filled_at),
    lastFilledRevisionNo: numOrNull(r.last_filled_revision_no),
  }));
  const chapters = db.all<R>("SELECT c.*, i.pid AS identity_pid FROM doc_chapter c JOIN doc_identity i ON i.id = c.identity_id WHERE c.revision_id = ?", [revisionId]).map((r) => ({
    id: String(r.id),
    docSectionId: String(r.doc_section_id),
    identity: { pid: String(r.identity_pid) },
    chapterKey: String(r.chapter_key),
    position: Number(r.position),
    partKey: (r.part_key ?? null) as string | null,
    title: parseJson<unknown>(r.title),
    shortTitle: (r.short_title ?? null) as string | null,
    contentSha256: String(r.content_sha256),
    lastFilledBy: (r.last_filled_by ?? null) as string | null,
    lastFilledAt: dateOrNull(r.last_filled_at),
    lastFilledRevisionNo: numOrNull(r.last_filled_revision_no),
  }));
  const subsections = db.all<R>("SELECT s.*, i.pid AS identity_pid FROM doc_subsection s JOIN doc_identity i ON i.id = s.identity_id WHERE s.revision_id = ?", [revisionId]).map((r) => ({
    id: String(r.id),
    chapterId: String(r.chapter_id),
    identity: { pid: String(r.identity_pid) },
    sectionNo: Number(r.section_no),
    title: r.title === null || r.title === undefined ? null : parseJson<unknown>(r.title),
    contentSha256: String(r.content_sha256),
  }));
  const blocks = db.all<R>("SELECT b.*, a.sha256 AS asset_sha256 FROM doc_block b LEFT JOIN asset a ON a.id = b.asset_id WHERE b.revision_id = ? ORDER BY b.ordinal ASC", [revisionId]).map((r) => ({
    docSectionId: String(r.doc_section_id),
    chapterId: (r.chapter_id ?? null) as string | null,
    subsectionId: (r.subsection_id ?? null) as string | null,
    pid: String(r.pid),
    address: (r.address ?? null) as string | null,
    artifactLabel: (r.artifact_label ?? null) as string | null,
    ordinal: Number(r.ordinal),
    paraNo: numOrNull(r.para_no),
    type: String(r.type),
    content: parseJson<unknown>(r.content),
    textPlain: String(r.text_plain),
    contentSha256: String(r.content_sha256),
    asset: r.asset_sha256 ? { sha256: String(r.asset_sha256) } : null,
  }));
  const legacy = db.all<R>("SELECT block_id, address, type, content, text_plain, content_sha256 FROM block WHERE revision_id = ?", [revisionId]).map((r) => ({
    blockId: String(r.block_id),
    address: String(r.address),
    type: String(r.type),
    content: parseJson<unknown>(r.content),
    textPlain: String(r.text_plain),
    contentSha256: String(r.content_sha256),
  }));
  const secById = new Map(sections.map((s) => [s.id, s]));
  const chById = new Map(chapters.map((c) => [c.id, c]));
  const subById = new Map(subsections.map((s) => [s.id, s]));
  const legacyByAddr = new Map(legacy.map((l) => [l.address, l]));
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const slotPos = (docSectionId: string) => secById.get(docSectionId)?.position ?? 0;

  const outChapters = chapters
    .map((c) => ({
      slotKey: secById.get(c.docSectionId)?.slotKey ?? "",
      chapterKey: c.chapterKey,
      pid: c.identity.pid,
      position: c.position,
      partKey: c.partKey,
      title: c.title as unknown as InlineV2,
      shortTitle: c.shortTitle,
      contentSha256: c.contentSha256,
      lastFilledBy: c.lastFilledBy,
      lastFilledAt: iso(c.lastFilledAt),
      lastFilledRevisionNo: c.lastFilledRevisionNo,
      _order: slotPos(c.docSectionId) * 10000 + c.position,
    }))
    .sort((a, b) => a._order - b._order);
  const chapterOrder = new Map(outChapters.map((c, i) => [c.chapterKey, i]));

  return {
    sections: sections.map((s) => ({
      slotKey: s.slotKey,
      sectionTypeKey: s.sectionTypeKey,
      templateSlotId: s.templateSlotId,
      position: s.position,
      filled: s.filled,
      payload: s.payload ?? null,
      payloadSha256: s.payloadSha256,
      lastFilledBy: s.lastFilledBy,
      lastFilledAt: iso(s.lastFilledAt),
      lastFilledRevisionNo: s.lastFilledRevisionNo,
    })),
    chapters: outChapters.map(({ _order: _o, ...c }) => {
      void _o;
      return c;
    }),
    subsections: subsections
      .map((s) => ({
        chapterKey: chById.get(s.chapterId)?.chapterKey ?? "",
        pid: s.identity.pid,
        sectionNo: s.sectionNo,
        title: (s.title ?? null) as InlineV2 | null,
        contentSha256: s.contentSha256,
      }))
      .sort((a, b) => (chapterOrder.get(a.chapterKey) ?? 0) - (chapterOrder.get(b.chapterKey) ?? 0) || a.sectionNo - b.sectionNo),
    blocks: blocks.map((b): StructureBlockRow => {
      const l = b.address ? legacyByAddr.get(b.address) : undefined;
      const row: StructureBlockRow = {
        slotKey: secById.get(b.docSectionId)?.slotKey ?? "",
        chapterKey: b.chapterId ? (chById.get(b.chapterId)?.chapterKey ?? null) : null,
        sectionNo: b.subsectionId ? (subById.get(b.subsectionId)?.sectionNo ?? null) : null,
        pid: b.pid,
        address: b.address ?? "",
        artifactLabel: b.artifactLabel,
        ordinal: b.ordinal,
        paraNo: b.paraNo,
        type: b.type,
        content: b.content,
        textPlain: b.textPlain,
        contentSha256: b.contentSha256,
        assetSha256: b.asset?.sha256 ?? null,
      };
      if (l && l.blockId === b.pid) {
        row.internal = { content: l.content, contentSha256: l.contentSha256, textPlain: l.textPlain, type: l.type };
      }
      return row;
    }),
  };
}
