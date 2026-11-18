import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  acknowledgeDisclosure,
  deleteAllSessions,
  deleteToken,
  isDisclosureAcknowledged,
  readScope,
  readToken,
  storageKey,
  writeScope,
  writeToken,
} from "./storage"
import { docKey, dropSession, lookupSession, recentChats, saveSession, type DocumentSessions, type SessionSummary } from "./session"
import { memoryStore } from "./test-store"

const TOKEN = "swo1_" + "A".repeat(43)

function documents(urls: (string | null | undefined)[], partitionKey?: string) {
  const reads = { count: 0 }
  const queue = [...urls]
  const storage = memoryStore()
  const docs: DocumentSessions = {
    storage,
    partitionKey,
    documentUrl: () => {
      reads.count += 1
      return queue.length > 1 ? queue.shift() : queue[0]
    },
  }
  return { docs, reads, storage }
}

describe("storage keys", () => {
  test("U-ST-05 (storage half) token stored under swarm.office.token with and without partition prefix", () => {
    const plain = { storage: memoryStore() }
    expect(writeToken(plain, TOKEN)).toBe(true)
    expect(plain.storage.dump()).toEqual({ "swarm.office.token": TOKEN })
    const parted = { storage: memoryStore(), partitionKey: "p1" }
    expect(writeToken(parted, TOKEN)).toBe(true)
    expect(parted.storage.dump()).toEqual({ "p1:swarm.office.token": TOKEN })
    expect(readToken(parted)).toBe(TOKEN)
    expect(readToken(plain)).toBe(TOKEN)
    expect(writeToken(plain, "not-a-token")).toBe(false)
    deleteToken(parted)
    expect(readToken(parted)).toBeUndefined()
  })

  test("U-ST-04 / U-ST-09 storage half: sign-out deletes every session key of the partition only", () => {
    const storage = memoryStore()
    const store = { storage, partitionKey: "p1" }
    storage.setItem("p1:swarm.office.session.aaa", "ses_1")
    storage.setItem("p1:swarm.office.session.bbb", "ses_2")
    storage.setItem("p2:swarm.office.session.ccc", "ses_3")
    storage.setItem("p1:swarm.office.contextScope", "whole")
    writeToken(store, TOKEN)
    deleteToken(store)
    expect(deleteAllSessions(store)).toBe(2)
    expect(storage.dump()).toEqual({
      "p2:swarm.office.session.ccc": "ses_3",
      "p1:swarm.office.contextScope": "whole",
    })
  })

  test("U-ST-11 / SC-51 contextScope defaults to selection and is stored per partition", () => {
    const storage = memoryStore()
    const word = { storage, partitionKey: "word" }
    const excel = { storage, partitionKey: "excel" }
    expect(readScope(word)).toBe("selection")
    writeScope(word, "whole")
    expect(readScope(word)).toBe("whole")
    expect(readScope(excel)).toBe("selection")
    expect(storage.dump()).toEqual({ "word:swarm.office.contextScope": "whole" })
    storage.setItem("excel:swarm.office.contextScope", "garbage")
    expect(readScope(excel)).toBe("selection")
  })

  test("ST-30 (unit half) disclosure acknowledgement flag per partition, value 1", () => {
    const storage = memoryStore()
    const word = { storage, partitionKey: "word" }
    const excel = { storage, partitionKey: "excel" }
    expect(isDisclosureAcknowledged(word)).toBe(false)
    acknowledgeDisclosure(word)
    expect(isDisclosureAcknowledged(word)).toBe(true)
    expect(isDisclosureAcknowledged(excel)).toBe(false)
    expect(storage.getItem(storageKey(word, "swarm.office.disclosureAck"))).toBe("1")
  })
})

describe("per-document session (SC-47, D7)", () => {
  test("U-ST-12 docKey = lowercase hex SHA-256 of the POSIX path as returned", async () => {
    const path = "/Users/x/a.docx"
    expect(await docKey(path)).toBe(createHash("sha256").update(path).digest("hex"))
    expect(await docKey(path)).toMatch(/^[0-9a-f]{64}$/)
    // No URL normalisation: a file:// form is a different key.
    expect(await docKey("file:///Users/x/a.docx")).not.toBe(await docKey(path))
  })

  test("U-ST-12 document.url is read on every lookup and save (no cache)", async () => {
    const env = documents(["/Users/x/a.docx"], "p1")
    await saveSession(env.docs, "ses_a")
    await lookupSession(env.docs)
    await lookupSession(env.docs)
    expect(env.reads.count).toBe(3)
    const key = "p1:swarm.office.session." + createHash("sha256").update("/Users/x/a.docx").digest("hex")
    expect(env.storage.dump()).toEqual({ [key]: "ses_a" })
  })

  test("U-ST-12 / U-ST-10 empty url stores no key and every load starts a new chat", async () => {
    const empty = documents([""])
    expect(await saveSession(empty.docs, "ses_x")).toBe(false)
    expect(await lookupSession(empty.docs)).toBeUndefined()
    expect(empty.storage.length).toBe(0)
    const missing = documents([undefined])
    expect(await saveSession(missing.docs, "ses_x")).toBe(false)
    expect(missing.storage.length).toBe(0)
  })

  test("U-ST-12 Save As after reload gives a new chat; the old id stays (no migration)", async () => {
    // Before reload Office keeps returning the old path; after reload the new one.
    const env = documents(["/Users/x/a.docx", "/Users/x/a.docx", "/Users/x/b.docx"])
    await saveSession(env.docs, "ses_a")
    expect(await lookupSession(env.docs)).toBe("ses_a")
    expect(await lookupSession(env.docs)).toBeUndefined()
    expect(Object.values(env.storage.dump())).toEqual(["ses_a"])
  })

  test("U-ST-11 / ST-26 (unit half) reopening restores the same document's chat; another document starts new", async () => {
    const storage = memoryStore()
    const make = (url: string): DocumentSessions => ({ storage, partitionKey: "p1", documentUrl: () => url })
    await saveSession(make("/Users/x/a.docx"), "ses_a")
    expect(await lookupSession(make("/Users/x/a.docx"))).toBe("ses_a")
    expect(await lookupSession(make("/Users/x/b.docx"))).toBeUndefined()
  })

  test("U-ST-10 T17 drops only the current document's key", async () => {
    const storage = memoryStore()
    const make = (url: string): DocumentSessions => ({ storage, partitionKey: "p1", documentUrl: () => url })
    await saveSession(make("/a.docx"), "ses_a")
    await saveSession(make("/b.docx"), "ses_b")
    expect(await dropSession(make("/a.docx"))).toBe(true)
    expect(await lookupSession(make("/a.docx"))).toBeUndefined()
    expect(await lookupSession(make("/b.docx"))).toBe("ses_b")
  })

  test("U-ST-11 Recent chats: current host only, newest first, at most 20", () => {
    const sessions = Array.from({ length: 30 }, (_, index) => ({
      id: `ses_${index}`,
      title: `t${index}`,
      time: { updated: index },
      metadata: { "swarm.office.host": index % 3 === 0 ? "Excel" : "Word" },
    }))
    const extra = [{ id: "ses_plain", title: "app chat", time: { updated: 999 }, metadata: { "swarm.origin": "app" } }]
    const word = recentChats<SessionSummary>([...sessions, ...extra], "Word")
    expect(word).toHaveLength(20)
    expect(word.every((item) => item.metadata?.["swarm.office.host"] === "Word")).toBe(true)
    expect(word.map((item) => item.time.updated)).toEqual(word.map((item) => item.time.updated).toSorted((a, b) => b - a))
    expect(word[0].id).toBe("ses_29")
    expect(recentChats(sessions, "Excel")).toHaveLength(10)
  })
})
