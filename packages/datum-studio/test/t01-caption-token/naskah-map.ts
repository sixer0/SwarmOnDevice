// Swarm 1.2.6 row 27 (T-01, flow F2): content-free mapper from a naskah figure block (the anonymised fixtures
// test/fixtures/anon126/t01_k*.json, and the local Rev D blocks of flow F2 in row 115) to a Studio v2 figure block.
// It copies structure only: no text is invented except the fixed source "Uji." (a naskah block carries none).
// Naskah fields with no v2 counterpart are dropped: `title` (Studio prints the label and caption), `nomor` (Studio
// numbers figures itself), `arah` (the v2 `direction` field is T-11's, rows 45-48), `labelShort` as a string.

export type NaskahBlock = {
  jenis: "diagram" | "chart"
  family?: string
  labels_verified?: boolean
  caption: string
  legend?: string[]
  data: Record<string, unknown>
}

export const NASKAH_SOURCE = "Uji."

/** One naskah block as a v2 `diagram` (inline spec) or `chart` (P-01, categorical) block; `caption` overrides the caption. */
export function naskahToBlockV2(n: NaskahBlock, caption: string = n.caption): Record<string, unknown> {
  const fig = { caption: { text: caption }, source: { text: NASKAH_SOURCE } }
  if (n.jenis === "chart") return { type: "chart", code: "P-01", data: n.data, ...fig }
  const spec: Record<string, unknown> = { family: n.family ?? "flow", nodes: n.data.nodes ?? [], edges: n.data.edges ?? [] }
  if (n.labels_verified !== undefined) spec.labels_verified = n.labels_verified
  if (Array.isArray(n.legend) && n.legend.length > 0) spec.legend = n.legend
  return { type: "diagram", spec, ...fig }
}
