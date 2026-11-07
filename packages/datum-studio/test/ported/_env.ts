// Row 42 W5: environment the Swarm host always provides (studio spec §2 B; row 107 M4, row 29).
// The original tests ran from the clone root with cwd fallbacks; the vendored copy has none:
// STUDIO_ASSETS_ROOT must be the absolute asset root and STUDIO_WORKSPACE_ROOT an absolute,
// allowed workspace root. Every ported test file calls useStudioEnv() as its first statement:
// the values are set at once (describe bodies run at collection, before hooks) and restored in
// that file's afterAll, so no other suite in the same bun process sees them (C65/C71 lesson).
// A function, not an import side effect: bun shares the module registry across test files.
import { afterAll } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetStudioEnvCache } from "../../vendor/src/lib/studio/contract/env";

export const VENDOR_ROOT = path.resolve(import.meta.dir, "..", "..", "vendor");
export const ASSETS_ROOT = path.join(VENDOR_ROOT, "src", "lib", "studio", "assets");

/**
 * Row 42 W14: absolute path of a vendored seed module (vendor/prisma/<name>.ts, build-time input of the row 110 export).
 * The ported seed tests import it through this computed specifier so `tsgo --noEmit` does not pull vendor/prisma/**
 * (excluded in tsconfig.json; it names @prisma/client) into the package program.
 */
export function seedModule(name: string): string {
  return path.join(VENDOR_ROOT, "prisma", `${name}.ts`);
}

const KEYS = ["STUDIO_ASSETS_ROOT", "STUDIO_WORKSPACE_ROOT"] as const;

export function useStudioEnv(): { workspaceRoot: string } {
  const before = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const workspaceRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "row42-ws-")));
  process.env.STUDIO_ASSETS_ROOT = ASSETS_ROOT;
  process.env.STUDIO_WORKSPACE_ROOT = workspaceRoot;
  resetStudioEnvCache();
  afterAll(() => {
    for (const k of KEYS) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
    resetStudioEnvCache();
  });
  return { workspaceRoot };
}
