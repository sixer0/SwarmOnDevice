// Row-94 unit tests — URL policy matrix (T-W7-2, masterplan/01f §6.4). PURE vectors: every
// denied range/name/encoding yields ok:false with the NAMED reason; a public host yields
// ok:true; the estate allow-list exception behaves per the header semantics in urlpolicy.ts.
// Run TARGETED: cd packages/setup && bun test test/mcp_urlpolicy.test.ts

import { describe, it, expect } from "bun:test"
import { checkUrl, isDeniedAddress } from "../src/mcpproxy/urlpolicy.ts"

describe("T-W7-2 rules 1-2: scheme + parseability", () => {
  const schemeVectors = [
    "file:///etc/passwd",
    "ftp://example.com/f",
    "gopher://example.com:70/x",
    "data:text/plain,hello",
    "javascript:alert(1)",
  ] as const
  for (const v of schemeVectors) {
    it(`${v} -> scheme_not_allowed`, () => {
      expect(checkUrl(v)).toEqual({ ok: false, reason: "scheme_not_allowed" })
    })
  }
  it("unparseable input refuses instead of throwing", () => {
    expect(checkUrl("not a url").ok).toBe(false)
    expect(checkUrl("").reason).toBe("url_unparseable")
    expect(checkUrl("http://").reason).toBe("url_unparseable")
  })
})

describe("T-W7-2 rule 3: denied host names", () => {
  const names = [
    "http://localhost/x",
    "http://APP.LOCAL/",
    "http://svc.internal:8080/",
    "http://host.docker.internal/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://node.localhost/",
  ] as const
  for (const v of names) {
    it(`${v} -> host_denied_name`, () => {
      expect(checkUrl(v)).toEqual({ ok: false, reason: "host_denied_name" })
    })
  }
})

describe("T-W7-2 rule 4: denied address ranges (public path, NO allow-list)", () => {
  const ranges: readonly [string, string][] = [
    ["http://127.0.0.1:9021/search?q=x", "loopback 127/8"],
    ["http://127.5.6.7/", "loopback non-zero second octet"],
    ["http://[::1]/", "IPv6 ::1"],
    ["http://0.0.0.0/", "this-network"],
    ["http://[::]/", "IPv6 unspecified"],
    ["http://169.254.169.254/latest/meta-data/", "link-local / cloud metadata"],
    ["http://10.10.20.30/", "RFC1918 10/8"],
    ["http://172.16.0.1/", "RFC1918 172.16/12"],
    ["http://172.31.255.255/", "RFC1918 172.16/12 upper edge"],
    ["http://192.168.11.7/", "RFC1918 192.168/16"],
    ["http://100.64.0.1/", "CGNAT 100.64/10"],
    ["http://[fd12:3456::1]/", "fc00::/7 unique-local"],
    ["http://[fe80::1]/", "fe80::/10 link-local"],
  ] as const
  for (const [v, label] of ranges) {
    it(`${label}: ${v} -> address_denied`, () => {
      expect(checkUrl(v)).toEqual({ ok: false, reason: "address_denied" })
    })
  }

  it("IPv4-mapped IPv6 normalised before the range test (§6.4 [H] closed by measurement)", () => {
    expect(checkUrl("http://[::ffff:127.0.0.1]/")).toEqual({ ok: false, reason: "address_denied" })
    expect(checkUrl("http://[::ffff:7f00:1]/")).toEqual({ ok: false, reason: "address_denied" }) // hex form
    expect(isDeniedAddress("::ffff:10.0.0.1")).toBe(true)
  })

  it("decimal / octal / hex IPv4 encodings are denied whichever layer normalises them", () => {
    // WHATWG URL expands these at parse time; the literal parsers catch them if it does not.
    expect(checkUrl("http://2130706433/")).toEqual({ ok: false, reason: "address_denied" }) // =127.0.0.1
    expect(checkUrl("http://0x7f.0.0.1/")).toEqual({ ok: false, reason: "address_denied" })
    expect(checkUrl("http://0177.0.0.1/")).toEqual({ ok: false, reason: "address_denied" })
    expect(isDeniedAddress("2130706433")).toBe(false) // a bare number is NOT a 4-part literal...
    expect(isDeniedAddress("0177.0.0.1")).toBe(true) // ...but octal dotted-quad IS, defensively parsed
  })

  it("non-denied public IPs pass", () => {
    expect(checkUrl("https://93.184.216.34/")).toEqual({ ok: true, host: "93.184.216.34" })
    expect(isDeniedAddress("172.15.0.1")).toBe(false) // just outside 172.16/12
    expect(isDeniedAddress("100.63.0.1")).toBe(false) // just below CGNAT
    expect(isDeniedAddress("172.20.0.1")).toBe(true) // inside 172.16/12
  })
})

describe("T-W7-2 rule 5 + estate exception: allow-list semantics", () => {
  it("allow-listed loopback estate service passes (search MUST reach SearXNG per §6.2)", () => {
    expect(checkUrl("http://127.0.0.1:9021/search?q=x&format=json", { allowList: ["127.0.0.1:9021"] })).toEqual({
      ok: true,
      host: "127.0.0.1",
    })
  })
  it("anything outside a supplied allow-list is refused, incl. other estate ports", () => {
    expect(checkUrl("http://127.0.0.1:9022/", { allowList: ["127.0.0.1:9021"] })).toEqual({
      ok: false,
      reason: "not_in_allow_list",
    })
    expect(checkUrl("https://example.com/", { allowList: ["127.0.0.1:9021"] })).toEqual({
      ok: false,
      reason: "not_in_allow_list",
    })
  })
  it("allow-list does NOT bypass scheme/parseability (rules 1-2 still fire)", () => {
    expect(checkUrl("file:///etc/passwd", { allowList: ["127.0.0.1"] })).toEqual({
      ok: false,
      reason: "scheme_not_allowed",
    })
    expect(checkUrl("garbage", { allowList: ["127.0.0.1"] })).toEqual({ ok: false, reason: "url_unparseable" })
  })
  it("a bare-host entry matches any port on that host", () => {
    expect(checkUrl("http://127.0.0.1:1234/", { allowList: ["127.0.0.1"] }).ok).toBe(true)
  })
})

describe("T-W7-2 positive control: public hosts", () => {
  it("https public host ok with normalised lowercase host", () => {
    expect(checkUrl("https://Example.COM/Path?q=1")).toEqual({ ok: true, host: "example.com" })
  })
  it("userinfo trickery cannot disguise an IP target", () => {
    expect(checkUrl("http://evil@example.com/../@127.0.0.1/")).toEqual({ ok: true, host: "example.com" }) // WHATWG puts example.com as host; the userinfo never reaches a request target
    expect(checkUrl("http://user:pw@127.0.0.1/")).toEqual({ ok: false, reason: "address_denied" })
  })
})
