/**
 * Op per pid pada pohon konten (SR-14; register 03 §10 "Sunting per pid",
 * blueprint §2.6 tabel op; D-131 butir 6).
 *
 * | Jenis      | Op                                                   |
 * |------------|------------------------------------------------------|
 * | BLOCK      | replace (tipe boleh berubah), insertBefore/After, delete, move |
 * | SUBSECTION | replace (SectionV2), insertBefore/After, delete      |
 * | CHAPTER    | replace (ChapterV2, kunci sama), delete              |
 *
 * Op lain -> 400 SCHEMA_INVALID `checkId: "PID_OP_KIND"`. `replace`
 * mempertahankan pid; sisipan memberi `newPid` (id klien bebas, atau bangkitan).
 * Murni: op hanya mengubah salinan pohon. Pemanggil lalu menggabungkan setiap
 * bab yang tersentuh lewat `mergeSubmission` compose (aturan pid §10 satu
 * sumber: node tanpa id mewarisi pid posisi atau dibangkitkan; pid bentrok ->
 * 422 PID_CONFLICT; isi bab divalidasi terhadap kerangka).
 */
import type { BlockV2, ChapterV2, PidAllocator, SectionV2, StudioDocV2Resolved, StudioIdentityKind } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import type { PatchPidBody } from "./body";
import { blockContainer, findChapterByKey, locateBlock, locateChapter, locateSection } from "./tree";

export interface PidOpContext {
  /** Identitas dokumen (aktif + pensiun), dikunci pid: cek pid klien sisipan. */
  identities: ReadonlyMap<string, { retiredRevisionNo: number | null }>;
  /** Lingkup pemilik pid aktif (mis. `chapter:3`), untuk details PID_CONFLICT. */
  ownerOf: (pid: string) => string | null;
  alloc: PidAllocator;
}

export interface PidOpOutcome {
  newPid?: string;
  /** Bab yang isinya berubah (kunci, urutan: asal lalu tujuan) untuk digabung ulang. */
  touchedChapters: string[];
  /** Bab yang dihapus (op delete pada pid bab). */
  deletedChapter?: { slotKey: string; key: string };
}

function fail(code: ConstructorParameters<typeof StudioEngineError>[0], message: string, details?: unknown): never {
  throw new StudioEngineError(code, message, details);
}

function kindFail(kind: StudioIdentityKind, op: string, hint?: string): never {
  fail("SCHEMA_INVALID", `Op ${op} tidak tersedia untuk ${kind.toLowerCase()}`, [
    {
      pointer: "/op",
      keyword: "pidOpKind",
      checkId: "PID_OP_KIND",
      message:
        hint ??
        "op per jenis: blok = replace, insertBefore, insertAfter, delete, move; section = replace, insertBefore, insertAfter, delete; bab = replace, delete",
    },
  ]);
}

function requireOnly(body: PatchPidBody, field: "block" | "section" | "chapter" | null, kind: StudioIdentityKind): void {
  for (const f of ["block", "section", "chapter"] as const) {
    if (f === field) {
      if (body[f] === undefined) fail("SCHEMA_INVALID", `${f} wajib untuk op ${body.op}`, [{ pointer: `/${f}`, keyword: "required", message: `${f} wajib diisi` }]);
    } else if (body[f] !== undefined) {
      fail("SCHEMA_INVALID", `${f} tidak berlaku untuk op ${body.op} pada ${kind.toLowerCase()}`, [{ pointer: `/${f}`, keyword: "not", message: `hapus ${f}` }]);
    }
  }
  if (body.op !== "move" && body.to !== undefined) fail("SCHEMA_INVALID", "to hanya berlaku untuk op move", [{ pointer: "/to", keyword: "not", message: "hapus to" }]);
}

/** Pid sisipan: id klien (harus belum pernah dipakai dokumen) atau bangkitan. */
function insertPid(clientId: string | undefined, kind: StudioIdentityKind, pointer: string, ctx: PidOpContext, hint: string): string {
  if (clientId === undefined) return ctx.alloc.next(kind, hint);
  const known = ctx.identities.get(clientId);
  if (known) {
    if (known.retiredRevisionNo !== null) {
      fail("PID_CONFLICT", `pid ${clientId} sudah dipensiunkan pada revisi ${known.retiredRevisionNo}; hapus id agar pid baru dibangkitkan`, {
        pid: clientId,
        pointer,
        retiredRevisionNo: known.retiredRevisionNo,
      });
    }
    const owner = ctx.ownerOf(clientId);
    fail("PID_CONFLICT", `pid ${clientId} sudah dipakai ${owner ?? "lingkup lain"}; hapus id atau pakai pid lain`, { pid: clientId, pointer, ownerScope: owner ?? "unknown" });
  }
  return clientId;
}

function idMismatch(given: string | undefined, pid: string, pointer: string): void {
  if (given !== undefined && given !== pid) {
    fail("PID_CONFLICT", `replace mempertahankan pid ${pid}; id ${given} di isi tidak sama (hapus id atau samakan)`, { pid: given, pointer, ownerScope: `pid:${pid}` });
  }
}

/** Terapkan op ke `doc` (dimutasi; pemanggil memberi salinan ber-id). `kind` = jenis identitas M18. */
export function applyPidOp(doc: StudioDocV2Resolved, pid: string, kind: StudioIdentityKind, body: PatchPidBody, ctx: PidOpContext): PidOpOutcome {
  if (kind === "BLOCK") return applyBlockOp(doc, pid, body, ctx);
  if (kind === "SUBSECTION") return applySectionOp(doc, pid, body, ctx);
  return applyChapterOp(doc, pid, body);
}

function applyBlockOp(doc: StudioDocV2Resolved, pid: string, body: PatchPidBody, ctx: PidOpContext): PidOpOutcome {
  const loc = locateBlock(doc, pid);
  if (!loc) {
    kindFail("BLOCK", body.op, "pid ini milik payload slot tak-berulang (mis. entri daftar rujukan); sunting lewat POST /api/studio/slots");
  }
  const touched = [loc.chapter.key];
  let newPid: string | undefined;
  switch (body.op) {
    case "replace": {
      requireOnly(body, "block", "BLOCK");
      idMismatch(body.block!.id, pid, "/block/id");
      loc.container[loc.blockIndex] = { ...(body.block as BlockV2), id: pid };
      break;
    }
    case "insertBefore":
    case "insertAfter": {
      requireOnly(body, "block", "BLOCK");
      newPid = insertPid(body.block!.id, "BLOCK", "/block/id", ctx, `${loc.chapter.key}.${loc.sectionNo}`);
      loc.container.splice(body.op === "insertBefore" ? loc.blockIndex : loc.blockIndex + 1, 0, { ...(body.block as BlockV2), id: newPid });
      break;
    }
    case "delete":
      requireOnly(body, null, "BLOCK");
      loc.container.splice(loc.blockIndex, 1);
      break;
    case "move": {
      requireOnly(body, null, "BLOCK");
      const to = body.to;
      if (!to) fail("SCHEMA_INVALID", "to wajib untuk op move", [{ pointer: "/to", keyword: "required", message: "to = {before} | {after} | {section}" }]);
      const anchor = to.before ?? to.after;
      if (anchor === pid) fail("SCHEMA_INVALID", "Jangkar move tidak boleh pid itu sendiri", [{ pointer: to.before ? "/to/before" : "/to/after", keyword: "not", message: "pid jangkar = pid sasaran" }]);
      const [moved] = loc.container.splice(loc.blockIndex, 1);
      let destKey: string;
      if (anchor !== undefined) {
        const a = locateBlock(doc, anchor);
        if (!a) fail("PID_NOT_FOUND", `Jangkar ${anchor} bukan blok aktif di bab dokumen ini`, { pid: anchor, pointer: to.before ? "/to/before" : "/to/after" });
        a.container.splice(to.before ? a.blockIndex : a.blockIndex + 1, 0, moved);
        destKey = a.chapter.key;
      } else {
        const s = to.section!;
        const target = findChapterByKey(doc, s.chapterKey);
        const container = target ? blockContainer(target.chapter, s.sectionNo, true) : null;
        if (!target || !container) {
          fail("ADDRESS_NOT_FOUND", `Section ${s.chapterKey}.${s.sectionNo} tidak ada di revisi terbaru`, { chapterKey: s.chapterKey, sectionNo: s.sectionNo });
        }
        if (s.at > container.length + 1) {
          fail("SCHEMA_INVALID", `to.section.at maksimal ${container.length + 1} untuk section ${s.chapterKey}.${s.sectionNo}`, [
            { pointer: "/to/section/at", keyword: "maximum", message: `posisi 1..${container.length + 1}` },
          ]);
        }
        container.splice(s.at - 1, 0, moved);
        destKey = target.chapter.key;
      }
      if (!touched.includes(destKey)) touched.push(destKey);
      break;
    }
  }
  return { newPid, touchedChapters: touched };
}

function applySectionOp(doc: StudioDocV2Resolved, pid: string, body: PatchPidBody, ctx: PidOpContext): PidOpOutcome {
  const loc = locateSection(doc, pid);
  if (!loc) {
    kindFail("SUBSECTION", body.op, "pid ini adalah intro bab (section 0): sunting blok intro per pid, atau ganti bab utuh (op replace pada pid bab)");
  }
  let newPid: string | undefined;
  const secs = loc.chapter.sections;
  switch (body.op) {
    case "replace":
      requireOnly(body, "section", "SUBSECTION");
      idMismatch(body.section!.id, pid, "/section/id");
      secs[loc.sectionIndex] = { ...(body.section as SectionV2), id: pid };
      break;
    case "insertBefore":
    case "insertAfter": {
      requireOnly(body, "section", "SUBSECTION");
      newPid = insertPid(body.section!.id, "SUBSECTION", "/section/id", ctx, `${loc.chapter.key}.${loc.sectionNo}`);
      secs.splice(body.op === "insertBefore" ? loc.sectionIndex : loc.sectionIndex + 1, 0, { ...(body.section as SectionV2), id: newPid });
      break;
    }
    case "delete":
      requireOnly(body, null, "SUBSECTION");
      secs.splice(loc.sectionIndex, 1);
      break;
    default:
      kindFail("SUBSECTION", body.op);
  }
  return { newPid, touchedChapters: [loc.chapter.key] };
}

function applyChapterOp(doc: StudioDocV2Resolved, pid: string, body: PatchPidBody): PidOpOutcome {
  const loc = locateChapter(doc, pid);
  if (!loc) fail("PID_NOT_FOUND", `Bab ${pid} tidak ada di revisi terbaru`, { pid });
  const list = loc.payload.chapters ?? [];
  switch (body.op) {
    case "replace": {
      requireOnly(body, "chapter", "CHAPTER");
      const next = body.chapter as ChapterV2;
      if (next.key !== loc.chapter.key) {
        fail("CHAPTER_KEY_INVALID", `replace bab mempertahankan kunci ${loc.chapter.key}; penomoran ulang kunci hanya lewat op struktur renumberChapters (ADMIN)`, {
          slotKey: loc.slotKey,
          key: next.key,
          expected: loc.chapter.key,
        });
      }
      idMismatch(next.id, pid, "/chapter/id");
      list[loc.index] = { ...next, id: pid };
      return { touchedChapters: [loc.chapter.key] };
    }
    case "delete":
      requireOnly(body, null, "CHAPTER");
      list.splice(loc.index, 1);
      return { touchedChapters: [], deletedChapter: { slotKey: loc.slotKey, key: loc.chapter.key } };
    default:
      kindFail("CHAPTER", body.op);
  }
}
