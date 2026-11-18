// Swarm 1.3.3 row 69 (MC-8 item 2): `downloadDir` accepts a path relative to the mission's project folder.
// Real file system (real symlinks) under $TMPDIR. Absolute input keeps the pre-1.3.3 rules.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpToolError, prepareDownloadDir, REAL_NODE_FS, resolveDownloadDir } from "../../vendor/scripts/studio/mcp/safety";

const nfs = REAL_NODE_FS;
const BASE = realpathSync(mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "row69-")));
afterAll(() => rmSync(BASE, { recursive: true, force: true }));

/** session root (the only allowed root), a project inside it, a sibling folder inside the root, a folder outside. */
function world(name: string) {
  const root = path.join(BASE, name, "sesi");
  const project = path.join(root, "proyek");
  const sibling = path.join(root, "lain");
  const outside = path.join(BASE, name, "luar");
  for (const d of [project, sibling, outside]) mkdirSync(d, { recursive: true });
  return { root, project, sibling, outside };
}

function refusal(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof McpToolError) return { code: e.code, message: e.message };
    throw e;
  }
  return { code: "no-throw", message: "" };
}

describe("row 69: a relative downloadDir resolves inside the project", () => {
  const w = world("inside");

  test("relative path lands inside the project folder, not the session root", () => {
    expect(resolveDownloadDir("keluaran/rev-1", [w.root], nfs, w.project)).toBe(path.join(w.project, "keluaran", "rev-1"));
    expect(resolveDownloadDir("keluaran", [w.root], nfs, w.project)).toBe(path.join(w.project, "keluaran"));
    expect(resolveDownloadDir("./keluaran/", [w.root], nfs, w.project)).toBe(path.join(w.project, "keluaran"));
  });

  test('"." is the project folder itself', () => {
    expect(resolveDownloadDir(".", [w.root], nfs, w.project)).toBe(w.project);
  });

  test("project folder equal to the session root works", () => {
    expect(resolveDownloadDir("unduhan", [w.root], nfs, w.root)).toBe(path.join(w.root, "unduhan"));
  });

  test("prepareDownloadDir creates the resolved folder inside the project", () => {
    const dir = resolveDownloadDir("dibuat/dalam", [w.root], nfs, w.project);
    prepareDownloadDir(dir, [w.root], nfs, w.project);
    expect(existsSync(path.join(w.project, "dibuat", "dalam"))).toBe(true);
  });
});

describe("row 69: a relative downloadDir without project context is refused", () => {
  const w = world("nocontext");

  test.each([["undefined", undefined], ["null", null], ["empty", ""], ["blank", "   "]])("project %s -> PATH_INVALID naming the missing project", (_n, project) => {
    const r = refusal(() => resolveDownloadDir("keluaran", [w.root], nfs, project as string | null | undefined));
    expect(r.code).toBe("PATH_INVALID");
    expect(r.message).toContain("folder proyek");
    expect(r.message).toContain("relatif");
  });

  test("never resolved against the server working directory, even when cwd is the allowed root", () => {
    const before = process.cwd();
    process.chdir(w.root);
    try {
      expect(refusal(() => resolveDownloadDir("keluaran", [w.root], nfs)).code).toBe("PATH_INVALID");
      expect(refusal(() => resolveDownloadDir("keluaran", [w.root], nfs, null)).code).toBe("PATH_INVALID");
    } finally {
      process.chdir(before);
    }
    expect(existsSync(path.join(w.root, "keluaran"))).toBe(false);
  });
});

describe("row 69: escape attempts through a relative downloadDir are refused", () => {
  const w = world("escape");

  test.each([
    ["../x"],
    [".."],
    ["a/../../x"],
    ["a/.."],
    ["a/../b"],
    ["..\\x"],
    ["a\\..\\..\\x"],
  ])("'..' segment %p -> PATH_INVALID", (raw) => {
    expect(refusal(() => resolveDownloadDir(raw, [w.root], nfs, w.project)).code).toBe("PATH_INVALID");
  });

  test.each([["~"], ["~/x"], ["~root/x"], ["~\\x"]])("home shortcut %p -> PATH_INVALID", (raw) => {
    expect(refusal(() => resolveDownloadDir(raw, [w.root], nfs, w.project)).code).toBe("PATH_INVALID");
  });

  test.each([["C:x"], ["C:\\x"], ["c:/x"], ["x:aliran"], ["a/b:c"]])("drive or stream form %p -> PATH_INVALID", (raw) => {
    // On Windows `C:\x` is absolute and takes the absolute rules (outside the root); everywhere else it is refused here.
    const code = refusal(() => resolveDownloadDir(raw, [w.root], nfs, w.project)).code;
    expect(["PATH_INVALID", "PATH_OUTSIDE_ROOTS"]).toContain(code);
    if (process.platform !== "win32") expect(code).toBe("PATH_INVALID");
  });

  test.each([["\\\\host\\share\\x"], ["//host/share/x"], ["\\\\?\\C:\\x"], ["\\\\.\\C:\\x"], ["\\??\\C:\\x"]])("UNC or device form %p -> PATH_INVALID", (raw) => {
    expect(refusal(() => resolveDownloadDir(raw, [w.root], nfs, w.project)).code).toBe("PATH_INVALID");
  });

  test("NUL byte -> PATH_INVALID", () => {
    expect(refusal(() => resolveDownloadDir("a\u0000b", [w.root], nfs, w.project)).code).toBe("PATH_INVALID");
    expect(refusal(() => resolveDownloadDir("a\u0000/../../b", [w.root], nfs, w.project)).code).toBe("PATH_INVALID");
  });

  test.each([["nul"], ["a/CON.txt"], ["a./b"], ["a /b"], [""], ["   "]])("existing lexical rule still holds for relative %p", (raw) => {
    expect(refusal(() => resolveDownloadDir(raw, [w.root], nfs, w.project)).code).toBe("PATH_INVALID");
  });

  test.each([[".claude"], [".git/x"], ["kerja/.swarm"], [".CLAUDE"]])("instruction folder %p -> PATH_PROTECTED", (raw) => {
    expect(refusal(() => resolveDownloadDir(raw, [w.root], nfs, w.project)).code).toBe("PATH_PROTECTED");
  });

  test("symlink inside the project pointing outside the allowed root -> PATH_OUTSIDE_ROOTS", () => {
    symlinkSync(w.outside, path.join(w.project, "tautan-luar"));
    expect(refusal(() => resolveDownloadDir("tautan-luar", [w.root], nfs, w.project)).code).toBe("PATH_OUTSIDE_ROOTS");
    expect(refusal(() => resolveDownloadDir("tautan-luar/anak/baru", [w.root], nfs, w.project)).code).toBe("PATH_OUTSIDE_ROOTS");
    expect(existsSync(path.join(w.outside, "anak"))).toBe(false);
  });

  test("symlink inside the project pointing into the root but outside the project -> refused, names the project", () => {
    symlinkSync(w.sibling, path.join(w.project, "tautan-lain"));
    const r = refusal(() => resolveDownloadDir("tautan-lain/x", [w.root], nfs, w.project));
    expect(r.code).toBe("PATH_OUTSIDE_ROOTS");
    expect(r.message).toContain("folder proyek");
  });

  test("prepareDownloadDir re-check: a folder swapped for a symlink out of the project is not created", () => {
    const dir = resolveDownloadDir("nanti", [w.root], nfs, w.project);
    symlinkSync(w.sibling, dir); // planted after the first validation
    expect(refusal(() => prepareDownloadDir(path.join(dir, "anak"), [w.root], nfs, w.project)).code).toBe("PATH_OUTSIDE_ROOTS");
    expect(existsSync(path.join(w.sibling, "anak"))).toBe(false);
  });
});

describe("row 69: the project folder itself must be a safe place", () => {
  const w = world("project");

  test("project outside the allowed roots -> PATH_OUTSIDE_ROOTS", () => {
    expect(refusal(() => resolveDownloadDir("x", [w.root], nfs, w.outside)).code).toBe("PATH_OUTSIDE_ROOTS");
  });

  test("project given as a relative path -> PATH_INVALID", () => {
    expect(refusal(() => resolveDownloadDir("x", [w.root], nfs, "proyek")).code).toBe("PATH_INVALID");
  });

  test("project that is a symlink leaving the allowed roots -> PATH_OUTSIDE_ROOTS", () => {
    const link = path.join(w.root, "proyek-tautan");
    symlinkSync(w.outside, link);
    expect(refusal(() => resolveDownloadDir("x", [w.root], nfs, link)).code).toBe("PATH_OUTSIDE_ROOTS");
  });
});

describe("row 69: absolute downloadDir keeps the pre-1.3.3 rules", () => {
  const w = world("absolute");
  const cases: [string, (w: ReturnType<typeof world>) => string, string][] = [
    ["inside the root", (x) => path.join(x.root, "unduhan"), "no-throw"],
    ["inside the root but outside the project", (x) => path.join(x.sibling, "unduhan"), "no-throw"],
    ["inside the project", (x) => path.join(x.project, "unduhan"), "no-throw"],
    ["outside the allowed roots", (x) => path.join(x.outside, "unduhan"), "PATH_OUTSIDE_ROOTS"],
    ["'..' leaving the root", (x) => `${x.root}/../luar/x`, "PATH_OUTSIDE_ROOTS"],
    ["instruction folder", (x) => path.join(x.root, ".claude"), "PATH_PROTECTED"],
    ["UNC", () => "//host/share/x", "PATH_INVALID"],
  ];

  test.each(cases)("%s: same result with and without a project", (_n, make, code) => {
    const raw = make(w);
    const without = refusal(() => resolveDownloadDir(raw, [w.root], nfs));
    const withProject = refusal(() => resolveDownloadDir(raw, [w.root], nfs, w.project));
    expect(without.code).toBe(code);
    expect(withProject).toEqual(without);
    if (code === "no-throw") expect(resolveDownloadDir(raw, [w.root], nfs, w.project)).toBe(path.resolve(raw));
  });

  test("absolute symlink leaving the root is still refused", () => {
    const link = path.join(w.root, "abs-tautan");
    symlinkSync(w.outside, link);
    expect(refusal(() => resolveDownloadDir(link, [w.root], nfs, w.project)).code).toBe("PATH_OUTSIDE_ROOTS");
  });

  test("prepareDownloadDir without a project behaves as before", () => {
    const dir = path.join(w.sibling, "abs-dibuat");
    prepareDownloadDir(dir, [w.root], nfs);
    expect(existsSync(dir)).toBe(true);
    expect(refusal(() => prepareDownloadDir(path.join(w.outside, "x"), [w.root], nfs)).code).toBe("PATH_OUTSIDE_ROOTS");
    expect(existsSync(path.join(w.outside, "x"))).toBe(false);
  });
});
