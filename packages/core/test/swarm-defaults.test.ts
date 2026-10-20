import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
// Importing the module runs its top-level side effect on process.env; the named
// import also gives access to the pure apply function used by the logic tests.
import { applySwarmDefaults, BASELINE_CONFIG } from "@opencode-ai/core/swarm-defaults"

// Synthetic roots keep the containment assertions independent of the machine that
// runs the suite. The default-roots tests below use the real home/tmp instead, so
// both the injected and the derived path logic are covered.
const roots = { home: "/home/u", tmp: "/tmp" }

function fresh(env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  applySwarmDefaults(env, roots)
  return env
}

describe("swarm defaults module", () => {
  describe("egress-off defaults (FR-DEF-03)", () => {
    test("sets each default when the environment is empty", () => {
      const env = fresh()
      expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1")
      expect(env.OPENCODE_DISABLE_MODELS_FETCH).toBe("1")
      expect(env.OPENCODE_DISABLE_LSP_DOWNLOAD).toBe("1")
      expect(env.SWARM).toBe("1")
    })

    test("does not overwrite a value the user already set (??= overridable)", () => {
      const env = fresh({ OPENCODE_DISABLE_AUTOUPDATE: "0", OPENCODE_DISABLE_LSP_DOWNLOAD: "false" })
      expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("0")
      expect(env.OPENCODE_DISABLE_LSP_DOWNLOAD).toBe("false")
      // untouched keys still receive the default
      expect(env.OPENCODE_DISABLE_MODELS_FETCH).toBe("1")
    })
  })

  describe("baseline config values (FR-DEF-04)", () => {
    test("publishes autoupdate false, share disabled, disabled providers", () => {
      expect(BASELINE_CONFIG.autoupdate).toBe(false)
      expect(BASELINE_CONFIG.share).toBe("disabled")
      expect(BASELINE_CONFIG.disabled_providers).toEqual(["opencode", "opencode-go"])
    })
  })

  describe("SWARM_* alias mirror (FR-DEF-05)", () => {
    test("Tier 1 names mirror to their OPENCODE_ twins", () => {
      const env = fresh({ SWARM_SERVER_PASSWORD: "sp", SWARM_SERVER_USERNAME: "su" })
      expect(env.OPENCODE_SERVER_PASSWORD).toBe("sp")
      expect(env.OPENCODE_SERVER_USERNAME).toBe("su")
    })

    test("SWARM_* wins when both names are set", () => {
      const env = fresh({ SWARM_SERVER_PASSWORD: "swarm-value", OPENCODE_SERVER_PASSWORD: "opencode-value" })
      expect(env.OPENCODE_SERVER_PASSWORD).toBe("swarm-value")
    })

    test("OPENCODE_* alone is still honoured", () => {
      const env = fresh({ OPENCODE_SERVER_PASSWORD: "sidecar-set" })
      expect(env.OPENCODE_SERVER_PASSWORD).toBe("sidecar-set")
    })

    test("generic mirror copies any SWARM_<X> to OPENCODE_<X>", () => {
      const env = fresh({ SWARM_FOO_BAR: "x" })
      expect(env.OPENCODE_FOO_BAR).toBe("x")
    })

    test("a bare SWARM marker is not mirrored into an OPENCODE_ key", () => {
      const env = fresh()
      expect(env.OPENCODE_).toBeUndefined()
    })
  })

  describe("path guard G3 (FR-DEF-06) — reject OpenCode locations", () => {
    test("drops OPENCODE_CONFIG_DIR under ~/.config/opencode", () => {
      const env = fresh({ OPENCODE_CONFIG_DIR: "/home/u/.config/opencode" })
      expect(env.OPENCODE_CONFIG_DIR).toBeUndefined()
    })

    test("drops a nested file under an OpenCode data dir, tilde expanded", () => {
      const env = fresh({ OPENCODE_DB: "~/.local/share/opencode/opencode.db" })
      expect(env.OPENCODE_DB).toBeUndefined()
    })

    test("drops $TMPDIR/opencode paths", () => {
      const env = fresh({ OPENCODE_CONFIG: "$TMPDIR/opencode/config.json" })
      expect(env.OPENCODE_CONFIG).toBeUndefined()
    })

    test("drops the system /Library/Application Support/opencode location", () => {
      const env = fresh({ OPENCODE_CONFIG: "/Library/Application Support/opencode/config.json" })
      expect(env.OPENCODE_CONFIG).toBeUndefined()
    })

    test("drops a desktop channel dir ai.opencode.desktop.beta", () => {
      const env = fresh({
        OPENCODE_TUI_CONFIG: "/home/u/Library/Application Support/ai.opencode.desktop.beta/tui.json",
      })
      expect(env.OPENCODE_TUI_CONFIG).toBeUndefined()
    })

    test("drops every guarded variable in one pass", () => {
      const env = fresh({
        OPENCODE_CONFIG: "/home/u/.config/opencode/c",
        OPENCODE_CONFIG_DIR: "/home/u/.config/opencode",
        OPENCODE_TUI_CONFIG: "/home/u/.cache/opencode/tui.json",
        OPENCODE_DB: "/home/u/.local/share/opencode/opencode.db",
        OPENCODE_AUTH_CONTENT: "/home/u/.local/share/opencode/auth.json",
        OPENCODE_PLUGIN_META_FILE: "/home/u/.opencode/plugin-meta.json",
      })
      expect(env.OPENCODE_CONFIG).toBeUndefined()
      expect(env.OPENCODE_CONFIG_DIR).toBeUndefined()
      expect(env.OPENCODE_TUI_CONFIG).toBeUndefined()
      expect(env.OPENCODE_DB).toBeUndefined()
      expect(env.OPENCODE_AUTH_CONTENT).toBeUndefined()
      expect(env.OPENCODE_PLUGIN_META_FILE).toBeUndefined()
    })

    test("an alias that points into an OpenCode location is dropped after mirroring", () => {
      const env = fresh({ SWARM_CONFIG_DIR: "/home/u/.config/opencode" })
      expect(env.OPENCODE_CONFIG_DIR).toBeUndefined()
    })
  })

  describe("path guard G3 (FR-DEF-06) — accept non-OpenCode locations", () => {
    test("keeps a Swarm config dir", () => {
      const env = fresh({ OPENCODE_CONFIG_DIR: "/home/u/.config/swarm" })
      expect(env.OPENCODE_CONFIG_DIR).toBe("/home/u/.config/swarm")
    })

    test("keeps a Swarm data path even though the internal db name stays opencode.db", () => {
      const env = fresh({ OPENCODE_DB: "/home/u/.local/share/swarm/opencode.db" })
      expect(env.OPENCODE_DB).toBe("/home/u/.local/share/swarm/opencode.db")
    })

    test("keeps a guarded value that is not a path at all", () => {
      const env = fresh({ OPENCODE_AUTH_CONTENT: '{"provider":"key"}' })
      expect(env.OPENCODE_AUTH_CONTENT).toBe('{"provider":"key"}')
    })

    test("leaves an unguarded variable pointing into an OpenCode dir untouched", () => {
      const env = fresh({ OPENCODE_FAKE_VCS: "/home/u/.config/opencode/vcs" })
      expect(env.OPENCODE_FAKE_VCS).toBe("/home/u/.config/opencode/vcs")
    })
  })

  describe("path guard G3 with the real default roots", () => {
    test("rejects a path under the real home .config/opencode", () => {
      const env: NodeJS.ProcessEnv = { OPENCODE_CONFIG_DIR: path.join(os.homedir(), ".config", "opencode") }
      applySwarmDefaults(env)
      expect(env.OPENCODE_CONFIG_DIR).toBeUndefined()
    })

    test("accepts a path under the real home .config/swarm", () => {
      const keep = path.join(os.homedir(), ".config", "swarm")
      const env: NodeJS.ProcessEnv = { OPENCODE_CONFIG_DIR: keep }
      applySwarmDefaults(env)
      expect(env.OPENCODE_CONFIG_DIR).toBe(keep)
    })
  })

  describe("idempotence (FR-DEF-08)", () => {
    test("applying twice to one object leaves it unchanged", () => {
      const env: NodeJS.ProcessEnv = {
        SWARM_SERVER_PASSWORD: "p",
        OPENCODE_SERVER_PASSWORD: "q",
        OPENCODE_CONFIG_DIR: "/home/u/.config/opencode",
      }
      applySwarmDefaults(env, roots)
      const once = { ...env }
      applySwarmDefaults(env, roots)
      expect(env).toEqual(once)
    })

    test("a second import of the module does not change process.env", async () => {
      // The static import above already ran the side effect once against the real
      // process. Re-importing with a cache-busting query forces the top-level code
      // to run again; an idempotent shim must leave the environment identical. The
      // specifier is held in a string variable so tsgo skips static resolution of
      // the query-suffixed path while Bun still resolves and cache-busts it.
      const before = { ...process.env }
      const reimport: string = "@opencode-ai/core/swarm-defaults?row36=reimport"
      await import(reimport)
      const after = { ...process.env }
      expect(after).toEqual(before)
    })

    test("the first import applied its effects to the real process.env", () => {
      expect(process.env.SWARM).toBe("1")
      expect(["1", "true"].includes((process.env.OPENCODE_DISABLE_AUTOUPDATE ?? "").toLowerCase())).toBe(true)
      expect(["1", "true"].includes((process.env.OPENCODE_DISABLE_LSP_DOWNLOAD ?? "").toLowerCase())).toBe(true)
    })
  })
})
