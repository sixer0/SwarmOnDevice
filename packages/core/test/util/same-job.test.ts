import { describe, expect, test } from "bun:test"
import { jobMatchesLabel, jobWords, sameJob } from "../../src/util/same-job"

describe("sameJob", () => {
  test("recognises the same job in different words", () => {
    expect(sameJob("Bump the dependencies, run the tests and fix whatever breaks", "bump dependencies and fix anything that breaks in the tests")).toBe(true)
    expect(sameJob("Please bump the dependencies again, run tests, fix what breaks", "Bump the dependencies, run the tests and fix whatever breaks")).toBe(true)
  })

  test("works for Indonesian asks", () => {
    expect(sameJob("tolong update dependensi dan jalankan test", "update dependensi lalu jalankan test")).toBe(true)
  })

  test("different jobs that share a verb are different", () => {
    expect(sameJob("fix the failing login test", "fix the typo in the readme")).toBe(false)
    expect(sameJob("write release notes for this version", "bump the version and tag it")).toBe(false)
  })

  test("short or empty text is never a match", () => {
    expect(sameJob("hi", "hi")).toBe(false)
    expect(sameJob("", "")).toBe(false)
  })

  test("a long pasted log does not drown out the ask", () => {
    const ask = "fix the failing checkout tests in the cart"
    expect(jobWords(ask + " " + "stacktrace ".repeat(500)).length).toBeLessThan(10)
  })
})

describe("jobMatchesLabel", () => {
  const label = "Bump the dependencies, run the tests and fix what breaks"

  test("an ask that says more than the label still matches", () => {
    expect(jobMatchesLabel("bump the dependencies and fix what breaks in packages/web", label)).toBe(true)
  })

  test("an unrelated ask does not", () => {
    expect(jobMatchesLabel("add dark mode to the settings page", label)).toBe(false)
    expect(jobMatchesLabel("fix the tests", label)).toBe(false)
  })

  test("needs two shared words however short the label", () => {
    expect(jobMatchesLabel("deploy the thing", "deploy")).toBe(false)
  })
})
