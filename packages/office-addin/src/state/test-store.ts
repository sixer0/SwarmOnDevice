// In-memory Web Storage subset for the state tests (no DOM preload needed).
import type { KeyValueStore } from "./storage"

export function memoryStore(): KeyValueStore & { dump: () => Record<string, string> } {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    key: (index) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size
    },
    dump: () => Object.fromEntries(map),
  }
}
