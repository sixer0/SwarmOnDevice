// Row 49a (Swarm 1.2.0, decision C104 M3): the template export and its drift check run from this package alone.
// Before, scripts/export-builtin-templates.ts re-hashed every source against the clone at
// /private/tmp/claude-501/gspdc/src and read two data files only the clone had (benchmark/manual000/template.v2.json,
// datum-manual-000.preset.json), so `--check` failed with ENOENT once that temp folder was gone. Both files are now
// vendored (byte copies, provenance.json), and the clone comparison runs only when DATUM_STUDIO_CLONE names a folder.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PKG = path.resolve(import.meta.dir, "..", "..");
const SCRIPT = path.join(PKG, "scripts", "export-builtin-templates.ts");
const SOURCES = [
  "prisma/seed-studio.ts",
  "prisma/seed-studio-templates.ts",
  "prisma/seed-doc-type-templates.ts",
  "prisma/seed-derived-presets.ts",
  "benchmark/manual000/template.json",
  "benchmark/manual000/template.v2.json",
  "benchmark/manual000/datum-manual-000.preset.json",
];

function runCheck(clone: string | undefined) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "DATUM_STUDIO_CLONE") env[k] = v;
  if (clone !== undefined) env.DATUM_STUDIO_CLONE = clone;
  const p = Bun.spawnSync([process.execPath, SCRIPT, "--check"], { cwd: PKG, env, stdout: "pipe", stderr: "pipe" });
  // stdout = one-line JSON log entries (templates log sink), then the pretty-printed summary starting at a lone "{".
  const out = p.stdout.toString();
  const start = out.search(/^\{$/m);
  return { code: p.exitCode, stderr: p.stderr.toString(), summary: start >= 0 ? (JSON.parse(out.slice(start)) as { drift: number; valid: number; templates: number }) : undefined };
}

const sha = (f: string): string => createHash("sha256").update(readFileSync(f)).digest("hex");

describe("M3 export --check without the clone", () => {
  test("DATUM_STUDIO_CLONE unset: exit 0, drift 0, every template valid", () => {
    const r = runCheck(undefined);
    expect(r.stderr).not.toContain("ENOENT");
    expect(r.code).toBe(0);
    expect(r.summary?.drift).toBe(0);
    expect(r.summary?.valid).toBe(r.summary?.templates);
  });

  test("DATUM_STUDIO_CLONE empty or a missing folder: comparison skipped, drift 0", () => {
    expect(runCheck("").summary?.drift).toBe(0);
    const missing = runCheck(path.join(tmpdir(), "row49a-no-such-clone"));
    expect(missing.code).toBe(0);
    expect(missing.stderr).toContain("clone comparison skipped");
    expect(missing.summary?.drift).toBe(0);
  });

  test("DATUM_STUDIO_CLONE set to a folder: the comparison runs and stops on a differing source", () => {
    const base = mkdtempSync(path.join(tmpdir(), "row49a-clone-"));
    try {
      for (const rel of SOURCES) {
        mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
        cpSync(path.join(PKG, "vendor", rel), path.join(base, rel));
      }
      expect(runCheck(base).summary?.drift).toBe(0);
      writeFileSync(path.join(base, "benchmark/manual000/template.v2.json"), "{}\n");
      const bad = runCheck(base);
      expect(bad.code).not.toBe(0);
      expect(bad.stderr).toContain("differs from the clone");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("catalog sources name the vendored files with their sha256", () => {
    const catalog = JSON.parse(readFileSync(path.join(PKG, "templates", "catalog.json"), "utf8")) as { sources: Record<string, { path: string; sha256: string }> };
    const entries = Object.values(catalog.sources);
    expect(entries.map((e) => e.path).sort()).toEqual(SOURCES.map((s) => `packages/datum-studio/vendor/${s}`).sort());
    for (const e of entries) expect(sha(path.join(PKG, "vendor", e.path.slice("packages/datum-studio/vendor/".length)))).toBe(e.sha256);
  });
});
