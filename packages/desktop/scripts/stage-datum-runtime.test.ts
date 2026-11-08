// Row 122 (linux/windows installer task): target tables and the linux-x64 unzip installer of stage-datum-runtime.ts.
// Pure tests: no network, no staged python; temp files under the OS temp folder only.
import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { crc32 } from "node:zlib"
import {
  ELF_EXPECTED,
  GLIBC_FLOOR_MINOR,
  PYTHON,
  PYTHON_LINUX,
  WHEELS,
  WHEELS_LINUX,
  glibcMaxMinor,
  installWheelByUnzip,
  nativeKind,
  runtimePlan,
  zipData,
  zipEntries,
} from "./stage-datum-runtime"

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "stage-datum-runtime-test-"))
afterAll(() => fs.rm(tmpRoot, { recursive: true, force: true }))

// A stored (method 0) zip, enough for wheel-shaped fixtures. mode = unix st_mode of the entry.
function storedZip(entries: Array<{ name: string; data: string | Buffer; mode?: number }>) {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data)
    const name = Buffer.from(e.name)
    const crc = crc32(data) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, data)
    centrals.push(central, name)
    offset += 30 + name.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

const digest = (data: string) => `sha256=${createHash("sha256").update(data).digest("base64url")}`

function fixtureWheel(opts: { badHash?: boolean; extra?: Array<{ name: string; data: string; mode?: number }> } = {}) {
  const files = [
    { name: "demo/__init__.py", data: "x = 1\n" },
    { name: "demo/_ext.cpython-314-x86_64-linux-gnu.so", data: "\x7fELF-not-really", mode: 0o100755 },
    { name: "demo-1.0.data/purelib/demo_extra.py", data: "y = 2\n" },
    { name: "demo-1.0.data/scripts/demo-tool", data: "#!python\nprint(1)\n", mode: 0o100755 },
    { name: "demo-1.0.dist-info/METADATA", data: "Metadata-Version: 2.1\nName: demo\nVersion: 1.0\n" },
    { name: "demo-1.0.dist-info/WHEEL", data: "Wheel-Version: 1.0\nRoot-Is-Purelib: false\nTag: cp314-cp314-manylinux_2_28_x86_64\n" },
    ...(opts.extra ?? []),
  ]
  const record =
    files.map((f) => `${f.name},${opts.badHash && f.name === "demo/__init__.py" ? digest("tampered") : digest(f.data)},${Buffer.byteLength(f.data)}`).join("\n") +
    "\ndemo-1.0.dist-info/RECORD,,\n"
  return storedZip([...files, { name: "demo-1.0.dist-info/RECORD", data: record }])
}

async function install(zip: Buffer, name: string) {
  const dir = await fs.mkdtemp(path.join(tmpRoot, `${name}-`))
  const whl = path.join(dir, "demo-1.0-cp314-cp314-manylinux_2_28_x86_64.whl")
  await fs.writeFile(whl, zip)
  const site = path.join(dir, "site")
  await fs.mkdir(site)
  return { site, run: () => installWheelByUnzip(whl, site) }
}

describe("runtimePlan (row 122)", () => {
  test("darwin-arm64 keeps the 1.2.1 pins and names", () => {
    const plan = runtimePlan("darwin-arm64")
    expect(plan.python).toBe(PYTHON)
    expect(plan.wheels).toBe(WHEELS)
    expect(PYTHON.sha256).toBe("95eb8c87d16af37c54e9765e31d8c56c0d8ffa9968ea0f704f73a9b83f84e9f9")
    expect(PYTHON.file).toBe("cpython-3.14.10+20261026-aarch64-apple-darwin-install_only_stripped.tar.gz")
    expect(WHEELS.map((w) => `${w.file} ${w.sha256}`)).toEqual([
      "et_xmlfile-2.0.0-py3-none-any.whl 7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa",
      "lxml-6.1.3-cp314-cp314-macosx_10_15_universal2.whl 2bec13085dc8ef48a3fe62f7dfcacfeda2c785cdf19cc8eeda2bb9ed081da165",
      "openpyxl-3.1.5-py2.py3-none-any.whl 5282c12b107bffeef825f4617dc029afaf41d0ea60823bbb665ef3079dc79de2",
      "pillow-13.0.0-cp314-cp314-macosx_11_0_arm64.whl d9b0a2bee3f3e03e9f29057aedb807dbf1e1d96ee1b9d0f422d9db6c8583271d",
      "python_docx-1.2.0-py3-none-any.whl 3fd478f3250fbbbfd3b94fe1e985955737c145627498896a8a6bf81f4baf66c7",
      "python_pptx-1.0.2-py3-none-any.whl 160838e0b8565a8b1f67947675886e9fea18aa5e795db7ae531606d68e785cba",
      "typing_extensions-4.16.0-py3-none-any.whl 481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8",
      "xlsxwriter-3.3.1-py3-none-any.whl 8e2c89e59d733fe59e112317218c64fbbc276d90a8c144ebd6f7fa15e7ab184a",
    ])
    expect(plan.lockFile).toBe("requirements.lock")
    expect(plan.pruneStdlib).toContain("config-3.14-darwin")
  })

  test("linux-x64 uses the R5.13 interpreter and manylinux_2_28 lxml/pillow; pure wheels unchanged", () => {
    const plan = runtimePlan("linux-x64")
    expect(plan.python).toBe(PYTHON_LINUX)
    expect(PYTHON_LINUX.file).toBe("cpython-3.14.10+20261026-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz")
    expect(PYTHON_LINUX.sha256).toBe("4d3c16c59ed0802a3d1d34d8bce504b15ceeaff39d62dadecc6a9fa803412aed")
    expect(PYTHON_LINUX.size).toBe(36776589)
    expect(new URL(PYTHON_LINUX.url).host).toBe("github.com")
    const native = WHEELS_LINUX.filter((w) => w.name === "lxml" || w.name === "pillow")
    expect(native.map((w) => w.sha256)).toEqual([
      "a7eb78ba28b187e1e9203a55c60fcf70df2d22cb205fe6d51b9383d6097419f0",
      "e91c2b1cbeae768c98752e67e717e283d68dae45717b41f2d91eaee648e37b7d",
    ])
    for (const w of native) {
      expect(new URL(w.url).host).toBe("files.pythonhosted.org")
      expect(w.url.endsWith(`/${w.file}`)).toBe(true)
      // R2.9: no manylinux tag above 2_28 (the glibc floor of the runtime).
      const minors = [...w.file.matchAll(/manylinux_2_(\d+)_x86_64/g)].map((m) => Number(m[1]))
      expect(Math.max(...minors)).toBeLessThanOrEqual(GLIBC_FLOOR_MINOR)
    }
    expect(WHEELS_LINUX.filter((w) => w.name !== "lxml" && w.name !== "pillow")).toEqual(WHEELS.filter((w) => w.name !== "lxml" && w.name !== "pillow"))
    expect(plan.lockFile).toBe("requirements-linux-x64.lock")
    expect(plan.pruneStdlib).toContain("config-3.14-x86_64-linux-gnu")
    expect(plan.pruneStdlib).not.toContain("config-3.14-darwin")
  })

  test("win32-x64 is refused until row 123", () => {
    expect(() => runtimePlan("win32-x64")).toThrow(/row 123/)
  })

  test("ELF_EXPECTED is the count row 122 recorded (R12.3)", () => {
    expect(ELF_EXPECTED).toBe(35)
  })
})

describe("installWheelByUnzip (row 122, pip --target layout)", () => {
  test("lays files out as pip does, with INSTALLER, REQUESTED and a sorted CRLF RECORD", async () => {
    const { site, run } = await install(fixtureWheel(), "ok")
    expect(await run()).toBe("demo-1.0")
    expect(await fs.readFile(path.join(site, "demo", "__init__.py"), "utf8")).toBe("x = 1\n")
    expect(await fs.readFile(path.join(site, "demo_extra.py"), "utf8")).toBe("y = 2\n")
    expect(await fs.readFile(path.join(site, "bin", "demo-tool"), "utf8")).toBe("#!python\nprint(1)\n")
    const mode = async (rel: string) => ((await fs.stat(path.join(site, rel))).mode & 0o777).toString(8)
    expect(await mode("demo/__init__.py")).toBe("644")
    expect(await mode("demo/_ext.cpython-314-x86_64-linux-gnu.so")).toBe("755")
    expect(await mode("bin/demo-tool")).toBe("755")
    expect(await fs.readFile(path.join(site, "demo-1.0.dist-info", "INSTALLER"), "utf8")).toBe("pip\n")
    expect(await fs.readFile(path.join(site, "demo-1.0.dist-info", "REQUESTED"), "utf8")).toBe("")
    const record = await fs.readFile(path.join(site, "demo-1.0.dist-info", "RECORD"), "utf8")
    expect(record.endsWith("\r\n")).toBe(true)
    const paths = record.trimEnd().split("\r\n").map((line) => line.split(",")[0])
    expect(paths).toEqual([...paths].sort())
    expect(paths).toContain("../../bin/demo-tool")
    expect(paths).toContain("demo_extra.py")
    expect(paths).toContain("demo-1.0.dist-info/INSTALLER")
    expect(paths).not.toContain("demo-1.0.data/purelib/demo_extra.py")
    expect(record).toContain(`demo-1.0.dist-info/REQUESTED,${digest("")},0\r\n`)
    expect(record).toContain("demo-1.0.dist-info/RECORD,,\r\n")
  })

  test("refuses a member whose bytes differ from its RECORD hash", async () => {
    const { run } = await install(fixtureWheel({ badHash: true }), "badhash")
    await expect(run()).rejects.toThrow(/RECORD hash mismatch for demo\/__init__\.py/)
  })

  test("refuses unsafe member paths and unsupported .data folders", async () => {
    const unsafe = await install(fixtureWheel({ extra: [{ name: "demo/../../escape.py", data: "z\n" }] }), "unsafe")
    await expect(unsafe.run()).rejects.toThrow(/unsafe entry/)
    const headers = await install(fixtureWheel({ extra: [{ name: "demo-1.0.data/headers/demo.h", data: "h\n" }] }), "headers")
    await expect(headers.run()).rejects.toThrow(/\.data\/headers is not supported/)
  })

  test("refuses a second wheel that would overwrite an installed file", async () => {
    const { run } = await install(fixtureWheel(), "twice")
    await run()
    await expect(run()).rejects.toThrow(/already installed by another wheel/)
  })

  test("zipData checks the CRC", () => {
    const zip = storedZip([{ name: "a.txt", data: "hello" }])
    const [entry] = zipEntries(zip)
    expect(zipData(zip, entry).toString()).toBe("hello")
    expect(() => zipData(zip, { ...entry, crc: (entry.crc ^ 1) >>> 0 })).toThrow(/CRC/)
  })
})

describe("ELF helpers (row 122)", () => {
  test("nativeKind tells ELF x86-64 from ELF aarch64, Mach-O and data", async () => {
    const elf = (machine: number) => {
      const b = Buffer.alloc(64)
      b.writeUInt32BE(0x7f454c46, 0)
      b[4] = 2
      b[5] = 1
      b.writeUInt16LE(machine, 18)
      return b
    }
    const macho = Buffer.alloc(64)
    macho.writeUInt32BE(0xcffaedfe, 0)
    const cases: Array<[string, Buffer, unknown]> = [
      ["x64.so", elf(0x3e), { kind: "elf", x64: true }],
      ["arm.so", elf(0xb7), { kind: "elf", x64: false }],
      ["mac.so", macho, { kind: "macho", x64: false }],
      ["text.py", Buffer.from("print('hi')\n".padEnd(64, " ")), null],
    ]
    for (const [name, bytes, want] of cases) {
      const f = path.join(tmpRoot, name)
      await fs.writeFile(f, bytes)
      expect(await nativeKind(f)).toEqual(want as never)
    }
  })

  test("glibcMaxMinor reads the highest GLIBC_2.N", () => {
    expect(glibcMaxMinor(Buffer.from("\0GLIBC_2.2.5\0GLIBC_2.17\0GLIBC_2.27\0GLIBC_PRIVATE\0"))).toBe(27)
    expect(glibcMaxMinor(Buffer.from("no versions"))).toBe(-1)
  })
})
