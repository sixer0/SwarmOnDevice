// Outside writer for store.test.ts: holds BEGIN IMMEDIATE on a store file for HOLD_MS, then commits.
// Runs under bun (bun:sqlite) or Electron's Node (node:sqlite). Args: <db file> <hold ms>
const [file, holdRaw] = process.argv.slice(2)
const holdMs = Number(holdRaw ?? "1500")
const isBun = typeof globalThis.Bun !== "undefined"
let db
if (isBun) {
  const { Database } = await import("bun:sqlite")
  const d = new Database(file)
  db = { exec: (s) => d.exec(s), close: () => d.close() }
} else {
  const { DatabaseSync } = await import("node:sqlite")
  const d = new DatabaseSync(file)
  db = { exec: (s) => d.exec(s), close: () => d.close() }
}
db.exec("PRAGMA busy_timeout = 5000")
db.exec("BEGIN IMMEDIATE")
db.exec("INSERT INTO store_meta (key, value) VALUES ('holder', 'held') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
process.stdout.write(`held ${Date.now()}\n`)
setTimeout(() => {
  db.exec("COMMIT")
  db.close()
  process.stdout.write(`committed ${Date.now()}\n`)
  process.exit(0)
}, holdMs)
