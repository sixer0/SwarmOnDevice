// The provider this app ships with, handed to the server it starts. It holds no key: the existing connect flow asks for
// one and stores it in auth.json, and until then the provider is only offered. Lowest layer of all, see ModelsDev.bundled.
const model = (id: string) => ({
  id,
  name: id,
  release_date: "",
  attachment: false,
  reasoning: false,
  temperature: false,
  tool_call: true,
  // Zero means undeclared: the server is asked for its window (provider/model-window.ts). No cost means never a spend limit.
  limit: { context: 0, output: 0 },
  modalities: { input: ["text"], output: ["text"] },
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
