// SearXNG settings.yml renderer — 01e §8 (template PC-PKG-05).
// Rendered to <toolsRoot>/searxng/settings.yml at mode 0600 (D-17 path list).
//
// H-11 engine pruning, two paths (the brief's "report which path you took"):
//  1. "image-settings" — the pinned image's OWN default settings.yml (extracted once at
//     bake via docker run --rm --entrypoint cat <pinned> /usr/local/searxng/searx/settings.yml,
//     01e §8.1) is parsed and the fallback form is generated: use_default_settings.engines.remove
//     = every engine name NOT in the curated four. This is the documented merge-prune fallback
//     generated mechanically from the pinned image's own settings — never hand-copied.
//  2. "fallback-list-of-four" — no image text available (no docker tooling in this render
//     context): render the primary §8 form (keep-defaults-off + enable the curated four +
//     categories_as_tabs: {} tab prune) and mark [H] for row 111's live probe table (§8.2).
//
// secret_key stays the literal "$SEARXNG_SECRET" indirection (upstream substitution, 02b §4).
// The OWNER step substitutes it from secrets/secret_key at apply time and MUST run
// validateRenderedSecrets() (index.ts) on the resolved value: `ultrasecretkey` refuses (P-8).

import { parseEngineNames, type NormalizedCtx, type RenderError, type RenderFile } from "./shared.ts"

const CURATED = ["wikipedia", "wikidata", "brave", "duckduckgo"] as const // 01e §8 approved-list seed

export function renderSearxngSettings(
  ctx: NormalizedCtx,
): { ok: true; file: RenderFile; warnings: string[] } | { ok: false; errors: RenderError[] } {
  if (ctx.explicitImageRequest && ctx.defaultSettingsText === undefined) {
    return {
      ok: false,
      errors: [
        {
          code: "ENGINE_SETTINGS_INVALID",
          message: "enginePath=image-settings requires ctx.defaultSettings (the pinned image's own settings.yml text)",
        },
      ],
    }
  }
  const warnings: string[] = []
  const head = [
    "# settings.yml — PC-PKG-05 rendered by the swarm-setup compose-files renderer (row 85)",
    "# Content spec: masterplan/01e_compose_spec.md §8. Mode 0600 (D-17). Owner substitutes",
    "# $SEARXNG_SECRET from secrets/secret_key at apply time; placeholder refusal per P-8.",
  ]

  const serverBlock = [
    "server:",
    '  secret_key: "$SEARXNG_SECRET"  # upstream substitution (02b §4); resolved value must never equal ultrasecretkey (P-8 gate lives with the owner step)',
    "  baseline_url: null  # explicit: none (single-user loopback, no limiter pressure needed)",
    "  public_instance: false  # DECIDED (02b:118): no limiter enforcement mode, no rate-limit UI",
    "  image_proxy: false  # D-07: kills the unauthenticated SSRF-oracle path; sanitiser strips markdown images anyway; key belongs under server:, not search:",
  ]

  const searchBlock = [
    "search:",
    "  formats: [html, json]  # JSON required by C7-1(4)/the swarm-web proxy queries; otherwise 403 (02b:117)",
    '  autocomplete: ""  # OFF: upstream default duckduckgo is a search-time side-channel per keystroke (02b §4)',
  ]

  const enableBlock = [
    "engines:  # curation mechanism: keep upstream default OFF flags, then enable ONLY the four curated engines (§8)",
    ...CURATED.flatMap((name) => [`  - name: ${name}`, "    disabled: false"]),
  ]

  let body: string[]
  if (ctx.enginePath === "image-settings") {
    const all = parseEngineNames(ctx.defaultSettingsText ?? "")
    const remove = all.filter((n) => !(CURATED as readonly string[]).includes(n))
    if (remove.length === 0) {
      return {
        ok: false,
        errors: [
          {
            code: "ENGINE_SETTINGS_INVALID",
            message:
              "defaultSettings parsed but yielded no engine names to prune — refusing to emit an empty remove list",
          },
        ],
      }
    }
    body = [
      "use_default_settings:  # generated from the PINNED image's own settings.yml (01e §8 note): remove-everything-except, immune to master-vs-pinned drift (U-12)",
      "  engines:",
      "    remove:",
      ...remove.map((n) => `      - ${n}`),
      "",
      ...serverBlock,
      "",
      ...searchBlock,
      "",
      ...enableBlock,
    ]
    warnings.push(
      `settings engine-path=image-settings: generated engines.remove list of ${remove.length} names from the pinned image's default settings`,
    )
  } else {
    body = [
      "use_default_settings: true  # merge semantics proven from docs.searxng.org (example merges by engine name; engines.remove is the documented exclusion list)",
      "",
      ...serverBlock,
      "",
      ...searchBlock,
      "",
      ...enableBlock,
      "",
      "categories_as_tabs: {}  # H-11 [H]: empty mapping prunes every tab (general remains via the engines' own categories). FALLBACK PATH: merge-prune feasibility UNVERIFIED without a live daemon — row 111 runs the §8.2 probe table (!bang of a non-curated engine must not hit it; csv must 403). If pruning fails live, re-render with the pinned image's own settings supplied (docker run --rm --entrypoint cat <pinned> /usr/local/searxng/searx/settings.yml) to switch this file to the generated engines.remove form.",
    ]
    warnings.push(
      "settings engine-path=fallback-list-of-four: curated four enabled + categories_as_tabs prune [H]; generated merge-prune list NOT available (no image extraction tooling in this context) — marked for row 111 verification",
    )
  }

  return {
    ok: true,
    file: {
      relPath: "searxng/settings.yml",
      content: [...head, "", ...body, ""].join("\n"),
      mode: 0o600,
      stack: "searxng",
    },
    warnings,
  }
}
