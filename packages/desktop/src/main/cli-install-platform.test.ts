import { describe, expect, test } from "bun:test"
import { cliLauncherPath, datumStudioLauncherPath, datumStudioRuntimePath, onPath } from "./cli-install"

// Row 127: bundled file names per platform (register R5.5, R6.1, R6.5). darwin results are the pre-127 strings.
describe("bundled paths per platform", () => {
  test("darwin is unchanged, with and without the explicit platform", () => {
    const res = "/A/Swarm.app/Contents/Resources"
    for (const p of [undefined, "darwin" as const]) {
      expect(cliLauncherPath(res, p)).toBe(`${res}/swarm-cli/swarm-launcher`)
      expect(datumStudioLauncherPath(res, p)).toBe(`${res}/datum-studio/datum-studio-launcher`)
      expect(datumStudioRuntimePath(`${res}/datum-studio/datum-studio-launcher`, p)).toBe(`${res}/swarm-cli/swarm`)
    }
  })

  test("linux uses the same sh launchers and the bare swarm binary", () => {
    const res = "/opt/Swarm/resources"
    expect(cliLauncherPath(res, "linux")).toBe("/opt/Swarm/resources/swarm-cli/swarm-launcher")
    expect(datumStudioLauncherPath(res, "linux")).toBe("/opt/Swarm/resources/datum-studio/datum-studio-launcher")
    expect(datumStudioRuntimePath(datumStudioLauncherPath(res, "linux"), "linux")).toBe(
      "/opt/Swarm/resources/swarm-cli/swarm",
    )
  })

  test("win32 uses the .cmd launchers, swarm.exe and backslashes", () => {
    const res = "C:\\Users\\a b\\AppData\\Local\\Programs\\Swarm\\resources"
    expect(cliLauncherPath(res, "win32")).toBe(`${res}\\swarm-cli\\swarm-launcher.cmd`)
    expect(datumStudioLauncherPath(res, "win32")).toBe(`${res}\\datum-studio\\datum-studio-launcher.cmd`)
    expect(datumStudioRuntimePath(datumStudioLauncherPath(res, "win32"), "win32")).toBe(`${res}\\swarm-cli\\swarm.exe`)
  })
})

describe("onPath per platform", () => {
  test("darwin and linux split on ':' and are case-sensitive", () => {
    for (const p of [undefined, "darwin" as const, "linux" as const]) {
      expect(onPath("/u/.local/bin", "/usr/bin:/u/.local/bin/", p)).toBe(true)
      expect(onPath("/u/.local/bin", "/usr/bin", p)).toBe(false)
      expect(onPath("/u/.local/bin", "/usr/bin;/u/.local/bin", p)).toBe(false)
      expect(onPath("/u/.local/bin", "/U/.local/bin", p)).toBe(false)
      expect(onPath("/u/.local/bin", undefined, p)).toBe(false)
    }
  })

  test("win32 splits on ';', ignores a trailing slash of either kind and letter case", () => {
    const dir = "C:\\Users\\a\\.local\\bin"
    expect(onPath(dir, "C:\\Windows\\system32;c:\\users\\a\\.local\\bin\\", "win32")).toBe(true)
    expect(onPath(dir, "C:\\Windows;C:\\Users\\a\\.local\\bin/", "win32")).toBe(true)
    expect(onPath(dir, "C:\\Windows\\system32", "win32")).toBe(false)
    expect(onPath(dir, "C:\\Users\\a\\.local\\bin:C:\\Windows", "win32")).toBe(false)
    expect(onPath(dir, undefined, "win32")).toBe(false)
  })
})
