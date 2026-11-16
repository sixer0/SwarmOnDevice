// 1.3.1 Windows (1.2.2 F1, S186-04): Windows drive folders are stored in POSIX form, so migration 0003's CHECK and the
// POSIX scope rules hold without a migration; POSIX paths are unchanged.
import { describe, expect, test } from "bun:test"
import { nativeProjectDir, projectDirScope, storeProjectDir } from "./mission/mission-store.ts"
import { defaultProjectDir } from "../mcp-host/mission/mission-tools.ts"

describe("Windows project dirs (F1)", () => {
  test("storeProjectDir: drive paths become /C:/..., POSIX paths pass through", () => {
    expect(storeProjectDir("C:\\Users\\budi\\Proj")).toBe("/C:/Users/budi/Proj")
    expect(storeProjectDir("d:/work/x")).toBe("/D:/work/x")
    expect(storeProjectDir("/Users/budi/Proj")).toBe("/Users/budi/Proj")
    expect(storeProjectDir("relative\\x")).toBe("relative\\x")
    expect(storeProjectDir("\\\\server\\share")).toBe("\\\\server\\share")
  })

  test("nativeProjectDir: only on win32 and only for a stored drive path", () => {
    expect(nativeProjectDir("/C:/Users/budi/Proj", "win32")).toBe("C:\\Users\\budi\\Proj")
    expect(nativeProjectDir("/C:/Users/budi/Proj", "darwin")).toBe("/C:/Users/budi/Proj")
    expect(nativeProjectDir("/Users/budi", "win32")).toBe("/Users/budi")
    expect(nativeProjectDir(storeProjectDir("C:\\a\\b"), "win32")).toBe("C:\\a\\b")
  })

  test("projectDirScope: Windows home and its direct children stay exact; a deeper project gets the prefix", () => {
    const home = "C:\\Users\\budi"
    expect(projectDirScope("C:\\Users\\budi", home)).toEqual({ exact: "/C:/Users/budi", prefix: null })
    expect(projectDirScope("C:\\Users\\budi\\Proj", home)).toEqual({ exact: "/C:/Users/budi/Proj", prefix: null })
    expect(projectDirScope("C:\\Users\\budi\\Proj\\App", home)).toEqual({ exact: "/C:/Users/budi/Proj/App", prefix: "/C:/Users/budi/Proj/App/" })
    expect(projectDirScope("C:\\", home).prefix).toBeNull()
    // macOS unchanged
    expect(projectDirScope("/Users/budi/a/b/c", "/Users/budi")).toEqual({ exact: "/Users/budi/a/b/c", prefix: "/Users/budi/a/b/c/" })
  })

  test("defaultProjectDir stores a Windows file root and a given Windows dir in POSIX form", () => {
    const a: Record<string, unknown> = {}
    defaultProjectDir(a, "C:\\Users\\budi\\Proj")
    expect(a.project).toEqual({ dir: "/C:/Users/budi/Proj" })
    const b: Record<string, unknown> = { project: { dir: "E:\\x\\y" } }
    defaultProjectDir(b, "C:\\Users\\budi")
    expect(b.project).toEqual({ dir: "/E:/x/y" })
    const c: Record<string, unknown> = {}
    defaultProjectDir(c, "/Users/budi/Proj")
    expect(c.project).toEqual({ dir: "/Users/budi/Proj" })
  })
})
