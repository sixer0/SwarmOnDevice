import { untrack } from "solid-js"

type QueryResult<T> = {
  readonly data: T
  readonly status: "pending" | "error" | "success"
  readonly dataUpdatedAt: number
}

/**
 * A solid-query `data` read that suspends only while the query has nothing to show yet.
 *
 * `useQuery(...).data` reads a Solid resource. A tracked read made before that resource first settles (always the case
 * on mount when the cache already holds data) leaves a watcher on its owner that suspends the owner's `<Suspense>` again
 * on every later observer update (refetch start, refetch end, a cache write), for one microtask each time. Solid then
 * takes the boundary's DOM out of the document and puts it back, and a focused input inside loses focus.
 * Once there is data, this reads it untracked and follows `dataUpdatedAt` instead, so later fetches never suspend.
 */
export function settledQueryData<T>(query: QueryResult<T>): T {
  if (query.status === "pending") return query.data
  // Tracked instead of the data: new data from a fetch or a cache write re-runs the reader.
  void query.dataUpdatedAt
  return untrack(() => query.data)
}
