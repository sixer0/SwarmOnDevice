// Pane storage (REG §5): every key carries the `${Office.context.partitionKey}:` prefix
// when a partition key is defined. Pure over an injected Web Storage subset; the
// caller passes `localStorage` and `Office.context.partitionKey`.
import {
  OFFICE_CONTEXT_SELECTION,
  OFFICE_CONTEXT_WHOLE,
  OFFICE_CONTEXT_SCOPE_KEY,
  OFFICE_DISCLOSURE_ACK_KEY,
  OFFICE_SESSION_STORAGE_PREFIX,
  OFFICE_TOKEN_LENGTH,
  OFFICE_TOKEN_PREFIX,
  OFFICE_TOKEN_STORAGE_KEY,
} from "../constants"
import type { ContextScope } from "./prompt"

export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">

export type PaneStore = {
  storage: KeyValueStore
  partitionKey?: string
}

export function storageKey(store: PaneStore, base: string) {
  return store.partitionKey ? `${store.partitionKey}:${base}` : base
}

// REG §5 token format: `swo1_` + base64url(32 bytes), 48 characters in total.
export function isToken(value: unknown): value is string {
  if (typeof value !== "string") return false
  if (value.length !== OFFICE_TOKEN_LENGTH) return false
  if (!value.startsWith(OFFICE_TOKEN_PREFIX)) return false
  return /^[A-Za-z0-9_-]+$/.test(value.slice(OFFICE_TOKEN_PREFIX.length))
}

export function readToken(store: PaneStore) {
  const value = store.storage.getItem(storageKey(store, OFFICE_TOKEN_STORAGE_KEY))
  return isToken(value) ? value : undefined
}

export function writeToken(store: PaneStore, token: string) {
  if (!isToken(token)) return false
  store.storage.setItem(storageKey(store, OFFICE_TOKEN_STORAGE_KEY), token)
  return true
}

export function deleteToken(store: PaneStore) {
  store.storage.removeItem(storageKey(store, OFFICE_TOKEN_STORAGE_KEY))
}

// T7 / T15: delete every `swarm.office.session.*` key of this partition only.
export function deleteAllSessions(store: PaneStore) {
  const prefix = storageKey(store, OFFICE_SESSION_STORAGE_PREFIX)
  const keys = Array.from({ length: store.storage.length }, (_, index) => store.storage.key(index)).filter(
    (key): key is string => key !== null && key.startsWith(prefix),
  )
  keys.forEach((key) => store.storage.removeItem(key))
  return keys.length
}

// FR-22 / SC-51: default `selection`; only an explicitly stored `whole` changes it.
export function readScope(store: PaneStore): ContextScope {
  return store.storage.getItem(storageKey(store, OFFICE_CONTEXT_SCOPE_KEY)) === OFFICE_CONTEXT_WHOLE
    ? OFFICE_CONTEXT_WHOLE
    : OFFICE_CONTEXT_SELECTION
}

export function writeScope(store: PaneStore, scope: ContextScope) {
  store.storage.setItem(storageKey(store, OFFICE_CONTEXT_SCOPE_KEY), scope)
}

// SC-50 / REG §5: acknowledgement flag, value "1", per host through the prefix rule.
// No prompt_async may be sent while this returns false.
export function isDisclosureAcknowledged(store: PaneStore) {
  return store.storage.getItem(storageKey(store, OFFICE_DISCLOSURE_ACK_KEY)) === "1"
}

export function acknowledgeDisclosure(store: PaneStore) {
  store.storage.setItem(storageKey(store, OFFICE_DISCLOSURE_ACK_KEY), "1")
}
