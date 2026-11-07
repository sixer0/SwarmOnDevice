// Row 107: template asset resolver and readers confined to the asset root; asset/font roots not cwd-dependent.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { ASSETS, codeOf, inCwd, outsidePng, stubUi, tmp, withEnv } from "./row107-helpers";

stubUi();
const profile = await import("../../vendor/src/lib/studio/services/templates/profile");
const wrapperMedia = await import("../../vendor/src/lib/studio/engine/docx/wrapper/media");
const blockMedia = await import("../../vendor/src/lib/studio/engine/docx/blocks/media");
const device = await import("../../vendor/src/lib/studio/engine/html/blocks/device");
const catalog = await import("../../vendor/src/lib/studio/engine/docx/fonts/catalog");
const relabel = await import("../../vendor/src/lib/studio/engine/docx/fonts/relabel");
const htmlFonts = await import("../../vendor/src/lib/studio/engine/html/base/fonts");
const base = await import("../../vendor/src/lib/studio/engine/docx/package/base");

type Ctx = Parameters<typeof wrapperMedia.loadLogo>[0];
type Tpl = Ctx["tpl"];

function tplWith(assets: Tpl["assets"]): Tpl {
  return { templateId: "t", versionId: "v", versionNo: 0, params: {}, roleFormats: {}, sectionPlan: {}, assets } as unknown as Tpl;
}

function ctxWith(assets: Tpl["assets"], logs: unknown[] = []): Ctx {
  return { snapshot: { doc: { assets: {} } }, tpl: tplWith(assets), figures: new Map(), log: (e: unknown) => logs.push(e) } as unknown as Ctx;
}

const rasterOutside = () => ({ logo: { kind: "raster" as const, absPath: outsidePng(), sha256: "" } });
const inAssetsRoot = <T>(fn: () => T) => withEnv({ STUDIO_ASSETS_ROOT: ASSETS }, () => inCwd(tmp("cwd"), fn));

describe("M3 services/templates/profile.ts: no unconfined default resolver", () => {
  test("resolveProfileInMemory without resolveAssetPath is refused", () => {
    const p = { base: profile.DATUM_CANONICAL_SLUG, slug: "x-y", kind: "DOCUMENT", overrides: {}, assets: { logo: { sha256: "0".repeat(64), path: "/etc/hosts", kind: "raster" } } };
    expect(codeOf(() => profile.resolveProfileInMemory(p as never))).toBe("PATH_OUTSIDE_ROOT");
    expect(codeOf(() => profile.resolveProfileInMemory(p as never, { resolveAssetPath: (rel) => `/confined/${path.basename(rel)}` }))).toBe("no-throw");
  });
});

describe("M3 readers refuse a template asset absPath outside STUDIO_ASSETS_ROOT", () => {
  test("engine/docx/wrapper/media.ts loadLogo / loadAsset", () => {
    expect(inAssetsRoot(() => codeOf(() => wrapperMedia.loadLogo(ctxWith(rasterOutside()))))).toBe("PATH_OUTSIDE_ROOT");
    expect(inAssetsRoot(() => codeOf(() => wrapperMedia.loadAsset(ctxWith(rasterOutside()), "logo")))).toBe("PATH_OUTSIDE_ROOT");
  });
  test("engine/docx/blocks/media.ts loadImageAsset", () => {
    const warns: string[] = [];
    const ctx = ctxWith(rasterOutside());
    const env = { ctx, block: { blockId: "b1", address: "1" }, warn: (m: string) => warns.push(m) };
    const got = inAssetsRoot(() => blockMedia.loadImageAsset(env as never, "logo"));
    expect(got).toBeUndefined();
    expect(warns.join(" ")).toContain("outside root");
  });
  test("engine/html/blocks/device.ts assetDataUri", () => {
    const logs: Array<{ code?: string }> = [];
    const got = inAssetsRoot(() => device.assetDataUri(ctxWith(rasterOutside(), logs), "logo", { blockId: "b1", address: "1" } as never));
    expect(got).toBeUndefined();
    expect(logs.map((l) => l.code)).toContain("RENDER_ASSET_UNREADABLE");
  });
  test("an asset inside the root is still read (no regression)", () => {
    const inside = { logo: { kind: "raster" as const, absPath: path.join(ASSETS, "logo", "gsp-tinta.png"), sha256: "" } };
    expect(inAssetsRoot(() => device.assetDataUri(ctxWith(inside), "logo", { blockId: "b1" } as never))).toStartWith("data:image/png;base64,");
  });
});

describe("M4 asset and font roots come from STUDIO_ASSETS_ROOT, not cwd", () => {
  test("default logo: works from any cwd, refused without the root", () => {
    const logo = inAssetsRoot(() => wrapperMedia.loadLogo(ctxWith({})));
    expect(logo.ext).toBe("png");
    const blankCwd = tmp("cwd-blank");
    expect(withEnv({ STUDIO_ASSETS_ROOT: undefined }, () => inCwd(blankCwd, () => codeOf(() => wrapperMedia.loadLogo(ctxWith({})))))).toBe("STORAGE_ROOT_FORBIDDEN");
  });
  test("docx font catalog, relabel source, html font files and DOCX base ignore cwd", () => {
    const sources = inAssetsRoot(() => catalog.fontSourcesFromTemplate(tplWith({})));
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((s) => s.absPath.startsWith(`${ASSETS}/`))).toBe(true);
    // C31 manifest (row 108, C58): no fonts/renamed/* entry; every listed font exists under the root
    expect(sources.every((s) => existsSync(s.absPath) && !s.absPath.includes("/renamed/"))).toBe(true);
    // relabel no longer reads any font root (row 108: RELABEL_FACES = [], relabelSource -> not shipped)
    expect(relabel.RELABEL_FACES.length).toBe(0);
    const files = inAssetsRoot(() => htmlFonts.fontFiles(tplWith({})));
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.absPath.startsWith(`${ASSETS}/`) && !f.absPath.includes("/renamed/"))).toBe(true);
    expect(inAssetsRoot(() => base.locateBase(tplWith({}))).absPath).toBe(path.join(ASSETS, "base", "default.docx"));
    const blankCwd = tmp("cwd-blank");
    expect(withEnv({ STUDIO_ASSETS_ROOT: undefined }, () => inCwd(blankCwd, () => codeOf(() => catalog.fontSourcesFromTemplate(tplWith({})))))).toBe("STORAGE_ROOT_FORBIDDEN");
    expect(withEnv({ STUDIO_ASSETS_ROOT: undefined }, () => inCwd(blankCwd, () => codeOf(() => base.locateBase(tplWith({})))))).toBe("STORAGE_ROOT_FORBIDDEN");
  });
});
