// Swarm 1.2.7 row 47f (M1-08, decisions C68, C75): the outward-consent reader and the own-API reader (F-4) read curl and
// wget with ONE value-option table, and the shell's output masking resolves words with the permission table's own path
// resolver. Pinned by identity: a second copy of either makes these fail. Pure: nothing runs, no file is touched.
import { describe, expect, test } from "bun:test"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { NetOptions } from "../../src/permission/net-options"
import { OutwardConsent } from "../../src/permission/outward-consent"
import { PathSpelling } from "../../src/permission/path-spelling"
import { Secrets } from "../../src/tool/secrets"

describe("47f M1-08: one curl/wget option table", () => {
  test("the outward reader and the own-API reader use the same table objects", () => {
    expect(NetOptions.CURL).toBeDefined()
    expect(NetOptions.WGET).toBeDefined()
    expect(OutwardConsent.netOptions.curl).toBe(NetOptions.CURL)
    expect(AutonomyTable.netOptions.curl).toBe(NetOptions.CURL)
    expect(OutwardConsent.netOptions.wget).toBe(NetOptions.WGET)
    expect(AutonomyTable.netOptions.wget).toBe(NetOptions.WGET)
  })

  test("the options only one copy knew before the merge take a value in the shared table", () => {
    for (const option of ["--libcurl", "--etag-save", "-o", "-K", "-x", "--url", "--proxy"])
      expect(NetOptions.takesValue(NetOptions.CURL, option)).toBe(true)
    expect(NetOptions.takesValue(NetOptions.WGET, "--max-redirect")).toBe(true)
    // A flag in curl: the outward reader still holds it (CURL_UPLOAD), the own-API reader does not skip the next word.
    expect(NetOptions.takesValue(NetOptions.CURL, "--form-escape")).toBe(false)
    expect(NetOptions.takesValue(NetOptions.CURL, "-s")).toBe(false)
    expect(NetOptions.CURL.address.has("--resolve")).toBe(true)
  })
})

describe("47f C68: masking reuses the classifier's path resolver", () => {
  test("the table's resolver is the shared one and masking expands with that same function", () => {
    expect(AutonomyTable.spelling).toBe(PathSpelling)
    expect(Secrets.expandSpelling).toBe(AutonomyTable.spelling.expand)
  })

  test("the folder cap is the shared one", () => {
    const many = Array.from({ length: PathSpelling.MAX_FOLDERS + 4 }, (_, index) => `/f${index}`)
    const reach = Secrets.workingFolders(many.map((folder) => ["cd", folder]), "/start", ["/h"])
    expect(reach.folders.length).toBe(PathSpelling.MAX_FOLDERS)
    expect(reach.certain).toBe(false)
  })
})
