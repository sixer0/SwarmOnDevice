// Row-94 unit tests — URL policy matrix (T-W7-2, masterplan/01f §6.4). PURE vectors: every
// denied range/name/encoding yields ok:false with the NAMED reason; a public host yields
// ok:true; the estate allow-list exception behaves per the header semantics in urlpolicy.ts.
// Run TARGETED: cd packages/setup && bun test test/mcp_urlpolicy.test.ts

import { describe, it, expect } from "bun:test"
import { checkUrl, isDeniedAddress, isIpLiteral, checkResolvedAddresses, nat64Embedded } from "../src/mcpproxy/urlpolicy.ts"

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

// --- FIX2 (senior review 107 MAJOR-3): deny-set completion + NAT64 + resolved-answer gate ------

describe("FIX2 deny-set: 0.0.0.0/8, ::/128, NAT64 64:ff9b::/96", () => {
  it("0.0.0.0/8 denied across the range, not only the exact address", () => {
    expect(checkUrl("http://0.0.0.0/")).toEqual({ ok: false, reason: "address_denied" })
    expect(checkUrl("http://0.5.6.7/")).toEqual({ ok: false, reason: "address_denied" })
    expect(isDeniedAddress("0.255.255.255")).toBe(true)
    expect(isDeniedAddress("1.0.0.1")).toBe(false) // just outside the range
  })

  it("::/128 unspecified and ::1 loopback denied", () => {
    expect(checkUrl("http://[::]/")).toEqual({ ok: false, reason: "address_denied" })
    expect(isDeniedAddress("::")).toBe(true)
    expect(isDeniedAddress("::1")).toBe(true)
  })

  it("NAT64 well-known prefix refused as literals (whole /96, documented conservative choice)", () => {
    expect(checkUrl("http://[64:ff9b::7f00:1]/")).toEqual({ ok: false, reason: "address_denied" }) // wraps 127.0.0.1
    expect(checkUrl("http://[64:ff9b::808:808]/")).toEqual({ ok: false, reason: "address_denied" }) // wraps 8.8.8.8 — prefix rule denies regardless
    expect(isDeniedAddress("64:ff9b::a0b:c0d")).toBe(true)
  })

  it("NAT64 embedded-v4 mapping UNDERSTOOD, not just pattern-blocked", () => {
    expect(nat64Embedded("64:ff9b::7f00:1")).toBe("127.0.0.1")
    expect(nat64Embedded("64:ff9b::808:808")).toBe("8.8.8.8")
    expect(nat64Embedded("64:ff9b:1::7f00:1")).toBeNull() // local-use /48 is not the well-known /96
    expect(nat64Embedded("2001:db8::1")).toBeNull()
    // Honest boundary: the local-use prefix is NOT in the literal deny set; names resolving to it
    // are still caught by the transport's resolved-answer gate (mcp_proxy FIX2 suite).
    expect(isDeniedAddress("64:ff9b:1::7f00:1")).toBe(false)
  })

  it("isIpLiteral distinguishes names from v4/v6 literals for the transport's pin decision", () => {
    expect(isIpLiteral("127.0.0.1")).toBe(true)
    expect(isIpLiteral("::1")).toBe(true)
    expect(isIpLiteral("64:ff9b::1")).toBe(true)
    expect(isIpLiteral("example.com")).toBe(false)
    expect(isIpLiteral("999.1.1.1")).toBe(false) // malformed quad stays name-shaped; parseIPv4 rejects >255
  })
})

describe("FIX2 checkResolvedAddresses: every-answer gate feeding the pinned connect", () => {
  it("all-public answer set passes (null = no policy objection)", () => {
    expect(checkResolvedAddresses(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"])).toBeNull()
  })
  it("split-horizon rebinding set (public + loopback) refuses the WHOLE call", () => {
    expect(checkResolvedAddresses(["93.184.216.34", "127.0.0.1"])).toBe("address_denied")
    expect(checkResolvedAddresses(["127.0.0.1", "93.184.216.34"])).toBe("address_denied") // order-independent
  })
  it("single private / metadata / NAT64 / CGNAT answer refuses", () => {
    expect(checkResolvedAddresses(["::1"])).toBe("address_denied")
    expect(checkResolvedAddresses(["169.254.169.254"])).toBe("address_denied")
    expect(checkResolvedAddresses(["64:ff9b::7f00:1"])).toBe("address_denied")
    expect(checkResolvedAddresses(["100.64.0.7"])).toBe("address_denied")
    expect(checkResolvedAddresses(["fe80::2"])).toBe("address_denied")
  })
  it("empty answer set is NOT a policy decision (the caller surfaces the DNS failure honestly)", () => {
    expect(checkResolvedAddresses([])).toBeNull()
  })
})
