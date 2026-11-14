// Swarm 1.2.9 row 34 (AC-A11a, spec 01a AT-A11a, register N9-111; decision C10(f)). In the chart flowchart (G-04) a BPMN
// event outline is drawn with one uniform scale, so it is a circle (rx = ry) and the connector ends glued onto it by
// `routePlaced` stay on its rim. Charts without a label-below BPMN shape keep the two-axis scale: g04 and every chart
// parity render stay byte-identical (pins = sha256 of the renders at HEAD before row 34, equal at BASE d4282fcfd8).
// Fixture: test/fixtures/syn129/a11_chart_bpmn_flow.json (N9-155, `no_direction` and `direction_tb`), styles datum and
// gallery. Red at BASE: every event arc is `A4.8366 1.9347`, rx/ry = 2.50 (the `sx <= 2.5 sy` cap of the chart scale).
import { useStudioEnv } from "../_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import * as chartMod from "../../../vendor/src/lib/studio/engine/chart/core"

type J = any
const FX = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "..", "fixtures", "syn129", "a11_chart_bpmn_flow.json"), "utf8")) as J
const PARITY_CHART_DIR = path.join(import.meta.dir, "..", "_fixtures", "tests", "parity", "fixtures", "chart")
const render = (chart: J, style: string): J => (chartMod as J).renderChart({ ...structuredClone(chart), style })
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex")

type Pt = { x: number; y: number }
const pts = (d: string): Pt[] => [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }))

/** The outline path(s) of node `id` and every arc in them: centre from the move-to and the far end of the first arc. */
function eventArcs(svg: string, id: string): { rx: number; ry: number; cx: number; cy: number }[] {
  const out: { rx: number; ry: number; cx: number; cy: number }[] = []
  for (const m of svg.matchAll(/<path [^>]*d="([^"]+)"[^>]*data-node="([^"]+)"/g)) {
    if (m[2] !== id) continue
    const d = m[1]
    const head = /^M(-?[\d.]+) (-?[\d.]+)A(-?[\d.]+) (-?[\d.]+) 0 1 0 (-?[\d.]+) (-?[\d.]+)/.exec(d)
    if (!head) continue
    const [x0, y0, , , x1] = head.slice(1).map(Number)
    for (const a of d.matchAll(/A(-?[\d.]+) (-?[\d.]+) /g)) out.push({ rx: Number(a[1]), ry: Number(a[2]), cx: (x0 + x1) / 2, cy: y0 })
  }
  return out
}

/** Link `index`: the start of its line and its tip (solid head: the move-to of the closed head; open head: its middle point). */
function linkEnds(svg: string, index: number): { start: Pt; tip: Pt } {
  const ds = [...svg.matchAll(/<path data-mark="link" data-series="konektor" data-index="(\d+)" d="([^"]+)"/g)].filter((m) => Number(m[1]) === index).map((m) => m[2])
  expect(ds.length, `link ${index}: line + head`).toBe(2)
  const head = ds[1]
  return { start: pts(ds[0])[0], tip: head.endsWith("Z") ? pts(head)[0] : pts(head)[1] }
}

const EVENTS = new Set(["event_start", "event_intermediate", "event_end"])

describe("AC-A11a chart flowchart: BPMN events are circles (N9-155)", () => {
  for (const variant of ["no_direction", "direction_tb"]) {
    for (const style of ["datum", "gallery"]) {
      test(`${variant} @${style}: every event outline arc has rx = ry and connector ends on an event lie on its circle`, () => {
        const chart = FX[variant]
        const svg = render(chart, style).svg as string
        const nodes = chart.data.spec.nodes as J[]
        const events = nodes.filter((n) => EVENTS.has(n.shape))
        expect(events.length, "fixture events").toBe(2)
        const ratios: string[] = []
        for (const n of events) {
          const arcs = eventArcs(svg, n.id)
          expect(arcs.length, `node ${n.id}: outline arcs`).toBeGreaterThanOrEqual(2)
          for (const a of arcs) ratios.push(`${n.id} rx/ry=${(a.rx / a.ry).toFixed(2)}`)
        }
        for (const n of events) for (const a of eventArcs(svg, n.id)) expect(Math.abs(a.rx - a.ry), `node ${n.id}: ${ratios.join(", ")}`).toBeLessThanOrEqual(0.01)
        const edges = chart.data.spec.edges as J[]
        let ends = 0
        edges.forEach((e, i) => {
          const { start, tip } = linkEnds(svg, i)
          for (const [id, p] of [[e.from, start], [e.to, tip]] as const) {
            const n = nodes.find((x) => x.id === id)
            if (!EVENTS.has(n?.shape)) continue
            const c = eventArcs(svg, id)[0]
            const dist = Math.hypot(p.x - c.cx, p.y - c.cy)
            expect(Math.abs(dist - c.rx), `link ${i} end on ${id}: distance ${dist.toFixed(4)} vs r ${c.rx}`).toBeLessThanOrEqual(0.1)
            ends++
          }
        })
        expect(ends, "connector ends on events").toBe(3)
      })
    }
  }
})

/** sha256 of every chart parity render (datum + gallery) at HEAD before row 34 (equal at BASE d4282fcfd8). */
const PINS: Record<string, string> = {
  "g01.json@datum": "41efb18256393907e89f7b14056e89f42d200223c3e54d3d099666a96602752a",
  "g01.json@gallery": "bc221d5c257402bb23522760525c1e19ab120ee953fcf189dffc8fb2699c2eb2",
  "g04.json@datum": "37039bce2451383aa168efd9cd5fed86322be0be3ea60ddbe55c7e28ca68f07c",
  "g04.json@gallery": "006e6ee19675485b8b66286bff9d23957357e087bbb0e1e6cf8ddc5fb09f48e6",
  "h01.json@datum": "8824bc8ce40c1014562a8c3e111b8a58dd1d86d0a76287481f9706c14d9537a8",
  "h01.json@gallery": "65178ab905b0f0006d38382596de8e77eb6299b17335825b392aab7b571cffbf",
  "h02.json@datum": "c332d58acb5379bbea24cec9b2b1c4f2e66a638e757dbdd6bb221407bc0fcd1f",
  "h02.json@gallery": "e19fd4e31ba240fc2f0aa96a31016f2bae09a3962e6f656eb40a03712fddcce8",
  "h03.json@datum": "08861dd7d184049b8d57085293775aa56d38b5e042456e7d194519732c2f7cce",
  "h03.json@gallery": "225c83fb74b08f91fa2fdbff36f797471aa47bb1902aeea9edf449b899b937d1",
  "h04.json@datum": "c549651911dbd11d418d72aaef680f3f16f83bca2e9f69f6cacf8cac825f8294",
  "h04.json@gallery": "4a638a17e6d292053003df4caf550d601b097631bb74a44631ca55548be6d69b",
  "h05.json@datum": "784e9c5953eb9cdf972327554f3d2297296ca48428b5a0034104554dc2fe9614",
  "h05.json@gallery": "7c7789105a76a7fd58aa3b762b923faab2aa4a457eac4947c594e0a3e284c973",
  "h06.json@datum": "dae6c1fe6a0944c6cbcea9185d0e5da1648533f674d667356ed35bd64c705afa",
  "h06.json@gallery": "ccaef68341b0836e42d59cd1e95b0251137ca9f8326e22367d21790efa25dd38",
  "h07.json@datum": "a8bb37f90577a4385646226f0798ddd5593de04b51742bdce89da1bcac8df764",
  "h07.json@gallery": "4f74a8b43974ac45f97a5af297770b0547108caee35ec5313f4581f37c828616",
  "k01.json@datum": "5c5cf5a2f11cbadd3f60b4932724d8f3dc0719de99c4c601775d8b999406cd42",
  "k01.json@gallery": "6ac63c0c0fc7fad6e19ddf39f626a23ac9d0f7405059e1210bed439c9c5722a7",
  "k02.json@datum": "74b6d54cf849c6643dbe12fc711efef98b03e2862ddd08ad7744a507c3f3c865",
  "k02.json@gallery": "3182952525fc3ea936503024aa15218f5dd33377d6a59b507997c1a51bfd4927",
  "k03.json@datum": "6a537318ac09a8d970c5213e490e8422dc22b24bb575554b437cc1e2910a21aa",
  "k03.json@gallery": "a67763cb20000fc0baa1be37e4921b0b7a5dcb8857c1c83dcd432ef2c31e7b59",
  "k04.json@datum": "214b4dfbc8a1f841eb2390460f1232faf9f91395db955330008f891e086d77e3",
  "k04.json@gallery": "498a72d710ca4c249db9f930797fb869b0e7fcc8d22cace8b6241ffe85daaec0",
  "k07.json@datum": "7c19b542fbfb1a06476e64233f84ec1d2c4f08de976ae30623cefcf32f132b5d",
  "k07.json@gallery": "90401ff701d2a23e0ef87bab20694e79f515c62f0698960f4e189317b6f3d559",
  "k08.json@datum": "c803fb85da28cb1e9cc6ed71d63f33819e080a232aff6edaf21c83ad6bb69710",
  "k08.json@gallery": "8699cd5c813320d7b27f8d16cf865030a3f533ee35f582e05edbdb4d38bdf56c",
  "k09.json@datum": "f60ff6608b5cb5b870037ff7bff41aa844bfc3fb8b002d7cfeecab5f8c7e4d1b",
  "k09.json@gallery": "86ebd1fc61c5a7bd5a1efc62a77a5236c37f638cf91e55d26ce17db44dbc43b6",
  "k10.json@datum": "b9c58f33542a5a0fa8b5e17cf06440232fb9edfb9ed1add36570755d8d5d83a2",
  "k10.json@gallery": "7fb488c0c40ddbef037fe707335d68e47c7ec6b9e1f8502dc443b7d8c4a51586",
  "k12.json@datum": "8f37281d57f56779856941a54857908f691626d18d26419ff31fd211e26fb980",
  "k12.json@gallery": "f3c86c2cdfb32756606e4d51c8aca3a4242d58f03b0fe1fd530c0ee72dc07d5a",
  "p01.json@datum": "3adf00c0f954b25c990cd11aa1e93e8b179ca9d5d092f57ecdf44a8bb32dcda1",
  "p01.json@gallery": "29ade58695592307a5c890fb230e6a02de39a10fdd6454f6c468841084c1763e",
  "p02.json@datum": "05a148ad12807b9c9d78397587e4c795bd3e4f9dde34ef64706c384b05c64ad3",
  "p02.json@gallery": "5f013a1cf60eff3154ae3cd2182bb40d963c552a6b78325de80f7463a33a0871",
  "p03.json@datum": "ed69a744c6c5c672b5078c2238ab2f7139d901dae836ec9c3c4a27afefc10e72",
  "p03.json@gallery": "ff73b6395d57ff552a75f0e854dd6778699da499c0c00e6dfdff875bfaf42f8b",
  "p04.json@datum": "1be52ea076c1e03c1e1fbe85b9571625ecd6e62caa5cffb9144c9bebb832c872",
  "p04.json@gallery": "786b7d1abe2a0cdef7c6e5e3cc3b827fde436bf7058bdb0f2603903df452f4f2",
  "p05.json@datum": "bf15c592fccd98112d2ec32a61c69c26cd6ae98acf06ee45bf696ff74c595fc8",
  "p05.json@gallery": "39baf517101e64d55f7e0b0ba36ebf5f900cf9a6df9c0640059671b27e5ed1be",
  "p06.json@datum": "eb49999d04733826d911bc16ff956b250e4dce7243d1ebcc4d9a71d028cef7c4",
  "p06.json@gallery": "53060ac88de20680f23f0fb86856f7cc462f39fe1c0a2665acc31b8e52aeb036",
  "p07.json@datum": "f992b048a578bdae83d45fbef9b6a41572f06d9e5e8ec2e9a5ab854b439c664f",
  "p07.json@gallery": "583bbc8322363bf3746f28a892376deae70a6f4c79d11e85ceb19c37f184f295",
  "p08.json@datum": "e256dd9c0b5627ab35b034a8d820e71620320f433aee5d09d449267d2fb3a7c6",
  "p08.json@gallery": "9c55eb6e69671320aa4a7aac38e9e348bd828d450679341895b611d0ef88cb03",
  "p09.json@datum": "819812fc530550d6ddd0eb71c0657b369d1c7f8ed2e89664fcca44d85a0af8a9",
  "p09.json@gallery": "77e637c58576e6d9f1fded6ccea64cd26f64023ddcb6d3300f114d81df60e7e1",
  "p10.json@datum": "b76adac2fe159cd7da9842c97367c50198957f30f1f3864165f7382c34e653a4",
  "p10.json@gallery": "af2bd5403e76aa302eb7ab6c45e8d017c022ed8b217d23e0fd67ba094344720b",
  "p11.json@datum": "df15876e55edfc589e174f876fe0de96ce9bdb18b1484fc4b92b51134ebac13f",
  "p11.json@gallery": "99b9fe199229783924215df4bcd311f07c719fc23fb95cd40d871c9d0e4c2c70",
  "p12.json@datum": "4430cd613ba4657c73c84e962e04a8a4f4d814b86fe580093cc7daca91c05715",
  "p12.json@gallery": "d4ca675066fdbfdae3668d7da431f912504142eb70465105de5de399500478f5",
  "p13.json@datum": "3a396125e75e14d7969ec491b1f596f5d5e13d4534918122818163489cc3b8ad",
  "p13.json@gallery": "29cee16bf34ea4cc45d6473b67c341fc0d6411e4366a9272b1f36c426193b5b0",
  "p15.json@datum": "45e6b882715bbfc9d00f6078da60c0c825de39f8fd2c7fc1fb949a2b907cbc59",
  "p15.json@gallery": "edf17a8a178e15ad3cbe6da2af1dbd22ab8440790c00ae6e31e43ac149ba5f4f",
  "s01.json@datum": "57e97f245ca4edcf016d66c18ea27e4704ac98be777fe2c353d4fbcd1de34dbc",
  "s01.json@gallery": "ee5de480310c1a53f009b1769f5312dd6aedcdae0de0230b7a69fe14ca998074",
  "s02.json@datum": "7335d833c804285e66c7c0f36eea6449359c500e65049a31be6c2b0170541bcf",
  "s02.json@gallery": "116bc11a0c163e40f09301ae5422dab4104fdbed80d4ba7f7903413b34688a66",
  "s03.json@datum": "9573bb7e6bc584a29091c6449b97e0851103217fa2fb31ff0e9d2be0c97cca03",
  "s03.json@gallery": "80f8bcbefd9e679e887cd8218ed197954271463c9dcbb0c6b99f663ff373cce3",
  "s04.json@datum": "e5103ff6aba31929ae544648641162f8622778eacc6070efc6b59560a71013a1",
  "s04.json@gallery": "9b55aca753742a623281103d8846fed168af91212e3044cdf74018a447eeaf1d",
  "s05.json@datum": "de3be771188b21791d8b21cf76f03a8a09d12f6564b4e7c3a890a66dc27509b2",
  "s05.json@gallery": "d50b06d6783364de0bfe20e343d6d754703b7d21e488488ab5f35b125d24e12c",
  "s06.json@datum": "13756ddc111c599b7d8563d3de5fc6bde2875ffe1b64b6a18c8a6510642bfba9",
  "s06.json@gallery": "3342c7943178e8db53619ce3e1a1298b5d7c5f1d622105402190680f897445b0",
  "w01.json@datum": "527d30d4aa09149784e483d6b2b4a4c5e781d76eeb9cf290a449e405f2335073",
  "w01.json@gallery": "e5700875e1e1b3ddd0add1ef5e5fd61884e5dcec4247e08aa175c00dc9b709bd",
  "w02.json@datum": "6d99e809ea5e39b350b3b78fbc6aefad8bdd9689e5c82619ce66b7b488734eb3",
  "w02.json@gallery": "3c16427155f50c4c953dbf7447caae59b724cc82c9f76c19f486bb0c161bebb5",
  "w03.json@datum": "d15588bbad55988c76855eb01e6da84ad7f4e1d051f875a305d2b289c8cb54e3",
  "w03.json@gallery": "784d07d86dd908068d70755a597cfa0972c88458fe0c4396fd56f622d0dc029d",
  "w04.json@datum": "3d39252336e01b7501882fe37bb62706048f85c48f5e275b09da26bb06c3af06",
  "w04.json@gallery": "707f9f1fd02598c4dd6f755b9d39e722ed3c4f5724a908dabce873fac52474b6",
  "w05.json@datum": "b6338401717086d14a04f6e1abc2172ac197d854cf475aebb768bc6457d89e5a",
  "w05.json@gallery": "7123031320b3f4b4c9a89faa54f2e94b25740b8e6288bf52348d2ea24e9dda82",
  "w06.json@datum": "8252d364839c209d7eab40dc8d8ec363f20734dc267af3b756fa2d334e18ce0c",
  "w06.json@gallery": "582b38aade03d2a805ea86967bd49e0bbc2ac3843dab9dc3af88f1ea67bca7fd",
  "w07.json@datum": "30b6612d0f2b76bd94f46ce7d5fd3b9b86683d8c667780b6d24bef2bc8f8ac21",
  "w07.json@gallery": "65fc4c5b2651b847a86fc71db6112f5b44d3bd95d27aa6f1a95b4ca6cf07db87",
  "w08.json@datum": "b51615960e54ea637e2fb79380ffd527dd187d70283a75c50c88704015f16ae1",
  "w08.json@gallery": "7081844bd8bb230fdd266912241d268a60e1eb6ab13f6b0368a0a5d7deb948f5",
}

describe("AC-A11a: charts without a BPMN shape are byte-identical (C10(f))", () => {
  test("g04 @datum and @gallery equal their HEAD-before-row-34 bytes", () => {
    const g04 = JSON.parse(readFileSync(path.join(PARITY_CHART_DIR, "g04.json"), "utf8"))
    expect(sha256(render(g04, "datum").svg)).toBe(PINS["g04.json@datum"])
    expect(sha256(render(g04, "gallery").svg)).toBe(PINS["g04.json@gallery"])
  })
  test("every chart parity render equals its HEAD-before-row-34 bytes", () => {
    const got: Record<string, string> = {}
    for (const f of readdirSync(PARITY_CHART_DIR).filter((x) => x.endsWith(".json")).sort()) {
      const spec = JSON.parse(readFileSync(path.join(PARITY_CHART_DIR, f), "utf8"))
      for (const style of ["datum", "gallery"]) {
        let svg: string
        try {
          svg = render(spec, style).svg
        } catch {
          got[`${f}@${style}`] = "refused"
          continue
        }
        got[`${f}@${style}`] = sha256(svg)
      }
    }
    expect(Object.keys(got).length).toBe(92)
    expect(got).toEqual(PINS)
  })
})
