// 1.3.1 Windows (1.2.2 F1): the window access check compares a Windows session folder with the store's /C:/... form.
import { expect, test } from "bun:test"
import { storeProjectDir, withinDirectory } from "./mission-ipc"

test("withinDirectory accepts a stored /C:/... mission inside a Windows session folder", () => {
  const home = "C:\\Users\\budi"
  expect(storeProjectDir("C:\\Users\\budi\\Proj")).toBe("/C:/Users/budi/Proj")
  expect(withinDirectory("/C:/Users/budi/Proj", "C:\\Users\\budi\\Proj", home)).toBe(true)
  expect(withinDirectory("/C:/Users/budi/Proj/App/sub", "C:\\Users\\budi\\Proj\\App", home)).toBe(true)
  // home and its direct children stay exact (S186-01)
  expect(withinDirectory("/C:/Users/budi/Proj", "C:\\Users\\budi", home)).toBe(false)
  expect(withinDirectory("/C:/Users/budi/Proj/App", "C:\\Users\\budi\\Proj", home)).toBe(false)
  expect(withinDirectory("/C:/Users/budi/Proj/App/../../x", "C:\\Users\\budi\\Proj\\App", home)).toBe(false)
  // macOS unchanged
  expect(withinDirectory("/Users/budi/a/b/c/d", "/Users/budi/a/b/c", "/Users/budi")).toBe(true)
})
