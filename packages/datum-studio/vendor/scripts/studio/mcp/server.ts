/**
 * Server MCP Studio (MCP-01; D-449, D-450, D-457): stdio, TERPISAH dari proses Next.
 *
 *   npx tsx <repo>/scripts/studio/mcp/server.ts
 *
 * Env: STUDIO_BASE_URL (bawaan http://127.0.0.1:9021), INTERNAL_API_SECRET (tidak pernah dicetak),
 * STUDIO_AGENT_ID (agentId bawaan), STUDIO_MCP_LOCK_AGENT_ID (kunci agentId), STUDIO_MCP_FILE_ROOTS (akar
 * baca berkas, bawaan cwd; TULIS berkas hanya bila diisi eksplisit — MCP-04 M-1), STUDIO_MCP_TOOLSETS (MCP-D1:
 * reports, documents, query; bawaan semua — hanya alat toolset aktif yang ada di tools/list).
 * Panduan: docs/STUDIO-MCP.md. Memakai SDK resmi `@modelcontextprotocol/sdk` (dipin 1.32.1) dengan
 * `Server` tingkat rendah: skema masukan JSON Schema divalidasi ajv di `tools.ts` (tanpa zod langsung).
 *
 * Log: HANYA stderr (stdout milik protokol JSON-RPC), satu baris JSON per kejadian, tanpa isi
 * argumen dan tanpa rahasia (disensor ulang). Galat yang sampai ke server Studio juga tercatat di log
 * server dengan cid yang sama (`correlationId` hasil alat).
 */
import "../_repo-alias";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { REPO_ROOT } from "../_repo-alias";
import type { HttpFetch } from "../_http-client";
import { describeConfig, loadConfig, MAX_MESSAGE_BYTES, MCP_SERVER_NAME, MCP_SERVER_VERSION, type StudioMcpConfig, type Toolset } from "./config";
import { guideSection170, MCP_DOC_RECIPE, MCP_RECIPE, PROMPT_DOCUMENT, PROMPT_REPORT, RESOURCE_DOC_RECIPE_URI, RESOURCE_GUIDE_URI, RESOURCE_RECIPE_URI, RESOURCE_TEMPLATE_URI, templateText } from "./resources";
import { McpToolError, REAL_NODE_FS, redactSecret, type NodeFs } from "./safety";
import { executeTool, McpSession, newCallId, TOOLS, UNTRUSTED_NOTICE } from "./tools";

export interface ServerDeps {
  config: StudioMcpConfig;
  fetchImpl?: HttpFetch;
  nfs?: NodeFs;
  now?: () => number;
  /** Penulis log (bawaan stderr). */
  log?: (line: string) => void;
  repoRoot?: string;
}

/**
 * Instruksi server (dikirim sekali saat initialize; banyak klien menaruhnya di prompt sistem setiap giliran,
 * jadi ringkas). MCP-D1: hanya menyebut toolset yang aktif; aturan panjang ada di resource resep.
 */
export function instructionsFor(toolsets: readonly Toolset[]): string {
  const on = (t: Toolset) => toolsets.includes(t);
  return [
    `Server MCP Studio GSP (toolset: ${toolsets.join(", ")}).`,
    ...(on("reports") ? [`Laporan kerja: prompt ${PROMPT_REPORT} atau resource ${RESOURCE_RECIPE_URI}: studio_report_template -> studio_report_check -> studio_report_submit -> studio_report_update (basis diingat sesi).`] : []),
    ...(on("documents")
      ? [`Dokumen klien: prompt ${PROMPT_DOCUMENT} atau resource ${RESOURCE_DOC_RECIPE_URI}: studio_templates_list -> studio_template_get -> studio_document_create -> studio_chapter_import_markdown -> studio_slot_fill -> studio_document_status -> studio_render -> studio_file_verify. Bab/slot/figur ke dokumen yang sudah ada wajib baseRevisionNo (atau basis diingat sesi). Grafik/diagram: studio_figure_preview -> studio_figure_revise.`]
      : []),
    ...(on("query") ? ["Cari/baca: studio_contracts_query, studio_search, studio_document_get."] : []),
    ...(on("write") ? ["Tulis: studio_write { mission, docKey, sections } (isi saja; mesin memformat, cek, render) -> studio_edit { documentId, edits } (cari-ganti, tanpa basis) -> studio_file_verify."] : []),
    "Rahasia dipegang server; jangan menulisnya di argumen. Hasil ringkas bawaan (detail=true penuh) membawa correlationIds; galat membawa code dan correlationId.",
    `Isi dari Studio dibungkus <data-tak-tepercaya> dan ditandai untrusted: true. ${UNTRUSTED_NOTICE}`,
    "Berkas hanya ditulis bila STUDIO_MCP_FILE_ROOTS diisi; berkas yang ada tidak ditimpa kecuali overwrite=true (cadangan dibuat dulu).",
  ].join(" ");
}

/** Bangun server MCP (belum tersambung transport). */
export function createStudioMcpServer(deps: ServerDeps): Server {
  const { config } = deps;
  const secret = config.secret;
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const emit = (rec: Record<string, unknown>) => log(redactSecret(JSON.stringify({ ts: new Date().toISOString(), source: "studio-mcp", ...rec }), secret));
  // C2: satu sesi (memori basis per dokumen) per server = per proses stdio.
  const toolDeps = { config, fetchImpl: deps.fetchImpl ?? (globalThis.fetch as unknown as HttpFetch), nfs: deps.nfs ?? REAL_NODE_FS, session: new McpSession(), ...(deps.now ? { now: deps.now } : {}) };
  const repoRoot = deps.repoRoot ?? REPO_ROOT;

  // MCP-D1: hanya alat toolset aktif yang terdaftar dan dapat dipanggil.
  const toolsets = config.toolsets;
  const active = TOOLS.filter((t) => t.toolsets.some((ts) => toolsets.includes(ts)));
  const reportsOn = toolsets.includes("reports");
  const documentsOn = toolsets.includes("documents");

  const server = new Server({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION, title: "Studio GSP" }, { capabilities: { tools: {}, prompts: {}, resources: {} }, instructions: instructionsFor(toolsets) });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    // title hanya di tingkat atas (tidak diulang di annotations) agar tools/list lebih kecil.
    tools: active.map((t) => {
      const { title, ...hints } = t.annotations;
      return { name: t.name, title, description: t.description, inputSchema: t.inputSchema, annotations: hints };
    }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const name = req.params.name;
    if (!active.some((t) => t.name === name)) {
      const known = TOOLS.find((t) => t.name === name);
      throw new McpError(ErrorCode.InvalidParams, known ? `alat ${name} tidak aktif (STUDIO_MCP_TOOLSETS=${toolsets.join(",")}; alat ini di toolset ${known.toolsets.join("/")})` : `alat tidak dikenal: ${name}`);
    }
    const callId = newCallId();
    const t0 = Date.now();
    const fsLog = { writes: [] as string[] };
    let env;
    try {
      env = await executeTool(name, req.params.arguments ?? {}, toolDeps, callId, fsLog);
    } catch (e) {
      // executeTool hanya melempar untuk alat tak dikenal (sudah dicek di atas).
      const msg = e instanceof McpToolError ? e.message : "galat internal";
      emit({ level: "error", event: "tool_call", tool: name, mcpCallId: callId, ok: false, code: "INTERNAL_ERROR" });
      throw new McpError(ErrorCode.InternalError, redactSecret(msg, secret));
    }
    emit({
      level: env.ok ? "info" : "error",
      event: "tool_call",
      tool: name,
      mcpCallId: callId,
      ok: env.ok,
      durationMs: Date.now() - t0,
      ...(env.error ? { code: env.error.code, correlationId: env.error.correlationId, httpStatus: env.error.httpStatus } : {}),
      ...(Array.isArray(env.data.correlationIds) && env.data.correlationIds.length > 0 ? { correlationIds: env.data.correlationIds } : {}),
      ...(env.internalDetail !== undefined ? { internalDetail: env.internalDetail } : {}),
      ...(fsLog.writes.length > 0 ? { fileWrites: fsLog.writes } : {}),
    });
    const structured = JSON.parse(redactSecret(JSON.stringify(env.data), secret)) as Record<string, unknown>;
    return { content: [{ type: "text", text: redactSecret(env.text, secret) }], structuredContent: structured, ...(env.ok || env.genuineFailure !== true ? {} : { isError: true }) };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      ...(documentsOn ? [{ uri: RESOURCE_DOC_RECIPE_URI, name: "resep-dokumen-klien", title: "Resep dokumen klien lewat MCP", description: "Urutan alat dokumen klien, payload slot, Markdown md/v1, revisi, render.", mimeType: "text/markdown" }] : []),
      ...(reportsOn
        ? [
      { uri: RESOURCE_RECIPE_URI, name: "resep-laporan-kerja", title: "Resep laporan kerja lewat MCP", description: "Urutan alat dan aturan laporan kerja MD-native (padanan panduan §17.0).", mimeType: "text/markdown" },
      { uri: RESOURCE_TEMPLATE_URI, name: "templat-laporan-kerja", title: "Templat laporan kerja", description: "Templat MD dari registri (target contoh; ganti mission/docKey).", mimeType: "text/markdown" },
      { uri: RESOURCE_GUIDE_URI, name: "panduan-17-0", title: "Panduan agen §17.0 (asli)", description: "Seksi §17.0 STUDIO-AGENT-GUIDE (memakai perintah CLI; padanan MCP di resep).", mimeType: "text/markdown" },
          ]
        : []),
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    let text: string | null = null;
    if (documentsOn && uri === RESOURCE_DOC_RECIPE_URI) text = MCP_DOC_RECIPE;
    else if (reportsOn && uri === RESOURCE_RECIPE_URI) text = MCP_RECIPE;
    else if (reportsOn && uri === RESOURCE_TEMPLATE_URI) text = templateText(null, null);
    else if (reportsOn && uri === RESOURCE_GUIDE_URI) text = guideSection170(repoRoot) ?? "Panduan tidak ditemukan di repo.";
    if (text === null) throw new McpError(ErrorCode.InvalidParams, `resource tidak dikenal: ${uri}`);
    return { contents: [{ uri, mimeType: "text/markdown", text }] };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      ...(documentsOn
        ? [
            {
              name: PROMPT_DOCUMENT,
              title: "Tulis dokumen klien Studio",
              description: "Resep dokumen klien (templat -> dokumen -> bab Markdown -> slot -> status -> render).",
              arguments: [
                { name: "mission", description: "Folder misi, mis. 2026-11-02_misi", required: false },
                { name: "docKey", description: "Kunci dokumen dalam misi", required: false },
                { name: "template", description: "Slug templat, mis. datum-gsp", required: false },
              ],
            },
          ]
        : []),
      ...(reportsOn
        ? [
      {
        name: PROMPT_REPORT,
        title: "Tulis dan kirim laporan kerja Studio",
        description: "Resep + templat laporan kerja untuk misi dan docKey Anda.",
        arguments: [
          { name: "mission", description: "Folder misi, mis. 2026-11-01_mcp01", required: false },
          { name: "docKey", description: "Kunci dokumen unik, mis. lapkerja-mcp01-a", required: false },
        ],
      },
          ]
        : []),
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const a = req.params.arguments ?? {};
    if (documentsOn && req.params.name === PROMPT_DOCUMENT) {
      const arg = (k: string) => (typeof a[k] === "string" && a[k].trim() !== "" ? a[k].trim() : null);
      const target = [arg("mission") ? `mission: ${arg("mission")}` : null, arg("docKey") ? `docKey: ${arg("docKey")}` : null, arg("template") ? `template: ${arg("template")}` : null].filter(Boolean).join(", ");
      return {
        description: "Resep dokumen klien Studio lewat MCP",
        messages: [{ role: "user", content: { type: "text", text: `${MCP_DOC_RECIPE}${target ? `\n\n## Target\n\n${target}` : ""}` } }],
      };
    }
    if (!reportsOn || req.params.name !== PROMPT_REPORT) throw new McpError(ErrorCode.InvalidParams, `prompt tidak dikenal: ${req.params.name}`);
    const mission = typeof a.mission === "string" && a.mission.trim() !== "" ? a.mission.trim() : null;
    const docKey = typeof a.docKey === "string" && a.docKey.trim() !== "" ? a.docKey.trim() : null;
    let template: string;
    try {
      template = templateText(mission, docKey);
    } catch (e) {
      throw new McpError(ErrorCode.InvalidParams, e instanceof Error ? e.message : String(e));
    }
    return {
      description: "Resep laporan kerja Studio lewat MCP dengan templat siap diisi",
      messages: [{ role: "user", content: { type: "text", text: `${MCP_RECIPE}\n\n## Templat\n\n${template}` } }],
    };
  });

  return server;
}

/** Entri stdio. */
export async function main(): Promise<void> {
  let config: StudioMcpConfig;
  try {
    config = loadConfig(process.env, process.cwd());
  } catch (e) {
    // L-7: disensor walau konfigurasi gagal dimuat (rahasia mentah dari env).
    process.stderr.write(`${redactSecret(JSON.stringify({ ts: new Date().toISOString(), source: "studio-mcp", level: "error", event: "config_invalid", message: e instanceof Error ? e.message : String(e) }), process.env.INTERNAL_API_SECRET ?? "")}\n`);
    process.exitCode = 2;
    return;
  }
  const server = createStudioMcpServer({ config });
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_MESSAGE_BYTES });
  await server.connect(transport);
  process.stderr.write(`${redactSecret(JSON.stringify({ ts: new Date().toISOString(), source: "studio-mcp", level: "info", event: "started", version: MCP_SERVER_VERSION, config: describeConfig(config) }), config.secret)}\n`);
  if (config.secret === "") {
    // P-3: rahasia kosong / rujukan `${...}` tak terisi terlihat saat start, bukan baru sebagai 401.
    process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), source: "studio-mcp", level: "warn", event: "secret_missing", code: "SECRET_MISSING", secretIssue: config.secretIssue, message: "alat ber-server menjawab SECRET_MISSING sampai INTERNAL_API_SECRET berisi nilai nyata" })}\n`);
  }
}

// Swarm patch (row 107, row 11 M5): the direct-run entry guard block is removed so that
// main() can never run as a side effect of loading this module inside the host bundle. The host
// calls main()/createStudioMcpServer explicitly.
