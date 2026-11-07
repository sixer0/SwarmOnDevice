/**
 * Swarm template sample and its render path (row 67; masterplan/01_specs_studio_templates.md §5.1 and
 * the U16 amendment U.1 step 3, U.3, U.4). Used by the template guard (`./guard`) and by the template
 * preview (`./preview`).
 *
 * - The sample is Studio's own `sampleDocumentV2` (3ebe486, ported verbatim, row 65 GO) plus the Swarm
 *   additions of U.3: a captioned data table of 5 columns by 4 body rows with a unit column, a SUMBER
 *   line and a numeric body; a paragraph with a provenance mark and a value with its unit; the
 *   identity paragraph (D17) and the closing-action paragraph (D18). Without them lint DATUM-09/10
 *   never fire, and Studio's plain sample fails D17, D18 and C-27 on every builtin (row 67 report).
 * - Row 65 L3: the sample is cloned per render (`structuredClone`), so the reference and the
 *   candidate never share objects, and its sha256 is recorded in the guard report.
 * - A render side = a frozen `ResolvedTemplate` + its skeleton. The sample goes through Studio's
 *   own ingest dry run with that template and skeleton (`ingestDocument(..., {dryRun, template,
 *   skeleton})`, the clone's draft-preview path: `app/api/studio/validate/_shared/dry-run.ts:247`), then
 *   through `renderSnapshot` (the `studio_render` engine and the same render bridge). Nothing is
 *   written to the store here.
 */
import type { ParamMap, ResolvedSlot, ResolvedTemplate, StudioCaller, StudioOutputFormat, StudioSkeletonV1, StudioTier } from "../../contract";
import { StudioEngineError } from "../../contract/errors";
import { previewLanguageOf, type PreviewLanguage } from "../../../../components/studio/template-preview/preview-language";
import { sampleDocumentV2 } from "../../../../components/studio/template-preview/sample-document-v2";
import type { SkeletonInput } from "../compose";
import { ingestDocument, type IngestResultV2 } from "../ingest";
import { renderSnapshot, type PureRenderResult } from "../render/pure";
import { getSkeleton, resolveSkeletonSlots } from "../skeleton";
import { resolvedBuiltinEditionAssets, resolveTemplate, resolveTemplateVersion } from "./index";
import { sha256Hex, stableStringify, type VersionPayload } from "./profile";

/** Version tag of the Swarm additions (bump on any content change; it is part of the sample sha). */
export const SWARM_SAMPLE_VERSION = "row67-1";

/** The local caller of guard and preview renders (C58: non-admin INTERNAL_AGENT, never class K). */
export const SAMPLE_RENDER_CALLER: StudioCaller = { kind: "INTERNAL_AGENT", requester: "swarm:template-guard", agentId: "template-guard", canWriteClassK: false };

// ── Swarm additions to the sample (U.3) ─────────────────────────────────

const t = (text: string) => ({ text });

interface SwarmAdditions {
  identity: string;
  dataLead: string;
  dataSource: string;
  table: Record<string, unknown>;
  method: string;
  closing: string;
}

const ADDITIONS: Readonly<Record<PreviewLanguage, SwarmAdditions>> = {
  ID: {
    identity:
      "Dokumen ini adalah standar kerja jenis KT yang disusun Divisi Engineering untuk tim penyusun templat, dengan jangkar terukur panjang saluran rencana 6.546,2 m.",
    dataLead:
      "Realisasi pemasangan sampai akhir September 2026 mencapai 6.212,4 m atau 94,9 persen dari rencana, dengan selisih terbesar di segmen timur karena izin galian terbit terlambat.",
    dataSource: "Laporan progres lapangan September 2026",
    table: {
      type: "table",
      columns: [{ role: "text" }, { role: "unit" }, { role: "numeral" }, { role: "numeral" }, { role: "numeral" }],
      rows: [
        { kind: "header", cells: [t("Segmen"), t("Satuan"), t("Rencana"), t("Realisasi"), t("Selisih")] },
        { cells: [t("Utara"), t("m"), t("2.100,0"), t("2.050,5"), t("49,5")] },
        { cells: [t("Selatan"), t("m"), t("1.900,0"), t("1.812,7"), t("87,3")] },
        { cells: [t("Timur"), t("m"), t("1.346,2"), t("1.149,2"), t("197,0")] },
        { cells: [t("Barat"), t("m"), t("1.200,0"), t("1.200,0"), t("0,0")] },
      ],
      caption: t("Rencana dan realisasi pemasangan saluran per segmen."),
      source: t("Laporan progres lapangan September 2026."),
    },
    method:
      "Urutan kerja disusun agar setiap segmen selesai diuji tekan sebelum segmen berikutnya digali, sehingga kebocoran dapat ditelusuri ke satu segmen dan tidak menunda serah terima seluruh saluran.",
    closing:
      "Tim penyusun templat diminta memeriksa pratinjau ini dan mengirim catatan perbaikan kepada Divisi Engineering paling lambat 15 Oktober 2026 melalui berita acara pemeriksaan templat yang ditandatangani pemeriksa.",
  },
  EN: {
    identity:
      "This document is a KT work standard prepared by the Engineering Division for the template authors, anchored on a planned pipeline length of 6,546.2 m.",
    dataLead:
      "By the end of September 2026 the installed length reached 6,212.4 m, which is 94.9 per cent of the plan, and the largest gap is in the east segment because the excavation permit came late.",
    dataSource: "Field progress report September 2026",
    table: {
      type: "table",
      columns: [{ role: "text" }, { role: "unit" }, { role: "numeral" }, { role: "numeral" }, { role: "numeral" }],
      rows: [
        { kind: "header", cells: [t("Segment"), t("Unit"), t("Plan"), t("Actual"), t("Gap")] },
        { cells: [t("North"), t("m"), t("2,100.0"), t("2,050.5"), t("49.5")] },
        { cells: [t("South"), t("m"), t("1,900.0"), t("1,812.7"), t("87.3")] },
        { cells: [t("East"), t("m"), t("1,346.2"), t("1,149.2"), t("197.0")] },
        { cells: [t("West"), t("m"), t("1,200.0"), t("1,200.0"), t("0.0")] },
      ],
      caption: t("Planned and installed pipeline length per segment."),
      source: t("Field progress report September 2026."),
    },
    method:
      "The work sequence makes sure that every segment passes its pressure test before the next segment is excavated, so that a leak can be traced to one segment and does not delay the handover of the whole pipeline.",
    closing:
      "The template authors are asked to check this preview and send their correction notes to the Engineering Division by 15 October 2026 through a signed template review record from the reviewer.",
  },
};

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function chaptersOf(sections: Json, sectionType: "chapter" | "appendix"): Json[] {
  for (const payload of Object.values(sections)) {
    if (isRecord(payload) && payload.type === sectionType && Array.isArray(payload.chapters)) return payload.chapters as Json[];
  }
  return [];
}

function firstBlocks(chapter: Json | undefined): unknown[] | null {
  const sections = chapter && Array.isArray(chapter.sections) ? (chapter.sections as Json[]) : [];
  const s = sections[0];
  return s && Array.isArray(s.blocks) ? (s.blocks as unknown[]) : null;
}

export interface SwarmSampleInput {
  /** Slug written in the sample (`template.slug`). The guard uses the reference slug on both sides. */
  slug: string;
  tier: StudioTier;
  slots: StudioSkeletonV1["slots"];
  language: PreviewLanguage;
}

/**
 * The Swarm sample `studio.doc/v2` for one skeleton: Studio's sample (slots outside the tier are
 * skipped, sample-document-v2.ts:298-301) plus the U.3 additions in the first and last chapter.
 * `meta.language` is set explicitly, so the reference and the candidate get the same document.
 */
export function swarmSampleDocument(input: SwarmSampleInput): Json {
  const doc = structuredClone(sampleDocumentV2({ slug: input.slug, tier: input.tier, slots: input.slots, language: input.language })) as Json;
  const add = ADDITIONS[input.language];
  (doc.meta as Json).language = input.language;
  const sections = isRecord(doc.sections) ? doc.sections : {};
  const chapters = chaptersOf(sections, "chapter");
  const first = chapters[0];
  if (first) {
    const intro = Array.isArray(first.intro) ? (first.intro as unknown[]) : [];
    first.intro = [{ type: "paragraph", text: add.identity, role: "identity" }, ...intro];
    const blocks = firstBlocks(first);
    if (blocks) {
      blocks.push(
        {
          type: "paragraph",
          text: add.dataLead,
          rail: [
            { kind: "mark", mark: "TERUKUR" },
            { kind: "source", text: add.dataSource },
          ],
        },
        structuredClone(add.table),
      );
    }
  }
  const last = chapters.at(-1);
  const lastBlocks = firstBlocks(last);
  if (lastBlocks) lastBlocks.push({ type: "paragraph", text: add.method }, { type: "paragraph", text: add.closing, role: "closingAction" });
  return doc;
}

/** sha256 of the canonical JSON of a sample (Row 65 L3; recorded as `sampleSha256`). */
export function sampleSha256(doc: unknown): string {
  return sha256Hex(stableStringify(doc));
}

/** Sample language of a template: its resolved `doc.language` (preview-language.ts:18), default ID. */
export function sampleLanguageOf(params: ParamMap): PreviewLanguage {
  return previewLanguageOf([], params["doc.language"]);
}

// ── Render sides ─────────────────────────────────────────────────────────

/** One render side: the frozen template, its skeleton and the per-slot values (U.1 step 3). */
export interface RenderSide {
  tpl: ResolvedTemplate;
  skeleton: SkeletonInput;
}

/** Side of a stored version (reference, or a stored version previewed): the same reads as `studio_render`. */
export async function sideFromVersion(versionId: string): Promise<RenderSide> {
  const tpl = await resolveTemplateVersion(versionId);
  const sk = await getSkeleton(versionId);
  return { tpl, skeleton: { templateVersionId: tpl.versionId, skeleton: sk.skeleton, skeletonSha256: sk.skeletonSha256, implicit: sk.implicit } };
}

/** Thrown when a side cannot be built (fail closed: the guard turns it into GUARD_UNAVAILABLE). */
export class SampleRenderError extends StudioEngineError {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super("RENDER_FAILED", message, { reason });
    this.name = "SampleRenderError";
  }
}

/**
 * Side of an unsaved candidate (row 66 `Candidate`): its folded payload and skeleton. The ids are the
 * `host` side's (the reference), so both renders differ only in template content. Assets come from the
 * builtin preset the definition names (`foldTemplateDefinition` copies the preset's assets), matched by
 * id and sha256; an unmatched asset fails closed.
 */
export async function sideFromCandidate(
  cand: { definition: { preset?: { slug: string; version?: number } }; payload: VersionPayload; skeleton: StudioSkeletonV1; skeletonSha256: string },
  host: ResolvedTemplate,
): Promise<RenderSide> {
  // Swarm patch (row 110e, C75): an asset matches by id and sha256 in the host, the preset or the shipped
  // edition assets (the fold gives a version the cover logo of its doc.language, so an EN copy hosted by an
  // ID preset carries the EN logo); earlier sources are not overwritten by later ones.
  const known: Array<Readonly<Record<string, ResolvedTemplate["assets"][string]>>> = [host.assets];
  if (cand.definition.preset) {
    const preset = await resolveTemplate(cand.definition.preset.slug, cand.definition.preset.version);
    known.push(preset.assets);
  }
  known.push(...resolvedBuiltinEditionAssets());
  const assets: Record<string, ResolvedTemplate["assets"][string]> = {};
  for (const [id, a] of Object.entries(cand.payload.assets ?? {})) {
    const k = known.map((m) => m[id]).find((x) => x !== undefined && x.sha256 === a.sha256);
    if (!k) throw new SampleRenderError("ASSET_UNRESOLVED", `template asset ${id} is not a shipped preset asset`);
    assets[id] = k;
  }
  const tpl: ResolvedTemplate = Object.freeze({
    templateId: host.templateId,
    versionId: host.versionId,
    versionNo: host.versionNo,
    params: Object.freeze({ ...cand.payload.resolvedParams }) as ParamMap,
    roleFormats: Object.freeze({ ...cand.payload.roleFormats }),
    sectionPlan: Object.freeze({ ...cand.payload.sectionPlan }),
    assets: Object.freeze(assets),
  });
  return { tpl, skeleton: { templateVersionId: host.versionId, skeleton: cand.skeleton, skeletonSha256: cand.skeletonSha256, implicit: false } };
}

/** Per-slot values for the render (fast path, the same resolution ingest applies to a given skeleton). */
export function slotsOf(side: RenderSide, tier: StudioTier): ReadonlyMap<string, ResolvedSlot> {
  return resolveSkeletonSlots({ params: side.tpl.params, roleFormats: side.tpl.roleFormats }, side.skeleton.skeleton.slots, undefined, { tier }).slots;
}

export interface SampleRenderOptions {
  tier: StudioTier;
  formats: readonly StudioOutputFormat[];
  /** Per-render job timeout (U.1 step 5: 60 s). */
  timeoutMs: number;
  correlationId: string;
  jobId?: string;
  measureLayout?: boolean;
}

export interface SampleRenderResult {
  ingest: IngestResultV2;
  /** null when the ingest dry run refused the sample (nothing rendered). */
  render: PureRenderResult | null;
}

/** Ingest dry run of a fresh clone of `doc` under the side's template, then the pure render. */
export async function renderSample(side: RenderSide, doc: Json, opts: SampleRenderOptions): Promise<SampleRenderResult> {
  const ingest = await ingestDocument(structuredClone(doc) as never, SAMPLE_RENDER_CALLER, {
    dryRun: true,
    template: side.tpl,
    skeleton: side.skeleton,
    correlationId: opts.correlationId,
  });
  if (!ingest.valid || !ingest.snapshot) return { ingest, render: null };
  const render = await renderSnapshot(ingest.snapshot, side.tpl, {
    formats: opts.formats,
    tier: opts.tier,
    slots: slotsOf(side, opts.tier),
    timeoutMs: opts.timeoutMs,
    ...(opts.jobId ? { jobId: opts.jobId } : {}),
    ...(opts.measureLayout === false ? { measureLayout: false } : {}),
  });
  return { ingest, render };
}
