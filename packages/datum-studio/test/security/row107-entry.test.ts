// Row 107 M5: the require.main entry blocks are gone; importing a module never executes main().
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PKG, tmp, VENDOR } from "./row107-helpers";

const ENTRY_FILES = ["scripts/studio/mcp/server.ts", "scripts/studio/studio-report.ts", "scripts/studio/draft-check.ts"];

describe("M5 direct-run guards removed", () => {
  test.each(ENTRY_FILES)("%s has no require.main / module guard", (rel) => {
    const src = readFileSync(path.join(VENDOR, rel), "utf8");
    expect(src).not.toContain("require.main");
    expect(src).not.toMatch(/===\s*module\b/);
  });

  test.each(ENTRY_FILES)("importing %s does not run main()", async (rel) => {
    const home = tmp("home");
    const proc = Bun.spawn([process.execPath, path.join(PKG, "test", "security", "row107-import-probe.ts"), path.join(VENDOR, rel)], {
      cwd: tmp("cwd"),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", HOME: home, HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost", STUDIO_MCP_FILE_ROOTS: home },
    });
    const timer = setTimeout(() => proc.kill(), 15000);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    expect(out).toBe("IMPORTED\n");
    expect(err).not.toContain("started");
    expect(err).not.toMatch(/usage|pemakaian|galat/i);
    expect(code).toBe(0);
  }, 20000);
});
