// Row 29: Studio platform layer (studio spec §1.3 twins, §2 A-J macOS replacements).
// Twins under test: contract/env.ts (patch), contract/auth.ts (NEW twin), contract/ui.ts (twin),
// scripts/studio/_repo-alias.ts (twin), scripts/studio/mcp/config.ts (patch).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const PKG = path.resolve(import.meta.dir, "..", "..");
const VENDOR = path.join(PKG, "vendor");
const CONTRACT = path.join(VENDOR, "src", "lib", "studio", "contract");

function tmp(label: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), `row29-${label}-`)));
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function withEnvAsync<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function inCwdAsync<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(before);
  }
}

function inCwd<T>(dir: string, fn: () => T): T {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(before);
  }
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? `no-code:${(e as Error).message}`;
  }
  return "no-throw";
}

async function codeOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return (e as { code?: string }).code ?? `no-code:${(e as Error).message}`;
  }
  return "no-throw";
}

// No mock.module: the ui twin must load without lucide-react (it is not installed).
const contract = await import("../../vendor/src/lib/studio/contract");
const env = await import("../../vendor/src/lib/studio/contract/env");
const auth = await import("../../vendor/src/lib/studio/contract/auth");
const ui = await import("../../vendor/src/lib/studio/contract/ui");
const config = await import("../../vendor/scripts/studio/mcp/config");
const freshEnv = async () => (await import(`../../vendor/src/lib/studio/contract/env.ts?row29=${Math.random()}`)) as typeof env;
const freshAlias = async () => (await import(`../../vendor/scripts/studio/_repo-alias.ts?row29=${Math.random()}`)) as typeof import("../../vendor/scripts/studio/_repo-alias");

describe("contract/env.ts §2 B: workspace root", () => {
  test("relative STUDIO_WORKSPACE_ROOT is refused, also when cwd would make it valid", async () => {
    const cwd = tmp("cwd");
    mkdirSync(path.join(cwd, "data", "studio-workspace"), { recursive: true });
    const e = await freshEnv();
    const got = withEnv({ STUDIO_WORKSPACE_ROOT: "data/studio-workspace" }, () => inCwd(cwd, () => codeOf(() => e.getStudioEnv())));
    expect(got).toBe("STORAGE_ROOT_FORBIDDEN");
    const e2 = await freshEnv();
    expect(withEnv({ STUDIO_WORKSPACE_ROOT: "./ws" }, () => codeOf(() => e2.getStudioEnv()))).toBe("STORAGE_ROOT_FORBIDDEN");
    const e3 = await freshEnv();
    expect(withEnv({ STUDIO_WORKSPACE_ROOT: undefined }, () => codeOf(() => e3.getStudioEnv()))).toBe("STORAGE_ROOT_FORBIDDEN");
  });
  test("absolute root is used as is and does not depend on cwd", async () => {
    const ws = tmp("ws");
    const a = await freshEnv();
    const b = await freshEnv();
    const ra = withEnv({ STUDIO_WORKSPACE_ROOT: ws }, () => inCwd(tmp("c1"), () => a.getStudioEnv()));
    const rb = withEnv({ STUDIO_WORKSPACE_ROOT: ws }, () => inCwd("/", () => b.getStudioEnv()));
    expect(ra.workspaceRoot).toBe(ws);
    expect(rb.workspaceRoot).toBe(ws);
  });
});

describe("contract/env.ts §2 C: forbidden roots (replaces SHARED_WORKSPACE)", () => {
  const app = () => {
    const base = tmp("app");
    const res = path.join(base, "Swarm.app", "Contents", "Resources");
    const helper = path.join(base, "Swarm.app", "Contents", "Frameworks", "Swarm Helper.app", "Contents", "MacOS", "Swarm Helper");
    mkdirSync(path.join(res, "datum-studio"), { recursive: true });
    mkdirSync(path.dirname(helper), { recursive: true });
    return { base, res, helper, bundle: path.join(base, "Swarm.app") };
  };
  test("/ and $HOME are refused; a folder below $HOME is allowed", () => {
    const home = tmp("home");
    const store = path.join(home, ".local", "share", "swarm", "datum-studio");
    mkdirSync(store, { recursive: true });
    const facts = { home, resourcesPath: null, execPath: "/usr/bin/true" };
    expect(codeOf(() => env.assertWorkspaceRootAllowed("/", facts))).toBe("STORAGE_ROOT_FORBIDDEN");
    expect(codeOf(() => env.assertWorkspaceRootAllowed(home, facts))).toBe("STORAGE_ROOT_FORBIDDEN");
    expect(codeOf(() => env.assertWorkspaceRootAllowed(`${home}/`, facts))).toBe("STORAGE_ROOT_FORBIDDEN");
    expect(codeOf(() => env.assertWorkspaceRootAllowed(`${store}/../../../..`, facts))).toBe("STORAGE_ROOT_FORBIDDEN");
    expect(env.assertWorkspaceRootAllowed(store, facts)).toBe(store);
  });
  test("inside Res/ or the app bundle is refused (Res from resourcesPath, bundle from the helper execPath)", () => {
    const a = app();
    const facts = { home: tmp("h"), resourcesPath: a.res, execPath: a.helper };
    expect(codeOf(() => env.assertWorkspaceRootAllowed(a.res, facts))).toBe("STORAGE_ROOT_FORBIDDEN");
    expect(codeOf(() => env.assertWorkspaceRootAllowed(path.join(a.res, "datum-studio"), facts))).toBe("STORAGE_ROOT_FORBIDDEN");
    expect(codeOf(() => env.assertWorkspaceRootAllowed(path.join(a.bundle, "Contents", "MacOS"), facts))).toBe("STORAGE_ROOT_FORBIDDEN");
    // execPath alone (no resourcesPath) still finds the OUTER bundle, not "Swarm Helper.app".
    const onlyExec = { home: facts.home, resourcesPath: null, execPath: a.helper };
    expect(codeOf(() => env.assertWorkspaceRootAllowed(path.join(a.bundle, "Contents", "Resources", "x"), onlyExec))).toBe("STORAGE_ROOT_FORBIDDEN");
    expect(env.assertWorkspaceRootAllowed(path.join(a.base, "store"), facts)).toBe(path.join(a.base, "store"));
  });
  test("a symlink that points into Res/ is refused after realpath", () => {
    const a = app();
    const link = path.join(tmp("lnk"), "store");
    symlinkSync(path.join(a.res, "datum-studio"), link);
    expect(codeOf(() => env.assertWorkspaceRootAllowed(link, { home: tmp("h"), resourcesPath: a.res, execPath: "/usr/bin/true" }))).toBe("STORAGE_ROOT_FORBIDDEN");
  });
  test("relative or NUL roots are refused", () => {
    expect(codeOf(() => env.assertWorkspaceRootAllowed("ws", {}))).toBe("STORAGE_ROOT_FORBIDDEN");
    expect(codeOf(() => env.assertWorkspaceRootAllowed(`${tmp("n")}\u0000`, {}))).toBe("STORAGE_ROOT_FORBIDDEN");
  });
  test("getStudioEnv applies the rule (HOME as root is refused) and ignores SHARED_WORKSPACE", async () => {
    const home = tmp("envhome");
    const e = await freshEnv();
    expect(withEnv({ HOME: home, STUDIO_WORKSPACE_ROOT: home }, () => codeOf(() => e.getStudioEnv()))).toBe("STORAGE_ROOT_FORBIDDEN");
    const ws = path.join(home, "ws");
    mkdirSync(ws);
    const e2 = await freshEnv();
    // The clone refused a root inside SHARED_WORKSPACE (resolved against cwd); Swarm has no SHARED_WORKSPACE.
    const got = withEnv({ HOME: home, STUDIO_WORKSPACE_ROOT: ws, SHARED_WORKSPACE: home }, () => e2.getStudioEnv().workspaceRoot);
    expect(got).toBe(ws);
  });
});

describe("contract/env.ts §2 A, D, E, I, J", () => {
  test("A/D/E: no soffice, Chromium path or render-env manifest is read from env", async () => {
    const ws = tmp("ade");
    const e = await freshEnv();
    const got = withEnv(
      { STUDIO_WORKSPACE_ROOT: ws, SOFFICE_PATH: "/evil/soffice", STUDIO_CHROMIUM_PATH: "/evil/chrome", STUDIO_RENDER_ENV_MANIFEST: "/evil/m.json" },
      () => e.getStudioEnv(),
    );
    expect(got).toEqual({ workspaceRoot: ws, chromiumPath: env.STUDIO_CHROMIUM_BRIDGE_LABEL });
    const names = Object.keys(env);
    for (const gone of ["DEFAULT_SOFFICE_PATH", "DEFAULT_STUDIO_WORKSPACE_ROOT", "DEFAULT_STUDIO_CHROMIUM_PATH", "DEFAULT_STUDIO_RENDER_ENV_MANIFEST", "DEFAULT_STUDIO_SOFFICE_TIMEOUT_MS", "DEFAULT_STUDIO_SOFFICE_MAX_INSTANCES", "STUDIO_SOFFICE_MAX_INSTANCES_CAP"]) {
      expect(names).not.toContain(gone);
    }
  });
  test("source has no process.cwd() call, no Windows path and no env name of A/D/E", () => {
    const src = readFileSync(path.join(CONTRACT, "env.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/process\.cwd\s*\(/);
    expect(code).not.toMatch(/C:\\\\|\.exe"|soffice\.com/);
    expect(code).not.toMatch(/SOFFICE_PATH|STUDIO_CHROMIUM_PATH|STUDIO_RENDER_ENV_MANIFEST|STUDIO_SOFFICE_|SHARED_WORKSPACE/);
  });
  test("I: process.getBuiltinModule exists in this runtime; J: isPathInside is case-sensitive on darwin", () => {
    expect(typeof process.getBuiltinModule).toBe("function");
    expect(env.isPathInside("/a/b/c", "/a/b")).toBe(true);
    expect(env.isPathInside("/a/bc", "/a/b")).toBe(false);
    if (process.platform === "darwin") expect(env.isPathInside("/A/b/c", "/a/b")).toBe(false);
  });
});

describe("contract/auth.ts twin", () => {
  test("local caller: INTERNAL_AGENT, agent:<id>, never class K, never admin", () => {
    expect(auth.localStudioCaller("claude")).toEqual({ kind: "INTERNAL_AGENT", requester: "agent:claude", agentId: "claude", canWriteClassK: false });
    expect(auth.localStudioCaller("swarm").requester).toBe("agent:swarm");
    expect(auth.localStudioCaller(null)).toEqual({ kind: "INTERNAL_AGENT", requester: auth.ANONYMOUS_INTERNAL_REQUESTER, agentId: undefined, canWriteClassK: false });
    expect(auth.localStudioCaller("bad\nid").requester).toBe(auth.ANONYMOUS_INTERNAL_REQUESTER);
    expect(auth.localStudioCaller("x".repeat(200)).agentId).toHaveLength(80);
  });
  test("getStudioCaller: only a matching x-internal-secret; no secret env -> UNAUTHORIZED", async () => {
    const req = (h: Record<string, string>) => new Request("http://studio.local/api/studio/documents", { headers: h });
    await withEnvAsync({ INTERNAL_API_SECRET: "s3cret-row29" }, async () => {
      expect(await codeOfAsync(() => auth.getStudioCaller(req({})))).toBe("UNAUTHORIZED");
      expect(await codeOfAsync(() => auth.getStudioCaller(req({ "x-internal-secret": "wrong" })))).toBe("UNAUTHORIZED");
      // HQ cookie and a bearer JWT are no longer identities.
      expect(await codeOfAsync(() => auth.getStudioCaller(req({ cookie: "gsp_hq_session=x", authorization: "Bearer y" })))).toBe("UNAUTHORIZED");
      const ok = await auth.getStudioCaller(req({ "x-internal-secret": "s3cret-row29", "x-studio-agent": "claude" }));
      expect(ok).toEqual(auth.localStudioCaller("claude"));
      const arg = await auth.getStudioCaller(req({ "x-internal-secret": "s3cret-row29", "x-studio-agent": "claude" }), "swarm");
      expect(arg.requester).toBe("agent:swarm");
    });
    await withEnvAsync({ INTERNAL_API_SECRET: undefined }, async () => {
      expect(await codeOfAsync(() => auth.getStudioCaller(req({ "x-internal-secret": "" })))).toBe("UNAUTHORIZED");
    });
  });
  test("secretEquals is content- and length-exact", () => {
    expect(auth.secretEquals("abc", "abc")).toBe(true);
    expect(auth.secretEquals("abc", "abcd")).toBe(false);
    expect(auth.secretEquals("", "")).toBe(true);
  });
  test("barrel still re-exports StudioCaller (type) and the twin imports no next/next-auth/hq-session", () => {
    expect(contract).toBeTruthy();
    const src = readFileSync(path.join(CONTRACT, "auth.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["'](next|next\/[^"']*|next-auth[^"']*|@\/lib\/hq-session)["']/);
  });
});

describe("contract/ui.ts twin", () => {
  test("navigation data unchanged except icon = lucide export name", () => {
    expect(ui.STUDIO_NAV.map((e) => e.href)).toEqual(["/studio", "/studio/documents", "/studio/templates", "/studio/artifacts", "/studio/playground", "/studio/system"]);
    for (const e of [...ui.STUDIO_NAV, ...ui.STUDIO_PALETTE_ACTIONS]) expect(e.icon).toBe(e.iconName);
    expect(ui.studioNavFor(false).map((e) => e.href)).toEqual(["/studio", "/studio/documents", "/studio/templates", "/studio/artifacts"]);
    expect(ui.studioPageTitle("Dokumen")).toBe("Dokumen · Studio · GSP Swarm HQ");
  });
  test("lucide-react is not resolvable here, and the twin loaded without it", () => {
    // On-disk check (a mock.module in another test file of the same run would fool require.resolve).
    for (const nm of [path.join(PKG, "node_modules"), path.join(PKG, "..", "..", "node_modules")]) {
      expect(existsSync(path.join(nm, "lucide-react"))).toBe(false);
    }
    expect(readFileSync(path.join(CONTRACT, "ui.ts"), "utf8")).not.toMatch(/from\s+["']lucide-react["']/);
  });
});

describe("scripts/studio/_repo-alias.ts twin", () => {
  test("REPO_ROOT comes from absolute STUDIO_VENDOR_ROOT only; never cwd or the module location", async () => {
    const root = tmp("vendorroot");
    const a = await withEnvAsync({ STUDIO_VENDOR_ROOT: root }, () => inCwdAsync(tmp("c"), () => freshAlias()));
    expect(a.REPO_ROOT).toBe(root);
    const b = await withEnvAsync({ STUDIO_VENDOR_ROOT: "vendor" }, () => freshAlias());
    expect(b.REPO_ROOT).toBe(b.REPO_ROOT_UNSET);
    const c = await withEnvAsync({ STUDIO_VENDOR_ROOT: undefined }, () => freshAlias());
    expect(c.REPO_ROOT).toBe("/var/empty");
    expect(c.resolveRepoRoot({ STUDIO_VENDOR_ROOT: `${root}/x/..` })).toBe(root);
  });
  test("no Module._resolveFilename hook is installed", async () => {
    const before = (Module as unknown as { _resolveFilename?: unknown })._resolveFilename;
    await freshAlias();
    expect((Module as unknown as { _resolveFilename?: unknown })._resolveFilename).toBe(before);
    expect((Module as unknown as Record<symbol, unknown>)[Symbol.for("gsp.studio.cli.repoAlias")]).toBeUndefined();
  });
  test("guideSection170 reads the guide under the vendor root (dev layout)", async () => {
    const res = await import("../../vendor/scripts/studio/mcp/resources");
    expect(statSync(path.join(VENDOR, "docs", "STUDIO-AGENT-GUIDE.md")).isFile()).toBe(true);
    const a = await withEnvAsync({ STUDIO_VENDOR_ROOT: VENDOR }, () => freshAlias());
    expect(res.guideSection170(a.REPO_ROOT)).toBeTruthy();
    expect(res.guideSection170((await withEnvAsync({ STUDIO_VENDOR_ROOT: undefined }, () => freshAlias())).REPO_ROOT)).toBeNull();
  });
});

describe("scripts/studio/mcp/config.ts patch", () => {
  test("server identity datum-studio 1.2.0", () => {
    expect(config.MCP_SERVER_NAME).toBe("datum-studio");
    expect(config.MCP_SERVER_VERSION).toBe("1.2.0");
  });
  test("toolsets: all on by default (write no longer opt-in), reports kept (U19), templates and missions present", () => {
    const root = tmp("roots");
    expect(config.loadConfig({ STUDIO_MCP_FILE_ROOTS: root }, "/").toolsets).toEqual(["documents", "query", "write", "templates", "reports", "missions"]);
    expect(config.parseToolsets("all")).toEqual(["documents", "query", "write", "templates", "reports", "missions"]);
    expect(config.parseToolsets("write,documents")).toEqual(["documents", "write"]);
    expect(codeOf(() => config.parseToolsets("drafts"))).toBe("CONFIG_INVALID");
    expect([...config.OPT_IN_TOOLSETS]).toEqual([]);
  });
  test("row 107 M1 kept: empty roots still refused", () => {
    expect(codeOf(() => config.loadConfig({}, "/"))).toBe("CONFIG_INVALID");
  });
});

describe("row 29 grep gate: no next, next-auth or lucide-react import in the shipped vendor code", () => {
  test("vendor/src and vendor/scripts (seeds under vendor/prisma are build input only)", () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, n.name);
        if (n.isDirectory()) walk(p);
        else if (/\.(ts|tsx|mts|js|mjs)$/.test(n.name)) {
          const t = readFileSync(p, "utf8");
          if (/(?:from|import)\s*\(?\s*["'](?:next|next\/[^"']*|next-auth(?:\/[^"']*)?|lucide-react)["']/.test(t)) hits.push(path.relative(VENDOR, p));
        }
      }
    };
    walk(path.join(VENDOR, "src"));
    walk(path.join(VENDOR, "scripts"));
    expect(hits).toEqual([]);
  });
});
