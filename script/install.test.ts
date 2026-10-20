import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, chmod, mkdir, rm, stat, writeFile } from "fs/promises"
import os from "os"
import path from "path"

// The upstream `install` downloaded release archives after discovering a version from
// registry.npmjs.org and api.github.com. Row 46 replaced all of that with a local-only installer
// (implementation/s46_install_sh.md): the binary comes from `--binary` or from a file named `swarm`
// beside the script, and the script contains no network tool at all (`rg -ni 'http|curl|wget' install`
// is empty). Every case below therefore asserts two things at once — the documented R-gate behaviour,
// and that no network tool was ever invoked, which is what the mocked-curl version of this file used
// to test positively.
const script = path.resolve(import.meta.dir, "../install")
const root = await mkdtemp(path.join(os.tmpdir(), "swarm-install-test-"))
afterAll(() => rm(root, { recursive: true, force: true }))

// A logging stand-in for every downloader the old script used. It fails loudly (exit 64) so an
// accidental call cannot be mistaken for success.
const spy = (name: string) => `#!/usr/bin/env bash\necho "${name} $*" >> "$NET_LOG"\nexit 64\n`
const spyBin = path.join(root, "spy-bin")
await mkdir(spyBin, { recursive: true })
for (const name of ["curl", "wget", "nc"]) {
  const file = path.join(spyBin, name)
  await writeFile(file, spy(name))
  await chmod(file, 0o755)
}

// Stubs that make this host look like an Intel Mac, for the R2 platform gate.
const intelBin = path.join(root, "intel-bin")
await mkdir(intelBin, { recursive: true })
await writeFile(path.join(intelBin, "uname"), '#!/usr/bin/env bash\n[ "$1" = "-s" ] && echo Darwin || echo x86_64\n')
await writeFile(path.join(intelBin, "sysctl"), "#!/usr/bin/env bash\necho 0\n")
await chmod(path.join(intelBin, "uname"), 0o755)
await chmod(path.join(intelBin, "sysctl"), 0o755)

let run = 0
async function install(input: {
  env?: Record<string, string>
  args?: string[]
  intel?: boolean
  home?: string
  scriptPath?: string
}) {
  const home = input.home ?? path.join(root, `home-${run++}`)
  const netLog = path.join(home, "net.log")
  await mkdir(home, { recursive: true })
  await writeFile(netLog, "")
  const proc = Bun.spawn(["bash", input.scriptPath ?? script, "--no-modify-path", ...(input.args ?? [])], {
    env: {
      PATH: `${input.intel ? `${intelBin}:` : ""}${spyBin}:/usr/bin:/bin`,
      HOME: home,
      SHELL: "/bin/bash",
      TMPDIR: home,
      NET_LOG: netLog,
      ...input.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const dest = path.join(home, ".swarm", "bin", "swarm")
  return {
    code,
    output: stdout + stderr,
    net: (await Bun.file(netLog).text()).trim().split("\n").filter(Boolean),
    dest,
    installed: await Bun.file(dest).exists(),
    home,
  }
}

// An executable that reports a version, which is what the R4 smoke test looks for.
async function fakeBinary(dir: string, name = "swarm", version = "1.19.3-test") {
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await writeFile(file, `#!/usr/bin/env bash\n[ "$1" = "--version" ] && echo "${version}" && exit 0\nexit 0\n`)
  await chmod(file, 0o755)
  return file
}

describe("install script (local-only)", () => {
  test("--help documents the local flow and touches no network tool", async () => {
    const result = await install({ args: ["--help"] })
    expect(result.code).toBe(0)
    expect(result.output).toContain("--binary <path>")
    expect(result.output).toContain("--no-modify-path")
    expect(result.output).toContain("never contacts a network host")
    expect(result.net).toEqual([])
  })

  test("refuses when no binary is available and creates nothing", async () => {
    const result = await install({})
    expect(result.code).toBe(1)
    expect(result.output).toContain("No Swarm binary found")
    expect(result.output).toContain("Pass --binary <path>")
    expect(result.installed).toBe(false)
    expect(result.net).toEqual([])
  })

  test("installs --binary to ~/.swarm/bin/swarm with mode 755", async () => {
    const sourceDir = path.join(root, `src-${run}`)
    const source = await fakeBinary(sourceDir)
    const result = await install({ args: ["--binary", source] })
    expect(result.code).toBe(0)
    expect(result.installed).toBe(true)
    // R5: fixed destination and mode 755.
    expect((await stat(result.dest)).mode & 0o777).toBe(0o755)
    expect(result.net).toEqual([])
  })

  test("picks up a swarm file sitting next to the script by default", async () => {
    // R3 default source: the file named swarm in the script's own directory. The repo copy is not
    // touched — a private copy of the script runs from a directory that also holds the binary.
    const dir = path.join(root, `beside-${run++}`)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, "install.sh"), await Bun.file(script).text())
    await chmod(path.join(dir, "install.sh"), 0o755)
    await fakeBinary(dir)
    const result = await install({ scriptPath: path.join(dir, "install.sh") })
    expect(result.code).toBe(0)
    expect(result.installed).toBe(true)
    expect(result.net).toEqual([])
  })

  test("R4: a source that cannot report a version installs nothing", async () => {
    const dir = path.join(root, `bad-${run}`)
    await mkdir(dir, { recursive: true })
    const bad = path.join(dir, "swarm")
    await writeFile(bad, "#!/usr/bin/env bash\nexit 3\n")
    await chmod(bad, 0o755)
    const result = await install({ args: ["--binary", bad] })
    expect(result.code).toBe(1)
    expect(result.output).toContain("Smoke test failed")
    expect(result.installed).toBe(false)
    expect(result.net).toEqual([])
  })

  test("R11: installing identical bytes twice reports already installed and keeps the file", async () => {
    const source = await fakeBinary(path.join(root, `idem-${run}`))
    const home = path.join(root, `home-${run++}`)
    const first = await install({ args: ["--binary", source], home })
    expect(first.code).toBe(0)
    const before = await stat(first.dest)
    const second = await install({ args: ["--binary", source], home })
    expect(second.code).toBe(0)
    expect(second.output).toContain("already installed at")
    expect((await stat(first.dest)).mtime.getTime()).toBe(before.mtime.getTime())
  })

  test("R5a: an rg beside the binary is copied into the same bin dir", async () => {
    const dir = path.join(root, `rg-${run}`)
    const source = await fakeBinary(dir)
    const rg = path.join(dir, "rg")
    await writeFile(rg, "#!/usr/bin/env bash\necho ripgrep-test\n")
    await chmod(rg, 0o755)
    const result = await install({ args: ["--binary", source] })
    expect(result.code).toBe(0)
    expect(await Bun.file(path.join(result.home, ".swarm", "bin", "rg")).exists()).toBe(true)
  })

  test("R2: refuses a non-Apple-Silicon Mac before looking at the binary", async () => {
    const result = await install({ intel: true, args: [] })
    expect(result.code).toBe(1)
    expect(result.output).toContain("Apple Silicon (darwin-arm64) only")
    expect(result.net).toEqual([])
  })

  test.skipIf(process.platform !== "darwin")(
    "R8: reports a quarantine attribute on the source and leaves it set",
    async () => {
      const dir = path.join(root, `quarantine-${run}`)
      const source = await fakeBinary(dir)
      await Bun.spawn(["xattr", "-w", "com.apple.quarantine", "0081;00000000;test;0000", source]).exited
      const result = await install({ args: ["--binary", source] })
      expect(result.code).toBe(0)
      expect(result.output).toContain("com.apple.quarantine")
      // The script never clears the attribute: removing it is a documented user action (01b §3.8).
      const probe = Bun.spawn(["xattr", "-p", "com.apple.quarantine", source], { stdout: "pipe" })
      const attrs = await new Response(probe.stdout).text()
      await probe.exited
      expect(attrs.trim()).not.toBe("")
    },
  )
})
