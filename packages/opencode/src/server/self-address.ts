// 1.2.6 row FX-14 (F-1, decision C24): where this process's own server listens, known only at runtime. The autonomy
// table reads it to refuse an agent's shell or fetch call to Swarm's own API (X `own_api`): with the server password an
// agent could answer its own prompts and change its own mode. Every other loopback port stays as it was (C19c). Kept in
// memory only; `Server.listen` adds an address when it binds and removes it when it stops.

export type Address = { readonly hostname: string; readonly port: number }

const held = new Map<string, Address>()

const key = (address: Address) => `${address.hostname}\u0000${address.port}`

/** Records a listener of this process. */
export function add(address: Address) {
  if (!Number.isInteger(address.port) || address.port <= 0) return
  held.set(key(address), { hostname: address.hostname, port: address.port })
}

/** Forgets a listener of this process once it stopped. */
export function remove(address: Address) {
  held.delete(key(address))
}

/** The listeners of this process, newest last. */
export function list(): readonly Address[] {
  return [...held.values()]
}

export * as SelfAddress from "./self-address"
