/**
 * Swarm 1.3.3 row 50 (ST-4; register 03 sections 2, 6 and 7; contract row 26): pairs of off-page connectors are
 * checked across the figures of a document when it is rendered, and their labels are made by the engine.
 *
 * Rule. A node with `shape: "offpage"` in the diagram block A must carry `ref {figure: B, key: K}`, where B is the
 * block id (pid) of another diagram block of the same document that has a number, and B must hold exactly one
 * `offpage` node with `ref {figure: A, key: K}`. Anything else is refused with `OFFPAGE_UNPAIRED`, and the text names
 * both figures and the key. An `offpage` node without `ref` is refused as well (the message shows the `ref` to add):
 * two figures whose connector labels are free text cannot be checked, and that is the case the rule exists for.
 *
 * Label. The label of both ends is written here, from the real figure numbers (`snapshot.numbering`), never from text
 * in the spec: `ke Gambar 2.2 · K` on the end the flow leaves through and `dari Gambar 2.1 · K` on the end it arrives
 * at (EN documents: `to Figure 2.2 · K` / `from Figure 2.1 · K`). An authored label is replaced and noted. A figure
 * that is renumbered therefore changes the printed label without any edit of the spec.
 *
 * Only contract types are imported, so the check can also be called from a lint module (`offpagePairIssues`).
 * A stand-alone preview of one figure cannot see the twin: it reports `offpagePreviewNotRun(spec)`, never a pass.
 */
import type { LintIssue, NormBlock, NormDocSnapshot, RenderScope, StudioDiagramV1 } from "../../contract";

/** Lint registry id (register 03 section 7) and `checkId` of the render finding. */
export const OFFPAGE_UNPAIRED = "OFFPAGE_UNPAIRED";

/** Reason text of a check that only a document render can run (register 03 section 6, `notRun` of the preview). */
export const OFFPAGE_PREVIEW_NOT_RUN_REASON = "belum diperiksa: hanya saat render";

/** `notRun` entry of the preview reply (row 65), in the shape of `LintReport.notRun`. */
export interface OffpagePreviewNotRun {
  id: typeof OFFPAGE_UNPAIRED;
  kind: "rule";
  reason: string;
}

export type OffpageRefusalCause =
  | "ref-missing"
  | "ref-on-other-shape"
  | "figure-self"
  | "figure-missing"
  | "figure-not-diagram"
  | "figure-unnumbered"
  | "twin-missing"
  | "key-mismatch"
  | "twin-duplicate";

export interface OffpageRefusal {
  cause: OffpageRefusalCause;
  /** Block id of the figure that holds the node. */
  blockId: string;
  /** Printed number of that figure, or its block id when it has none. */
  figure: string;
  node: string;
  /** `ref.figure` as written (block id of the other figure), when the node has a `ref`. */
  otherBlockId?: string;
  /** Printed number of the other figure, when it resolves. */
  otherFigure?: string;
  key?: string;
  address?: string;
  /** Reader text; starts with the code. */
  message: string;
}

export interface OffpageLabelNote {
  blockId: string;
  figure: string;
  node: string;
  key: string;
  authored: string;
  generated: string;
}

export interface OffpageCheck {
  /** The snapshot with generated labels on inline specs (the same object when nothing changed). */
  snapshot: NormDocSnapshot;
  /** Generated-label specs of blocks that refer to an artefact, by the block's `content.spec` object. */
  artifactSpecs: WeakMap<object, StudioDiagramV1>;
  refusals: OffpageRefusal[];
  /** One entry per node whose authored label differed from the generated one. */
  notes: OffpageLabelNote[];
  /** Lint rows: FAIL per refusal; else PASS once when pairs exist; NOT_RUN per end whose twin is outside the scope. */
  checks: LintIssue[];
  /** Number of complete pairs. */
  pairs: number;
  /** Ends whose twin is outside the rendered scope (chapter or slot draft). */
  unchecked: number;
}

export interface OffpageCheckOptions {
  /** Specs of diagram blocks that refer to an artefact, by block id (resolved by the caller). */
  specs?: ReadonlyMap<string, StudioDiagramV1>;
  /** Rendered scope; absent = whole document. In a chapter or slot draft a twin outside the scope is not refused. */
  scope?: RenderScope;
}

interface OffpageRefLike {
  figure: string;
  key: string;
}

interface Fig {
  block: NormBlock;
  spec: StudioDiagramV1;
  inline: boolean;
  order: number;
}

interface End {
  fig: Fig;
  nodeIndex: number;
  nodeId: string;
  ref: OffpageRefLike;
  /** true = the flow arrives here from the other figure (the node only has outgoing connectors). */
  entry: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function refOf(node: unknown): OffpageRefLike | undefined {
  if (!isRecord(node) || !isRecord(node.ref)) return undefined;
  const { figure, key } = node.ref;
  return typeof figure === "string" && figure !== "" && typeof key === "string" && key !== "" ? { figure, key } : undefined;
}

function nodesOf(spec: StudioDiagramV1): Array<Record<string, unknown>> {
  const nodes = (spec as { nodes?: unknown }).nodes;
  return Array.isArray(nodes) ? nodes.filter(isRecord) : [];
}

function isOffpage(node: Record<string, unknown>): boolean {
  return node.shape === "offpage";
}

function inlineSpecOf(block: NormBlock): StudioDiagramV1 | undefined {
  const c = isRecord(block.content) ? block.content : undefined;
  const spec = c?.spec;
  if (!isRecord(spec)) return undefined;
  if (typeof spec.artifactId === "string" && !("$schema" in spec)) return undefined;
  return spec as unknown as StudioDiagramV1;
}

/** An `offpage` node with only outgoing connectors is where the flow comes in; every other node is an exit. */
function isEntry(spec: StudioDiagramV1, nodeId: string): boolean {
  const edges = (spec as { edges?: unknown }).edges;
  let incoming = 0;
  let outgoing = 0;
  for (const e of Array.isArray(edges) ? edges : []) {
    if (!isRecord(e)) continue;
    if (e.to === nodeId) incoming++;
    if (e.from === nodeId) outgoing++;
  }
  return outgoing > 0 && incoming === 0;
}

const WORDS = {
  ID: { to: "ke", from: "dari", figure: "Gambar" },
  EN: { to: "to", from: "from", figure: "Figure" },
} as const;

/**
 * The printed label of one end: direction word, the other figure's number as the document prints it, and the pair
 * key. `number` is the entry of `snapshot.numbering` ("Gambar 2.2"); an EN document prints "Figure 2.2".
 */
export function offpageLabel(direction: "to" | "from", number: string, key: string, lang: "ID" | "EN" = "ID"): string {
  const w = WORDS[lang];
  const printed = lang === "EN" && number.startsWith(`${WORDS.ID.figure} `) ? `${w.figure} ${number.slice(WORDS.ID.figure.length + 1)}` : number;
  return `${w[direction]} ${printed} · ${key}`;
}

/** The `ref` a ref-less node needs, as text for the refusal. */
function refHint(blockId: string): string {
  return `tambahkan "ref": {"figure": "<id blok diagram pasangan>", "key": "<kunci sambungan>"} pada simpul ini, dan di gambar pasangan satu simpul offpage dengan "ref": {"figure": "${blockId}", "key": "<kunci yang sama>"}`;
}

/**
 * The check and the generated labels, pure and synchronous. Never throws: a block whose spec cannot be read is left
 * to the figure build, and a `ref` that points at it is refused as `figure-missing`.
 */
export function checkOffpagePairs(snapshot: NormDocSnapshot, opts: OffpageCheckOptions = {}): OffpageCheck {
  const artifactSpecs = new WeakMap<object, StudioDiagramV1>();
  const blocks: readonly NormBlock[] = Array.isArray(snapshot?.blocks) ? snapshot.blocks : [];
  const numbering: Record<string, string> = isRecord(snapshot?.numbering) ? (snapshot.numbering as Record<string, string>) : {};
  const lang: "ID" | "EN" = (snapshot?.doc as { meta?: { language?: unknown } } | undefined)?.meta?.language === "EN" ? "EN" : "ID";
  const wholeDocument = (opts.scope?.kind ?? "DOCUMENT") === "DOCUMENT";

  const figs = new Map<string, Fig>();
  const typeOf = new Map<string, string>();
  blocks.forEach((block, order) => {
    typeOf.set(block.blockId, block.type);
    if (block.type !== "diagram") return;
    const inline = inlineSpecOf(block);
    const spec = inline ?? opts.specs?.get(block.blockId);
    if (spec && isRecord(spec)) figs.set(block.blockId, { block, spec, inline: inline !== undefined, order });
  });

  const refusals: OffpageRefusal[] = [];
  const nameOf = (blockId: string): string => {
    const n = numbering[blockId];
    return n ? `${n} (blok ${blockId})` : `blok ${blockId}`;
  };
  const refuse = (cause: OffpageRefusalCause, fig: Fig, node: string, text: string, ref?: OffpageRefLike): void => {
    const r: OffpageRefusal = {
      cause,
      blockId: fig.block.blockId,
      figure: numbering[fig.block.blockId] ?? fig.block.blockId,
      node,
      message: `${OFFPAGE_UNPAIRED}: ${nameOf(fig.block.blockId)}, simpul "${node}"${ref ? ` ref {figure: "${ref.figure}", key: "${ref.key}"}` : ""}: ${text}`,
    };
    if (ref) {
      r.otherBlockId = ref.figure;
      r.key = ref.key;
      if (numbering[ref.figure]) r.otherFigure = numbering[ref.figure];
    }
    if (fig.block.address) r.address = fig.block.address;
    refusals.push(r);
  };

  // 1. Collect the ends; refuse what can be judged inside one figure.
  const ends: End[] = [];
  for (const fig of figs.values()) {
    nodesOf(fig.spec).forEach((node, nodeIndex) => {
      const nodeId = typeof node.id === "string" ? node.id : `#${nodeIndex + 1}`;
      const ref = refOf(node);
      if (!isOffpage(node)) {
        if (node.ref !== undefined) refuse("ref-on-other-shape", fig, nodeId, `ref hanya berlaku pada simpul shape "offpage"; hapus ref atau ubah shape`, ref);
        return;
      }
      if (!ref) {
        refuse("ref-missing", fig, nodeId, `penghubung luar-halaman tanpa ref tidak dapat dipasangkan; ${refHint(fig.block.blockId)}`);
        return;
      }
      ends.push({ fig, nodeIndex, nodeId, ref, entry: isEntry(fig.spec, nodeId) });
    });
  }

  const endsAt = (blockId: string, toBlockId: string): End[] => ends.filter((e) => e.fig.block.blockId === blockId && e.ref.figure === toBlockId);

  // 2. Pair every end with its twin.
  const labels = new Map<End, string>();
  const checks: LintIssue[] = [];
  let unchecked = 0;
  let pairedEnds = 0;
  for (const end of ends) {
    const own = end.fig.block.blockId;
    const { figure: other, key } = end.ref;
    const mirror = `ref {figure: "${own}", key: "${key}"}`;
    if (other === own) {
      refuse("figure-self", end.fig, end.nodeId, `ref.figure menunjuk gambar ini sendiri; isi id blok diagram pasangan`, end.ref);
      continue;
    }
    const target = figs.get(other);
    if (!target) {
      const type = typeOf.get(other);
      if (type !== undefined && type !== "diagram") {
        refuse("figure-not-diagram", end.fig, end.nodeId, `blok "${other}" adalah ${type}, bukan diagram; ref.figure harus id blok diagram yang memuat simpul offpage dengan ${mirror}`, end.ref);
      } else if (type === undefined && !wholeDocument && numbering[other]) {
        // A chapter or slot draft: the twin's figure exists in the document (it has a number) but is not rendered.
        unchecked++;
        labels.set(end, offpageLabel(end.entry ? "from" : "to", numbering[other], key, lang));
        checks.push({
          checkId: OFFPAGE_UNPAIRED,
          status: "NOT_RUN",
          detail: `belum diperiksa: ${nameOf(other)} di luar lingkup render; pasangan kunci "${key}" dari ${nameOf(own)} diperiksa saat render dokumen utuh`,
          ...(end.fig.block.address ? { address: end.fig.block.address } : {}),
        });
      } else {
        refuse("figure-missing", end.fig, end.nodeId, `"${other}" bukan id blok diagram di dokumen ini (atau spec-nya tidak terbaca); ref.figure harus id blok diagram yang memuat simpul offpage dengan ${mirror}`, end.ref);
      }
      continue;
    }
    if (!numbering[own] || !numbering[other]) {
      const bare = !numbering[own] ? own : other;
      refuse("figure-unnumbered", end.fig, end.nodeId, `blok "${bare}" tidak bernomor (tanpa caption), jadi label "Gambar <nomor>" tidak dapat dibuat; beri caption pada kedua gambar`, end.ref);
      continue;
    }
    const back = endsAt(other, own);
    const twins = back.filter((e) => e.ref.key === key);
    const siblings = endsAt(own, other).filter((e) => e.ref.key === key);
    if (twins.length === 0) {
      const keys = [...new Set(back.map((e) => `"${e.ref.key}"`))];
      if (keys.length > 0) {
        refuse("key-mismatch", end.fig, end.nodeId, `${nameOf(other)} tidak punya simpul offpage dengan ${mirror}; kunci yang ada di sana untuk gambar ini: ${keys.join(", ")}. Samakan key di kedua ujung`, end.ref);
      } else {
        refuse("twin-missing", end.fig, end.nodeId, `${nameOf(other)} tidak punya simpul offpage kembaran; tambahkan di sana satu simpul shape "offpage" dengan ${mirror}`, end.ref);
      }
      continue;
    }
    if (twins.length > 1 || siblings.length > 1) {
      const where = twins.length > 1 ? nameOf(other) : nameOf(own);
      refuse("twin-duplicate", end.fig, end.nodeId, `kunci "${key}" dipakai lebih dari satu simpul offpage di ${where} untuk pasangan gambar ini; satu kunci = tepat satu simpul di tiap gambar`, end.ref);
      continue;
    }
    // One end leaves, the other arrives. When the connectors of both ends read the same way, document order decides.
    const twin = twins[0];
    const entry = end.entry !== twin.entry ? end.entry : end.fig.order > twin.fig.order;
    labels.set(end, offpageLabel(entry ? "from" : "to", numbering[other], key, lang));
    pairedEnds++;
  }

  for (const r of refusals) checks.push({ checkId: OFFPAGE_UNPAIRED, status: "FAIL", detail: r.message, ...(r.address ? { address: r.address } : {}) });
  const pairs = Math.floor(pairedEnds / 2);
  if (refusals.length === 0 && pairs > 0) {
    checks.push({ checkId: OFFPAGE_UNPAIRED, status: "PASS", detail: `${pairs} pasang penghubung luar-halaman berpasangan; label dibangkitkan mesin dari nomor gambar` });
  }
  if (refusals.length > 0 || labels.size === 0) return { snapshot, artifactSpecs, refusals, notes: [], checks, pairs, unchecked };

  // 3. Write the generated labels on a copy (the stored snapshot and artefact specs are never written).
  const notes: OffpageLabelNote[] = [];
  const byFig = new Map<Fig, Map<number, End>>();
  for (const end of labels.keys()) {
    const m = byFig.get(end.fig) ?? new Map<number, End>();
    m.set(end.nodeIndex, end);
    byFig.set(end.fig, m);
  }
  const replaced = new Map<string, NormBlock>();
  for (const [fig, byIndex] of byFig) {
    let k = -1;
    const all = (fig.spec as { nodes?: unknown }).nodes as unknown[];
    const nodes = all.map((node) => {
      if (!isRecord(node)) return node;
      k++;
      const end = byIndex.get(k);
      if (!end) return node;
      const generated = labels.get(end) as string;
      const authored = typeof node.label === "string" ? node.label : "";
      if (authored !== generated) {
        notes.push({ blockId: fig.block.blockId, figure: numbering[fig.block.blockId] ?? fig.block.blockId, node: end.nodeId, key: end.ref.key, authored, generated });
      }
      return { ...node, label: generated };
    });
    const spec = { ...fig.spec, nodes } as unknown as StudioDiagramV1;
    const content = fig.block.content as Record<string, unknown>;
    if (fig.inline) replaced.set(fig.block.blockId, { ...fig.block, content: { ...content, spec } });
    else if (isRecord(content.spec)) artifactSpecs.set(content.spec, spec);
  }
  const out = replaced.size === 0 ? snapshot : { ...snapshot, blocks: blocks.map((b) => replaced.get(b.blockId) ?? b) };
  return { snapshot: out, artifactSpecs, refusals, notes, checks, pairs, unchecked };
}

/** Lint rows only (for a lint module that holds the whole snapshot; inline specs). */
export function offpagePairIssues(snapshot: NormDocSnapshot, opts: OffpageCheckOptions = {}): LintIssue[] {
  return checkOffpagePairs(snapshot, opts).checks;
}

/** The part of the artefact reader this module needs (`ArtifactSpecReader`, `InlineSpecReader`). */
export interface DiagramSpecSource {
  diagram(spec: unknown): Promise<StudioDiagramV1>;
}

export interface OffpagePairing<R extends DiagramSpecSource> extends OffpageCheck {
  /** The reader to build figures with: `reader` itself, or a view of it that returns the generated-label specs. */
  reader: R;
}

/**
 * The document render step: reads the specs of blocks that refer to an artefact through `reader` (a spec that cannot
 * be read is left to the figure build, which reports it), runs `checkOffpagePairs`, and returns the snapshot and the
 * reader to build the figures from.
 */
export async function pairOffpageConnectors<R extends DiagramSpecSource>(snapshot: NormDocSnapshot, reader: R, opts: Pick<OffpageCheckOptions, "scope"> = {}): Promise<OffpagePairing<R>> {
  const specs = new Map<string, StudioDiagramV1>();
  for (const block of Array.isArray(snapshot?.blocks) ? snapshot.blocks : []) {
    if (block.type !== "diagram" || inlineSpecOf(block) !== undefined) continue;
    const ref = isRecord(block.content) ? block.content.spec : undefined;
    if (!isRecord(ref) || typeof ref.artifactId !== "string") continue;
    try {
      specs.set(block.blockId, await reader.diagram(ref));
    } catch {
      // Reported by buildFigures for this block (ARTIFACT_NOT_FOUND / REGISTRY_KIND_UNKNOWN).
    }
  }
  const check = checkOffpagePairs(snapshot, { specs, scope: opts.scope });
  if (specs.size === 0 || check.refusals.length > 0) return { ...check, reader };
  const view = Object.create(reader) as R;
  view.diagram = async (spec: unknown): Promise<StudioDiagramV1> => (isRecord(spec) ? check.artifactSpecs.get(spec) : undefined) ?? reader.diagram(spec);
  return { ...check, reader: view };
}

/**
 * Stand-alone preview of one figure (row 65): the twin lives in another figure, so the pair is not checked there.
 * Returns the `notRun` entry when the spec holds an `offpage` node, else undefined. Never a pass.
 */
export function offpagePreviewNotRun(spec: unknown): OffpagePreviewNotRun | undefined {
  if (!isRecord(spec) || !Array.isArray(spec.nodes)) return undefined;
  return spec.nodes.some((n) => isRecord(n) && isOffpage(n)) ? { id: OFFPAGE_UNPAIRED, kind: "rule", reason: OFFPAGE_PREVIEW_NOT_RUN_REASON } : undefined;
}
