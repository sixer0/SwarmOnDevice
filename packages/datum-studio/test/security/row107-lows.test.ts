// Row 107 Lows L5, L6 and the row 27 H2 patch (verified present).
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { codeOf, stubUi, STUDIO, tmp, VENDOR } from "./row107-helpers";

stubUi();
const figure = await import("../../vendor/scripts/studio/mcp/figure-tools");
const safety = await import("../../vendor/scripts/studio/mcp/safety");

describe("L5 scripts/studio/mcp/figure-tools.ts mergeFigurePatch", () => {
  test("__proto__ / constructor / prototype keys from JSON are not copied", () => {
    const patch = JSON.parse('{"__proto__":{"polluted":1},"constructor":{"x":1},"prototype":2,"caption":"c"}');
    const out = figure.mergeFigurePatch({ data: [1] }, patch);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((out as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.keys(out).sort()).toEqual(["caption", "data"]);
    expect(out.constructor).toBe(Object);
  });
});

describe("L6 scripts/studio/mcp/safety.ts PROTECTED_DIRS", () => {
  test.each([".swarm", ".opencode"])("writing under %s is refused", (dir) => {
    const root = tmp("roots");
    mkdirSync(path.join(root, dir));
    expect(codeOf(() => safety.resolveAllowedPath(path.join(root, dir, "x.md"), [root], "write-report", safety.REAL_NODE_FS))).toBe("PATH_PROTECTED");
    expect(codeOf(() => safety.resolveAllowedPath(path.join(root, "ok.md"), [root], "write-report", safety.REAL_NODE_FS))).toBe("no-throw");
  });
});

describe("H2 engine/docx/package/parts.ts (row 27 patch, verify only)", () => {
  test("spacingAttr enum-checks and escapes lineRule; file matches provenance", () => {
    const rel = "src/lib/studio/engine/docx/package/parts.ts";
    const src = readFileSync(path.join(STUDIO, "engine", "docx", "package", "parts.ts"), "utf8");
    expect(src).toContain('const LINE_RULES: ReadonlySet<unknown> = new Set(["auto", "exact", "atLeast"]);');
    expect(src).toContain('`w:lineRule="${escapeXml(rule)}"`');
    expect(src).not.toContain('w:lineRule="${p.lineRule ?? "auto"}"');
    const prov = JSON.parse(readFileSync(path.join(VENDOR, "provenance.json"), "utf8")) as { files: Array<{ path: string; sha256: string; status: string }> };
    const entry = prov.files.find((f) => f.path === rel);
    expect(entry?.status).toBe("patched");
    expect(createHash("sha256").update(readFileSync(path.join(VENDOR, rel))).digest("hex")).toBe(entry?.sha256 ?? "");
  });
});
