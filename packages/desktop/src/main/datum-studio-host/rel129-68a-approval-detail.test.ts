// Swarm 1.2.9 row 68a (gate 68 F1, decision C80; N9-044, 01c §3.4). The rehome route refuses an unconfirmed answer
// with 409 and the body `{ name: "RehomeRefusedError", data: { code, message: REFUSAL_TEXT[code], detail } }`
// (opencode `handlers/project.ts` REFUSAL_TEXT + the refusal branch; detail values from `project/rehome.ts`, pinned by
// `rel129-c06-decision-check.test.ts`). The desktop joins "<route text>: <detail>" for REHOME_APPROVAL_MISSING only
// when the detail is one of the two fixed strings "decision" / "decision unchecked", so the app can show N9-044. Any
// other detail is not joined (it keeps the route text). Namespace import, so the file loads at BASE and fails there on
// assertions (red run).
import { describe, expect, test } from "bun:test"
import * as ipcModule from "./mission-ipc"

const ipc = ipcModule as unknown as Record<string, any>
const MISSION = "2026-11-14_syn129-approval"
const ROOT = "/srv/swarm/Documents/Default Project"
// Copied from the route (`REFUSAL_TEXT.REHOME_APPROVAL_MISSING`), the real `data.message` of this refusal.
const ROUTE_TEXT = "The move needs the person's answered decision for this mission."
const body = { missionId: MISSION, from: ROOT, to: `${ROOT}/DEMS`, sessions: [], approvalRef: "D-1", approvalMission: MISSION }
const server = async () => ({ url: "http://127.0.0.1:4096", username: "opencode", password: "pw" })

const refusedWith = async (detail?: string) => {
  const data = { code: "REHOME_APPROVAL_MISSING", message: ROUTE_TEXT, ...(detail === undefined ? {} : { detail }) }
  const fetch = async () => new Response(JSON.stringify({ name: "RehomeRefusedError", data }), { status: 409 })
  const r = await ipc.createRehomeCaller({ server, nonce: () => "n".repeat(43), fetch })(body)
  return `${r.ok} ${r.code} ${r.message}`
}

describe("1.2.9 row 68a: REHOME_APPROVAL_MISSING with the decision detail reaches the app joined", () => {
  test("detail 'decision' and 'decision unchecked' are joined to the route text", async () => {
    expect(await refusedWith("decision")).toBe(
      "false REHOME_APPROVAL_MISSING The move needs the person's answered decision for this mission: decision",
    )
    expect(await refusedWith("decision unchecked")).toBe(
      "false REHOME_APPROVAL_MISSING The move needs the person's answered decision for this mission: decision unchecked",
    )
  })

  test("any other detail, or none, keeps the route text unjoined", async () => {
    for (const detail of [undefined, "", "compensates", "groupKind", "approvalMission", "sessions", "decision ", "Decision", "decision unchecked: x"])
      expect({ detail, out: await refusedWith(detail) }).toEqual({ detail, out: `false REHOME_APPROVAL_MISSING ${ROUTE_TEXT}` })
  })
})
