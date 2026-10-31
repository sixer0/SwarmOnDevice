import { afterEach, expect, test } from "bun:test"
import { Unattended } from "../../src/permission/unattended"

afterEach(() => {
  delete process.env.SWARM_UNATTENDED_AFTER_MS
})

test("waits ten minutes for the first request, and a minute once nobody answered one", () => {
  expect(Unattended.wait(false)).toBe(600_000)
  expect(Unattended.wait(true)).toBe(60_000)
})

test("the environment sets the wait, and never lengthens the wait after a miss", () => {
  process.env.SWARM_UNATTENDED_AFTER_MS = "5000"
  expect(Unattended.wait(false)).toBe(5000)
  expect(Unattended.wait(true)).toBe(5000)
  process.env.SWARM_UNATTENDED_AFTER_MS = "7200000"
  expect(Unattended.wait(true)).toBe(60_000)
})

test("zero or nonsense means wait for good", () => {
  process.env.SWARM_UNATTENDED_AFTER_MS = "0"
  expect(Unattended.wait(false)).toBeUndefined()
  process.env.SWARM_UNATTENDED_AFTER_MS = "soon"
  expect(Unattended.wait(false)).toBeUndefined()
})
