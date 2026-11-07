/**
 * services/adapt-v1 — halaman depan v1 → payload slot v2 (register §14.2).
 *
 * - `front.cover` auto (`CoverData`) → `CoverPayloadV2` (`kicker` → `tagline`).
 * - `front.cover` explicit (`body`) → paragraf ber-`role` `title`/`standfirst`/
 *   `scopeLine`/`addressLine`/`kicker` → medan sampul; `controlBlock` → `control`;
 *   `colophon` → `colophon`; sisanya dibuang + `dropped.frontItems`.
 * - `front.controlSheet` auto (`ControlSheetData`) → `ControlSheetPayloadV2`.
 *   Explicit (tidak dirinci register; perluasan setara cover): `pageTitle` →
 *   `title`, `methodStatement` → `methodStatement`; tabel → `revisionHistory`/
 *   `verificationChain`/`distribution` menurut `preset` bila cocok, selain itu
 *   urutan kemunculan; `kicker`/`blockHeading` = label slot/templat (dibuang).
 * - `signatureBlock` di badan explicit menjadi slot `signature` bila
 *   `front.signature` absen.
 * - `front.toc` → `TocPayloadV2`; `entries` dipertahankan hanya bila slot toc
 *   MIXED (`opts.tocMixed`), selain itu dibuang + `dropped.tocEntries`.
 */
import type {
  ControlBlock,
  ControlSheetData,
  ControlSheetPayloadV2,
  CoverData,
  CoverPayloadV2,
  FrontItem,
  FrontPage,
  Inline,
  InlineV2,
  SignatureBlock,
  SignaturePayloadV2,
  TableBlock,
  TocPayloadV2,
  TocSpec,
} from "@/lib/studio/contract";
import { TABLE_BLOCK_TYPES } from "@/lib/studio/contract";
import { adaptTable, type AdaptCtx } from "./blocks";
import { adaptInline, adaptInlineList, adaptInlineOpt, inlinePart, INLINE_KEYS, ptr } from "./inline";
import type { AdaptRecorder } from "./report";

const TABLE_TYPES: ReadonlySet<string> = new Set(TABLE_BLOCK_TYPES);
const COVER_TITLE_LINES_MAX = 4;
const CONTROL_TABLE_FIELDS = ["revisionHistory", "verificationChain", "distribution"] as const;
type ControlTableField = (typeof CONTROL_TABLE_FIELDS)[number];

/** Penampung `signatureBlock` yang ditemukan di badan explicit (dipakai bila `front.signature` absen). */
export interface FrontCarry {
  signature?: { block: SignatureBlock; pointer: string };
}

function adaptControlRows(c: ControlBlock, p: string, rec: AdaptRecorder): CoverPayloadV2["control"] {
  rec.rest(c, ["type", "rows"], p);
  return c.rows.map((row, i) => {
    const pr = ptr(p, "rows", i);
    return [
      adaptInline(row[0], ptr(pr, 0), rec),
      adaptInline(row[1], ptr(pr, 1), rec),
      adaptInline(row[2], ptr(pr, 2), rec),
      adaptInline(row[3], ptr(pr, 3), rec),
    ];
  });
}

function adaptColophon(c: { left: Inline; right: Inline } & object, p: string, rec: AdaptRecorder) {
  rec.rest(c, ["type", "left", "right"], p);
  return { left: adaptInline(c.left, `${p}/left`, rec), right: adaptInline(c.right, `${p}/right`, rec) };
}

function countFrontPrimitive(item: { type?: string }, rec: AdaptRecorder): void {
  if (item.type === "spacer") rec.drop("spacer");
  else if (item.type === "device") rec.drop("device");
  else rec.drop("frontItems");
}

/** Hitung butir `body` yang dibuang seluruhnya (mis. `PartSpec.body`). */
export function dropFrontBody(body: readonly FrontItem[] | undefined, rec: AdaptRecorder): void {
  for (const item of body ?? []) countFrontPrimitive(item as { type?: string }, rec);
}

// ── Sampul ───────────────────────────────────────────────────────────────

export function adaptCover(f: FrontPage, p: string, ctx: AdaptCtx, carry: FrontCarry): CoverPayloadV2 {
  const { rec } = ctx;
  rec.rest(f, ["mode", "data", "body"], p);
  const out: CoverPayloadV2 = { type: "cover" };
  if (f.data) {
    const d = f.data as CoverData;
    const pd = `${p}/data`;
    rec.rest(d, ["kicker", "titleLines", "standfirst", "scopeLine", "addressLine", "control", "colophon", "identityString"], pd);
    if (d.kicker) {
      out.tagline = adaptInline(d.kicker, `${pd}/kicker`, rec);
      rec.rename("cover.kicker->tagline");
    }
    if (d.titleLines) out.titleLines = adaptInlineList(d.titleLines, `${pd}/titleLines`, rec);
    const opt = (k: "standfirst" | "scopeLine" | "addressLine" | "identityString") => {
      const v = adaptInlineOpt(d[k], `${pd}/${k}`, rec);
      if (v) out[k] = v;
    };
    opt("standfirst");
    opt("scopeLine");
    opt("addressLine");
    if (d.control) {
      out.control = adaptControlRows(d.control, `${pd}/control`, rec);
      rec.rename("control.rows->control");
    }
    if (d.colophon) out.colophon = adaptColophon(d.colophon, `${pd}/colophon`, rec);
    opt("identityString");
  }
  if (f.body) adaptCoverBody(f.body, `${p}/body`, ctx, out, carry);
  return out;
}

function adaptCoverBody(body: readonly FrontItem[], p: string, ctx: AdaptCtx, out: CoverPayloadV2, carry: FrontCarry): void {
  const { rec } = ctx;
  const titleLines: InlineV2[] = out.titleLines ? [...out.titleLines] : [];
  body.forEach((item, i) => {
    const pi = ptr(p, i);
    const t = (item as { type: string }).type;
    if (t === "paragraph") {
      const para = item as Extract<FrontItem, { type: "paragraph" }>;
      const v = (): InlineV2 => {
        rec.rest(para, ["type", "blockId", ...INLINE_KEYS, "role"], pi);
        return inlinePart(para, pi, rec);
      };
      switch (para.role) {
        case "title":
          if (titleLines.length < COVER_TITLE_LINES_MAX) titleLines.push(v());
          else rec.drop("frontItems");
          return;
        case "kicker":
          if (!out.tagline) {
            out.tagline = v();
            rec.rename("cover.kicker->tagline");
          } else rec.drop("frontItems");
          return;
        case "standfirst":
        case "scopeLine":
        case "addressLine":
          if (!out[para.role]) out[para.role] = v();
          else rec.drop("frontItems");
          return;
        default:
          rec.drop("frontItems");
          return;
      }
    }
    if (t === "controlBlock" && !out.control) {
      out.control = adaptControlRows(item as ControlBlock, pi, rec);
      rec.rename("control.rows->control");
      return;
    }
    if (t === "colophon" && !out.colophon) {
      out.colophon = adaptColophon(item as { left: Inline; right: Inline }, pi, rec);
      return;
    }
    if (t === "signatureBlock" && !carry.signature) {
      carry.signature = { block: item as SignatureBlock, pointer: pi };
      return;
    }
    countFrontPrimitive(item as { type?: string }, rec);
  });
  if (titleLines.length > 0) out.titleLines = titleLines;
}

// ── Lembar kendali ───────────────────────────────────────────────────────

export function adaptControlSheet(f: FrontPage, p: string, ctx: AdaptCtx, carry: FrontCarry): ControlSheetPayloadV2 {
  const { rec } = ctx;
  rec.rest(f, ["mode", "data", "body"], p);
  const out: ControlSheetPayloadV2 = { type: "controlSheet" };
  if (f.data) {
    const d = f.data as ControlSheetData;
    const pd = `${p}/data`;
    // `kicker` = label slot (DF-59): dihitung sebagai medan dibuang.
    rec.rest(d, ["title", "revisionHistory", "verificationChain", "methodStatement", "distribution"], pd);
    const title = adaptInlineOpt(d.title, `${pd}/title`, rec);
    if (title) out.title = title;
    for (const k of CONTROL_TABLE_FIELDS) {
      const tb = d[k];
      if (tb) out[k] = adaptTable(tb, `${pd}/${k}`, ctx);
    }
    const ms = adaptInlineOpt(d.methodStatement, `${pd}/methodStatement`, rec);
    if (ms) out.methodStatement = ms;
  }
  if (f.body) adaptControlSheetBody(f.body, `${p}/body`, ctx, out, carry);
  return out;
}

function adaptControlSheetBody(
  body: readonly FrontItem[],
  p: string,
  ctx: AdaptCtx,
  out: ControlSheetPayloadV2,
  carry: FrontCarry,
): void {
  const { rec } = ctx;
  const tables: Array<{ tb: TableBlock; pointer: string }> = [];
  body.forEach((item, i) => {
    const pi = ptr(p, i);
    const t = (item as { type: string }).type;
    if (t === "paragraph") {
      const para = item as Extract<FrontItem, { type: "paragraph" }>;
      const target = para.role === "pageTitle" ? "title" : para.role === "methodStatement" ? "methodStatement" : null;
      if (target && !out[target]) {
        rec.rest(para, ["type", "blockId", ...INLINE_KEYS, "role"], pi);
        out[target] = inlinePart(para, pi, rec);
        rec.rename(`controlSheet.${para.role}->${target}`);
      } else rec.drop("frontItems");
      return;
    }
    if (TABLE_TYPES.has(t)) {
      tables.push({ tb: item as TableBlock, pointer: pi });
      return;
    }
    if (t === "signatureBlock" && !carry.signature) {
      carry.signature = { block: item as SignatureBlock, pointer: pi };
      return;
    }
    countFrontPrimitive(item as { type?: string }, rec);
  });
  // Pass 1: `preset` yang sama dengan nama medan; pass 2: sisa menurut urutan medan.
  const placed = new Set<number>();
  tables.forEach(({ tb, pointer }, i) => {
    const k = tb.preset as ControlTableField | undefined;
    if (k && (CONTROL_TABLE_FIELDS as readonly string[]).includes(k) && !out[k]) {
      out[k] = adaptTable(tb, pointer, ctx);
      placed.add(i);
    }
  });
  tables.forEach(({ tb, pointer }, i) => {
    if (placed.has(i)) return;
    const k = CONTROL_TABLE_FIELDS.find((f) => !out[f]);
    if (k) {
      out[k] = adaptTable(tb, pointer, ctx);
      rec.rename(`controlSheet.table(position)->${k}`);
    } else rec.drop("frontItems");
  });
}

// ── Daftar isi dan tanda tangan ──────────────────────────────────────────

export function adaptToc(t: TocSpec, p: string, ctx: AdaptCtx, tocMixed: boolean): TocPayloadV2 {
  const { rec } = ctx;
  rec.rest(t, ["entries"], p);
  const out: TocPayloadV2 = { type: "toc" };
  const entries = t.entries ?? [];
  if (entries.length === 0) return out;
  if (!tocMixed) {
    rec.drop("tocEntries", entries.length);
    return out;
  }
  out.entries = entries.map((e, i) => {
    const pe = ptr(p, "entries", i);
    rec.rest(e, ["level", "label", "title", "page"], pe);
    const v: NonNullable<TocPayloadV2["entries"]>[number] = {
      level: e.level,
      title: adaptInline(e.title, `${pe}/title`, rec),
      page: e.page,
    };
    if (e.label) v.label = adaptInline(e.label, `${pe}/label`, rec);
    return v;
  });
  return out;
}

export function adaptSignature(s: SignatureBlock, p: string, rec: AdaptRecorder): SignaturePayloadV2 {
  rec.rest(s, ["type", "roles"], p);
  return {
    type: "signatureBlock",
    roles: s.roles.map((r, i) => {
      const pr = ptr(p, "roles", i);
      rec.rest(r, ["role", "holder", "date"], pr);
      const v: SignaturePayloadV2["roles"][number] = {
        role: adaptInline(r.role, `${pr}/role`, rec),
        holder: adaptInline(r.holder, `${pr}/holder`, rec),
      };
      if (r.date) v.date = adaptInline(r.date, `${pr}/date`, rec);
      return v;
    }),
  };
}
