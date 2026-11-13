// 1.2.8 row 59a, G3-04: provenance.json `counts` must equal the recount of files[] and the files on disk.
// Delta bookkeeping hid a wrong starting value in 1.2.0 and 1.2.8 (lock incident C121); only recomputation catches it.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const VENDOR = path.resolve(import.meta.dir, "../../vendor");
type Entry = { path: string; status: string; bytes: number; sha256: string };
const prov = JSON.parse(readFileSync(path.join(VENDOR, "provenance.json"), "utf8")) as {
  counts: Record<string, number>;
  files: Entry[];
};

describe("G3-04 provenance counts", () => {
  test("counts equal the recount of the entries and the files on disk", () => {
    const by = (s: string) => prov.files.filter((e) => e.status === s).length;
    const bytes = prov.files.reduce((n, e) => n + readFileSync(path.join(VENDOR, e.path)).length, 0);
    expect(prov.counts).toEqual({
      files: prov.files.length,
      copied: by("copied"),
      patched: by("patched"),
      replaced: by("replaced"),
      added: by("added"),
      bytes,
    });
    expect(by("copied") + by("patched") + by("replaced") + by("added")).toBe(prov.files.length);
  });

  test("every entry bytes and sha256 match its file", () => {
    const bad = prov.files.filter((e) => {
      const data = readFileSync(path.join(VENDOR, e.path));
      return data.length !== e.bytes || createHash("sha256").update(data).digest("hex") !== e.sha256;
    });
    expect(bad.map((e) => e.path)).toEqual([]);
  });
});
