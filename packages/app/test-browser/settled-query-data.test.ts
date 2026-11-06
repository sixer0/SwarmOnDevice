import { describe, expect, test } from "bun:test"
import { createComputed, createRoot, getListener } from "solid-js"
import { settledQueryData } from "@/pages/home/settled-query-data"

/** A query result whose `data` getter records whether it was read inside a tracking scope (as a Suspense read is). */
function query(status: "pending" | "error" | "success", data: string | undefined) {
  const reads: boolean[] = []
  return {
    reads,
    result: {
      status,
      dataUpdatedAt: 1,
      get data() {
        reads.push(getListener() !== null)
        return data
      },
    },
  }
}

// Runs under --conditions=browser: the unit suite (--conditions=solid) does not run computations reactively.
const inMemo = <T>(fn: () => T) =>
  createRoot((dispose) => {
    let value!: T
    // A computation, as in createMemo: getListener() is set while it runs.
    createComputed(() => (value = fn()))
    dispose()
    return value
  })

describe("settledQueryData (row 15c)", () => {
  test("with data, the resource read is untracked, so a later refetch cannot suspend", () => {
    const q = query("success", "cached")
    expect(inMemo(() => settledQueryData(q.result))).toBe("cached")
    expect(q.reads).toEqual([false])
  })

  test("while pending, the read stays tracked, so the first load still shows the Suspense fallback", () => {
    const q = query("pending", undefined)
    expect(inMemo(() => settledQueryData(q.result))).toBe(undefined)
    expect(q.reads).toEqual([true])
  })

  test("an errored query keeps its last data and is read untracked", () => {
    const q = query("error", "last")
    expect(inMemo(() => settledQueryData(q.result))).toBe("last")
    expect(q.reads).toEqual([false])
  })
})
