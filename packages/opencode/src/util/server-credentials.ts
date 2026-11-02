// With these a process could call the server's API as its owner, past every prompt.
const SERVER_CREDENTIALS = new Set([
  "OPENCODE_SERVER_PASSWORD",
  "SWARM_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
  "SWARM_SERVER_USERNAME",
])

/** Last, after anything that adds to the env, so nothing can put them back. Upper-cased because Windows finds a variable under any spelling. */
export const withoutServerCredentials = <Value>(env: Record<string, Value>) =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !SERVER_CREDENTIALS.has(name.toUpperCase())))
