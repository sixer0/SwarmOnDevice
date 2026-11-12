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
import { diagramSchema } from "../../../src/lib/studio/contract/schema/diagram.schema";
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
  // Row 73 (W-03): the server splits issues into defects (fix) and notices (engine adapted, no action).
  const defects = Array.isArray(f.defects) ? f.defects.length : null;
  if (defects !== null && Array.isArray(f.notices)) lines.push(`  cacat ${defects}, catatan ${f.notices.length} (figure.defects / figure.notices)`);
  if ((defects ?? layout) > 0) lines.push("  perbaiki: studio_figure_revise (patch data/caption/labelShort/topN/orientation/sort) lalu pratinjau lagi");
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
    "Pratinjau satu chart/diagram tanpa render dokumen: ukuran + isu tata letak bersaran. Sasaran pid/address atau block v2 (dry-run). SVG: downloadDir atau includeSvg. Gerbang = pratinjau inline. standalone: hanya figur sendiri (caption, KUNCI, SUMBER), batas numerik; png: +PNG.",
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
    const fields = ["figure.issues", "figure.notices", "figure.defects", "figure.label"];
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

const PROTO_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Swarm 1.2.6 row 69 (T-16, register E-17): deep merge of a `spec` patch. Plain objects merge key by key, arrays and
 * scalars replace, `null` removes the key; prototype keys are never copied. Neither input is mutated.
 */
function deepMergeSpec(base: Rec, patch: Rec): Rec {
  const out: Rec = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (PROTO_KEYS.has(k)) continue;
    if (v === null) delete out[k];
    else if (isRecord(v)) out[k] = deepMergeSpec(isRecord(out[k]) ? out[k] : {}, v);
    else out[k] = v;
  }
  return out;
}

/**
 * Gabung `patch` ke isi blok v2: `null` = hapus medan; caption/source/keyRow berupa string -> `{ text }`.
 * Swarm 1.2.6 row 69 (T-16): `spec` is deep-merged into the stored spec (objects merge, arrays replace, `null` removes),
 * so a nodes-only or edges-only patch keeps family, edges, title and the rest. A spec patch that leaves a required
 * diagram key (diagram.schema.ts `required`) missing is refused SCHEMA_INVALID naming the key, before any write.
 */
export function mergeFigurePatch(content: Rec, patch: Rec): Rec {
  const out: Rec = { ...content };
  for (const [k, v] of Object.entries(patch)) {
    // Swarm patch (row 107, row 11 L5): prototype keys are never copied (as write-normalize.ts:255).
    if (PROTO_KEYS.has(k)) continue;
    if (v === null) delete out[k];
    else if (k === "spec" && isRecord(v)) out[k] = deepMergeSpec(isRecord(out[k]) ? out[k] : {}, v);
    else out[k] = INLINE_TEXT_KEYS.has(k) && typeof v === "string" ? { text: v } : v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "spec")) {
    const spec = isRecord(out.spec) ? out.spec : null;
    const missing = spec === null ? ["spec"] : (diagramSchema.required as readonly string[]).filter((r) => !Object.prototype.hasOwnProperty.call(spec, r));
    if (missing.length > 0) {
      throw new McpToolError("SCHEMA_INVALID", `spec hasil gabungan kehilangan medan wajib: ${missing.join(", ")}; kirim nilai medan itu atau jangan hapus (null) medan itu. Tidak ada yang dikirim`, { pointer: `/spec/${missing[0]}` });
    }
  }
  return out;
}

/** Swarm 1.2.6 row 73 (W-05, register N-023): node/edge delta of one figure revision. */
export interface FigureGraphDelta {
  code: "FIGURE_GRAPH_DELTA";
  nodes: { before: number; after: number; added: string[]; removed: string[] };
  edges: { before: number; after: number; added: string[]; removed: string[]; rewired: string[] };
}

/** Node ids and edge keys (`from->to`) of a figure's graph: diagram `spec.nodes/edges`, chart graph `data.nodes/links`. */
function figureGraph(content: Rec): { nodes: string[]; edges: string[] } | null {
  const data = isRecord(content.data) && content.data.shape === "graph" ? content.data : null;
  const g = isRecord(content.spec) ? content.spec : data;
  if (g === null) return null;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter(isRecord) : []);
  const edgeList = g === data ? g.links : g.edges;
  if (!Array.isArray(g.nodes) && !Array.isArray(edgeList)) return null;
  return { nodes: list(g.nodes).map((n) => String(n.id ?? "")), edges: list(edgeList).map((e) => `${String(e.from ?? "")}->${String(e.to ?? "")}`) };
}

/** Multiset difference `a - b` (each occurrence counted once). */
function minus(a: readonly string[], b: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const x of b) left.set(x, (left.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const n = left.get(x) ?? 0;
    if (n > 0) left.set(x, n - 1);
    else out.push(x);
  }
  return out;
}

/**
 * Swarm 1.2.6 row 73 (W-05/OFF-06): nodes and edges added, removed and rewired between the stored figure content and
 * the merged content about to be written. An edge is keyed by its endpoints (`from->to`); a removed edge and an added
 * edge sharing one endpoint are reported as one rewired edge (`a->b => a->c`). null when the figure has no graph or
 * nothing changed. A REPORT for the agent, never a refusal: the write goes ahead either way.
 */
export function figureGraphDelta(before: Rec, after: Rec): FigureGraphDelta | null {
  const b = figureGraph(before);
  const a = figureGraph(after);
  if (b === null && a === null) return null;
  const gb = b ?? { nodes: [], edges: [] };
  const ga = a ?? { nodes: [], edges: [] };
  const edgesAdded = minus(ga.edges, gb.edges);
  const edgesRemoved = minus(gb.edges, ga.edges);
  const rewired: string[] = [];
  for (let i = edgesRemoved.length - 1; i >= 0; i--) {
    const [rf, rt] = edgesRemoved[i].split("->");
    const j = edgesAdded.findIndex((x) => {
      const [af, at] = x.split("->");
      return af === rf || at === rt;
    });
    if (j < 0) continue;
    rewired.unshift(`${edgesRemoved[i]} => ${edgesAdded[j]}`);
    edgesRemoved.splice(i, 1);
    edgesAdded.splice(j, 1);
  }
  const nodesAdded = minus(ga.nodes, gb.nodes);
  const nodesRemoved = minus(gb.nodes, ga.nodes);
  if (nodesAdded.length + nodesRemoved.length + edgesAdded.length + edgesRemoved.length + rewired.length === 0) return null;
  return {
    code: "FIGURE_GRAPH_DELTA",
    nodes: { before: gb.nodes.length, after: ga.nodes.length, added: nodesAdded, removed: nodesRemoved },
    edges: { before: gb.edges.length, after: ga.edges.length, added: edgesAdded, removed: edgesRemoved, rewired },
  };
}

/** Row 73 (W-05): the safe head line (counts only) and the untrusted block (ids come from the stored content). */
function graphDeltaLines(id: string, d: FigureGraphDelta): string[] {
  const n = d.nodes;
  const e = d.edges;
  const head = `  FIGURE_GRAPH_DELTA: simpul ${n.before}→${n.after}, tepi ${e.before}→${e.after} (simpul +${n.added.length}/-${n.removed.length}; tepi +${e.added.length}/-${e.removed.length}, disambung ulang ${e.rewired.length}); periksa bahwa perubahan ini disengaja`;
  const body = [
    ...(n.added.length > 0 ? [`simpul ditambah: ${n.added.join(", ")}`] : []),
    ...(n.removed.length > 0 ? [`simpul dihapus: ${n.removed.join(", ")}`] : []),
    ...(e.added.length > 0 ? [`tepi ditambah: ${e.added.join(", ")}`] : []),
    ...(e.removed.length > 0 ? [`tepi dihapus: ${e.removed.join(", ")}`] : []),
    ...(e.rewired.length > 0 ? [`tepi disambung ulang: ${e.rewired.join(", ")}`] : []),
  ];
  const block = serverBlock(body, { jenis: "delta-graf", documentId: id });
  return [head, ...(block !== null ? [block] : [])];
}

const figureReviseTool: ToolDef = {
  name: "studio_figure_revise",
  description:
    "Ubah konten satu figur v2 tanpa kirim ulang bab, lalu pratinjau. patch parsial: data, caption, unit, labelShort, topN, orientation, sort...; spec digabung; null = hapus. Simpul/tepi berubah -> FIGURE_GRAPH_DELTA. Wajib change + baseRevisionNo (atau basis sesi).",
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
    const stored = isRecord(g.content) ? g.content : {};
    const block = mergeFigurePatch(stored, patch);
    // Row 73 (W-05): node/edge delta vs the base revision, reported after the write (never a refusal).
    const graphDelta = figureGraphDelta(stored, block);
    const reply = await http(ctx, "PATCH", r16, "PATCH /api/studio/documents/{id}/paragraphs/{pid}", { json: { op: "replace", baseRevisionNo: base, block, change: a.change, ...agent } });
    const p = isRecord(reply.body) ? reply.body : {};
    const rev = isRecord(p.revision) ? p.revision : {};
    const revNo = typeof rev.revisionNo === "number" ? rev.revisionNo : null;
    const newPid = typeof p.newPid === "string" ? p.newPid : typeof p.pid === "string" ? p.pid : pid;
    const rebasedWarning = revNo !== null ? rememberRevision(ctx, id, revNo, { created: false, unchanged: p.unchanged === true, rebased: p.rebased === true, sentBase: base }, "studio_figure_revise") : null;
    const lines = [`revisi figur pid ${tok(newPid)}: dokumen ${tok(id)} rev ${tok(revNo)} (${tok(rev.changeScope)}) di atas basis ${base}${p.rebased === true ? ", rebased" : ""}`];
    if (basis.line !== null) lines.push(basis.line);
    if (graphDelta !== null) lines.push(...graphDeltaLines(id, graphDelta));
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
      ...(graphDelta !== null ? { graphDelta } : {}),
      ...(fig !== null ? { figure: fig, issueCount: fig.issueCount ?? null, layoutIssueCount: fig.layoutIssueCount ?? null } : {}),
      completeness: completenessBrief(p.completeness),
    };
    const out: ToolOutput = { text: lines.join("\n"), data: { ...(neutralizeDeep(data) as Rec), ...untrustedFields(["figure.issues", "figure.notices", "figure.defects", "figure.label", "figure.error", "completeness", "existing.createdBy", ...(graphDelta !== null ? ["graphDelta"] : [])]) } };
    return withWarnings(out, adoptedWarning(ownership), rebasedWarning, previewWarning);
  },
};

export const FIGURE_TOOLS: readonly ToolDef[] = [figurePreviewTool, figureReviseTool];
