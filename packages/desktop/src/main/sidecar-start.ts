// The sidecar start protocol (1.2.6 row 38b, SEC-06). server.ts builds the `start` message, sidecar.ts parses it and
// starts the server through listenWithNonce. Kept free of electron and of the virtual server module so bun tests it.
//
// The desktop nonce travels only in this message (postMessage, in memory). It is set on the server with
// DesktopNonce.set before Server.listen, so no request is ever served without it. It never goes into process.env.

export type StartCommand = {
  type: "start"
  hostname: string
  port: number
  password: string
  userDataPath: string
  /** This launch's desktop nonce (row 38b); absent = the server holds none and refuses the person-only routes. */
  desktopNonce?: string
}

export type StopCommand = { type: "stop" }
export type SidecarCommand = StartCommand | StopCommand

export function buildStartMessage(input: Omit<StartCommand, "type">): StartCommand {
  return {
    type: "start",
    hostname: input.hostname,
    port: input.port,
    password: input.password,
    userDataPath: input.userDataPath,
    ...(input.desktopNonce === undefined ? {} : { desktopNonce: input.desktopNonce }),
  }
}

export function parseSidecarCommand(value: unknown): SidecarCommand | undefined {
  if (!value || typeof value !== "object") return
  const command = value as Partial<StartCommand | StopCommand>
  if (command.type === "stop") return { type: "stop" }
  if (command.type !== "start") return
  if (typeof command.hostname !== "string") return
  if (typeof command.port !== "number") return
  if (typeof command.password !== "string") return
  if (typeof command.userDataPath !== "string") return
  if (command.desktopNonce !== undefined && typeof command.desktopNonce !== "string") return
  return {
    type: "start",
    hostname: command.hostname,
    port: command.port,
    password: command.password,
    userDataPath: command.userDataPath,
    desktopNonce: command.desktopNonce,
  }
}

type ListenOptions = {
  port: number
  hostname: string
  username: string
  password: string
  cors: string[]
}

/** The parts of `virtual:opencode-server` the start uses. */
export type ServerModule<L> = {
  DesktopNonce: { set: (nonce: string | undefined) => void }
  RunLease: { host: () => void }
  Server: { listen: (options: ListenOptions) => Promise<L> }
}

export async function listenWithNonce<L>(command: StartCommand, mod: ServerModule<L>): Promise<L> {
  // Throws on a value that is not a nonce, which fails the start before anything listens.
  mod.DesktopNonce.set(command.desktopNonce)
  mod.RunLease.host()
  return mod.Server.listen({
    port: command.port,
    hostname: command.hostname,
    username: "opencode",
    password: command.password,
    cors: ["oc://renderer"],
  })
}
