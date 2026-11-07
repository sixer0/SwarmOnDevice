// Row 66 (template service, masterplan/01_specs_studio_templates.md §2-§4, C13, U16; decisions C54, C58):
// create (copy, from scratch), update (template, skeleton, changes), archive, under the form lock
// P1-P9 + §3.2 + §3.3, against a REAL temp DATUM Studio store. The only stand-in is the template guard
// (row 67 has not landed): a function installed through the service's own seam `configureTemplateGuard`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeHostStore, openHostStore, type SqliteStudioStore } from "../../src/store-bridge/index.ts";
import type { StudioCaller } from "../../vendor/src/lib/studio/contract/auth";
import type { StudioTemplateV2 } from "../../vendor/src/lib/studio/contract";
import type { TemplateGuardInput, TemplateGuardOutcome } from "../../vendor/src/lib/studio/services/templates/service";

const PKG = path.resolve(import.meta.dir, "..", "..");
const VENDOR = path.join(PKG, "vendor");
const TEMPLATES = path.join(PKG, "templates");
const base = process.env.ROW66_TEST_DIR ?? tmpdir();
mkdirSync(base, { recursive: true });
const WORK = realpathSync(mkdtempSync(path.join(base, "row66-")));
const ROOT = path.join(WORK, "datum-studio");
const LOG = path.join(WORK, "logs", "store.jsonl");
const TPL_LOG = path.join(WORK, "logs", "templates.jsonl");

process.env.STUDIO_WORKSPACE_ROOT = ROOT;
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets");

// C58: the local caller is a non-admin INTERNAL_AGENT.
const caller: StudioCaller = { kind: "INTERNAL_AGENT", requester: "agent:row66-test", agentId: "row66-test", canWriteClassK: false };

let store: SqliteStudioStore;
let templates: typeof import("../../vendor/src/lib/studio/services/templates");
let service: typeof import("../../vendor/src/lib/studio/services/templates/service");
let skeleton: typeof import("../../vendor/src/lib/studio/services/skeleton");
let params: typeof import("../../vendor/src/lib/studio/params");
let merge: typeof import("../../vendor/src/lib/studio/engine/tokens/merge");
let lock: typeof import("../../vendor/src/lib/studio/services/templates/form-lock");
let categories: typeof import("../../vendor/src/components/studio/template-editor/param-categories");

// Guard double behind the row 67 seam: records each call; its verdict is set per test.
const guardCalls: TemplateGuardInput[] = [];
let guardMode: "pass" | "warn" | "reject" | "throw" | "unavailable" = "pass";
const SKILL_SHA = "a".repeat(64);
async function testGuard(input: TemplateGuardInput): Promise<TemplateGuardOutcome> {
  guardCalls.push(input);
  if (guardMode === "throw") throw new Error("guard crashed (test)");
  if (guardMode === "unavailable") return { verdict: "unavailable", reason: "LAYOUT_NOT_MEASURED" };
  if (guardMode === "reject") return { verdict: "reject", report: { checks: [{ id: "DATUM-05", outcome: "reject" }] } };
  return { verdict: guardMode, report: { guard: "row66 test seam", reference: input.reference, lintTier: input.lintTier }, skillSha: SKILL_SHA };
}

type Raw = Record<string, unknown>;
function reader(): { get(s: string, p?: unknown[]): Raw | undefined; all(s: string, p?: unknown[]): Raw[] } {
  return (store as unknown as { requireReader(): { get(s: string, p?: unknown[]): Raw | undefined; all(s: string, p?: unknown[]): Raw[] } }).requireReader();
}
function versionRow(slug: string, no: number): Raw {
  const r = reader().get("SELECT v.* FROM template_version v JOIN template t ON t.id = v.template_id WHERE t.slug = ? AND v.version_no = ?", [slug, no]);
  if (!r) throw new Error(`no version ${slug} v${no}`);
  return r;
}
function latestNo(slug: string): number {
  return Number(reader().get("SELECT latest_version_no AS n FROM template WHERE slug = ?", [slug])?.n ?? 0);
}
function versionCount(): number {
  return Number(reader().get("SELECT count(*) AS n FROM template_version")?.n);
}

/** Expect a refusal with this tool code (Swarm or Studio) and, when given, this lock reason; nothing stored. */
async function refused(p: Promise<unknown>, code: string, reason?: string): Promise<{ code: string; reason?: string; issues: Array<{ rule: string; reason?: string; key: string }> }> {
  const before = versionCount();
  let err: unknown;
  await p.then(
    () => {
      throw new Error(`expected ${code}${reason ? ` (${reason})` : ""}, got success`);
    },
    (e) => {
      err = e;
    },
  );
  expect(service.templateErrorCode(err)).toBe(code);
  const details = ((err as { details?: { reason?: string; issues?: Array<{ rule: string; reason?: string; key: string }> } }).details ?? {});
  if (reason !== undefined) expect(details.reason).toBe(reason);
  expect(versionCount()).toBe(before);
  return { code, reason: details.reason, issues: details.issues ?? [] };
}

const COPY = "user-uji-salinan";

beforeAll(async () => {
  mkdirSync(path.dirname(TPL_LOG), { recursive: true });
  store = await openHostStore(ROOT, { release: "1.2.0", logFile: LOG });
  templates = await import("../../vendor/src/lib/studio/services/templates");
  templates.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.0" });
  templates.setTemplatesLogSink((e) => appendFileSync(TPL_LOG, `${JSON.stringify(e)}\n`));
  service = await import("../../vendor/src/lib/studio/services/templates/service");
  skeleton = await import("../../vendor/src/lib/studio/services/skeleton");
  params = await import("../../vendor/src/lib/studio/params");
  merge = await import("../../vendor/src/lib/studio/engine/tokens/merge");
  lock = await import("../../vendor/src/lib/studio/services/templates/form-lock");
  categories = await import("../../vendor/src/components/studio/template-editor/param-categories");
});

afterAll(async () => {
  service.configureTemplateGuard(null);
  templates.setTemplatesLogSink(null);
  await closeHostStore(store);
});

describe("row 66: guard seam and copy", () => {
  test("without a guard every save is refused before any other check (fail closed), nothing stored", async () => {
    service.configureTemplateGuard(null);
    await refused(service.createUserTemplateV2({ slug: COPY, name: "Uji Salinan", kind: "DOCUMENT", changeNote: "x", from: { slug: "datum-gsp" } }, caller), "GUARD_UNAVAILABLE", "GUARD_NOT_CONFIGURED");
    // The clone entry point too (row 109's refusal is now this one: FORBIDDEN).
    await expect(templates.createTemplateV2({ slug: "user-x", name: "x", kind: "DOCUMENT", changeNote: "x", template: {} as never }, caller)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(reader().get("SELECT count(*) AS n FROM template WHERE origin = 'user'")?.n).toBe(0);
    service.configureTemplateGuard(testGuard);
  });

  test("copy datum-gsp -> user v1 equals the pin byte for byte (definition sha, payload, skeleton)", async () => {
    const r = await service.createUserTemplateV2({ slug: COPY, name: "Uji Salinan", kind: "DOCUMENT", changeNote: "Salinan uji kasus 06", from: { slug: "datum-gsp" } }, caller);
    expect(r.version.versionNo).toBe(1);
    expect(r.template.origin).toBe("user");
    expect(r.guard.verdict).toBe("pass");
    expect(r.changedKeys).toBe(0);
    const pin = versionRow("datum-gsp", 1);
    const v1 = versionRow(COPY, 1);
    for (const col of ["definition", "definition_sha256", "overrides", "resolved_params", "params_sha256", "role_formats", "section_plan", "assets", "skeleton", "skeleton_sha256"]) {
      expect([col, v1[col]]).toEqual([col, pin[col]]);
    }
    expect(v1.base_version_id).toBe(pin.id);
    expect(v1.guard_verdict).toBe("pass");
    expect(v1.guard_skill_sha).toBe(SKILL_SHA);
    expect(String(v1.created_by)).toBe("agent:row66-test");
    // The guard saw the source as reference, and the lint tier is TERBIT (U.1 step 4).
    const g = guardCalls.at(-1)!;
    expect(g.reference).toEqual({ slug: "datum-gsp", versionNo: 1, versionId: String(pin.id) });
    expect(g.lintTier).toBe("TERBIT");
    // Resolution: same params as the source, same preset layer (rows 109 loadTemplateLayers).
    const src = await templates.resolveTemplate("datum-gsp");
    const cp = await templates.resolveTemplate(COPY);
    expect(cp.params).toEqual(src.params);
    expect(cp.roleFormats).toEqual(src.roleFormats);
    const ls = await skeleton.loadTemplateLayers(src.versionId);
    const lc = await skeleton.loadTemplateLayers(cp.versionId);
    expect(lc.layers).toEqual(ls.layers);
    expect([...lc.presetPins].sort()).toEqual([...ls.presetPins].sort());
    const ss = await skeleton.resolveSlotsForVersion(src.versionId, { tier: "TERBIT" });
    const sc = await skeleton.resolveSlotsForVersion(cp.versionId, { tier: "TERBIT" });
    expect(sc.skeletonSha256).toBe(ss.skeletonSha256);
    expect(JSON.stringify([...sc.slots.entries()])).toBe(JSON.stringify([...ss.slots.entries()]));
  });

  test("one slot changed -> v2; v1 stays byte-equal; history lists both with guard verdicts", async () => {
    const before = JSON.stringify(versionRow(COPY, 1));
    const def = (await templates.getTemplateV2(COPY, 1, { includeAdvanced: true })).definition as StudioTemplateV2;
    const slots = def.skeleton.slots.map((s) => (s.slotKey === "references" ? { ...s, label: "Daftar Rujukan" } : s));
    const r = await service.updateUserTemplateV2({ slug: COPY, baseVersionNo: 1, changeNote: "Label slot referensi", skeleton: { slots } }, caller);
    expect(r.version.versionNo).toBe(2);
    expect(JSON.stringify(versionRow(COPY, 1))).toBe(before);
    const v2 = versionRow(COPY, 2);
    expect(v2.base_version_id).toBe(versionRow(COPY, 1).id);
    expect(v2.skeleton_sha256).not.toBe(versionRow(COPY, 1).skeleton_sha256);
    const sk = await skeleton.getSkeleton(String(v2.id));
    expect(sk.skeleton.slots.find((s) => s.slotKey === "references")?.label).toBe("Daftar Rujukan");
    expect(sk.skeletonSha256).toBe(String(v2.skeleton_sha256));
    // Params are untouched by a label change.
    expect(v2.params_sha256).toBe(versionRow(COPY, 1).params_sha256);
    const hist = await service.listTemplateVersionHistory(COPY);
    expect(hist.map((h) => [h.versionNo, h.guardVerdict])).toEqual([
      [1, "pass"],
      [2, "pass"],
    ]);
    const detail = await templates.getTemplate(COPY);
    expect(detail.versions.map((v) => (v as { guardVerdict?: unknown }).guardVerdict)).toEqual(["pass", "pass"]);
  });

  test("case 06 op 2: cover.title.sizePt 26 through changes -> v3 (warn verdict saved)", async () => {
    guardMode = "warn";
    const r = await service.updateUserTemplateV2({ slug: COPY, baseVersionNo: 2, changeNote: "Judul sampul 26 pt", changes: { advanced: { "cover.title.sizePt": 26 } } }, caller);
    guardMode = "pass";
    expect(r.version.versionNo).toBe(3);
    expect(r.guard.verdict).toBe("warn");
    expect(r.changedKeys).toBe(1);
    expect((await templates.resolveTemplate(COPY, 3)).params["cover.title.sizePt"]).toBe(26);
    expect((await templates.resolveTemplate(COPY, 2)).params["cover.title.sizePt"]).not.toBe(26);
    expect(versionRow(COPY, 3).guard_verdict).toBe("warn");
  });

  test("case 06 op 3: type.face.serif Calibri -> TEMPLATE_FORM_LOCKED category:tipografi, latest stays 3", async () => {
    await refused(service.updateUserTemplateV2({ slug: COPY, baseVersionNo: 3, changeNote: "x", changes: { advanced: { "type.face.serif": "Calibri" } } }, caller), "TEMPLATE_FORM_LOCKED", "category:tipografi");
    expect(latestNo(COPY)).toBe(3);
  });
});

describe("row 66: versions, read-only builtins, identity", () => {
  test("BASE_CONFLICT on a stale base", async () => {
    await refused(service.updateUserTemplateV2({ slug: COPY, baseVersionNo: 2, changeNote: "x", changes: { advanced: { "cover.title.sizePt": 25 } } }, caller), "BASE_CONFLICT");
  });

  test("builtin update and archive -> TEMPLATE_READ_ONLY", async () => {
    await refused(service.updateUserTemplateV2({ slug: "datum-gsp", baseVersionNo: 1, changeNote: "x", changes: { advanced: { "cover.title.sizePt": 25 } } }, caller), "TEMPLATE_READ_ONLY");
    await refused(service.archiveUserTemplate({ slug: "datum-gsp", archived: true }, caller), "TEMPLATE_READ_ONLY");
  });

  test("slug taken, kind unsupported, preset not copyable, non-user slug", async () => {
    await refused(service.createUserTemplateV2({ slug: COPY, name: "x", kind: "DOCUMENT", changeNote: "x", from: { slug: "datum-gsp" } }, caller), "TEMPLATE_SLUG_TAKEN");
    await refused(service.createUserTemplateV2({ slug: "user-chart", name: "x", kind: "CHART", changeNote: "x", from: { slug: "datum-gsp" } }, caller), "TEMPLATE_KIND_UNSUPPORTED");
    await refused(service.createUserTemplateV2({ slug: "user-preset", name: "x", kind: "DOCUMENT", changeNote: "x", from: { slug: "datum-gsp-preset" } }, caller), "SCHEMA_INVALID");
    await refused(service.createUserTemplateV2({ slug: "user--x", name: "x", kind: "DOCUMENT", changeNote: "x", from: { slug: "datum-gsp" } }, caller), "SCHEMA_INVALID");
    await refused(service.createUserTemplateV2({ slug: "laporan-saya", name: "x", kind: "DOCUMENT", changeNote: "x", from: { slug: "datum-gsp" } }, caller), "SCHEMA_INVALID");
  });

  test("guard reject -> GUARD_REJECTED; guard crash or unavailable -> GUARD_UNAVAILABLE; nothing saved", async () => {
    for (const [mode, code] of [
      ["reject", "GUARD_REJECTED"],
      ["throw", "GUARD_UNAVAILABLE"],
      ["unavailable", "GUARD_UNAVAILABLE"],
    ] as const) {
      guardMode = mode;
      await refused(service.updateUserTemplateV2({ slug: COPY, baseVersionNo: 3, changeNote: "x", changes: { advanced: { "cover.title.sizePt": 25 } } }, caller), code);
    }
    guardMode = "pass";
    expect(latestNo(COPY)).toBe(3);
  });

  test("from scratch: every key counts (a builtin's layer is refused); a minimal definition is accepted with no base", async () => {
    const gsp = (await templates.getTemplateV2("datum-gsp", undefined, { includeAdvanced: true })).definition as StudioTemplateV2;
    const r1 = await refused(service.createUserTemplateV2({ slug: "user-baru", name: "Baru", kind: "DOCUMENT", changeNote: "x", template: gsp }, caller), "TEMPLATE_FORM_LOCKED");
    expect(r1.issues.length).toBeGreaterThan(1);
    // From scratch every key counts, slot keys too: the skeleton is datum-gsp's slots without their params.
    const bare = { slots: gsp.skeleton.slots.map((s) => ({ ...s, essentials: {}, advanced: undefined })) };
    const minimal = { $schema: "studio.template/v2", preset: { slug: "datum-gsp-preset" }, essentials: { "doc.language": "EN" }, skeleton: bare };
    const r = await service.createUserTemplateV2({ slug: "user-baru", name: "Baru", kind: "DOCUMENT", changeNote: "Templat baru", template: minimal }, caller);
    expect(r.version.versionNo).toBe(1);
    expect(versionRow("user-baru", 1).base_version_id).toBeNull();
    expect(guardCalls.at(-1)!.reference.slug).toBe("datum-kanonik");
    // A user template's preset must be a builtin preset.
    await refused(service.createUserTemplateV2({ slug: "user-baru-2", name: "x", kind: "DOCUMENT", changeNote: "x", template: { ...minimal, preset: { slug: "user-baru" } } }, caller), "TEMPLATE_NOT_FOUND");
    await refused(service.createUserTemplateV2({ slug: "user-baru-2", name: "x", kind: "DOCUMENT", changeNote: "x", template: { ...minimal, preset: undefined } }, caller), "SCHEMA_INVALID");
  });

  test("archive hides, refuses update, keeps copy-from and versions; unarchive restores", async () => {
    await service.archiveUserTemplate({ slug: "user-baru", archived: true }, caller);
    expect((await templates.listTemplates({})).some((t) => t.slug === "user-baru")).toBe(false);
    expect((await templates.listTemplates({ archived: true })).some((t) => t.slug === "user-baru")).toBe(true);
    await refused(service.updateUserTemplateV2({ slug: "user-baru", baseVersionNo: 1, changeNote: "x", changes: { essentials: { "doc.language": "ID" } } }, caller), "TEMPLATE_ARCHIVED");
    const c = await service.createUserTemplateV2({ slug: "user-dari-arsip", name: "x", kind: "DOCUMENT", changeNote: "x", from: { slug: "user-baru" } }, caller);
    expect(versionRow("user-dari-arsip", 1).definition_sha256).toBe(versionRow("user-baru", 1).definition_sha256);
    await service.archiveUserTemplate({ slug: "user-baru", archived: false }, caller);
    expect((await templates.listTemplates({})).some((t) => t.slug === "user-baru")).toBe(true);
    expect(c.version.versionNo).toBe(1);
  });

  test("name/description only: labels change, no new version", async () => {
    const before = versionCount();
    const def = (await templates.getTemplateV2(COPY, undefined, { includeAdvanced: true })).definition as StudioTemplateV2;
    const r = await service.updateUserTemplateV2({ slug: COPY, baseVersionNo: 3, changeNote: "label", name: "Uji Salinan Baru", template: def }, caller);
    expect(r.unchanged).toBe(true);
    expect(versionCount()).toBe(before);
    expect(reader().get("SELECT name FROM template WHERE slug = ?", [COPY])?.name).toBe("Uji Salinan Baru");
    await refused(service.updateUserTemplateV2({ slug: COPY, baseVersionNo: 3, changeNote: "x", template: def }, caller), "CHANGE_FIELDS_REQUIRED");
  });

  test("clone entry points route through the service (R01/R02 POST)", async () => {
    const def = (await templates.getTemplateV2(COPY, undefined, { includeAdvanced: true })).definition as StudioTemplateV2;
    const next = { ...def, essentials: { ...def.essentials, "doc.language": "EN" } };
    const r = await templates.createTemplateVersionV2(COPY, { baseVersionNo: 3, changeNote: "Bahasa EN", template: next }, caller);
    expect(r.version.versionNo).toBe(4);
    await expect(templates.createTemplateVersionV2(COPY, { baseVersionNo: 4, changeNote: "x", template: { ...next, advanced: { ...next.advanced, "type.face.serif": "Calibri" } } }, caller)).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { swarmCode: "TEMPLATE_FORM_LOCKED", reason: "category:tipografi" },
    });
    await expect(templates.createTemplate({ slug: "user-v1" } as never, caller)).rejects.toMatchObject({ code: "FORBIDDEN", details: { reason: "TEMPLATE_V1_UNSUPPORTED" } });
  });
});

describe("row 66: form lock P1-P9 (spec §3.1, C13 M1/M2/H1)", () => {
  const upd = (changes: Record<string, unknown>) => service.updateUserTemplateV2({ slug: COPY, baseVersionNo: latestNo(COPY), changeNote: "x", changes: changes as never }, caller);
  const updSlots = async (edit: (slots: StudioTemplateV2["skeleton"]["slots"]) => StudioTemplateV2["skeleton"]["slots"]) => {
    const def = (await templates.getTemplateV2(COPY, undefined, { includeAdvanced: true })).definition as StudioTemplateV2;
    return service.updateUserTemplateV2({ slug: COPY, baseVersionNo: latestNo(COPY), changeNote: "x", skeleton: { slots: edit(structuredClone(def.skeleton.slots)) } }, caller);
  };

  test("P1 unknown key", async () => {
    await refused(upd({ advanced: { "no.such.param": 1 } }), "PARAM_UNKNOWN_KEY");
  });
  test("P2 class T (template level) and slot.setup.pageSizeTw (slot)", async () => {
    await refused(upd({ advanced: { "grid.rederiveForNonA4": false } }), "PARAM_CLASS_T_READONLY");
    await refused(updSlots((s) => s.map((x) => (x.slotKey === "appendices" ? { ...x, advanced: { ...(x.advanced ?? {}), "slot.setup": { pageSizeTw: [1, 2] } } } : x))), "PARAM_CLASS_T_READONLY");
  });
  test("P3 derived and internal surfaces (no ADMIN exception)", async () => {
    await refused(upd({ advanced: { "type.scale.body.leading": 14 } }), "PARAM_CLASS_T_READONLY");
    await refused(upd({ advanced: { "render.docx.updateFieldsOnOpen": false } }), "PARAM_SURFACE_FORBIDDEN");
    // Row 65 H1 route 1: render.docx.normalStyle (internal object) is refused before P9 by P3.
    await refused(upd({ advanced: { "render.docx.normalStyle": { faceRole: "serif", face: "Calibri", color: "FF0000" } } }), "PARAM_SURFACE_FORBIDDEN");
  });
  test("P4 slot scope", async () => {
    await refused(updSlots((s) => s.map((x) => (x.slotKey === "references" ? { ...x, essentials: { ...x.essentials, "org.nib": "1" } } : x))), "SLOT_PARAM_SCOPE_INVALID");
  });
  test("P5 class K (no ADMIN bypass)", async () => {
    await refused(upd({ advanced: { "doc.number": "{urut}/X/{tahun}" } }), "TEMPLATE_FORM_LOCKED", "class-K");
  });
  test("P6 locked categories: tipografi, warna, halaman-grid", async () => {
    await refused(upd({ advanced: { "type.face.serif": "Calibri" } }), "TEMPLATE_FORM_LOCKED", "category:tipografi");
    await refused(upd({ essentials: { "color.interior.signal": "FF0000" } }), "TEMPLATE_FORM_LOCKED", "category:warna");
    await refused(upd({ essentials: { "page.size": "Letter" } }), "TEMPLATE_FORM_LOCKED", "category:halaman-grid");
  });
  test("P7 apparatus prefixes", async () => {
    await refused(upd({ advanced: { "naming.file.form": "judulTanggalIso" } }), "TEMPLATE_FORM_LOCKED", "apparatus");
    await refused(updSlots((s) => s.map((x) => (x.slotKey === "cover" ? { ...x, essentials: { ...x.essentials, "device.sealBand.enabled": false } } : x))), "TEMPLATE_FORM_LOCKED", "apparatus");
  });
  test("P8 value out of range", async () => {
    await refused(upd({ advanced: { "cover.title.sizePt": 30 } }), "SCHEMA_INVALID");
  });
  test("P9 colour and object types, row 65 routes, list colour literal", async () => {
    await refused(upd({ advanced: { "runningHead.ruleColour": "FF0000" } }), "TEMPLATE_FORM_LOCKED", "type:hex");
    await refused(upd({ advanced: { "table.zebra.colour": "FF0000" } }), "TEMPLATE_FORM_LOCKED", "type:tokenRef");
    await refused(upd({ advanced: { "cover.kicker.colour": "FF0000" } }), "TEMPLATE_FORM_LOCKED", "type:tokenRef");
    await refused(upd({ advanced: { "chart.colorRole.accent": "C00000" } }), "TEMPLATE_FORM_LOCKED", "type:tokenRef");
    await refused(upd({ advanced: { "chart.heatmap.ramp": ["paper", "C00000"] } }), "TEMPLATE_FORM_LOCKED", "type:list:colour");
    await refused(upd({ advanced: { "render.section.numberSeparator": "-" } }), "TEMPLATE_FORM_LOCKED", "render-internal");
  });
  test("P9 allow-list: slot.setup startOnNewPage is editable, its other fields are not", async () => {
    const r = await updSlots((s) => s.map((x) => (x.slotKey === "appendices" ? { ...x, advanced: { ...(x.advanced ?? {}), "slot.setup": { startOnNewPage: false } } } : x)));
    expect(r.unchanged).toBe(false);
    await refused(updSlots((s) => s.map((x) => (x.slotKey === "appendices" ? { ...x, advanced: { ...(x.advanced ?? {}), "slot.setup": { startOnNewPage: false, orientation: "landscape" } } } : x))), "TEMPLATE_FORM_LOCKED", "category:halaman-grid");
  });
  test("M1: a new slot is checked in full", async () => {
    await refused(
      updSlots((s) => [...s, { slotKey: "rules", sectionType: "ruleIndex", label: "Indeks Aturan", position: s.length + 1, required: false, positionLocked: false, repeatable: false, contentMode: "AUTO", tiers: [], admits: [], essentials: { "device.datumRule.enabled": false } } as never]),
      "TEMPLATE_FORM_LOCKED",
      "category:halaman-grid",
    );
  });
  test("M1: a key moved between essentials and advanced with the same value is a change", async () => {
    const v = (await templates.getTemplateV2(COPY, undefined, { includeAdvanced: true })).definition!.essentials["type.scale.body.size"];
    const r = await refused(upd({ advanced: { "type.scale.body.size": v } }), "TEMPLATE_FORM_LOCKED", "category:tipografi");
    expect(r.issues[0].key).toBe("type.scale.body.size");
  });
  test("M1: an unset of a locked key is a change", async () => {
    await refused(upd({ unset: ["color.interior.signal"] }), "TEMPLATE_FORM_LOCKED", "category:warna");
  });
  test("M2: an unknown tier locks every changed key; the tier value fails P8", async () => {
    const r = await refused(upd({ advanced: { "artifact.tier": "RAHASIA", "cover.title.sizePt": 25 } }), "TEMPLATE_FORM_LOCKED", "tier-unknown");
    expect(r.issues.map((i) => [i.rule, i.key])).toEqual([
      ["M2", "cover.title.sizePt"],
      ["P8", "artifact.tier"],
    ]);
  });
});

describe("row 66: role formats (§3.2) and skeleton (§3.3)", () => {
  const upd = (roleFormats: Record<string, unknown>) => service.updateUserTemplateV2({ slug: COPY, baseVersionNo: latestNo(COPY), changeNote: "x", changes: { roleFormats } }, caller);
  const updSlots = async (edit: (slots: StudioTemplateV2["skeleton"]["slots"]) => StudioTemplateV2["skeleton"]["slots"]) => {
    const def = (await templates.getTemplateV2(COPY, undefined, { includeAdvanced: true })).definition as StudioTemplateV2;
    return service.updateUserTemplateV2({ slug: COPY, baseVersionNo: latestNo(COPY), changeNote: "x", skeleton: { slots: edit(structuredClone(def.skeleton.slots)) } }, caller);
  };

  test("role format: face, colour, shading, borders, centred jc, size range are locked", async () => {
    await refused(upd({ "body.paragraph": { run: { face: "Calibri" } } }), "TEMPLATE_FORM_LOCKED", "role-field:face");
    await refused(upd({ "body.paragraph": { run: { color: "FF0000" } } }), "TEMPLATE_FORM_LOCKED", "role-field:color");
    await refused(upd({ "body.paragraph": { para: { shading: { fill: "FF0000", val: "clear" } } } }), "TEMPLATE_FORM_LOCKED", "role-field:shading");
    await refused(upd({ "aside.body": { cell: { borders: { top: { val: "single", sz: 30, color: "101418", space: 0 } } } } }), "TEMPLATE_FORM_LOCKED", "role-field:borders");
    await refused(upd({ "body.paragraph": { para: { jc: "center" } } }), "TEMPLATE_FORM_LOCKED", "role-field:jc");
    await refused(upd({ "body.paragraph": { run: { szHalfPt: 200 } } }), "TEMPLATE_FORM_LOCKED", "role-range:szHalfPt");
    await refused(upd({ "body.paragraph": { para: { lineRule: "atLeast" } } }), "TEMPLATE_FORM_LOCKED", "role-field:para.lineRule");
  });

  test("role format: spacing is editable and stored as base resolved sub-object + changed field", async () => {
    const r = await upd({ "body.paragraph": { para: { spacingAfterTw: 160 } } });
    const rf = (await templates.resolveTemplate(COPY, r.version.versionNo)).roleFormats["body.paragraph"]!;
    expect(rf.para?.spacingAfterTw).toBe(160);
    expect(rf.para?.lineTw).toBe(270);
    expect(rf.run?.face).toBe("IBM Plex Serif");
  });

  test("skeleton: required slot removal, locked position, cover first, label rules", async () => {
    const renumber = (s: StudioTemplateV2["skeleton"]["slots"]) => s.map((x, i) => ({ ...x, position: i + 1 }));
    const r1 = await refused(updSlots((s) => renumber(s.filter((x) => x.slotKey !== "toc"))), "TEMPLATE_FORM_LOCKED");
    expect(r1.issues.map((i) => i.reason)).toContain("slot-required");
    const r2 = await refused(updSlots((s) => s.map((x) => (x.slotKey === "content" ? { ...x, required: false } : x))), "TEMPLATE_FORM_LOCKED", "slot-required");
    expect(r2.issues.length).toBe(1);
    const r3 = await refused(updSlots((s) => s.map((x) => (x.slotKey === "cover" ? { ...x, position: 2 } : x.slotKey === "controlSheet" ? { ...x, position: 1 } : x))), "TEMPLATE_FORM_LOCKED");
    expect(r3.issues.map((i) => i.reason).sort()).toEqual(["cover-first", "slot-position-locked"]);
    await refused(updSlots((s) => s.map((x) => (x.slotKey === "references" ? { ...x, label: "Referensi — utama" } : x))), "TEMPLATE_FORM_LOCKED", "slot-label");
    await refused(updSlots((s) => s.map((x) => (x.slotKey === "references" ? { ...x, label: "Referensi?" } : x))), "TEMPLATE_FORM_LOCKED", "slot-label");
  });

  test("skeleton: a section type change of an unlocked optional slot is allowed (new slot, empty layer)", async () => {
    const r = await updSlots((s) => s.map((x) => (x.slotKey === "references" ? { ...x, sectionType: "ruleIndex", label: "Indeks Aturan", essentials: {}, contentMode: "AUTO" } : x)));
    const sk = await skeleton.getSkeleton(r.version.id);
    expect(sk.skeleton.slots.find((x) => x.slotKey === "references")?.sectionType).toBe("ruleIndex");
  });
});

describe("row 66: one allowed change per editable category, limits, evidence", () => {
  test("each editable category accepts one change (new version each)", async () => {
    const def = (await templates.getTemplateV2(COPY, undefined, { includeAdvanced: true })).definition as StudioTemplateV2;
    const current = { ...def.essentials, ...(def.advanced ?? {}) } as Record<string, unknown>;
    const done: Record<string, string> = {};
    const skipped: string[] = [];
    for (const cat of categories.PARAM_CATEGORIES.map((c) => c.id)) {
      const cand = params.ALL_PARAMS.filter((d) => categories.categoryOf(d) === cat && lock.staticParamLock(d) === "editable" && d.key !== "slot.setup" && d.key !== "artifact.tier");
      let pickedKey: string | null = null;
      let pickedValue: unknown = null;
      for (const d of cand) {
        const now = Object.prototype.hasOwnProperty.call(current, d.key) ? current[d.key] : d.default;
        const options: unknown[] =
          d.type === "bool" ? [!now] : d.type === "enum" ? (d.enum ?? []).filter((e) => e !== now) : typeof now === "number" ? [d.range?.min, d.range?.max, (now as number) + 1].filter((x) => x !== undefined && x !== now) : d.type === "string" && !d.pattern ? [`${String(now ?? "")} Uji`.trim()] : [];
        const ok = options.find((v) => merge.validateParamValue(d, v as never) === null && merge.effectiveClass(d, v as never, "TERBIT") === "B");
        if (ok !== undefined) {
          pickedKey = d.key;
          pickedValue = ok;
          break;
        }
      }
      if (!pickedKey) {
        if (cand.length > 0) skipped.push(cat);
        continue;
      }
      const surface = params.PARAMS_BY_KEY.get(pickedKey)!.surface === "essential" ? "essentials" : "advanced";
      const r = await service.updateUserTemplateV2({ slug: COPY, baseVersionNo: latestNo(COPY), changeNote: `uji ${cat}`, changes: { [surface]: { [pickedKey]: pickedValue } } as never }, caller);
      expect(r.unchanged).toBe(false);
      done[cat] = `${pickedKey}=${JSON.stringify(pickedValue)} -> v${r.version.versionNo}`;
    }
    console.log(`row66 allowed change per editable category: ${JSON.stringify(done, null, 1)}; no scalar candidate: ${JSON.stringify(skipped)}`);
    expect(Object.keys(done).length).toBeGreaterThanOrEqual(8);
  });

  test("input limits (§6): depth, forbidden key, bidi control, size", async () => {
    let deep: unknown = 1;
    for (let i = 0; i < 14; i++) deep = { a: deep };
    await refused(service.updateUserTemplateV2({ slug: COPY, baseVersionNo: latestNo(COPY), changeNote: "x", changes: { advanced: { "cover.title.sizePt": deep as never } } }, caller), "SCHEMA_INVALID");
    await refused(service.updateUserTemplateV2(JSON.parse(`{"slug":"${COPY}","baseVersionNo":${latestNo(COPY)},"changeNote":"x","changes":{"advanced":{"__proto__":{"x":1}}}}`), caller), "SCHEMA_INVALID");
    await refused(service.updateUserTemplateV2({ slug: COPY, baseVersionNo: latestNo(COPY), changeNote: "x‮", changes: { advanced: { "cover.title.sizePt": 25 } } }, caller), "SCHEMA_INVALID");
    await refused(service.updateUserTemplateV2({ slug: COPY, baseVersionNo: latestNo(COPY), changeNote: "x", changes: { advanced: { "cover.title.sizePt": 25, pad: "x".repeat(1 << 20) } as never } }, caller), "INPUT_TOO_LARGE");
  });

  test("lint-parameter set (U.1a): every key is locked by a static rule (A-U3)", () => {
    const keys = lock.lintParameterKeys();
    const by = keys.map((k) => [k, lock.staticParamLock(params.PARAMS_BY_KEY.get(k)!)]);
    console.log(`row66 lint-parameter set: ${JSON.stringify(by)}`);
    expect(keys.length).toBeGreaterThan(8);
    expect(by.filter(([, r]) => r === "editable")).toEqual([]);
  });

  test("checkTemplateForm saves nothing and reports the lock", async () => {
    const before = versionCount();
    const def = (await templates.getTemplateV2(COPY, undefined, { includeAdvanced: true })).definition as StudioTemplateV2;
    const bad = await service.checkTemplateForm({ template: { ...def, advanced: { ...def.advanced, "type.face.serif": "Calibri" } }, base: { slug: COPY } });
    expect([bad.valid, bad.code]).toEqual([false, "TEMPLATE_FORM_LOCKED"]);
    const good = await service.checkTemplateForm({ template: { ...def, advanced: { ...def.advanced, "cover.title.sizePt": 24.5 } }, base: { slug: COPY } });
    expect(good).toMatchObject({ valid: true, changedKeys: 1 });
    expect(versionCount()).toBe(before);
  });

  test("errors are logged durably (JSON lines with code and correlation id)", () => {
    const lines = readFileSync(TPL_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { level: string; code?: string; correlationId?: string });
    expect(lines.some((l) => l.level === "warn" && l.code === "TEMPLATE_FORM_LOCKED" && typeof l.correlationId === "string")).toBe(true);
    expect(lines.some((l) => l.level === "error" && l.code === "GUARD_UNAVAILABLE")).toBe(true);
    expect(lines.some((l) => l.level === "info" && l.code === "TEMPLATE_VERSION_CREATED")).toBe(true);
  });

  test("no prisma import in the row 66 files", () => {
    const files = [
      "vendor/src/lib/studio/services/templates/index.ts",
      "vendor/src/lib/studio/services/templates/service.ts",
      "vendor/src/lib/studio/services/templates/form-lock.ts",
      "vendor/src/lib/studio/services/skeleton/repository.ts",
      "vendor/src/components/studio/template-editor/param-categories.ts",
      "vendor/src/components/studio/template-editor/param-labels.ts",
      "src/store-bridge/rows.ts",
    ];
    const hits = files.flatMap((f) => readFileSync(path.join(PKG, f), "utf8").split("\n").flatMap((l, i) => (/prisma/i.test(l) && /\b(import|require)\b/.test(l) ? [`${f}:${i + 1}`] : [])));
    expect(hits).toEqual([]);
  });
});
