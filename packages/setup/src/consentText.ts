// Consent-screen texts — rendered from masterplan/01d_preinstall_consent_dataflow.md (REVISED,
// row 74 fix round). The nine P-13 field labels are used verbatim and in the same order as the
// eight blocks of 01d §4 so row 79's mechanical gate holds: Purpose, Source URL, Version, Hash,
// Licence, Size, Egress statement, Paths written, Uninstall path.
//
// English is primary; the Indonesian sentences appear exactly where 01d carries them (blocks 4.7
// and 4.8 — assumption A-5). Version/Hash/Size lines here describe provenance; the EXACT pin values
// are printed live from tools.lock.json via resolveArtifact (row 82) so this file never drifts a
// value away from the lock. Where 01d names a value that is still unclosed (guest image D-13/F-5,
// firecrawl-mcp F-2/D-11, Obsidian team_id U-2), the text says so instead of guessing (C-5).
//
// Citations into decisions/decisions.md quote that entry's own heading — 'USER DECISION
// (PORT BLOCK, 05:33 UTC)' — instead of a line number. The log grows on top of itself, so a bare
// ":NN" pointer goes stale without warning: the one this file carried for the port ruling drifted
// off target within a day (row 113's finding §2.5 in verification/09_preinstall_security.md).
// A heading is unique and greppable (`rg -n -F "USER DECISION (PORT BLOCK" decisions.md`), a line
// number is neither.

import type { ComponentId } from "./constants.ts"

export interface ConsentBlock {
  /** Which 01d block this is ("4.1".."4.8"), cited on screen. */
  readonly block: string
  /** Human title for the sub-block (runtime carries two: 4.1 + 4.2). */
  readonly title: string
  readonly purpose: string
  readonly sourceUrl: readonly string[]
  /** Provenance sentence for the Version field (values print live from the lock). */
  readonly versionNote: string
  /** Provenance sentence for the Hash field, including any caveat 01d says to show. */
  readonly hashNote: string
  readonly licence: string
  readonly sizeNote: string
  /** Egress statement; first lines are the disclosure decision 12 demands. */
  readonly egress: readonly string[]
  readonly pathsWritten: readonly string[]
  readonly uninstallPath: readonly string[]
  /** Third-party terms LINKED here — never auto-accepted (C-2). Absent = plain FOSS licence. */
  readonly termsUrl?: string
  /** Revision string the setup records for the linked terms (01d §6.5 terms_revision), or n/a. */
  readonly termsRevision?: string
  /** Extra warnings 01d says belong on the screen. */
  readonly warnings: readonly string[]
}

/** The sentence 01d §6.3 requires at the end of every third-party-terms block. */
export const THIRD_PARTY_TERMS_SENTENCE =
  "These terms are between you and the upstream party; PT GSP does not accept them for you."

/** runtime carries two sub-blocks (01d maps eight blocks to seven ids, A-2: one id, one state
 *  record, two things a user should read separately). */
const RUNTIME: readonly ConsentBlock[] = [
  {
    block: "4.1",
    title: "Container runtime: Colima, Lima and the VM image",
    purpose:
      "Provides the Linux virtual machine that runs the container stacks. Colima is the user-space " +
      "manager, Lima the hypervisor layer underneath, and the VM boots from a disk image Colima " +
      "downloads on first start. Chosen because SearXNG/Firecrawl run as containers and Docker " +
      "Desktop was rejected: its subscription agreement bars government entities from using it " +
      "without a paid subscription, and this product's clients are government entities.",
    sourceUrl: [
      "https://github.com/abiosoft/colima/releases/download/v0.10.3/colima-Darwin-arm64",
      "https://github.com/lima-vm/lima/releases/download/v2.2.1/lima-2.2.1-Darwin-arm64.tar.gz",
      "https://formulae.brew.sh/api/formula/colima.json (Homebrew alternative; bottles on ghcr.io)",
      "VM guest image: no reviewed pin yet (finding F-5); the runtime step may not fetch an unpinned image (gate D-13)",
    ],
    versionNote:
      "Colima v0.10.3, Lima v2.2.1, QEMU 11.1.2 only for the non-default --vm-type qemu fallback; guest image tag unverified as a pin.",
    hashNote:
      "Colima sha256 from the release's own .sha256sum sidecar; Lima sha256 from the release SHA256SUMS covered by a PGP signature (strongest chain in the pin set); " +
      "the VM guest image has NO hash from any source — 'no reviewed value' (D-13/F-5).",
    licence:
      "Colima MIT; Lima Apache-2.0; QEMU (fallback VM type) GPL-2.0-only; Ubuntu guest brings its own content licences (not enumerated).",
    sizeNote:
      "Colima 15,656,320 B; Lima 38,328,082 B; guest image measured candidate 332,354,401 B (not a pin). VM disk grows as containers are pulled.",
    egress: [
      "Install sends metadata requests and binary downloads to the hosts on the printed list (Homebrew API + bottle registry + GitHub release hosts), plus, on first profile start, the guest-image download finding F-5 tracks.",
      "Nothing the user has created leaves the machine. After install, 'colima start --profile swarm' boots a Linux VM; its outbound traffic is what the SearXNG/Firecrawl stacks do (disclosed in their blocks).",
      "Whether Colima or Lima phone home for update checks: UNKNOWN, closed by row 113's observed-egress test. No registry login of any kind is performed, so no credential leaves via this block.",
    ],
    pathsWritten: [
      "/opt/homebrew/Cellar/colima/** and /opt/homebrew/Cellar/lima/** plus bin symlinks and the Homebrew cache under ~/Library/Caches/Homebrew/** (outside the P-16 whitelist — finding F-3, disclosed not hidden)",
      "~/.colima/swarm/** and ~/.lima/swarm/** (instance dir name verified by row 86)",
      "Swarm's own records: ~/.swarm/tools/runtime/ (PC-PATH-08) and ~/.swarm/setup/state.json (PC-PATH-02)",
    ],
    uninstallPath: [
      "swarm-setup remove stops and deletes the 'swarm' Colima profile ONLY if the state file records Swarm created it, and only objects labelled io.gsp.swarm.managed=true in project swarm-tools.",
      "Never 'docker system prune', never the user's default profile or current context, never 'brew uninstall' — formulae get a printed manual command (P-4 pattern).",
    ],
    warnings: [
      "Homebrew absent means this block stops with instructions; the setup never installs Homebrew itself (P-3).",
    ],
  },
  {
    block: "4.2",
    title: "Docker client: docker CLI and compose plugin",
    purpose:
      "Gives the setup the docker command and docker compose subcommand to bring stacks up and down " +
      "against the 'swarm' context. Only the client is installed; the engine runs inside the Colima VM from block 4.1.",
    sourceUrl: [
      "https://formulae.brew.sh/api/formula/docker.json",
      "https://formulae.brew.sh/api/formula/docker-compose.json",
      "https://github.com/docker/compose/releases/download/v5.6.0/docker-compose-darwin-aarch64",
      "upstream projects: https://github.com/docker/cli · https://github.com/docker/compose",
    ],
    versionNote:
      "docker CLI 29.9.1 via the Homebrew formula; compose plugin v5.6.0. Installs alongside an existing older docker without replacing it.",
    hashNote:
      "Compose sha256 from the release per-asset .sha256 sidecar cross-checked against checksums.txt. The docker CLI is the weak link and the screen says so: " +
      "its only independent hash is the Homebrew bottle metadata (vendor static channel publishes no checksum; docker/cli publishes no releases) — item U-3.",
    licence:
      "docker/cli Apache-2.0; docker/compose Apache-2.0 (both verified via the GitHub API). The commercial Docker Desktop terms do NOT apply to these FOSS artifacts and this screen does not imply they do.",
    sizeNote:
      "Compose 30,812,418 B; docker CLI bottle published per macOS codename (static-tarball reference 19,655,010 B is quoted as order of magnitude, not as the pin).",
    egress: [
      "Install contacts the Homebrew API host and ghcr.io only. At run time the client talks to the local socket of the 'swarm' context and, during a pull, to the registries named in blocks 4.7/4.8.",
      "No 'docker login' is ever performed: anonymous pulls only, which is why Docker Hub rate limits are a known constraint (P-15 prefers ghcr.io references).",
    ],
    pathsWritten: [
      "/opt/homebrew/Cellar/docker/**, /opt/homebrew/Cellar/docker-compose/**, and the CLI plugin file /opt/homebrew/lib/docker/cli-plugins/docker-compose (F-3 whitelist note applies)",
      "~/.docker/ is created by the docker CLI itself on first use; Swarm never writes a credential helper into it.",
    ],
    uninstallPath: [
      "Identical to block 4.1: labelled objects and the 'swarm' profile only; formulae left in place with a printed manual command.",
      "If the user already had a docker CLI, the setup detects it and does not overwrite it.",
    ],
    termsUrl: "https://www.docker.com/legal/docker-subscriptions-service-agreement",
    termsRevision:
      "n/a (FOSS licences Apache-2.0; the Docker Desktop subscription agreement is named here so a client that mandates Docker Desktop knows which terms it is NOT accepting)",
    warnings: [],
  },
]

/** Single-block components (all ids except runtime). */
const SINGLE: Record<Exclude<ComponentId, "runtime">, readonly ConsentBlock[]> = {
  node: [
    {
      block: "4.3",
      title: "Node.js runtime (private pinned copy)",
      purpose:
        "Provides the JavaScript runtime Graft needs (Node >= 20) and firecrawl-mcp needs (Node >= 22) " +
        "as a private pinned copy, so a clean Mac can install the tool set without an administrator and " +
        "without changing the user's own Node (P-19 prerequisite chain).",
      sourceUrl: [
        "https://nodejs.org/dist/v24.22.0/node-v24.22.0-darwin-arm64.tar.gz",
        "https://nodejs.org/dist/v24.22.0/SHASUMS256.txt (vendor sums, a different artifact from the tarball)",
      ],
      versionNote:
        "v24.22.0 'Krypton', newest LTS head at collection time; satisfies both consumers. .tar.gz form decided by gate item D-09.",
      hashNote:
        "sha256 read from the vendor's own published SHASUMS256.txt — the strongest kind of independent source (P-1): the sums file is a different artifact from the tarball.",
      licence:
        "MIT (the LICENSE file opens with the MIT permission text; GitHub says NOASSERTION only because the same file lists bundled components' licences).",
      sizeNote:
        "Tarball 53,049,576 B (50.6 MiB) measured against the vendor; extracted runtime is larger (row 87 measures it).",
      egress: [
        "Download contacts nodejs.org only. npm runs against registry.npmjs.org for the Graft and firecrawl-mcp installs; Node itself sends nothing and has no telemetry flags to set.",
        "Caveat in front of a human: npm may contact the registry for package metadata even for a pinned install — that is why the registry host is on the list.",
      ],
      pathsWritten: [
        "~/.swarm/tools/node/** (private runtime, PC-PATH-08) staged under ~/.swarm/tmp with an atomic move (P-15)",
        "npm cache redirected to ~/.swarm/tools/node/.npm-cache so nothing lands under ~/.npm (P-16)",
        "No shell rc file edited, no PATH change — the user's own Node stays untouched.",
      ],
      uninstallPath: [
        "Delete ~/.swarm/tools/node and the state entry — remove deletes only the private directory (row 87 acceptance).",
      ],
      warnings: [],
    },
  ],
  graft: [
    {
      block: "4.4",
      title: "Graft context graph (@nanonets/graft)",
      purpose:
        "Builds a repository context graph offline so the agent can navigate code with cheap queries " +
        "instead of reading files. Only the wiring layer is used: build, check, ask, callers, skeleton, blast, grep, map.",
      sourceUrl: [
        "https://registry.npmjs.org/@nanonets/graft (package metadata + tarball)",
        "project: https://github.com/trailhq/Trail-Code",
      ],
      versionNote:
        "@nanonets/graft 0.18.0 decided by gate item D-10: it is the version whose arm64 behaviour is documented on this machine; the 0.23.x tree-sitter prebuild layout is UNVERIFIED (U-5). " +
        "Never installed: the renamed twin @trailhq/trail-code (registers only the 'trail' binary).",
      hashNote:
        "npm dist.integrity sha512 — registry metadata served separately from the tarball, satisfying P-1 independence.",
      licence: "MIT, 'Copyright (c) 2026 Context Graph Engine contributors'.",
      sizeNote:
        "Tarball 728,291 B unpacking to 2,670,849 B across 576 files; installed footprint measured 387 MB on this machine (tree-sitter grammars dominate) — both figures shown because the tarball alone would understate Graft by two orders of magnitude.",
      egress: [
        "(a) Telemetry: the installed version reports anonymous usage stats to events.nanonets.com ON BY DEFAULT. The setup exports DO_NOT_TRACK=1 before install and in the MCP runtime env, installs with scripts ignored, and checks 'graft telemetry' afterwards expecting off. events.nanonets.com is deliberately NOT on the host list, so a leak is visible at the firewall.",
        "(b) Code: the wiring layer reads the repository and writes its graph locally, no key, no network. '--deep' would send source excerpts to an LLM provider and 'graft init' would read past Claude Code sessions and PR review comments — BOTH are forbidden by row 88 and the must-be-unset set; this text says so in plain words.",
      ],
      pathsWritten: [
        "~/.swarm/tools/graft/** (private prefix, PC-PATH-08); MCP entry in ~/.config/swarm/ written only after health passes (row 97)",
        "When the user later runs a graft build inside a repository: <repo>/graft/**, a 'graft/' line added to that repo's .gitignore, possibly <repo>/.graft/config.json — edits to a user repository disclosed here per P-10, outside ~/.swarm.",
        "The setup never runs 'graft init': ~/.claude, ~/.codex and project .mcp.json files are not written by this installer.",
      ],
      uninstallPath: [
        "Delete ~/.swarm/tools/graft and the two recorded config entries, restoring the byte manifest captured before install (row 88 gate).",
        "Graph directories inside user repositories are NOT deleted automatically; remove prints the list so the user can clean them — silently editing a user's repo during uninstall would be worse than leaving a regenerable cache.",
      ],
      warnings: [
        "The Homebrew 'rtk' 0.49.0 already on this machine is the OTHER RTK edition and does not satisfy the rtk pin — relevant when reading block 4.5.",
      ],
    },
  ],
  rtk: [
    {
      block: "4.5",
      title: "RTK command-output filter — rtk-oss edition",
      purpose:
        "Filters and shortens the output of shell commands before it reaches the model (the token-saving tool). " +
        "Installed as the Apache-only rtk-oss edition.",
      sourceUrl: [
        "https://github.com/rtk-ai/rtk/releases/download/v1.0.1/rtk-oss-aarch64-apple-darwin.tar.gz",
        "plus the release's separate checksums.txt",
      ],
      versionNote:
        "v1.0.1 of 2026-10-14, rtk-oss arm64 asset. Warning carried from row 77: the Homebrew rtk 0.49.0 on this machine is the other edition and does not satisfy this pin.",
      hashNote:
        "sha256 read from the release's separate 2,236-byte checksums.txt — a different file from the same release, exactly the independence P-1 demands. Never re-fetched from that release during install.",
      licence:
        "Apache-2.0 for rtk-oss. The standard rtk edition bundles a BUSL-1.1 engine whose use grant excludes offering RTK or a derivative commercially (blocker B3/L16 route that to legal; engineering proceeds on rtk-oss). " +
        "The two editions install the same binary name and cannot coexist.",
      sizeNote: "arm64 rtk-oss asset 4,999,666 B (4.8 MiB) at v1.0.1.",
      egress: [
        "The README states RTK collects no command content and no file contents; telemetry is anonymous, OFF by default, and nothing is sent until 'rtk telemetry enable' runs — which the setup never runs.",
        "Local disclosure: RTK keeps a 90-day tracking history in ~/Library/Application Support/rtk/config.toml; that history may contain command text (P-11 requires off-or-short with mode 0600).",
        "Operator disclosure: RTK works by rewriting agent shell commands and hiding output from the model; 'rtk recall <hash>' is the only way to see what was elided.",
      ],
      pathsWritten: [
        "~/.swarm/tools/rtk/bin/rtk (private path, invoked by absolute path so a Homebrew rtk is never shadowed or overwritten — row 89)",
        "RTK's own config dir ~/Library/Application Support/rtk/ (outside P-16, disclosed) and Swarm-side integration files under ~/.config/swarm/ (row 97).",
        "The setup does not run 'rtk init': no other agent's settings file is edited.",
      ],
      uninstallPath: [
        "Delete ~/.swarm/tools/rtk. The config dir is deleted only if the state file shows Swarm created it; a pre-existing one is left alone and reported. A pre-existing Homebrew rtk is never modified (row 89 verifies byte-identical).",
      ],
      warnings: [
        "If an 'rtk' is already present (Homebrew edition), the two editions cannot coexist — the private install never touches it, but the user should know.",
      ],
    },
  ],
  obsidian: [
    {
      block: "4.6",
      title: "Obsidian and the Swarm vault",
      purpose:
        "Local plain-text note storage for the human side of the workflow, with a dedicated Swarm vault " +
        "holding an inbox/ folder the agent writes to and a person reads from (C7-3).",
      sourceUrl: [
        "https://github.com/obsidianmd/obsidian-releases/releases/download/v1.14.4/Obsidian-1.14.4.dmg",
        "terms: https://obsidian.md/terms · licence page: https://obsidian.md/license",
      ],
      versionNote:
        "v1.14.4 of 2026-10-05 (asset Obsidian-1.14.4.dmg). The official page labels the Mac build 'Universal': one DMG serves Apple Silicon and Intel (slice-level universality rests on the label, not binary inspection).",
      hashNote:
        "CAVEAT the screen does not hide: NO official Obsidian checksum exists for the DMG (three official avenues checked). " +
        "The sha256 shown below comes from the Homebrew project's cask record — independent of the file, but not from Obsidian (U-1). " +
        "obsidian.team_id is UNVERIFIED too; row 82's codesign -dvvv on the mounted app is the closer (U-2).",
      licence:
        "Proprietary, per-user, non-transferable (LicenseRef-Obsidian). The 2026 terms permit commercial and government use at no cost; the exposure is copying/sharing, not using. " +
        "That is why the file is fetched on the user's own machine from Obsidian's official release and PT GSP never hosts, mirrors or bundles it (P-12/L-4).",
      sizeNote: "DMG 233,704,463 B (222.9 MiB).",
      egress: [
        "The vault is local Markdown files; no account needed; this install configures no Sync and no Publish (P-12).",
        "Flow 1: the app's own update mechanism — the cask record for this exact version carries auto_updates:true, so an unattended self-update can move the machine off the reviewed pin. Swarm keeps the app inside the pin where a documented switch exists and CANNOT guarantee it otherwise.",
        "Flow 2: anything the user chooses to do inside the app — outside Swarm's control and outside this design.",
        "Community plugins: none pre-seeded, Restricted Mode stays on, the Local REST API plugin is NOT used at all — Swarm reaches the vault through a path-limited filesystem tool, so no port on 127.0.0.1:27124 is opened.",
      ],
      pathsWritten: [
        "/Applications/Obsidian.app — ONLY if absent (P-16 whitelist)",
        "the new vault at PC-PATH-13 with its inbox/ folder at PC-PATH-12, plus a .obsidian/ settings dir inside that vault",
        "Swarm install records under ~/.swarm/tools/obsidian/; Obsidian's own global state under ~/Library/Application Support/obsidian/ (created by the app on first launch, outside P-16 — F-3/D-08)",
        "An existing personal vault is never pointed at or modified (C7-3).",
      ],
      uninstallPath: [
        "Remove deletes only what the state file lists: the app if Swarm installed it, and the config entries.",
        "REMOVING THE OBSIDIAN COMPONENT NEVER DELETES THE VAULT. The vault lives under ~/.swarm/vault (gate D-05 moved it out of the tool dir on purpose) and is deleted only by its own confirmation naming the folder and its file count — it holds notes a person wrote; deleting it is the one irreversible action in this document.",
        "If the user installed Obsidian themselves, the app is left in place.",
      ],
      termsUrl: "https://obsidian.md/terms",
      termsRevision:
        "last updated 2025-02-20 (recorded revision per 01d §6.5; the page is linked, never fetched at install, C-3/A-4)",
      warnings: [
        "Fetching Obsidian on the user's behalf is itself under legal review (L14); PT GSP does not mirror or bundle it.",
      ],
    },
  ],
  searxng: [
    {
      block: "4.7",
      title: "SearXNG metasearch stack",
      purpose:
        "A local metasearch endpoint the agent can query without a hosted search account, so results can be " +
        "sanitised and audited through the Swarm MCP proxy (C7-1). Off by default and unticked (decision 12).",
      sourceUrl: [
        "ghcr.io/searxng/searxng@sha256:... (preferred over docker.io: Hub rate-limits anonymous pulls, P-15)",
        "companion docker.io/valkey/valkey:9-alpine@sha256:... (the project's own compose names Valkey)",
        "images are pulled by dockerd INSIDE the swarm VM, not fetched by the setup (enforcement split D-16b)",
      ],
      versionNote:
        "SearXNG tag 2026.10.19-81371861f and valkey:9-alpine, pinned by row 78; digests print live from the lock (PC-IMG-01, PC-IMG-07).",
      hashNote:
        "Index + arm64 manifest digests from research/02e_image_pins.md (content-addressed). Row 78 names the SearXNG digest a controller re-fetch candidate because the project pushes dated tags several times a day.",
      licence:
        "SearXNG AGPL-3.0-only; Valkey BSD-3-Clause. The AGPL reading that matters here (L-1): pulling and running an UNMODIFIED image on LOOPBACK does not trigger section 13; patching, mirroring or exposing the service to others does — which is why public_instance stays false.",
      sizeNote: "115,329,246 B compressed for the two images together (96,040,360 B SearXNG + 19,288,886 B Valkey).",
      egress: [
        "*** Search text leaves this machine. Teks pencarian yang Anda ketik dikirim ke mesin pencari pihak ketiga di luar komputer ini. ***",
        "SearXNG answers by querying other engines. The shipped settings enable exactly FOUR engines — Wikipedia, Wikidata, Brave and DuckDuckGo — so query text reaches those four services (and Wikidata's API); autocomplete is off. Upstream's default-enabled group differs and includes Google CSE, which Swarm does NOT enable because it requires credentials we will not invent (gate D-18).",
        "For a defense user a query can carry project names, hostnames or error strings (P-7); the four engines are curated by row 75 §8 and legal item L17 still governs whether all four survive review.",
        "1. The port is open to this Mac: any program running as you can issue searches through 127.0.0.1:9021 (PC-PORT-01; the number was 8888 until the user's PORT BLOCK of 2026-10-20 05:33 UTC, decisions.md entry 'USER DECISION (PORT BLOCK, 05:33 UTC)'); the Firecrawl API is behind a bearer token, SearXNG has no token mechanism upstream. The caveat itself did not move with the number: at either port the exposure is the same. This is not a defect and cannot be fixed by Swarm without forking the product — but cost, query text and an outbound footprint are available to every local process (gate F-79-D).",
        "2. The image-fetch path is switched OFF: image_proxy:false (gate D-07). Left on, SearXNG would fetch result images from engine-supplied URLs with no policy and no audit line — an unaudited second fetch path and an SSRF probe into private ranges through the unauthenticated port above. Nothing is lost: the model consumes text and the sanitiser strips markdown images anyway.",
        "3. Only queries are logged, and locally: every call recorded with URL/query, response size and sha256 in ~/.swarm/logs/web-audit.log (PC-PATH-10) — an audit trail on the same disk as the user's work (retention row 76; UU PDP reading is L18).",
        "Nothing is sent to PT GSP: no Swarm server, no update feed, no analytics endpoint exists in this design (decision 3).",
      ],
      pathsWritten: [
        "~/.swarm/tools/searxng/secrets/ — dir 0700, one 0600 file per secret (secret_key behind SEARXNG_SECRET; the placeholder value 'ultrasecretkey' is rejected per P-8; optional valkey_auth) — layout adopted over a shared .env by gate D-04",
        "~/.swarm/tools/searxng/settings.yml (rendered from shipped template PC-PKG-05, bind-mounted read-only)",
        "~/.swarm/tools/searxng/searxng.env (non-secret: base URL only)",
        "~/.swarm/tools/searxng/cache/ (bind-mounted; NAMED VOLUMES are not used — uninstall leaves no docker volume residue, D-17)",
        "compose file PC-PKG-03 read from the package, never downloaded; inside the VM: labelled containers + project-prefixed networks of stack A + the one published host binding, PC-PORT-01 = 127.0.0.1:9021 (was 8888 before the PORT BLOCK, decisions.md entry 'USER DECISION (PORT BLOCK, 05:33 UTC)'; port history table 01d §5.4)",
        "CONDITIONAL (F-79-C): if row 75's FORCE_OWNERSHIP virtiofs fallback is ever taken, two of these paths become chmod 0777 and the 0600-in-0700 promise above stops being true for them — rows 75/84 own that decision.",
      ],
      uninstallPath: [
        "docker compose -p swarm-tools down restricted to objects labelled io.gsp.swarm.managed=true AND io.gsp.swarm.component=searxng; then labelled images by digest; then ~/.swarm/tools/searxng/ including secrets/, settings.yml, searxng.env, cache/.",
        "Bind mounts mean normally no docker volume object exists; ask-before-delete still applies to any volume the state file lists (P-14). 'docker system prune' is never run.",
      ],
      warnings: [
        "Requires the container runtime (block 4.1). Below the 16 GiB memory floor the stacks are skipped (decision 12; floor owned by rows 75/112).",
      ],
    },
  ],
  firecrawl: [
    {
      block: "4.8",
      title: "Firecrawl crawler stack",
      purpose:
        "Self-hosted scrape and crawl service so the agent retrieves pages through ONE controlled exit point " +
        "instead of ad-hoc fetches. Off by default, unticked, and skipped automatically below the memory floor.",
      sourceUrl: [
        "ghcr.io/firecrawl/firecrawl · ghcr.io/firecrawl/playwright-service · ghcr.io/firecrawl/nuq-postgres",
        "docker.io/library/redis:alpine · docker.io/library/rabbitmq:3-management · docker.io/library/nginx:stable-alpine (auth proxy)",
        "plus the npm package firecrawl-mcp for the agent-side connector",
        "images are pulled by dockerd INSIDE the swarm VM, not fetched by the setup (D-16b)",
      ],
      versionNote:
        "2.11.554-production (api), sha-a7a63b4bfabf (playwright-service, nuq-postgres); floating tags alpine/3-management/stable-alpine held only by their digests (no immutable tag exists). " +
        "firecrawl-mcp is NOT PINNED anywhere yet (finding F-2/D-11): 3.33.1 at collection time, requires Node >= 22 — the connector install waits for its pin.",
      hashNote:
        "Six image digests from research/02e_image_pins.md (PC-IMG-02..08), printed live from the lock. firecrawl-mcp integrity has no supplier yet (F-2).",
      licence:
        "Firecrawl application AGPL-3.0 with MIT SDKs; firecrawl-mcp MIT. Dependencies change the picture (finding F-4): RabbitMQ MPL-2.0 (server/tier-1) with some Apache-2.0 OCF files; nginx BSD-2-Clause; " +
        "Redis is a tri-license (RSALv2 OR SSPLv1 OR AGPLv3) for Redis 8+, BSD-3-Clause for <=7.2 — which one the pinned redis:alpine digest contains is UNKNOWN until row 75 inspects the image config (D-14). " +
        "Pre-committed consequence: if that digest resolves to AGPLv3 Redis, this stack contains a SECOND AGPL component — nothing changes about the loopback/unmodified posture that keeps section 13 quiet (L-1), but the notice inventory grows.",
      sizeNote:
        "1,506,115,926 B (1,436.4 MiB) compressed for the six images — the largest single consent item by a wide margin. firecrawl-mcp adds 633,631 B unpacked once pinned.",
      egress: [
        "*** Crawled URLs and the content of the pages fetched leave this machine and arrive at whatever site is crawled. Permintaan crawl dan isi halaman yang diambil dikirim ke dan dari situs target di luar komputer ini. ***",
        "Scraping sends outbound requests to target sites; a crawl is indistinguishable on the wire from the user browsing those sites, and the target's own access rules apply (L17).",
        "Three further flows are disclosed and all three are DESIGNED SHUT: pass-through vars that would forward scraped content to OpenAI, Ollama, Slack, Supabase, a webhook or a proxy must all be unset and are lint-checked (P-9); the API is unauthenticated upstream, answered by publishing NOTHING except the nginx auth proxy on PC-PORT-02 = 127.0.0.1:9022 (was 3002 on the host before the PORT BLOCK, 01d §5.4) behind a generated bearer token (PC-ENV-03), while 3002 survives only as the Firecrawl api container's own internal listen (PC-PORT-04), which is never published; the Playwright service routes through an egress-filtering proxy denying private/loopback/link-local ranges so a model-chosen URL cannot reach the LAN (P-9, C7-2).",
        "The self-hosted build has no advanced anti-bot engine; screenshots and page actions are not in the default stack — stated plainly because a user may expect cloud-product parity.",
        "As with SearXNG: every call is recorded in ~/.swarm/logs/web-audit.log and nothing is sent to PT GSP.",
      ],
      pathsWritten: [
        "~/.swarm/tools/firecrawl/secrets/ — dir 0700, one 0600 file per secret: proxy_token (PC-ENV-03/V06), postgres_password (V02), bull_auth_key (V03), optional redis_auth/rabbitmq_password only if rows' open decisions come out 'on' (D-22: a file the installer did not create is never mounted)",
        "~/.swarm/tools/firecrawl/nginx/nginx.conf (generated by row 84 from row 75's template, bind-mounted read-only)",
        "~/.swarm/tools/firecrawl/logs/ — auth-proxy access log, host-mounted: a second audit surface beside PC-PATH-10; records requests, not content",
        "~/.swarm/tools/firecrawl/mcp/ — the pinned firecrawl-mcp install, once it has a pin at all (F-2/D-11)",
        "compose file PC-PKG-04 + helper script read from the package; inside the VM: labelled containers, stack-B networks, images",
        "~/.config/swarm/: the MCP entry written by row 97 AFTER health passes",
        "Privacy plus: upstream defines no persistent volumes for Postgres/Redis/RabbitMQ, so crawl results are EPHEMERAL by default — crawled content does not survive a restart.",
      ],
      uninstallPath: [
        "Same labelled-object rule as block 4.7 with io.gsp.swarm.component=firecrawl, project swarm-tools, ask-before-delete for any volume holding data, then ~/.swarm/tools/firecrawl/.",
        "Because upstream declares no persistent volumes the normal residue is empty; the before/after manifest of docker ps -a, images, volumes and contexts is P-14's acceptance test.",
      ],
      warnings: [
        "Skipped automatically on a host below the 16 GiB physical-RAM floor (decision 12; ratified gate R-4, measured by row 112). Requires the container runtime (block 4.1).",
      ],
    },
  ],
}

/** One consent block set per register component id; `runtime` renders two sub-blocks. */
export const CONSENT_BLOCKS: Record<ComponentId, readonly ConsentBlock[]> = {
  runtime: RUNTIME,
  ...SINGLE,
}
