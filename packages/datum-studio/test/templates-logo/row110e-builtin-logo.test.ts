// Row 110e (Swarm 1.2.0, decision C75): Studio's built-in templates ship the manual's cover logo.
// catalog.json `editionAssets` gives every version folded on a builtin the logo of its doc.language:
// ID gsp-seal.png (DT-13c, ID p.48 "Logo, kop, pita segel, klasifikasi, dan kicker jenis dokumen bernilai
// seal"; C46) and EN gsp-tinta.png (DT-13c EN p.50 "keep the logo black"; Table 8.1 EN p.51 "Black ink,
// once: on the cover"). Cover item 2 (ID p.47, EN p.49): 44-46 mm; DT-14: once.
// Runs against a REAL temp DATUM Studio store and the vendored ingest + renderSnapshot (no user upload).
// The only stand-in is the render bridge transport (as in test/template-guard), which this DOCX/HTML
// render does not need for its files.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { closeHostStore, openHostStore, type SqliteStudioStore } from "../../src/store-bridge/index.ts";
import type { StudioTemplateV2 } from "../../vendor/src/lib/studio/contract";

const PKG = path.resolve(import.meta.dir, "..", "..");
const VENDOR = path.join(PKG, "vendor");
const STUDIO_ASSETS = path.join(VENDOR, "src", "lib", "studio", "assets");
const TEMPLATES = path.join(PKG, "templates");
const HOUSE_LOGO = path.join(PKG, "..", "desktop", "datum", "datum-house-style", "assets", "logo");
const base = process.env.ROW110E_TEST_DIR ?? tmpdir();
mkdirSync(base, { recursive: true });
const WORK = realpathSync(mkdtempSync(path.join(base, "row110e-")));
const ROOT = path.join(WORK, "datum-studio");
const LOG = path.join(WORK, "logs", "store.jsonl");
const TPL_LOG = path.join(WORK, "logs", "templates.jsonl");

process.env.STUDIO_WORKSPACE_ROOT = ROOT;
process.env.STUDIO_ASSETS_ROOT = STUDIO_ASSETS;

const sha = (b: Uint8Array | Buffer) => createHash("sha256").update(b).digest("hex");
const SEAL = "a43657da7dd8e5c06e3474a15b349036a0066011d8272597840f5b3bb8dfe95d";
const TINTA = "69636059ddc4155c66430007d9c8bf280ce44090f408b5ab557f5efd0962111e";
const EXPECTED: Record<string, { file: string; sha256: string }> = { ID: { file: "gsp-seal.png", sha256: SEAL }, EN: { file: "gsp-tinta.png", sha256: TINTA } };
const EMU_PER_MM = 36_000;

let store: SqliteStudioStore;
let templates: typeof import("../../vendor/src/lib/studio/services/templates");
let sampleMod: typeof import("../../vendor/src/lib/studio/services/templates/sample-render");
let skeleton: typeof import("../../vendor/src/lib/studio/services/skeleton");
let runtime: typeof import("../../vendor/src/lib/studio/engine/browser/runtime");

type Entry = { slug: string; language: string; isPreset: boolean };
const catalog = JSON.parse(readFileSync(path.join(TEMPLATES, "catalog.json"), "utf8")) as {
  templates: Entry[];
  editionAssets: Record<string, Record<string, { sha256: string; path: string; kind: string }>>;
};

beforeAll(async () => {
  mkdirSync(path.dirname(TPL_LOG), { recursive: true });
  store = await openHostStore(ROOT, { release: "1.2.0", logFile: LOG });
  templates = await import("../../vendor/src/lib/studio/services/templates");
  templates.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.0" });
  templates.setTemplatesLogSink((e) => appendFileSync(TPL_LOG, `${JSON.stringify(e)}\n`));
  sampleMod = await import("../../vendor/src/lib/studio/services/templates/sample-render");
  skeleton = await import("../../vendor/src/lib/studio/services/skeleton");
  runtime = await import("../../vendor/src/lib/studio/engine/browser/runtime");
  runtime.setRenderBridgeTransport(async (req) => {
    if (req.op === "hello") return { ok: true, electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 20, scripts: ["studio.measure"] };
    if (req.op === "checkPage") return { ok: true, electron: "42.3.3", script: "studio.measure", result: { paged: true, pageCount: 6, truncated: false, elements: [] } };
    return { ok: false, code: "UNKNOWN_OP", message: String(req.op) };
  });
  await templates.ensureBuiltinTemplates();
});

afterAll(async () => {
  runtime.setRenderBridgeTransport(null);
  templates.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.0" });
  templates.setTemplatesLogSink(null);
  await closeHostStore(store);
});

/** Render the Swarm sample of a builtin (DOCX + HTML) from its pinned version, no document assets. */
async function renderBuiltin(slug: string, language: "ID" | "EN") {
  const d = await templates.getTemplate(slug);
  const side = await sampleMod.sideFromVersion(d.version.id);
  const doc = sampleMod.swarmSampleDocument({ slug, tier: "TERBIT", slots: side.skeleton.skeleton.slots, language });
  const out = await sampleMod.renderSample(side, doc, { tier: "TERBIT", formats: ["DOCX", "HTML"], timeoutMs: 60_000, correlationId: `row110e-${slug}`, measureLayout: false });
  expect(out.ingest.valid).toBe(true);
  expect(out.render!.status).toBe("SUCCEEDED");
  const docx = out.render!.files.find((f) => f.format === "DOCX" && f.role === "PRIMARY")!;
  const html = out.render!.files.find((f) => f.format === "HTML" && f.role === "PRIMARY")!;
  return { docx: docx.data as Uint8Array, html: typeof html.data === "string" ? html.data : strFromU8(html.data) };
}

/** DOCX: every media part, the parts that reference each, and each reference's extent in mm. */
function docxLogo(docx: Uint8Array, expectSha: string) {
  const z = unzipSync(docx);
  const media = Object.keys(z).filter((k) => k.startsWith("word/media/"));
  const logoParts = media.filter((k) => sha(z[k]) === expectSha);
  const blackParts = media.filter((k) => sha(z[k]) === TINTA);
  const refs: Array<{ part: string; cxMm: number; cyMm: number; inFirstSection: boolean }> = [];
  for (const lp of logoParts) {
    const target = lp.replace(/^word\//, "");
    for (const relsName of Object.keys(z).filter((k) => /^word\/_rels\/.+\.xml\.rels$/.test(k))) {
      const rels = strFromU8(z[relsName]);
      for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
        if (!m[0].includes(`Target="${target}"`)) continue;
        const id = /Id="([^"]+)"/.exec(m[0])![1];
        const part = relsName.replace("_rels/", "").replace(/\.rels$/, "");
        const xml = strFromU8(z[part]);
        for (const dr of xml.matchAll(/<w:drawing>[\s\S]*?<\/w:drawing>/g)) {
          if (!dr[0].includes(`r:embed="${id}"`)) continue;
          const ext = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(dr[0])!;
          // Cover = the first Word section: the drawing precedes the first section break (<w:sectPr>).
          const firstSect = xml.indexOf("<w:sectPr");
          refs.push({ part, cxMm: Number(ext[1]) / EMU_PER_MM, cyMm: Number(ext[2]) / EMU_PER_MM, inFirstSection: firstSect < 0 || (dr.index ?? 0) < firstSect });
        }
      }
    }
  }
  return { media: media.length, logoParts, blackParts, refs };
}

/** HTML: every <img> whose data URI decodes to `expectSha`, with its style and the role of its wrapper. */
function htmlLogo(html: string, expectSha: string) {
  const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  const hits = imgs.filter((tag) => {
    const src = /src="data:image\/png;base64,([^"]+)"/.exec(tag);
    return src !== null && sha(Buffer.from(src[1], "base64")) === expectSha;
  });
  // The cover unit is `<section ... data-wrapper="cover">` (engine/html/blocks/wrapper.ts:235-236, :463); the
  // next unit starts at the next data-wrapper attribute.
  const imgIdx = hits.length > 0 ? html.indexOf(hits[0]) : -1;
  const coverStart = html.indexOf('data-wrapper="cover"');
  const nextUnit = html.indexOf("data-wrapper=", coverStart + 1);
  const onCover = coverStart >= 0 && imgIdx > coverStart && (nextUnit < 0 || imgIdx < nextUnit);
  return { imgs: imgs.length, hits, style: hits.map((t) => /style="([^"]+)"/.exec(t)?.[1] ?? ""), coverLogoRoles: html.split('data-role="cover.logo"').length - 1, onCover };
}

describe("row 110e: shipped files and catalog", () => {
  test("the ID logo is a byte copy of datum-house-style/assets/logo/gsp-seal.png; EN is the shipped black ink mark", () => {
    for (const lang of ["ID", "EN"]) {
      const e = EXPECTED[lang];
      const shipped = readFileSync(path.join(STUDIO_ASSETS, "logo", e.file));
      expect(sha(shipped)).toBe(e.sha256);
      expect(sha(readFileSync(path.join(HOUSE_LOGO, e.file)))).toBe(e.sha256);
      expect(catalog.editionAssets[lang]).toEqual({ logo: { sha256: e.sha256, path: `src/lib/studio/assets/logo/${e.file}`, kind: "raster" } });
    }
    expect(Object.keys(catalog.editionAssets).sort()).toEqual(["EN", "ID"]);
  });

  test("every shipped builtin (16) resolves to the logo of its catalog language, inside STUDIO_ASSETS_ROOT", async () => {
    expect(catalog.templates.length).toBe(16);
    const seen: Record<string, number> = { ID: 0, EN: 0 };
    for (const e of catalog.templates) {
      const t = await templates.resolveTemplate(e.slug);
      const want = EXPECTED[e.language];
      expect(Object.keys(t.assets)).toEqual(["logo"]);
      expect(t.assets.logo.sha256).toBe(want.sha256);
      expect(t.assets.logo.kind).toBe("raster");
      expect(t.assets.logo.absPath).toBe(path.join(STUDIO_ASSETS, "logo", want.file));
      seen[e.language] += 1;
    }
    console.log(`row110e: builtins by edition ${JSON.stringify(seen)}`);
    expect(seen).toEqual({ ID: 11, EN: 5 });
  });
});

describe("row 110e: rendering the datum-gsp sample from the built-in (no user upload)", () => {
  test("ID datum-gsp: DOCX cover embeds gsp-seal.png once at 44 mm; HTML prints one <img> 44 mm on the cover", async () => {
    const r = await renderBuiltin("datum-gsp", "ID");
    const d = docxLogo(r.docx, SEAL);
    console.log(`row110e: datum-gsp DOCX media=${d.media} sealParts=${d.logoParts.join(",")} blackParts=${d.blackParts.length} refs=${JSON.stringify(d.refs)}`);
    expect(d.logoParts.length).toBe(1);
    expect(d.blackParts.length).toBe(0);
    expect(d.refs.length).toBe(1);
    expect(d.refs[0].part).toBe("word/document.xml");
    expect(d.refs[0].cxMm).toBeGreaterThanOrEqual(44);
    expect(d.refs[0].cxMm).toBeLessThanOrEqual(46);
    expect(d.refs[0].inFirstSection).toBe(true);
    const h = htmlLogo(r.html, SEAL);
    console.log(`row110e: datum-gsp HTML imgs=${h.imgs} sealImgs=${h.hits.length} style=${JSON.stringify(h.style)} coverLogoRoles=${h.coverLogoRoles}`);
    expect(h.hits.length).toBe(1);
    expect(h.coverLogoRoles).toBe(1);
    expect(h.style[0]).toContain("width:44mm");
    expect(htmlLogo(r.html, TINTA).hits.length).toBe(0);
    // On the cover only: the one logo <img> sits inside the cover unit.
    expect(h.onCover).toBe(true);
  });

  test("EN datum-laporan-en: DOCX embeds the black gsp-tinta.png once at 44 mm; HTML one <img> 44 mm; no seal logo", async () => {
    const r = await renderBuiltin("datum-laporan-en", "EN");
    const d = docxLogo(r.docx, TINTA);
    console.log(`row110e: datum-laporan-en DOCX media=${d.media} tintaParts=${d.logoParts.join(",")} refs=${JSON.stringify(d.refs)}`);
    expect(d.logoParts.length).toBe(1);
    expect(d.refs.length).toBe(1);
    expect(d.refs[0].cxMm).toBeGreaterThanOrEqual(44);
    expect(d.refs[0].cxMm).toBeLessThanOrEqual(46);
    expect(d.refs[0].inFirstSection).toBe(true);
    expect(docxLogo(r.docx, SEAL).logoParts.length).toBe(0);
    const h = htmlLogo(r.html, TINTA);
    console.log(`row110e: datum-laporan-en HTML imgs=${h.imgs} tintaImgs=${h.hits.length} style=${JSON.stringify(h.style)} coverLogoRoles=${h.coverLogoRoles}`);
    expect(h.hits.length).toBe(1);
    expect(h.coverLogoRoles).toBe(1);
    expect(h.style[0]).toContain("width:44mm");
    expect(h.onCover).toBe(true);
    expect(htmlLogo(r.html, SEAL).hits.length).toBe(0);
  });

  test("ID datum-laporan: DOCX + HTML carry the seal logo (a Rev A doc-type builtin on the rev-a preset)", async () => {
    const r = await renderBuiltin("datum-laporan", "ID");
    expect(docxLogo(r.docx, SEAL).refs.length).toBe(1);
    expect(htmlLogo(r.html, SEAL).hits.length).toBe(1);
  });
});

describe("row 110e: user copies fold alike", () => {
  test("an EN copy folded on the ID rev-a preset carries the EN logo, byte-equal to the builtin; its candidate side resolves", async () => {
    for (const slug of ["datum-laporan-en", "datum-laporan", "datum-gsp"]) {
      const d = await templates.getTemplateV2(slug, undefined, { includeAdvanced: true });
      const def = d.definition as StudioTemplateV2;
      const fold = templates.foldTemplateDefinition(def, templates.presetFoldBase(def.preset!.slug, def.preset!.version));
      expect(fold.payload.assets).toEqual(templates.builtinTemplate(slug)!.payload.assets);
      const sk = skeleton.skeletonForInsert(fold.skeleton);
      // Hosted by the ID datum-gsp (as preview does without a base): the EN logo is matched in the shipped edition assets.
      const host = await templates.resolveTemplate("datum-gsp");
      const side = await sampleMod.sideFromCandidate({ definition: def, payload: fold.payload, skeleton: sk.skeleton, skeletonSha256: sk.skeletonSha256 }, host);
      const lang = (fold.payload.resolvedParams["doc.language"] as string) ?? "ID";
      expect(side.tpl.assets.logo.sha256).toBe(EXPECTED[lang].sha256);
    }
  });

  test("a candidate asset that is not shipped still fails closed (ASSET_UNRESOLVED)", async () => {
    const d = await templates.getTemplateV2("datum-gsp", undefined, { includeAdvanced: true });
    const def = d.definition as StudioTemplateV2;
    const fold = templates.foldTemplateDefinition(def, templates.presetFoldBase(def.preset!.slug));
    const sk = skeleton.skeletonForInsert(fold.skeleton);
    const payload = { ...fold.payload, assets: { logo: { sha256: "0".repeat(64), path: "src/lib/studio/assets/logo/gsp-seal.png", kind: "raster" } } };
    const host = await templates.resolveTemplate("datum-gsp");
    await expect(sampleMod.sideFromCandidate({ definition: def, payload, skeleton: sk.skeleton, skeletonSha256: sk.skeletonSha256 }, host)).rejects.toMatchObject({ code: "RENDER_FAILED", details: { reason: "ASSET_UNRESOLVED" } });
  });
});

describe("row 110e: catalog editionAssets keep row 107's path guards", () => {
  function tamperedDir(name: string, editionAssets: unknown): string {
    const dir = path.join(WORK, `tpl-${name}`);
    cpSync(TEMPLATES, dir, { recursive: true });
    const c = JSON.parse(readFileSync(path.join(dir, "catalog.json"), "utf8")) as Record<string, unknown>;
    c.editionAssets = editionAssets;
    writeFileSync(path.join(dir, "catalog.json"), `${JSON.stringify(c, null, 2)}\n`);
    return dir;
  }
  const logo = (p: string) => ({ ID: { logo: { sha256: SEAL, path: p, kind: "raster" } } });
  const cases: Array<[string, unknown]> = [
    ["dotdot", logo("src/lib/studio/assets/../../../../etc/passwd.png")],
    ["absolute", logo("/etc/hosts.png")],
    ["outside-root", logo("src/lib/studio/services/templates/index.png")],
    ["hidden", logo("src/lib/studio/assets/.secret/x.png")],
    ["extension", logo("src/lib/studio/assets/logo/gsp-seal.sh")],
    ["language", { XX: { logo: { sha256: SEAL, path: "src/lib/studio/assets/logo/gsp-seal.png", kind: "raster" } } }],
    ["kind", { ID: { logo: { sha256: SEAL, path: "src/lib/studio/assets/logo/gsp-seal.png", kind: "script" } } }],
    ["sha", { ID: { logo: { sha256: "ABC", path: "src/lib/studio/assets/logo/gsp-seal.png", kind: "raster" } } }],
    ["not-object", ["src/lib/studio/assets/logo/gsp-seal.png"]],
  ];
  for (const [name, ea] of cases) {
    test(`refused at load (SCHEMA_INVALID): ${name}`, () => {
      templates.configureTemplateSource({ templatesDir: tamperedDir(name, ea), assetRepoRoot: VENDOR, release: "1.2.0" });
      let code: string | undefined;
      try {
        templates.builtinTemplateSlugs();
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(code).toBe("SCHEMA_INVALID");
      templates.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.0" });
    });
  }

  test("the shipped catalog loads and every builtin folds with its edition logo", () => {
    expect(templates.builtinTemplateSlugs().length).toBe(16);
    for (const e of catalog.templates) expect(templates.builtinTemplate(e.slug)!.payload.assets.logo.sha256).toBe(EXPECTED[e.language].sha256);
    const ea = templates.resolvedBuiltinEditionAssets();
    expect(ea.map((a) => a.logo.absPath).sort()).toEqual([path.join(STUDIO_ASSETS, "logo", "gsp-seal.png"), path.join(STUDIO_ASSETS, "logo", "gsp-tinta.png")]);
  });
});
