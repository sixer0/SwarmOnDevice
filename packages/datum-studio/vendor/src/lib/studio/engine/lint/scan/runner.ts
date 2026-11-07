/**
 * Runner lint (S44): menyatukan LintIssue dari semua modul lint menjadi
 * LintReport dengan status per cek (PASS / FAIL / NOT_RUN / REPORT), banner
 * jujur, dan status rilis per tier (P16-01 `gate.lintFailureBlocksRelease`).
 *
 * Prinsip (A10): lint tidak pernah menahan berkas; runner hanya menetapkan
 * status rilis. Port perilaku `run()`/`print_report()` datum_lint.py: cek yang
 * tidak dijalankan tercetak NOT-RUN dengan pemiliknya, bukan PASS; vonis FAIL
 * bila ada FAIL di antara cek yang dijalankan.
 *
 * Dipakai modul lint lain (render S45, structure S46, language S47) dan
 * orkestrator (S51) lewat `assembleLintReport`, tanpa mengubah kontrak.
 */
import type { LintCheckStatus, LintDef, LintIssue, LintReport, ParamMap, StudioTier } from "../../../contract";
import { LINT_REGISTRY } from "../../../registry/lint";
import { paramBool } from "./checks";

export type LintModule = LintDef["module"];
export type LintStage = "ingest" | "post";
type Tier = LintReport["tier"];

const REGISTRY_INDEX: ReadonlyMap<string, number> = new Map(LINT_REGISTRY.map((d, i) => [d.id, i]));
const REGISTRY_BY_ID: ReadonlyMap<string, LintDef> = new Map(LINT_REGISTRY.map((d) => [d.id, d]));

const TIERS: ReadonlySet<string> = new Set(["NOTA", "TERBIT", "SERAH"]);

export function asTier(t: StudioTier | string): Tier {
  return (TIERS.has(t) ? t : "NOTA") as Tier;
}

/** Status agregat satu cek: FAIL > REPORT > PASS > NOT_RUN. */
export function aggregateStatus(list: readonly LintIssue[]): LintCheckStatus {
  if (list.some((i) => i.status === "FAIL")) return "FAIL";
  if (list.some((i) => i.status === "REPORT")) return "REPORT";
  if (list.some((i) => i.status === "PASS")) return "PASS";
  return "NOT_RUN";
}

/** Cek berlaku untuk tier bila terdaftar untuk tier itu; ID tak terdaftar selalu berlaku. */
export function appliesToTier(checkId: string, tier: Tier): boolean {
  const def = REGISTRY_BY_ID.get(checkId);
  return !def || def.tiers.includes(tier);
}

/**
 * Ringkas daftar per cek: FAIL/REPORT dipertahankan semua (beralamat); bila
 * tidak ada, satu PASS (detail = jumlah unit yang lolos) atau satu NOT_RUN.
 * Urutan: urutan registri, lalu ID tak terdaftar menurut abjad; di dalam satu
 * cek urutan masuk (urutan dokumen) dipertahankan.
 */
export function collapseIssues(issues: readonly LintIssue[]): LintIssue[] {
  const groups = new Map<string, LintIssue[]>();
  for (const i of issues) {
    const g = groups.get(i.checkId);
    if (g) g.push(i);
    else groups.set(i.checkId, [i]);
  }
  const ids = [...groups.keys()].sort((a, b) => {
    const ia = REGISTRY_INDEX.get(a) ?? Number.MAX_SAFE_INTEGER;
    const ib = REGISTRY_INDEX.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ia !== ib ? ia - ib : a < b ? -1 : a > b ? 1 : 0;
  });
  const out: LintIssue[] = [];
  for (const id of ids) {
    const g = groups.get(id) ?? [];
    const bad = g.filter((i) => i.status === "FAIL" || i.status === "REPORT");
    if (bad.length > 0) {
      out.push(...bad);
      continue;
    }
    const pass = g.filter((i) => i.status === "PASS");
    if (pass.length > 0) {
      const detail = pass.length === 1 ? pass[0].detail : `${pass.length} unit lolos`;
      out.push({ checkId: id, status: "PASS", ...(detail ? { detail } : {}) });
      continue;
    }
    const nr = g[0];
    out.push({ checkId: id, status: "NOT_RUN", ...(nr.detail ? { detail: nr.detail } : {}) });
  }
  return out;
}

/** Alasan NOT_RUN baku per modul bila modul tidak melapor sebuah cek. */
export function notRunReasonFor(def: LintDef, stage: LintStage, moduleError?: string): string {
  if (def.notRunReason) return def.notRunReason;
  if (def.module === "human") return "pemeriksaan manusia (Tabel 16.2 langkah 7-9); tidak dijalankan mesin";
  if (def.module === "render" && stage === "ingest") return "tahap ingest: lint pasca-render (engine/lint/render) belum dijalankan";
  if (moduleError) return `modul engine/lint/${def.module} tidak dijalankan: ${moduleError}`;
  return `modul engine/lint/${def.module} tidak melapor cek ini`;
}

export interface AssembleInput {
  tier: StudioTier | string;
  stage: LintStage;
  /** Semua LintIssue yang dihasilkan modul (boleh berulang per cek). */
  issues: readonly LintIssue[];
  params: ParamMap;
  /** Modul yang hasilnya akan ditambahkan pemanggil (cek-nya tidak diisi NOT_RUN). */
  external?: readonly LintModule[];
  /** Galat per modul (mis. StudioNotImplemented) untuk alasan NOT_RUN. */
  moduleErrors?: Partial<Record<LintModule, string>>;
}

function countStatuses(statuses: readonly LintCheckStatus[]): Record<LintCheckStatus, number> {
  const n: Record<LintCheckStatus, number> = { PASS: 0, FAIL: 0, NOT_RUN: 0, REPORT: 0 };
  for (const s of statuses) n[s]++;
  return n;
}

/**
 * Status rilis per tier (P16-01): FAIL bila ada cek berlaku yang FAIL dan
 * `gate.lintFailureBlocksRelease` true; PASS bila ada cek berlaku yang
 * dijalankan (PASS/REPORT, atau FAIL saat P16-01 false); selain itu NOT_RUN.
 *
 * `faultedModules` (F-058): modul lint yang crash dan memiliki cek berlaku
 * untuk tier ini. Bila tidak kosong, status rilis tidak pernah PASS: cek modul
 * itu tidak dinilai, jadi PASS akan palsu (KT-13). FAIL tetap FAIL (temuan
 * nyata dari modul lain); selain itu NOT_RUN.
 */
export function releaseStatusFor(
  perCheck: ReadonlyMap<string, LintCheckStatus>,
  tier: Tier,
  params: ParamMap,
  faultedModules: readonly LintModule[] = [],
): LintReport["releaseStatus"] {
  const blocks = paramBool(params, "gate.lintFailureBlocksRelease", true);
  let ran = false;
  for (const [id, st] of perCheck) {
    if (!appliesToTier(id, tier)) continue;
    if (st === "FAIL" && blocks) return "FAIL";
    if (st !== "NOT_RUN") ran = true;
  }
  if (faultedModules.length > 0) return "NOT_RUN";
  return ran ? "PASS" : "NOT_RUN";
}

/**
 * Modul yang crash (`moduleErrors`) dan punya cek terdaftar yang berlaku untuk
 * tier serta tidak dilaporkan modul/pemanggil lain. Urut registri, unik.
 */
export function faultedModulesFor(
  moduleErrors: AssembleInput["moduleErrors"],
  tier: Tier,
  reported: ReadonlySet<string>,
  external: ReadonlySet<LintModule>,
): LintModule[] {
  const out: LintModule[] = [];
  if (!moduleErrors) return out;
  for (const def of LINT_REGISTRY) {
    const m = def.module;
    if (out.includes(m) || !moduleErrors[m] || external.has(m) || reported.has(def.id)) continue;
    if (def.tiers.includes(tier)) out.push(m);
  }
  return out;
}

/** Rakit LintReport dari isu mentah semua modul. Tidak melempar. */
export function assembleLintReport(i: AssembleInput): LintReport {
  const tier = asTier(i.tier);
  const external = new Set<LintModule>(i.external ?? []);
  const reported = new Set(i.issues.map((x) => x.checkId));
  const filled: LintIssue[] = [...i.issues];
  let externalCount = 0;
  for (const def of LINT_REGISTRY) {
    if (reported.has(def.id)) continue;
    if (external.has(def.module)) {
      externalCount++;
      continue;
    }
    filled.push({ checkId: def.id, status: "NOT_RUN", detail: notRunReasonFor(def, i.stage, i.moduleErrors?.[def.module]) });
  }
  const checks = collapseIssues(filled);

  const perCheck = new Map<string, LintCheckStatus>();
  {
    const groups = new Map<string, LintIssue[]>();
    for (const c of checks) groups.set(c.checkId, [...(groups.get(c.checkId) ?? []), c]);
    for (const [id, g] of groups) perCheck.set(id, aggregateStatus(g));
  }
  const faulted = faultedModulesFor(i.moduleErrors, tier, reported, external);
  const releaseStatus = releaseStatusFor(perCheck, tier, i.params, faulted);

  const all = countStatuses([...perCheck.values()]);
  const applicable = [...perCheck].filter(([id]) => appliesToTier(id, tier));
  const app = countStatuses(applicable.map(([, s]) => s));
  const blocks = paramBool(i.params, "gate.lintFailureBlocksRelease", true);
  const parts = [
    `Lint ${tier} tahap ${i.stage}: dijalankan ${all.PASS + all.FAIL + all.REPORT} cek (PASS ${all.PASS}, FAIL ${all.FAIL}, REPORT ${all.REPORT}); NOT-RUN ${all.NOT_RUN} (alasan per cek)`,
    `berlaku tier ${tier}: ${applicable.length} cek (FAIL ${app.FAIL}, NOT-RUN ${app.NOT_RUN})`,
  ];
  if (externalCount > 0) parts.push(`${externalCount} cek modul ${[...external].join("/")} ditambahkan pemanggil`);
  if (applicable.length === 0) parts.push(`lint tidak diwajibkan pada tier ${tier} (P3-08)`);
  if (!blocks && app.FAIL > 0) parts.push(`${app.FAIL} cek FAIL tidak menahan rilis (P16-01 false)`);
  if (faulted.length > 0) {
    const what = faulted.map((m) => `${m} (${i.moduleErrors?.[m] ?? "galat"})`).join(", ");
    parts.push(`CACAT INSTRUMEN: modul engine/lint ${what} gagal; cek berlaku modul itu tidak dinilai, status rilis tidak boleh PASS`);
  }
  parts.push(`status rilis ${tier}: ${releaseStatus}`);
  parts.push("berkas tidak ditahan (A10)");
  return { tier, checks, releaseStatus, banner: parts.join("; ") };
}
