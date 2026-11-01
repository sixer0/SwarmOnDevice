import path from "path"

process.env.OPENCODE_DB = ":memory:"
process.env.NPM_CONFIG_AUDIT = "false"
process.env.OPENCODE_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.OPENCODE_DISABLE_MODELS_FETCH = "true"

// Suites here are about what a project's config does, so their temp folders count as trusted. test/config/trust.test.ts turns this off.
const { ProjectTrust } = await import("../src/project/trust")
ProjectTrust.assumeTrustedForTests(true)
