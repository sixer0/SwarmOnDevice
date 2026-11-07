// Row 107 test helpers (security patch guards on the vendored Studio copy).
import { mock } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const PKG = path.resolve(import.meta.dir, "..", "..");
export const VENDOR = path.join(PKG, "vendor");
export const STUDIO = path.join(VENDOR, "src", "lib", "studio");
export const ASSETS = path.join(STUDIO, "assets");

// contract/ui.ts imports lucide-react, a UI-only package that row 29 replaces with a twin and
// that is not installed here. Only these seven named icons are read at module load.
export function stubUi(): void {
  const icon = () => null;
  mock.module("lucide-react", () => ({
    Activity: icon,
    FilePlus2: icon,
    FileStack: icon,
    FileText: icon,
    FlaskConical: icon,
    LayoutTemplate: icon,
    Shapes: icon,
  }));
}

/** Fresh temp dir (realpath, so /var vs /private/var never matters). */
export function tmp(label: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), `row107-${label}-`)));
}

/** A valid 1x1 PNG. */
export const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);

/** A real PNG placed OUTSIDE every Studio root (the "secret" a template must not embed). */
export function outsidePng(): string {
  const dir = tmp("outside");
  const p = path.join(dir, "secret.png");
  writeFileSync(p, PNG_1X1);
  return p;
}

/** Fake repo root with `src/lib/studio/assets/<rel>` written or symlinked. */
export function fakeRepo(): { root: string; assets: string } {
  const root = tmp("repo");
  const assets = path.join(root, "src", "lib", "studio", "assets");
  mkdirSync(path.join(assets, "logo"), { recursive: true });
  writeFileSync(path.join(assets, "logo", "ok.png"), PNG_1X1);
  return { root, assets };
}

/** Run `fn` with process cwd set to `dir`, restoring it afterwards. */
export function inCwd<T>(dir: string, fn: () => T): T {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(before);
  }
}

export async function inCwdAsync<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(before);
  }
}

/** Run `fn` with env vars set (undefined = unset), restoring them afterwards. */
export function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
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

/** Error code of a thrown StudioEngineError / ConfigError / McpToolError, or "no-throw". */
export function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "no-throw";
  } catch (e) {
    return String((e as { code?: unknown }).code ?? (e as Error).name);
  }
}

export async function codeOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "no-throw";
  } catch (e) {
    return String((e as { code?: unknown }).code ?? (e as Error).name);
  }
}
