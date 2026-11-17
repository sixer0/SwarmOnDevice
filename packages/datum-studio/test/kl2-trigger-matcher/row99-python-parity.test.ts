/**
 * 1.3.3 row 99 (spec KL-2 item 1): parity of the TS trigger matcher with the Python matcher of the index builder
 * (`build_kl_index.match`, decision C27 location). Both read the same `indeks_pemicu.json`; the Python side runs in an
 * isolated interpreter (`python3 -I -B`, nothing written) and returns domain, found words and first file per text.
 *
 * Second check, only when KL_LIBRARY_ROOT names a library root (".../4 Knowledge Bank/ekas-lapis-teks") or, failing
 * that, SWARM_REPLAY_DIR holds the R11 replay copy (row 146: one variable for every replay input): the builder's own
 * CLI `--match`, which rebuilds the index from the library, for the R11 texts. Skipped when neither is set.
 */
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { TRIGGER_INDEX_FILE, loadTriggerIndex, matchKnowledge } from "../../src/mcp-host/mission/knowledge-match.ts"
import { existsSync } from "node:fs"
import { replayPath } from "../replay-dir"

const SCRIPTS = path.resolve(import.meta.dir, "../../../desktop/datum/knowledge-library/scripts")
const INDEX = path.join(SCRIPTS, TRIGGER_INDEX_FILE)
const PYTHON = Bun.which("python3")
const R11_ROOT = replayPath("R11_library", "ai-knowledge-library-edisi-umum", "4 Knowledge Bank", "ekas-lapis-teks")
const LIBRARY = process.env.KL_LIBRARY_ROOT ?? (R11_ROOT && existsSync(R11_ROOT) ? R11_ROOT : undefined)
const NO_LIBRARY = "row 99 R11 CLI parity: library not available (set KL_LIBRARY_ROOT, or SWARM_REPLAY_DIR=<1.3.3 patch folder>/research/replay)"
if (!LIBRARY) console.log(`[skip] ${NO_LIBRARY}`)
if (!LIBRARY) test.skip(NO_LIBRARY, () => {})

// R11 texts 2 and 3 are verbatim (research/05_replay_inventory.md R11); texts 1 and 4 were never stored and are not
// substituted here.
const R11 = ["hitung anggaran rugi ruas serat dan kapasitas penyimpanan rekaman 30 hari", "notulen rapat dan surat undangan"]

const TEXTS = [
  ...R11,
  "buat diagram topologi",
  "Buat Diagram Topologi Jaringan Pusat Kendali",
  "gambar satu garis panel listrik gedung",
  "satu-garis",
  "rapat koordinasi mingguan tim pemasaran",
  "susun jadwal cuti karyawan dan daftar hadir",
  "kapasitas",
  "kapasitas ruang",
  "kapasitas arsip",
  "data model",
  "beban kerja proyek",
  "hitung redaman serat optik ruas 12 km dengan OTDR",
  "rencana pembumian dan proteksi petir menara BTS",
  "pentanahannya belum diukur",
  "sizing UPS 10 kVA dan baterai VRLA untuk ruang server",
  "kebutuhan bandwidth CCTV 64 kamera 4 MP 25 fps, retensi rekaman 30 hari",
  "konfigurasi VLAN, QoS dan firewall di switch inti",
  "analisis keandalan MTBF dan interval pemeliharaan genset",
  "survei GNSS dan peta topografi lokasi menara",
  "perhitungan beban angin pada tiang dan pondasi beton",
  "deteksi objek dengan computer vision pada video analitik",
  "arsitektur sistem: kebutuhan, verifikasi dan validasi antarmuka",
  "link budget microwave dan zona fresnel 7 GHz",
  "pendinginan ruang server: beban panas dan BTU",
  "ITP dan inspeksi QA/QC proyek",
  "loss budget db/km, as-built ODF",
  "İP kamera ÉTÉ — naïve café",
  "",
]

type PyHit = { domain: string; words: string[]; firstFile: string }

function pythonMatches(texts: string[]): { weakEqual: boolean; results: PyHit[][] } {
  const program = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "import build_kl_index as b",
    "t = json.load(open(sys.argv[2], encoding='utf-8'))",
    "texts = json.loads(sys.stdin.read())",
    "out = [[{'domain': d, 'words': w, 'firstFile': t['domains'][d]['read_order'][0]} for d, w in b.match(t, x).items()] for x in texts]",
    "print(json.dumps({'weakEqual': sorted(b.WEAK) == t['weak'], 'results': out}))",
  ].join("\n")
  const run = Bun.spawnSync([PYTHON!, "-I", "-B", "-c", program, SCRIPTS, INDEX], {
    stdin: new TextEncoder().encode(JSON.stringify(texts)),
  })
  if (run.exitCode !== 0) throw new Error("python matcher failed: " + run.stderr.toString())
  return JSON.parse(run.stdout.toString())
}

describe.skipIf(!PYTHON)("row 99 parity with build_kl_index.match (python3 required)", () => {
  if (!PYTHON) console.warn("row 99 parity skipped: python3 not found on PATH")
  const index = loadTriggerIndex(INDEX).index!
  const py = pythonMatches(TEXTS)

  test("the index's weak list is the builder's WEAK (one source, decision C7 item 2)", () => {
    expect(py.weakEqual).toBe(true)
  })

  test(`at least 20 texts compared (${TEXTS.length})`, () => {
    expect(TEXTS.length).toBeGreaterThanOrEqual(20)
  })

  TEXTS.forEach((text, i) => {
    test(`parity ${i + 1}: ${JSON.stringify(text)}`, () => {
      const ts = matchKnowledge(text, index).map((h) => ({ domain: h.domain, words: h.words, firstFile: h.firstFile }))
      expect(ts).toEqual(py.results[i])
    })
  })

  test("the set covers no-domain, weak-only and diagram cases", () => {
    const domains = (i: number) => py.results[i].map((h) => h.domain)
    expect(domains(TEXTS.indexOf("notulen rapat dan surat undangan"))).toEqual([])
    expect(domains(TEXTS.indexOf("kapasitas"))).toEqual([])
    expect(domains(TEXTS.indexOf("kapasitas arsip"))).toEqual(["STORAGE"])
    expect(domains(TEXTS.indexOf("buat diagram topologi"))).toEqual(["DIAGRAM-STANDARD"])
  })
})

describe.skipIf(!PYTHON || !LIBRARY)("row 99 R11 texts against the builder CLI --match (KL_LIBRARY_ROOT or SWARM_REPLAY_DIR)", () => {
  const index = loadTriggerIndex(INDEX).index!
  R11.forEach((text) => {
    test(`CLI parity: ${text}`, () => {
      const run = Bun.spawnSync([PYTHON!, "-I", "-B", path.join(SCRIPTS, "build_kl_index.py"), "--root", LIBRARY!, "--match", text])
      expect(run.exitCode).toBe(0)
      const cli = run.stdout
        .toString()
        .split("\n")
        .filter((line) => line.includes(" <- "))
        .map((line) => {
          const m = /^(\S+) <- (.*) \| buka dulu: (.*)$/.exec(line)!
          return { domain: m[1], words: m[2].split(", "), firstFile: m[3] }
        })
      expect(matchKnowledge(text, index).map((h) => ({ domain: h.domain, words: h.words, firstFile: h.firstFile }))).toEqual(cli)
    })
  })
})
