// Swarm 1.2.7 row 47f (decision C68): how a shell word names a place, ONE resolver for the permission table's app-state
// reader (`spelledPlaces` in `autonomy-table.ts`, SR7-01) and the shell's output masking (`Secrets.expandSpelling` and
// `Secrets.workingFolders`, U16 / SR7-07). Row 47b had copied the table's rules into `tool/secrets.ts`; two copies of a
// path rule drift (M1-10). Pure: no disk access.
import os from "node:os"
import { Global } from "@opencode-ai/core/global"

/** `~`, `$HOME` and `${HOME}` at the start of a word, alone or before a `/`. */
export const HOME_SPELLING = /^(?:~|\$HOME\b|\$\{HOME\})(?=\/|$)/
const VARIABLE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g
/** How many folders a chain of `cd`s may lead to before the readers stop following (an over-read is capped). */
export const MAX_FOLDERS = 16

/** The home folders a place may be spelled under: the one Swarm reads (pinned in tests) and the system's. */
export function homes() {
  return [...new Set([Global.Path.home, os.homedir()])]
}

/**
 * A word as the shell would expand it: a home spelling under every home given, then set environment variables.
 * `certain` is false when some part of it could not be expanded here (`~user`, an unset variable, a command substitution).
 */
export function expand(word: string, homes: readonly string[]): { names: string[]; certain: boolean } {
  const home = HOME_SPELLING.exec(word)
  const starts = home ? homes.map((place) => place + word.slice(home[0].length)) : [word]
  // `~user` names another user's home.
  let certain = !/^~[^/]/.test(word)
  const names = starts.map((start) =>
    start.replace(VARIABLE, (whole, braced: string | undefined, bare: string | undefined) => {
      const value = process.env[(braced ?? bare)!]
      if (value === undefined) certain = false
      return value ?? whole
    }),
  )
  if (names.some((name) => /[$`]/.test(name))) certain = false
  return { names: [...new Set(names)], certain }
}

/** The folders a command may be in after one more change of folder: those before plus `more`, capped at `MAX_FOLDERS`. */
export function widen(folders: readonly string[], more: readonly string[]): { folders: string[]; capped: boolean } {
  const next = [...new Set([...folders, ...more])]
  return { folders: next.slice(0, MAX_FOLDERS), capped: next.length > MAX_FOLDERS }
}

export * as PathSpelling from "./path-spelling"
