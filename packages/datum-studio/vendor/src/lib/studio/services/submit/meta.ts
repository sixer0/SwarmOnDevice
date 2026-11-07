/**
 * Prasyarat pembuatan dokumen lewat kiriman v2 (register 03 §7.2, §11.2 EC16).
 *
 * Meta lengkap dibentuk compose (`defaultMeta`, SR-08) dan bentrok meta pada
 * dokumen yang ada diputus `mergeSubmission` (`META_CONFLICT`). Modul ini hanya
 * menyediakan cek prasyarat pembuatan dan tanggal Asia/Jakarta (§7.2 `issueDate`).
 */
import type { DocMetaV2 } from "../../contract";
import type { StudioCaller } from "../../contract/auth";
import { StudioEngineError } from "../../contract/errors";

/** Pengisi bila identitas pemanggil tidak tersedia (jalur internal tanpa pemanggil). */
export const ANONYMOUS_FILLER = "anonymous";

/**
 * Prefiks pengisi agen = `REQUESTER_PREFIX.agent` (`contract/auth`). Literal di sini agar modul
 * tetap daun (tanpa impor runtime next-auth); kesamaannya dikunci uji `fixf-filler-format`.
 */
export const AGENT_FILLER_PREFIX = "agent:";

/**
 * SR-55 M4 (FIX-S): identitas pengisi untuk cap `lastFilledBy`, teks `change`
 * otomatis, dan nama penulis di `SCOPE_CONFLICT`. Diambil dari identitas
 * pemanggil yang sudah diverifikasi (`contract/auth`), BUKAN dari `agentId` badan:
 * INTERNAL_AGENT = `agentId` ternormalisasi pemegang rahasia (atau requester bila
 * absen); sesi HQ/Google = `requester` sesi. `agentId` badan dari sesi hanya label
 * yang dicatat terpisah di log.
 *
 * SR-55b N3 (FIX-S2): SATU format untuk semua jalur tulis v2 — kiriman R04/R12/R13
 * (`submit/pipeline`, `ingest/v2`) dan sunting R16/R06/R14 (`revisions/v2/commit`).
 *
 * FIX-F C1 (D-313): format = kontrak terdokumentasi (`docs/STUDIO-AGENT-GUIDE.md`,
 * `docs/API-REFERENCE.md`): berprefiks jenis pemanggil, sama dengan `requester`.
 * INTERNAL_AGENT = `agent:<agentId>` (tanpa id: `anonymous-internal`), sesi =
 * `user:<nama>` / `google:<email>`. UI memetakannya ke label awam (`actorLabel`).
 */
export function fillerOf(caller: Pick<StudioCaller, "kind" | "requester" | "agentId"> | null | undefined): string {
  if (!caller) return ANONYMOUS_FILLER;
  if (caller.kind === "INTERNAL_AGENT") {
    const id = typeof caller.agentId === "string" ? caller.agentId.trim() : "";
    if (id !== "") return `${AGENT_FILLER_PREFIX}${id}`;
  }
  return caller.requester || ANONYMOUS_FILLER;
}

/** Tanggal `YYYY-MM-DD` zona Asia/Jakarta. */
export function jakartaDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Dokumen belum ada: `template` dan `meta.title` wajib (400 `META_REQUIRED_FOR_CREATE`). */
export function assertCreatable(
  template: { slug: string; version?: number } | undefined,
  meta: DocMetaV2 | undefined,
): asserts meta is DocMetaV2 & { title: string } {
  const missing: string[] = [];
  if (!template?.slug) missing.push("template");
  if (!meta?.title || meta.title.trim().length === 0) missing.push("meta.title");
  if (missing.length > 0) {
    throw new StudioEngineError(
      "META_REQUIRED_FOR_CREATE",
      `Dokumen belum ada; untuk membuatnya kirim juga ${missing.join(" dan ")}`,
      { missing },
    );
  }
}
