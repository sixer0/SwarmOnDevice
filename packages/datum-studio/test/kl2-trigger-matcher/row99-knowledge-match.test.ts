/**
 * 1.3.3 row 99 (spec KL-2 item 1): server-side trigger matcher. Unit checks against the real index the builder
 * wrote (packages/desktop/datum/knowledge-library/scripts/indeks_pemicu.json, decision C27) and small fixtures for
 * the weak-word rule and the failure paths. Python parity lives in row99-python-parity.test.ts.
 */
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  TRIGGER_INDEX_FILE,
  firstFileLocation,
  loadTriggerIndex,
  matchKnowledge,
  matchKnowledgeFromFile,
  normaliseForMatch,
  resolveTriggerIndexPath,
  triggerIndexCandidates,
} from "../../src/mcp-host/mission/knowledge-match.ts"

const SCRIPTS = path.resolve(import.meta.dir, "../../../desktop/datum/knowledge-library/scripts")
const INDEX = path.join(SCRIPTS, TRIGGER_INDEX_FILE)

function fixture(body: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "row99-"))
  const file = path.join(dir, TRIGGER_INDEX_FILE)
  fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body))
  return file
}

const SMALL = {
  domains: {
    POWER: { terms: ["ups", "kapasitas", "beban", "daya cadangan"], read_order: ["04_KNOWLEDGE-CARDS/POWER/A.md"] },
    EMPTY: { terms: ["kosong"], read_order: [] },
  },
  weak: ["kapasitas", "beban"],
}

describe("row 99 normalisation mirrors build_kl_index.match", () => {
  test("lower case, every run of other characters becomes one space, padded with spaces", () => {
    // values taken from python3 -I: ' ' + re.sub(r'[^0-9a-zà-ÿ/+\-]+', ' ', t.lower()) + ' '
    expect(normaliseForMatch("Buat DIAGRAM, topologi!")).toBe(" buat diagram topologi  ")
    expect(normaliseForMatch("db/km as-built 10+")).toBe(" db/km as-built 10+ ")
    expect(normaliseForMatch("é ü\tñ")).toBe(" é ü ñ ")
    expect(normaliseForMatch("")).toBe("  ")
  })
})

describe("row 99 match against the real index", () => {
  const loaded = loadTriggerIndex(INDEX)
  if (!loaded.index) throw new Error("real index did not load: " + loaded.reason)
  const index = loaded.index

  test("R11 text 2: fibre optic, storage, video in the Python order with first files", () => {
    const hits = matchKnowledge("hitung anggaran rugi ruas serat dan kapasitas penyimpanan rekaman 30 hari", index)
    expect(hits.map((h) => h.domain)).toEqual(["FIBER-OPTIC", "STORAGE", "VIDEO-SURVEILLANCE"])
    expect(hits[0].words).toEqual(["anggaran", "rugi", "serat"])
    expect(hits[0].firstFile).toBe("04_KNOWLEDGE-CARDS/FIBER-OPTIC/REF-FO-001.md")
  })

  test("R11 text 3: a non-technical title gives no domain", () => {
    expect(matchKnowledge("notulen rapat dan surat undangan", index)).toEqual([])
  })

  test("buat diagram topologi gives the diagram domain with its skill first file", () => {
    expect(matchKnowledge("buat diagram topologi", index)).toEqual([
      { domain: "DIAGRAM-STANDARD", firstFile: "skill:gsp-diagram-standard/references/index.md", words: ["diagram", "topologi"] },
    ])
  })

  test("one weak word gives nothing; two weak words of one domain select it", () => {
    expect(matchKnowledge("kapasitas", index)).toEqual([])
    expect(matchKnowledge("kapasitas ruang", index)).toEqual([])
    expect(matchKnowledge("kapasitas arsip", index).map((h) => h.domain)).toEqual(["STORAGE"])
  })

  test("multi-word phrase matches only as a whole phrase", () => {
    expect(matchKnowledge("gambar satu garis panel", index).map((h) => h.domain)).toContain("DIAGRAM-STANDARD")
    expect(matchKnowledge("satu-garis", index)).toEqual([])
    expect(matchKnowledge("satu orang, garis lurus", index)).toEqual([])
  })

  test("whole words only: no prefix or affix match", () => {
    expect(matchKnowledge("pentanahannya", index)).toEqual([])
    expect(matchKnowledge("menghitung redaman", index).map((h) => h.domain)).toEqual(["FIBER-OPTIC"])
  })
})

describe("row 99 weak rule on a fixture index", () => {
  const index = loadTriggerIndex(fixture(SMALL)).index!

  test("one weak = none, two weak = domain, one strong = domain", () => {
    expect(matchKnowledge("kapasitas", index)).toEqual([])
    expect(matchKnowledge("beban kapasitas", index)).toEqual([
      { domain: "POWER", firstFile: "04_KNOWLEDGE-CARDS/POWER/A.md", words: ["beban", "kapasitas"] },
    ])
    expect(matchKnowledge("UPS", index).map((h) => h.domain)).toEqual(["POWER"])
    expect(matchKnowledge("daya cadangan", index)[0].words).toEqual(["daya cadangan"])
  })

  test("a matched domain without a reading order is left out (it has no first file to name)", () => {
    expect(matchKnowledge("kosong", index)).toEqual([])
  })
})

describe("row 99 index problems never throw", () => {
  test("missing file", () => {
    const r = matchKnowledgeFromFile("buat diagram topologi", path.join(os.tmpdir(), "row99-absent", TRIGGER_INDEX_FILE))
    expect(r.domains).toEqual([])
    expect(r.reason).toMatch(/^index not readable: /)
  })
  test("no path at all", () => {
    expect(matchKnowledgeFromFile("buat diagram topologi", undefined)).toEqual({
      domains: [],
      reason: "index path not known",
    })
  })
  test("not JSON", () => {
    expect(matchKnowledgeFromFile("ups", fixture("{not json")).reason).toMatch(/^index not JSON: /)
  })
  test("no weak key (index from an older builder)", () => {
    const r = matchKnowledgeFromFile("ups", fixture({ domains: SMALL.domains }))
    expect(r).toEqual({ domains: [], reason: "index has no weak list" })
  })
  test("no domains object", () => {
    expect(matchKnowledgeFromFile("ups", fixture({ weak: [] })).reason).toBe("index has no domains")
  })
  test("good file gives domains and no reason", () => {
    expect(matchKnowledgeFromFile("ups", fixture(SMALL))).toEqual({
      domains: [{ domain: "POWER", firstFile: "04_KNOWLEDGE-CARDS/POWER/A.md", words: ["ups"] }],
    })
  })
})

describe("row 99 host helpers", () => {
  test("index candidates under a library root, explicit path first", () => {
    expect(triggerIndexCandidates({ libraryRoot: "/lib", explicitPath: "/x/i.json" })).toEqual([
      "/x/i.json",
      // row 151 (S8): the one search list the reader uses too (folders x names; see row151-one-library-loader.test.ts)
      path.join("/lib", TRIGGER_INDEX_FILE),
      path.join("/lib", "INDEKS-PEMICU.json"),
      path.join("/lib", "knowledge-library-index", TRIGGER_INDEX_FILE),
      path.join("/lib", "knowledge-library-index", "INDEKS-PEMICU.json"),
      path.join("/lib", "4 Knowledge Bank", "ekas-lapis-teks", TRIGGER_INDEX_FILE),
      path.join("/lib", "4 Knowledge Bank", "ekas-lapis-teks", "INDEKS-PEMICU.json"),
    ])
    expect(triggerIndexCandidates({})).toEqual([])
  })
  test("resolve picks the first candidate that exists, else undefined", () => {
    const file = fixture(SMALL)
    expect(resolveTriggerIndexPath({ libraryRoot: path.dirname(file), explicitPath: "/absent/i.json" })).toBe(file)
    expect(resolveTriggerIndexPath({ explicitPath: INDEX })).toBe(INDEX)
    expect(resolveTriggerIndexPath({ libraryRoot: "/absent-row99" })).toBeUndefined()
  })
  test("first-file location: library-relative or skill-relative", () => {
    expect(firstFileLocation("04_KNOWLEDGE-CARDS/FIBER-OPTIC/REF-FO-001.md")).toEqual({
      base: "library",
      path: "04_KNOWLEDGE-CARDS/FIBER-OPTIC/REF-FO-001.md",
    })
    expect(firstFileLocation("skill:gsp-diagram-standard/references/index.md")).toEqual({
      base: "skill",
      path: "gsp-diagram-standard/references/index.md",
    })
  })
})
