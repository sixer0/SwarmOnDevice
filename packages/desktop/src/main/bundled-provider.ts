// The provider this app ships with, handed to the server it starts. It holds no key: the existing connect flow asks for
// one and stores it in auth.json, and until then the provider is only offered. Lowest layer of all, see ModelsDev.bundled.
// `name` (= the key) and `release_date` ("") are left to the server's defaults (ModelsDev.bundled), so the payload stays
// within the 1000 bytes the Windows launcher's `set /p` reads (spec 114 section 5.3). With MODEL_LIMITS: 921 bytes (1.2.6).

// Declared window per model (U1, 1.2.6 CFG-01). A user `provider.gsp-ai-tail.models.<id>.limit` still wins.
const MODEL_LIMITS = {
  thinker: { context: 784000, output: 120000 },
  worker: { context: 512000, output: 90000 },
  "worker-fast": { context: 512000, output: 60000 },
} as const

const model = (id: keyof typeof MODEL_LIMITS) => ({
  id,
  // GSP AI thinker, worker and worker-fast accept images (user 2026-11-09), so vision tools and image attachments are offered.
  attachment: true,
  reasoning: false,
  temperature: false,
  tool_call: true,
  // Declared, so the server window probe and refusal learning (provider/model-window.ts) skip these models. No cost means
  // never a spend limit.
  limit: MODEL_LIMITS[id],
  modalities: { input: ["text", "image"], output: ["text"] },
})

export const BUNDLED_PROVIDER = {
  provider: {
    id: "gsp-ai-tail",
    name: "GSP AI",
    env: [],
    npm: "@ai-sdk/openai-compatible",
    api: "http://100.102.23.27:11400/v1",
    models: { thinker: model("thinker"), worker: model("worker"), "worker-fast": model("worker-fast") },
  },
  // Model tier per subagent (spec 161, SA-11): planning and review on thinker, gathering on worker-fast, the rest on worker.
  subagents: {
    general: "worker",
    explore: "worker-fast",
    coder: "worker",
    planner: "thinker",
    verifier: "thinker",
    "data-collector": "worker-fast",
    "document-writer": "worker",
  },
}

export const BUNDLED_PROVIDER_ENV = { SWARM_BUNDLED_PROVIDER: JSON.stringify(BUNDLED_PROVIDER) }
