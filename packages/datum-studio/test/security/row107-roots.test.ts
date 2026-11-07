// Row 107: read roots never fall back to process.cwd(); traversal and absolute paths are refused.
import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ASSETS, codeOf, codeOfAsync, fakeRepo, inCwd, inCwdAsync, outsidePng, PNG_1X1, stubUi, tmp, withEnv } from "./row107-helpers";

stubUi();
const config = await import("../../vendor/scripts/studio/mcp/config");
const env = await import("../../vendor/src/lib/studio/contract/env");
const assets = await import("../../vendor/src/lib/studio/services/templates/assets");
const imp = await import("../../vendor/src/lib/studio/services/templates/import");
const ingest = await import("../../vendor/src/lib/studio/services/ingest/assets");

describe("M1 scripts/studio/mcp/config.ts: no cwd read root", () => {
  test("empty STUDIO_MCP_FILE_ROOTS is refused at startup (no cwd fallback)", () => {
    expect(codeOf(() => config.loadConfig({}, "/"))).toBe("CONFIG_INVALID");
    expect(codeOf(() => config.loadConfig({ STUDIO_MCP_FILE_ROOTS: "  " }, process.cwd()))).toBe("CONFIG_INVALID");
  });
  test("relative root refused; cwd argument has no effect on the roots", () => {
    expect(codeOf(() => config.loadConfig({ STUDIO_MCP_FILE_ROOTS: "docs" }, "/"))).toBe("CONFIG_INVALID");
    const root = tmp("roots");
    const a = config.loadConfig({ STUDIO_MCP_FILE_ROOTS: root }, "/");
    const b = inCwd(tmp("elsewhere"), () => config.loadConfig({ STUDIO_MCP_FILE_ROOTS: root }, process.cwd()));
    expect(a.fileRoots).toEqual([root]);
    expect(b.fileRoots).toEqual([root]);
  });
});

describe("M4 contract/env.ts: explicit roots", () => {
  test("studioAssetsRoot: missing or relative is refused, absolute is used as is, cwd ignored", () => {
    expect(withEnv({ STUDIO_ASSETS_ROOT: undefined }, () => codeOf(() => env.studioAssetsRoot()))).toBe("STORAGE_ROOT_FORBIDDEN");
    expect(withEnv({ STUDIO_ASSETS_ROOT: "src/lib/studio/assets" }, () => codeOf(() => env.studioAssetsRoot()))).toBe("STORAGE_ROOT_FORBIDDEN");
    const got = withEnv({ STUDIO_ASSETS_ROOT: ASSETS }, () => inCwd(tmp("cwd"), () => env.studioAssetsRoot()));
    expect(got).toBe(ASSETS);
  });
  test("assertPathInsideRoot refuses traversal, outside absolute, relative, NUL and symlink escape", () => {
    const { root, assets: a } = fakeRepo();
    expect(env.assertPathInsideRoot(path.join(a, "logo", "ok.png"), a)).toBe(path.join(a, "logo", "ok.png"));
    expect(codeOf(() => env.assertPathInsideRoot(`${a}/logo/../../../../../etc/hosts`, a))).toBe("PATH_OUTSIDE_ROOT");
    expect(codeOf(() => env.assertPathInsideRoot("/etc/hosts", a))).toBe("PATH_OUTSIDE_ROOT");
    expect(codeOf(() => env.assertPathInsideRoot("logo/ok.png", a))).toBe("PATH_OUTSIDE_ROOT");
    expect(codeOf(() => env.assertPathInsideRoot(`${a}/logo/ok.png\u0000`, a))).toBe("PATH_OUTSIDE_ROOT");
    symlinkSync(outsidePng(), path.join(a, "logo", "link.png"));
    expect(codeOf(() => env.assertPathInsideRoot(path.join(a, "logo", "link.png"), a))).toBe("PATH_OUTSIDE_ROOT");
    expect(root).toBeTruthy();
  });
  test("getStudioEnv: STUDIO_WORKSPACE_ROOT missing or relative is refused (no cwd default)", async () => {
    const fresh = async () => (await import(`../../vendor/src/lib/studio/contract/env.ts?row107=${Math.random()}`)) as typeof env;
    const unset = await fresh();
    expect(withEnv({ STUDIO_WORKSPACE_ROOT: undefined, SHARED_WORKSPACE: undefined }, () => codeOf(() => unset.getStudioEnv()))).toBe("STORAGE_ROOT_FORBIDDEN");
    const rel = await fresh();
    expect(withEnv({ STUDIO_WORKSPACE_ROOT: "data/studio-workspace", SHARED_WORKSPACE: undefined }, () => codeOf(() => rel.getStudioEnv()))).toBe("STORAGE_ROOT_FORBIDDEN");
    const ws = tmp("ws");
    const ok = await fresh();
    const got = withEnv({ STUDIO_WORKSPACE_ROOT: ws, SHARED_WORKSPACE: undefined }, () => inCwd(tmp("cwd"), () => ok.getStudioEnv().workspaceRoot));
    expect(got).toBe(ws);
  });
});

describe("M3/M4 services/templates/assets.ts: template asset resolver", () => {
  test("no cwd default: missing or relative repoRoot is refused", async () => {
    // @ts-expect-error -- the patch removes the default; an untyped caller must still fail closed
    expect(codeOf(() => assets.resolveRepoAssetPath("src/lib/studio/assets/logo/gsp-tinta.png"))).toBe("STORAGE_ROOT_FORBIDDEN");
    expect(codeOf(() => assets.resolveRepoAssetPath("src/lib/studio/assets/logo/gsp-tinta.png", "vendor"))).toBe("STORAGE_ROOT_FORBIDDEN");
    // @ts-expect-error -- as above
    expect(await codeOfAsync(() => assets.scanCanonicalAssets())).toBe("STORAGE_ROOT_FORBIDDEN");
  });
  test("traversal, absolute and symlink escape are refused; cwd change has no effect", () => {
    const { root, assets: a } = fakeRepo();
    expect(codeOf(() => assets.resolveRepoAssetPath("src/lib/studio/assets/../../../../etc/hosts", root))).toBe("PATH_OUTSIDE_ROOT");
    expect(codeOf(() => assets.resolveRepoAssetPath("/etc/hosts", root))).toBe("PATH_OUTSIDE_ROOT");
    symlinkSync(outsidePng(), path.join(a, "logo", "evil.png"));
    expect(codeOf(() => assets.resolveRepoAssetPath("src/lib/studio/assets/logo/evil.png", root))).toBe("PATH_OUTSIDE_ROOT");
    const here = assets.resolveRepoAssetPath("src/lib/studio/assets/logo/ok.png", root);
    const there = inCwd(tmp("cwd"), () => assets.resolveRepoAssetPath("src/lib/studio/assets/logo/ok.png", root));
    expect(here).toBe(path.join(a, "logo", "ok.png"));
    expect(there).toBe(here);
  });
});

describe("C13 M3 services/templates/import.ts: repoRoot required, presets confined", () => {
  const COVER = { slotKey: "cover", sectionType: "cover", label: "Cover", position: 1, required: true, positionLocked: true, repeatable: false, contentMode: "MIXED", tiers: [], admits: [], essentials: {} };
  const v2 = (dir: string, preset?: string) => {
    const f = path.join(dir, "t.json");
    writeFileSync(f, JSON.stringify({ $schema: "studio.template/v2", ...(preset ? { preset: { slug: preset } } : {}), essentials: {}, skeleton: { slots: [COVER] } }));
    return f;
  };
  test("loadResolvedTemplateV2File / loadResolvedProfileFile without repoRoot throw (no cwd default)", async () => {
    const dir = tmp("tpl");
    const f = v2(dir);
    expect(await codeOfAsync(() => inCwdAsync(dir, () => imp.loadResolvedTemplateV2File(f)))).toBe("STORAGE_ROOT_FORBIDDEN");
    const prof = path.join(dir, "p.json");
    writeFileSync(prof, JSON.stringify({ base: "datum-kanonik", slug: "x-y", kind: "DOCUMENT", overrides: {} }));
    expect(await codeOfAsync(() => inCwdAsync(dir, () => imp.loadResolvedProfileFile(prof)))).toBe("STORAGE_ROOT_FORBIDDEN");
  });
  test("presetFiles outside the template root (absolute or ../) are refused", async () => {
    const root = tmp("builtin");
    const f = v2(root, "evil");
    const outside = tmp("outside");
    const presetOut = path.join(outside, "evil.preset.json");
    writeFileSync(presetOut, JSON.stringify({ base: "datum-kanonik", slug: "evil", kind: "DOCUMENT", overrides: {} }));
    expect(await codeOfAsync(() => imp.loadResolvedTemplateV2File(f, { repoRoot: root, presetFiles: { evil: presetOut } }))).toBe("PATH_OUTSIDE_ROOT");
    expect(await codeOfAsync(() => imp.loadResolvedTemplateV2File(f, { repoRoot: root, presetFiles: { evil: path.relative(root, presetOut) } }))).toBe("PATH_OUTSIDE_ROOT");
  });
  test("sibling preset next to a template outside repoRoot is not read", async () => {
    const root = tmp("builtin");
    const outside = tmp("outside");
    const f = v2(outside, "evil");
    writeFileSync(path.join(outside, "evil.preset.json"), JSON.stringify({ base: "datum-kanonik", slug: "evil", kind: "DOCUMENT", overrides: {} }));
    expect(await codeOfAsync(() => imp.loadResolvedTemplateV2File(f, { repoRoot: root }))).toBe("TEMPLATE_NOT_FOUND");
  });
});

describe("M4 services/ingest/assets.ts: no cwd-relative asset candidates", () => {
  test("an index entry that exists only relative to cwd is not picked up", () => {
    const indexDir = tmp("index");
    const index = path.join(indexDir, "index.json");
    writeFileSync(index, JSON.stringify([{ id: "fig-1", path: "fig/only-in-cwd.png" }]));
    const cwd = tmp("cwd");
    mkdirSync(path.join(cwd, "fig"));
    writeFileSync(path.join(cwd, "fig", "only-in-cwd.png"), PNG_1X1);
    expect(inCwd(cwd, () => ingest.loadAssetIndex(index))).toEqual([]);
    mkdirSync(path.join(indexDir, "fig"));
    writeFileSync(path.join(indexDir, "fig", "only-in-cwd.png"), PNG_1X1);
    expect(inCwd(cwd, () => ingest.loadAssetIndex(index)).map((s) => s.absPath)).toEqual([path.join(indexDir, "fig", "only-in-cwd.png")]);
  });
});
