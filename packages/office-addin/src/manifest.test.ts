import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { OFFICE_ICON_32_URL, OFFICE_ICON_64_URL, OFFICE_JS_URL, OFFICE_PANE_URL } from "./constants"

const root = join(import.meta.dir, "..")
const xml = await Bun.file(join(root, "manifest", "swarm-office-addin.xml")).text()
const doc = new DOMParser().parseFromString(xml, "application/xml")
const app = doc.documentElement

const one = (name: string) => {
  const found = app.getElementsByTagName(name)
  expect(found.length).toBe(1)
  return found[0]
}

describe("U-MAN-01 manifest values equal register 6.2", () => {
  test("well-formed", () => {
    expect(doc.getElementsByTagName("parsererror").length).toBe(0)
    expect(app.tagName).toBe("OfficeApp")
  })

  test("identity", () => {
    expect(app.getAttribute("xsi:type")).toBe("TaskPaneApp")
    expect(one("Id").textContent).toBe("b25aaa4e-a1e7-46ef-bba0-0139b2a424b9")
    expect(one("Version").textContent).toBe("1.0.0.2")
    expect(one("ProviderName").textContent).toBe("PT GSP")
    expect(one("DefaultLocale").textContent).toBe("en-US")
  })

  test("display name and description with id-ID override", () => {
    const name = one("DisplayName")
    expect(name.getAttribute("DefaultValue")).toBe("Swarm")
    expect(name.getElementsByTagName("Override")[0].getAttribute("Locale")).toBe("id-ID")
    expect(name.getElementsByTagName("Override")[0].getAttribute("Value")).toBe("Swarm")
    const desc = one("Description")
    expect(desc.getAttribute("DefaultValue")).toBe("Chat with Swarm on this Mac about the current document.")
    expect(desc.getElementsByTagName("Override")[0].getAttribute("Locale")).toBe("id-ID")
    expect(desc.getElementsByTagName("Override")[0].getAttribute("Value")).toBe(
      "Mengobrol dengan Swarm di Mac ini tentang dokumen yang sedang dibuka.",
    )
  })

  test("hosts, permissions, source and icons", () => {
    expect([...one("Hosts").getElementsByTagName("Host")].map((h) => h.getAttribute("Name"))).toEqual([
      "Document",
      "Workbook",
    ])
    expect(one("Permissions").textContent).toBe("ReadWriteDocument")
    expect(one("SourceLocation").getAttribute("DefaultValue")).toBe("https://localhost:46317/pane/index.html")
    expect(one("SourceLocation").getAttribute("DefaultValue")).toBe(OFFICE_PANE_URL)
    expect(one("IconUrl").getAttribute("DefaultValue")).toBe(OFFICE_ICON_32_URL)
    expect(one("HighResolutionIconUrl").getAttribute("DefaultValue")).toBe(OFFICE_ICON_64_URL)
  })

  test("absent elements", () => {
    for (const name of ["Requirements", "AppDomains", "VersionOverrides"])
      expect(app.getElementsByTagName(name).length).toBe(0)
  })
})

describe("U-MAN-02 icons", () => {
  test.each([32, 64])("icon-%i.png has that pixel size", async (size) => {
    const bytes = new Uint8Array(await Bun.file(join(root, "public", "icons", `icon-${size}.png`)).arrayBuffer())
    expect([...bytes.subarray(1, 4)]).toEqual([80, 78, 71])
    const view = new DataView(bytes.buffer)
    expect(view.getUint32(16)).toBe(size)
    expect(view.getUint32(20)).toBe(size)
  })
})

describe("index.html", () => {
  test("loads Office.js from the register URL", async () => {
    const html = await Bun.file(join(root, "index.html")).text()
    expect(html).toContain(`<script src="${OFFICE_JS_URL}"></script>`)
    expect(html.indexOf(OFFICE_JS_URL)).toBeLessThan(html.indexOf("</head>"))
  })

  test("loads the pane entry module after the root element, after Office.js", async () => {
    const html = await Bun.file(join(root, "index.html")).text()
    const entry = html.indexOf('<script type="module" src="/src/index.tsx"></script>')
    expect(entry).toBeGreaterThan(html.indexOf('<div id="root"></div>'))
    expect(entry).toBeGreaterThan(html.indexOf(OFFICE_JS_URL))
  })
})
