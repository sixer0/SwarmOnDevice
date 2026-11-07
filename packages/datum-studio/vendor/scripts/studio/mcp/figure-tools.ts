/**
 * FIG-03b: alat MCP pratinjau dan revisi SATU figur (toolset `documents`), agar agen tidak perlu mengirim ulang bab
 * dan merender seluruh dokumen untuk melihat satu grafik/diagram.
 *
 * - `studio_figure_preview`: `POST /api/studio/documents/{id}/figures/preview` (route baca saja FIG-03b; tanpa job,
 *   berkas, atau baris DB di server). Hasil kecil: ukuran, isu lint/tata letak (`checkId`, `detail`, `suggest`),
 *   ringkasan data. SVG mentah TIDAK dikembalikan bawaan; `includeSvg` = dipotong 6000 karakter di blok tak
 *   tepercaya; `downloadDir` = SVG ditulis di akar STUDIO_MCP_FILE_ROOTS (aturan sama dengan `studio_file_verify`).
 * - `studio_figure_revise`: tambal medan konten satu blok figur v2 lewat R16 `PATCH .../paragraphs/{pid}` op
 *   `replace` (isi dibaca dari R16 GET di revisi basis, medan `patch` digabung; `null` = hapus medan), lalu
 *   pratinjau revisi baru. Aturan sama dengan alat tulis lain (MCP-D3..D5): basis eksplisit atau basis sesi, selain
 *   itu BASIS_MISSING sebelum jaringan; `rebased`/revisi > basis+1 -> BASIS_REBASED + basis dilupakan; dokumen yang
 *   dibuat pemanggil lain -> DOCUMENT_OWNED_BY_OTHER (0 tulis) kecuali `adoptExisting: true`.
 *
 * Teks asal server (detail/suggest lint, label `Gambar n.m`, SVG, pesan mesin) hanya di blok `<data-tak-tepercaya>`
 * dan `structuredContent` membawa `untrusted: true`; di luar blok hanya token aman (`tok`).
 */
import crypto from "node:crypto";
import path from "node:path";
import { DATUM_NAME_UNSAFE_CHARS, PID_PATTERN, studioRoutePath } from "../../../src/lib/studio/contract/env";
import { datumSafeName } from "../../../src/lib/studio/services/render/naming";
import { ADOPT, adoptedWarning, BASE_REV, bodyAgentId, CHANGE, checkOwnership, completenessBrief, existingData, rememberRevision, requireBasis, withWarnings, type ExistingDoc, type Ownership } from "./doc-tools";
import { assertFileWriteEnabled, McpToolError, prepareDownloadDir, resolveDownloadDir, writeFileGuarded } from "./safety";
import {
  bool,
  http,
  isRecord,
  neutralizeDeep,
  neutralizeMarkers,
  num,
  obj,
  plainAgentId,
  S,
  serverBlock,
  str,
  tok,
  untrustedFields,
  type Args,
  type ToolContext,
  type ToolDef,
  type ToolOutput,
  type ToolWarning,
} from "./tool-kit";

type Rec = Record<string, unknown>;

/** Batas SVG yang dikembalikan `includeSvg` (karakter). */
export const SVG_CAP = 6000;
const ISSUE_LINES = 20;
export const CHART_PATCH_KEYS = ["data", "caption", "source", "note", "unit", "dec", "highlight", "limit", "keyRow", "code", "form", "panels", "orientation", "sort", "topN", "otherLabel", "labelShort"] as const;
export const DIAGRAM_PATCH_KEYS = ["spec", "caption", "source", "keyRow"] as const;
const PATCH_KEYS: ReadonlySet<string> = new Set([...CHART_PATCH_KEYS, ...DIAGRAM_PATCH_KEYS]);
const INLINE_TEXT_KEYS: ReadonlySet<string> = new Set(["caption", "source", "keyRow"]);
const PID_RE = new RegExp(PID_PATTERN);
const PID = { type: "string", pattern: PID_PATTERN } as const;
const ADDRESS = { type: "string", minLength: 1, maxLength: 80, description: "3.1.4 / Gambar 3.1" } as const;
const PREVIEW_ACTION = "POST /api/studio/documents/{id}/figures/preview";

const previewRoute = (id: string) => `/api/studio/documents/${encodeURIComponent(id)}/figures/preview`;
const sha256Hex = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");

async function callPreview(ctx: ToolContext, id: string, body: Rec): Promise<Rec> {
  const reply = await http(ctx, "POST", previewRoute(id), PREVIEW_ACTION, { json: body });
  return isRecord(reply.body) ? reply.body : {};
}

/** Figur tanpa SVG (SVG hanya bila diminta, terpotong). */
function figureBrief(fig: Rec): Rec {
  const rest = { ...fig };
  delete rest.svg;
  delete rest.png; // row 165C: the stand-alone PNG is written to downloadDir, never returned
  return rest;
}

/**
 * Swarm patch (row 165C, F56-3): DATUM file name of a stand-alone figure (`Gambar 4.1 <Judul>.svg`, server
 * `figure.standalone.fileName`). The server text is untrusted: it is cleaned again here with the same DATUM rule
 * (naming.ts datumSafeName: no path separators, no control characters, max 120 characters, no trailing dot), so
 * the name can never leave `downloadDir`; anything unusable falls back to the token-safe store name.
 */
export function standaloneFileName(f: Rec, ext: "svg" | "png", fallback: string): string {
  const sa = isRecord(f.standalone) ? f.standalone : {};
  const names = isRecord(sa.fileName) ? sa.fileName : {};
  const raw = typeof names[ext] === "string" ? (names[ext] as string) : "";
  // Row 165I (C196, L1): a name with control, bidi, zero-width or separator characters is rejected as a whole (the
  // token-safe store name is used), not stripped: env.ts DATUM_NAME_UNSAFE_CHARS, same rule as safeDatumName.
  if (DATUM_NAME_UNSAFE_CHARS.test(raw) || raw.normalize("NFC") !== raw) return fallback;
  const stem = raw.toLowerCase().endsWith(`.${ext}`) ? raw.slice(0, -(ext.length + 1)) : raw;
  // DATUM rule first (drops separators and control characters), then no leading dot or space (no hidden file).
  const safe = datumSafeName(stem, ext, "").replace(/^[.\s]+/, "");
  return safe === ext || safe === `.${ext}` || safe.length <= ext.length + 1 ? fallback : safe;
}

/**
 * Baris hasil pratinjau: kepala token aman + blok tak tepercaya (label, isu + saran). `rendered: false` = mesin
 * menolak figur (kode aman di kepala, pesan di blok).
 */
export function previewLines(id: string, b: Rec, label = "pratinjau figur"): string[] {
  const rev = `dokumen ${tok(id)} rev ${tok(b.revisionNo)} (terkini ${tok(b.currentRevisionNo)})`;
  if (b.rendered !== true) {
    const e = isRecord(b.error) ? b.error : {};
    const block = serverBlock([`galat: ${String(e.message ?? "")}`, ...(e.details !== undefined ? [`rincian: ${JSON.stringify(e.details)}`] : [])], { jenis: "galat-figur", documentId: id });
    return [`${label}: mesin menolak figur (${tok(e.code)}); ${rev}. Perbaiki isi figur lalu pratinjau lagi`, ...(block !== null ? [block] : [])];
  }
  const f = isRecord(b.figure) ? b.figure : {};
  const size = isRecord(f.size) ? f.size : {};
  const issues = Array.isArray(f.issues) ? f.issues.filter(isRecord) : [];
  const n = typeof f.issueCount === "number" ? f.issueCount : issues.length;
  const layout = typeof f.layoutIssueCount === "number" ? f.layoutIssueCount : n;
  const lines = [
    `${label} ${tok(f.type)} ${tok(f.code)} pid ${tok(f.pid)} alamat ${tok(f.address)}${f.inline === true ? " (blok inline, tidak disimpan)" : ""}: ${rev}; ${tok(size.widthMm)} x ${tok(size.heightMm)} mm, SVG ${tok(size.svgBytes)} B; ${layout} isu tata letak${n > layout ? ` (+${n - layout} info)` : ""}${n > 0 ? ", di blok di bawah" : ""}`,
  ];
  const d = isRecord(f.data) ? f.data : null;
  if (d !== null) lines.push(`  data: ${tok(d.shape)} ${tok(d.items)} butir, label terpanjang ${tok(d.maxLabelChars)} karakter`);
  // SEC-FIX (D-502 Low 11): yang DIRENDER (sesudah orientation/AUTO_ORIENT/topN/labelShort), di samping masukan.
  const rd = isRecord(f.rendered) ? f.rendered : null;
  if (rd !== null) lines.push(`  dirender: ${tok(rd.code)} ${tok(rd.orientation)}, ${tok(rd.items)} butir, label terpanjang ${tok(rd.maxLabelChars)} karakter`);
  const body = [
    `label: ${String(f.label ?? "-")}`,
    ...issues.slice(0, ISSUE_LINES).map((i) => `- ${String(i.checkId)}${i.info === true ? " (info)" : ""}: ${String(i.detail ?? "")}${typeof i.suggest === "string" ? ` | saran: ${i.suggest}` : ""}`),
    ...(n > Math.min(issues.length, ISSUE_LINES) ? [`... ${n - Math.min(issues.length, ISSUE_LINES)} isu lain (structuredContent.figure.issues, maks 40)`] : []),
  ];
  lines.push(serverBlock(body, { jenis: "isu-figur", documentId: id }) as string);
  if (layout > 0) lines.push("  perbaiki: studio_figure_revise (patch data/caption/labelShort/topN/orientation/sort) lalu pratinjau lagi");
  return lines;
}

/** Nama berkas SVG dari token aman MCP: `<documentId>-<pid|alamat>[-inline]-rev<N>.svg`. */
function svgFileName(id: string, b: Rec, f: Rec): string {
  const stem = typeof f.pid === "string" && PID_RE.test(f.pid) ? f.pid : typeof f.address === "string" && /^[A-Za-z0-9 .]{1,40}$/.test(f.address) ? f.address.replace(/[^A-Za-z0-9.]/g, "_") : "figur";
  const rev = typeof b.revisionNo === "number" && Number.isInteger(b.revisionNo) ? b.revisionNo : 0;
  return `${id}-${stem}${f.inline === true ? "-inline" : ""}-rev${rev}.svg`;
}

const figurePreviewTool: ToolDef = {
  name: "studio_figure_preview",
  description:
    "Pratinjau satu chart/diagram tanpa render dokumen: ukuran + isu tata letak bersaran. Sasaran pid/address atau block v2 (dry-run). SVG: downloadDir atau includeSvg. standalone: gambar mandiri (caption, KUNCI, SUMBER; Gambar n.m Judul); png: +PNG.",
  inputSchema: obj(
    {
      documentId: S.documentId,
      pid: PID,
      address: ADDRESS,
      block: { type: "object", description: "chart/diagram" },
      rev: S.rev,
      includeSvg: { type: "boolean", description: "SVG terpotong." },
      // Row 165E (C192, tools/list < 30 KB): the meaning of standalone/png lives in the tool description and the guide.
      standalone: { type: "boolean" },
      png: { type: "boolean" },
      downloadDir: { type: "string", minLength: 1, maxLength: 1024, description: "Folder di akar." },
      overwrite: { type: "boolean" },
      agentId: S.agentId,
    },
    ["documentId"],
  ),
  annotations: { title: "Pratinjau figur", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  toolsets: ["documents"],
  async run(a, ctx) {
    const id = str(a, "documentId") as string;
    const pid = str(a, "pid");
    const address = str(a, "address");
    if (pid !== null && address !== null) throw new McpToolError("INVALID_ARGUMENT", "berikan pid atau address, bukan keduanya");
    if (pid === null && address === null && a.block === undefined) throw new McpToolError("INVALID_ARGUMENT", "berikan pid, address, atau block");
    // Folder divalidasi SEBELUM jaringan, termasuk folder bernama folder instruksi (`.claude`): pembantu bersama
    // dengan studio_file_verify (SEC-FIX L-2).
    const dirRaw = str(a, "downloadDir");
    if (dirRaw === null && bool(a, "overwrite")) throw new McpToolError("INVALID_ARGUMENT", "overwrite hanya bersama downloadDir");
    if (dirRaw !== null) assertFileWriteEnabled(ctx.deps.config.fileWriteEnabled, "studio_figure_preview (downloadDir)");
    const dir = dirRaw !== null ? resolveDownloadDir(dirRaw, ctx.deps.config.fileRoots, ctx.deps.nfs) : null;
    const includeSvg = bool(a, "includeSvg");
    // Row 165C (F56-3): stand-alone figure (the original's apparatus "figure" render); PNG only into downloadDir.
    const standalone = bool(a, "standalone");
    const png = bool(a, "png");
    if (png && !standalone) throw new McpToolError("INVALID_ARGUMENT", "png hanya bersama standalone: true");
    if (png && dir === null) throw new McpToolError("INVALID_ARGUMENT", "png hanya bersama downloadDir");
    const body: Rec = {
      ...(pid !== null ? { pid } : {}),
      ...(address !== null ? { address } : {}),
      ...(a.block !== undefined ? { block: a.block } : {}),
      ...(num(a, "rev") !== null ? { revisionNo: num(a, "rev") } : {}),
      ...(includeSvg || dir !== null ? { svg: true } : {}),
      ...(standalone ? { standalone: true } : {}),
      ...(png ? { png: true } : {}),
      ...bodyAgentId(a, ctx),
    };
    const b = await callPreview(ctx, id, body);
    const lines = previewLines(id, b);
    if (b.rendered !== true) {
      const data = { documentId: id, revisionNo: b.revisionNo ?? null, currentRevisionNo: b.currentRevisionNo ?? null, rendered: false, target: b.target ?? null, error: b.error ?? null };
      return { text: lines.join("\n"), data: { ...(neutralizeDeep(data) as Rec), ...untrustedFields(["error.message", "error.details", "target"]) } };
    }
    const f = isRecord(b.figure) ? b.figure : {};
    const svg = typeof f.svg === "string" ? f.svg : "";
    const extra: Rec = {};
    const fields = ["figure.issues", "figure.label"];
    if (standalone) fields.push("figure.standalone");
    if (dir !== null) {
      if (svg === "") throw new McpToolError("SVG_UNAVAILABLE", "server tidak mengirim SVG; tidak ada yang disimpan");
      const pngB64 = typeof f.png === "string" ? f.png : "";
      if (png && pngB64 === "") throw new McpToolError("PNG_UNAVAILABLE", "server tidak mengirim PNG; tidak ada yang disimpan");
      const save = (name: string, buf: Buffer) => {
        const dest = path.join(dir, name);
        const got = sha256Hex(buf);
        const w = writeFileGuarded(dest, buf, { roots: ctx.deps.config.fileRoots, purpose: "write-file", overwrite: bool(a, "overwrite"), nfs: ctx.deps.nfs, now: ctx.now, log: ctx.fsLog.writes, isSame: (x) => sha256Hex(x) === got });
        return { dest, bytes: buf.length, sha256: got, w };
      };
      prepareDownloadDir(dir, ctx.deps.config.fileRoots, ctx.deps.nfs);
      const tokName = svgFileName(id, b, f);
      const s1 = save(standalone ? standaloneFileName(f, "svg", tokName) : tokName, Buffer.from(svg, "utf8"));
      Object.assign(extra, { savedTo: s1.dest, bytes: s1.bytes, sha256: s1.sha256, alreadyPresent: s1.w.unchanged, backup: s1.w.backup });
      const saved = [`SVG disimpan ke: ${s1.dest} (${s1.bytes} B)${s1.w.unchanged ? " (sudah ada dengan isi sama)" : ""}${s1.w.backup !== null ? `; cadangan: ${s1.w.backup}` : ""}`];
      if (png) {
        const s2 = save(standaloneFileName(f, "png", tokName.replace(/\.svg$/, ".png")), Buffer.from(pngB64, "base64"));
        Object.assign(extra, { pngSavedTo: s2.dest, pngBytes: s2.bytes, pngSha256: s2.sha256, pngAlreadyPresent: s2.w.unchanged, pngBackup: s2.w.backup });
        saved.push(`PNG disimpan ke: ${s2.dest} (${s2.bytes} B)${s2.w.unchanged ? " (sudah ada dengan isi sama)" : ""}${s2.w.backup !== null ? `; cadangan: ${s2.w.backup}` : ""}`);
      }
      if (standalone) {
        // The stand-alone name carries the caption (server text): the lines go in the untrusted block.
        fields.push("savedTo", "backup", ...(png ? ["pngSavedTo", "pngBackup"] : []));
        lines.push(`  gambar mandiri disimpan (${png ? "SVG + PNG" : "SVG"}); lokasi di blok di bawah`);
        lines.push(serverBlock(saved, { jenis: "berkas-gambar", documentId: id }) as string);
      } else lines.push(`  ${saved[0]}`);
    }
    const fig = figureBrief(f);
    if (includeSvg) {
      const cut = neutralizeMarkers(svg).slice(0, SVG_CAP);
      fig.svg = cut;
      extra.svgTruncated = svg.length > SVG_CAP;
      fields.push("figure.svg");
      lines.push(serverBlock([cut], { jenis: "svg", documentId: id }) as string);
    }
    const data = { documentId: id, revisionNo: b.revisionNo ?? null, currentRevisionNo: b.currentRevisionNo ?? null, rendered: true, issueCount: f.issueCount ?? null, layoutIssueCount: f.layoutIssueCount ?? null, figure: fig, ...extra };
    return { text: lines.join("\n"), data: { ...(neutralizeDeep(data) as Rec), ...untrustedFields(fields) } };
  },
};

/**
 * Pemilik dokumen dari R05 (`document.createdBy`), lalu aturan pemilik BERSAMA `checkOwnership` (doc-tools; SEC-FIX
 * review 6): pemanggil lain -> DOCUMENT_OWNED_BY_OTHER (0 tulis) kecuali adoptExisting / adopsi sesi.
 */
async function figureOwnership(a: Args, ctx: ToolContext, id: string): Promise<Ownership> {
  const reply = await http(ctx, "GET", studioRoutePath("R05", { id }), "GET /api/studio/documents/{id}");
  const d = isRecord(reply.body) && isRecord(reply.body.document) ? reply.body.document : {};
  const doc: ExistingDoc = {
    id,
    docNumber: typeof d.docNumber === "string" ? d.docNumber : null,
    createdBy: typeof d.createdBy === "string" ? d.createdBy : null,
    currentRevisionNo: typeof d.currentRevisionNo === "number" ? d.currentRevisionNo : null,
    correlationId: reply.correlationId ?? null,
  };
  return checkOwnership(a, ctx, doc, plainAgentId(a, ctx), {
    lead: (_docTok, me) => `dokumen ${tok(id)} dibuat pemanggil lain, bukan ${me}; figur tidak diubah (0 tulis). Ulangi dengan adoptExisting: true bila Anda memang ditugasi mengubahnya`,
    step: "GET /api/studio/documents/{id}",
  });
}

/** Gabung `patch` ke isi blok v2: `null` = hapus medan; caption/source/keyRow berupa string -> `{ text }`. */
export function mergeFigurePatch(content: Rec, patch: Rec): Rec {
  const out: Rec = { ...content };
  for (const [k, v] of Object.entries(patch)) {
    // Swarm patch (row 107, row 11 L5): prototype keys are never copied (as write-normalize.ts:255).
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (v === null) delete out[k];
    else out[k] = INLINE_TEXT_KEYS.has(k) && typeof v === "string" ? { text: v } : v;
  }
  return out;
}

const figureReviseTool: ToolDef = {
  name: "studio_figure_revise",
  description:
    "Ubah konten satu figur v2 tanpa kirim ulang bab, lalu pratinjau. patch: data, caption, unit, labelShort, topN, orientation, sort...; null = hapus. Wajib change + baseRevisionNo (atau basis sesi).",
  inputSchema: obj(
    {
      documentId: S.documentId,
      pid: PID,
      address: ADDRESS,
      patch: { type: "object", minProperties: 1, description: "diagram: spec/caption/source/keyRow" },
      baseRevisionNo: BASE_REV,
      change: CHANGE,
      preview: { type: "boolean", description: "Bawaan true." },
      adoptExisting: { ...ADOPT, description: "Dokumen agentId lain (eksplisit)." },
      agentId: S.agentId,
    },
    ["documentId", "patch", "change"],
  ),
  annotations: { title: "Revisi figur", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  toolsets: ["documents"],
  async run(a, ctx) {
    const id = str(a, "documentId") as string;
    const pidArg = str(a, "pid");
    const address = str(a, "address");
    if ((pidArg === null) === (address === null)) throw new McpToolError("INVALID_ARGUMENT", "berikan tepat satu dari pid atau address; tidak ada yang dikirim");
    const unknown = Object.keys(isRecord(a.patch) ? a.patch : {}).filter((k) => !PATCH_KEYS.has(k));
    if (unknown.length > 0) throw new McpToolError("INVALID_ARGUMENT", `patch memuat medan yang bukan konten figur: ${unknown.map((k) => tok(k, "?")).join(", ")}; tidak ada yang dikirim`);
    // F-3 tanpa jaringan: basis eksplisit atau basis sesi.
    const basis = requireBasis(num(a, "baseRevisionNo"), ctx, id, null);
    const base = basis.baseRevisionNo;
    const ownership = await figureOwnership(a, ctx, id);
    const agent = bodyAgentId(a, ctx);
    let pid = pidArg;
    if (pid === null) {
      const pv = await callPreview(ctx, id, { address, revisionNo: base, ...agent });
      const t = pv.rendered === true && isRecord(pv.figure) ? pv.figure : isRecord(pv.target) ? pv.target : {};
      if (typeof t.pid !== "string" || !PID_RE.test(t.pid)) throw new McpToolError("INVALID_ARGUMENT", "alamat ini tidak punya pid (dokumen v1); revisi figur hanya untuk dokumen v2. Tidak ada yang dikirim");
      pid = t.pid;
    }
    const r16 = studioRoutePath("R16", { id, pid });
    const got = await http(ctx, "GET", `${r16}?rev=${base}`, "GET /api/studio/documents/{id}/paragraphs/{pid}");
    const g = isRecord(got.body) ? got.body : {};
    const allowed: readonly string[] = g.type === "chart" ? CHART_PATCH_KEYS : g.type === "diagram" ? DIAGRAM_PATCH_KEYS : [];
    if (allowed.length === 0) throw new McpToolError("INVALID_ARGUMENT", `pid ${tok(pid)} berjenis ${tok(g.type)}, bukan chart/diagram; tidak ada yang dikirim`);
    const patch = isRecord(a.patch) ? a.patch : {};
    const bad = Object.keys(patch).filter((k) => !allowed.includes(k));
    if (bad.length > 0) throw new McpToolError("INVALID_ARGUMENT", `medan ${bad.join(", ")} tidak berlaku untuk ${String(g.type)} (boleh: ${allowed.join(", ")}); tidak ada yang dikirim`);
    const block = mergeFigurePatch(isRecord(g.content) ? g.content : {}, patch);
    const reply = await http(ctx, "PATCH", r16, "PATCH /api/studio/documents/{id}/paragraphs/{pid}", { json: { op: "replace", baseRevisionNo: base, block, change: a.change, ...agent } });
    const p = isRecord(reply.body) ? reply.body : {};
    const rev = isRecord(p.revision) ? p.revision : {};
    const revNo = typeof rev.revisionNo === "number" ? rev.revisionNo : null;
    const newPid = typeof p.newPid === "string" ? p.newPid : typeof p.pid === "string" ? p.pid : pid;
    const rebasedWarning = revNo !== null ? rememberRevision(ctx, id, revNo, { created: false, unchanged: p.unchanged === true, rebased: p.rebased === true, sentBase: base }, "studio_figure_revise") : null;
    const lines = [`revisi figur pid ${tok(newPid)}: dokumen ${tok(id)} rev ${tok(revNo)} (${tok(rev.changeScope)}) di atas basis ${base}${p.rebased === true ? ", rebased" : ""}`];
    if (basis.line !== null) lines.push(basis.line);
    let previewWarning: ToolWarning | null = null;
    let fig: Rec | null = null;
    if (a.preview !== false && revNo !== null) {
      try {
        const pv = await callPreview(ctx, id, { pid: newPid, revisionNo: revNo, ...agent });
        lines.push(...previewLines(id, pv, "  pratinjau"));
        fig = pv.rendered === true && isRecord(pv.figure) ? figureBrief(pv.figure) : { rendered: false, error: pv.error ?? null };
      } catch (e) {
        if (!(e instanceof McpToolError)) throw e;
        previewWarning = { code: "PREVIEW_FAILED", message: `pratinjau revisi baru gagal (${tok(e.code)}); revisi tetap tersimpan. Ulangi studio_figure_preview { documentId, pid, rev }` };
      }
    }
    const data = {
      documentId: id,
      pid: newPid,
      revisionNo: revNo,
      baseRevisionNo: base,
      changeScope: rev.changeScope ?? null,
      rebased: p.rebased === true,
      ...(basis.remembered ? { basisFromSession: base } : {}),
      ...existingData(ownership.adopted ? ownership : null),
      ...(fig !== null ? { figure: fig, issueCount: fig.issueCount ?? null, layoutIssueCount: fig.layoutIssueCount ?? null } : {}),
      completeness: completenessBrief(p.completeness),
    };
    const out: ToolOutput = { text: lines.join("\n"), data: { ...(neutralizeDeep(data) as Rec), ...untrustedFields(["figure.issues", "figure.label", "figure.error", "completeness", "existing.createdBy"]) } };
    return withWarnings(out, adoptedWarning(ownership), rebasedWarning, previewWarning);
  },
};

export const FIGURE_TOOLS: readonly ToolDef[] = [figurePreviewTool, figureReviseTool];
