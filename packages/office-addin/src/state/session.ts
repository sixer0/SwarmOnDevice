// One session per document (FS FR-33..FR-35; SC-47; D7/C22; REG §5).
// docKey = lowercase hex SHA-256 of `Office.context.document.url` exactly as returned
// (on this Mac a bare POSIX path, hashed with no normalisation). The url is read
// through the injected reader on EVERY lookup, save and drop and is never cached.
// An empty url (unsaved document) stores nothing: every pane load starts a new chat.
// The url itself never leaves this module except as its hash.
import { OFFICE_HOST_METADATA_KEY, OFFICE_RECENT_CHATS_LIMIT, OFFICE_SESSION_STORAGE_PREFIX } from "../constants"
import type { OfficeHost } from "./prompt"
import { storageKey, type PaneStore } from "./storage"

/** @internal test seam */
export type DocumentSessions = PaneStore & {
  // Reads Office.context.document.url now. Called on every use; never memoised.
  documentUrl: () => string | null | undefined
}

export async function docKey(url: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

// The full storage key of the current document, or undefined for an unsaved document.
export async function sessionKey(docs: DocumentSessions) {
  const url = docs.documentUrl()
  if (!url) return undefined
  return storageKey(docs, OFFICE_SESSION_STORAGE_PREFIX + (await docKey(url)))
}

export async function lookupSession(docs: DocumentSessions) {
  const key = await sessionKey(docs)
  if (!key) return undefined
  return docs.storage.getItem(key) ?? undefined
}

// Returns false when nothing was stored (unsaved document).
export async function saveSession(docs: DocumentSessions, sessionID: string) {
  const key = await sessionKey(docs)
  if (!key) return false
  docs.storage.setItem(key, sessionID)
  return true
}

// T17 and New chat (FR-34): drop only the current document's key.
export async function dropSession(docs: DocumentSessions) {
  const key = await sessionKey(docs)
  if (!key) return false
  docs.storage.removeItem(key)
  return true
}

export type SessionSummary = {
  id: string
  title: string
  time: { updated: number }
  metadata?: { [key: string]: unknown }
}

// FR-35 / RC-2: Office chats of the current host only, newest first, at most 20.
export function recentChats<T extends SessionSummary>(sessions: T[], host: OfficeHost) {
  return sessions
    .filter((session) => session.metadata?.[OFFICE_HOST_METADATA_KEY] === host)
    .toSorted((a, b) => b.time.updated - a.time.updated)
    .slice(0, OFFICE_RECENT_CHATS_LIMIT)
}
