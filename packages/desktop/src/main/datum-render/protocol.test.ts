import { describe, expect, test } from "bun:test"
import { BridgeError, errorResponse, parseLine, validateRequest } from "./protocol"

function code(fn: () => unknown) {
  try {
    fn()
  } catch (e) {
    return e instanceof BridgeError ? e.code : "OTHER"
  }
  return "NONE"
}

describe("render bridge request validation", () => {
  test("accepts the three spec ops and hello", () => {
    expect(validateRequest({ op: "png", src: "/a/b.svg", dst: "/a/b.png", width: 1961, height: 1181 })).toEqual({
      op: "png",
      src: "/a/b.svg",
      dst: "/a/b.png",
      width: 1961,
      height: 1181,
    })
    expect(validateRequest({ op: "png", src: "/a/b.svg", dst: "/a/b.png", width: 800 })).toEqual({
      op: "png",
      src: "/a/b.svg",
      dst: "/a/b.png",
      width: 800,
    })
    expect(validateRequest({ op: "pdf", src: "/a/doc.html", dst: "/a/doc.pdf", preferCSSPageSize: true })).toEqual({
      op: "pdf",
      src: "/a/doc.html",
      dst: "/a/doc.pdf",
      preferCSSPageSize: true,
    })
    expect(validateRequest({ op: "pdf", src: "/a/f.svg", dst: "/a/f.pdf", widthMm: 166, heightMm: 100 })).toMatchObject({
      widthMm: 166,
      heightMm: 100,
    })
    expect(validateRequest({ op: "checkPage", html: "<p>x</p>", wMm: 210, hMm: 297, script: "(o)=>1", arg: { a: 1 } })).toMatchObject({
      op: "checkPage",
      wMm: 210,
      arg: { a: 1 },
    })
    expect(validateRequest({ op: "hello", token: "t", id: 3 })).toEqual({ op: "hello" })
  })

  test("refuses unknown ops and unknown fields", () => {
    expect(code(() => validateRequest({ op: "exec", cmd: "ls" }))).toBe("UNKNOWN_OP")
    expect(code(() => validateRequest({ op: "png", src: "/a.svg", dst: "/a.png", width: 10, url: "http://x" }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest([]))).toBe("BAD_REQUEST")
  })

  test("refuses wrong extensions and sizes", () => {
    expect(code(() => validateRequest({ op: "png", src: "/a.html", dst: "/a.png", width: 10 }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ op: "png", src: "/a.svg", dst: "/a.pdf", width: 10 }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ op: "png", src: "/a.svg", dst: "/a.png", width: 0 }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ op: "png", src: "/a.svg", dst: "/a.png", width: 16385 }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ op: "png", src: "/a.svg", dst: "/a.png", width: 1.5 }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ op: "pdf", src: "/a.docx", dst: "/a.pdf" }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ op: "pdf", src: "/a.svg", dst: "/a.pdf", widthMm: 10 }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ op: "pdf", src: "/a.html", dst: "/a.pdf", preferCSSPageSize: "yes" }))).toBe("BAD_REQUEST")
  })

  test("checkPage needs exactly one of html and src, and a script", () => {
    expect(code(() => validateRequest({ op: "checkPage", wMm: 1, hMm: 1, script: "x" }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ op: "checkPage", html: "a", src: "/a.html", wMm: 1, hMm: 1, script: "x" }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ op: "checkPage", html: "a", wMm: 1, hMm: 1 }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ op: "checkPage", src: "/a.svg", wMm: 1, hMm: 1, script: "x" }))).toBe("BAD_REQUEST")
  })

  test("pagePng (row 151b): html src, a dstDir, optional pages/dpi/page size; everything else refused", () => {
    expect(validateRequest({ op: "pagePng", src: "/a/doc.html", dstDir: "/a/verify/o1" })).toEqual({
      op: "pagePng",
      src: "/a/doc.html",
      dstDir: "/a/verify/o1",
    })
    expect(validateRequest({ op: "pagePng", src: "/a/doc.htm", dstDir: "/a", pages: [3, 1], dpi: 96, widthMm: 148, heightMm: 210 })).toEqual({
      op: "pagePng",
      src: "/a/doc.htm",
      dstDir: "/a",
      pages: [3, 1],
      dpi: 96,
      widthMm: 148,
      heightMm: 210,
    })
    const ok = { op: "pagePng", src: "/a/doc.html", dstDir: "/a" }
    expect(code(() => validateRequest({ ...ok, src: "/a/fig.svg" }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ ...ok, dstDir: "" }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ op: "pagePng", src: "/a/doc.html" }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ ...ok, dst: "/a/p.png" }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ ...ok, script: "(function(){})" }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ ...ok, pages: [] }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ ...ok, pages: [1, 1] }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ ...ok, pages: [0] }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ ...ok, pages: [2001] }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ ...ok, pages: [1.5] }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ ...ok, pages: Array.from({ length: 13 }, (_, i) => i + 1) }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ ...ok, dpi: 35 }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ ...ok, dpi: 301 }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ ...ok, dpi: 150.5 }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ ...ok, widthMm: 148 }))).toBe("BAD_REQUEST")
    expect(code(() => validateRequest({ ...ok, widthMm: 5001, heightMm: 10 }))).toBe("BAD_REQUEST")
  })

  test("parses the envelope and keeps the token out of the error response", () => {
    const env = parseLine(JSON.stringify({ token: "secret", id: "j1", op: "hello" }))
    expect(env).toMatchObject({ id: "j1", token: "secret" })
    expect(code(() => parseLine("{not json"))).toBe("BAD_REQUEST")
    expect(code(() => parseLine(JSON.stringify({ id: "x".repeat(65), op: "hello" })))).toBe("BAD_REQUEST")
    const res = errorResponse("j1", new Error("internal detail /Users/x"))
    expect(res).toEqual({ id: "j1", ok: false, code: "RENDER_FAILED", message: "render failed", error: "render failed" })
  })
})
