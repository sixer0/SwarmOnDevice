/**
 * Minimal bun:test stand-in so store.test.ts runs unchanged under Electron's Node
 * (spec §2.3 item 3: a pass under bun only is not a pass). Supports exactly what the test uses.
 */
type Fn = () => unknown | Promise<unknown>
const tests: Array<{ name: string; fn: Fn }> = []
const afterAlls: Fn[] = []
let prefix = ""
let scheduled = false

function schedule() {
  if (scheduled) return
  scheduled = true
  setTimeout(runAll, 0)
}

async function runAll() {
  let pass = 0
  let fail = 0
  const t0 = Date.now()
  for (const t of tests) {
    const s = Date.now()
    try {
      await t.fn()
      pass++
      console.log(`(pass) ${t.name} [${Date.now() - s}ms]`)
    } catch (e) {
      fail++
      console.log(`(fail) ${t.name}\n  ${e instanceof Error ? e.stack : String(e)}`)
    }
  }
  for (const f of afterAlls) await f()
  console.log(`\n ${pass} pass\n ${fail} fail\nRan ${tests.length} tests [${Date.now() - t0}ms] runtime node ${process.versions.node} electron ${process.versions.electron ?? "-"} type ${(process as { type?: string }).type ?? "-"}`)
  process.exitCode = fail === 0 ? 0 : 1
  ;(globalThis as { __row30Done?: (code: number) => void }).__row30Done?.(process.exitCode)
}

export function describe(name: string, fn: () => void) {
  const old = prefix
  prefix = prefix ? `${prefix} > ${name}` : name
  fn()
  prefix = old
}

export function test(name: string, fn: Fn, _timeout?: number) {
  tests.push({ name: prefix ? `${prefix} > ${name}` : name, fn })
  schedule()
}

export function afterAll(fn: Fn) {
  afterAlls.push(fn)
}

function fmt(v: unknown) {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return fmt(a) === fmt(b)
}

function matchers(actual: unknown, negate: boolean) {
  const ok = (cond: boolean, msg: string) => {
    if (cond === negate) throw new Error(`expect${negate ? ".not" : ""}: ${msg}`)
  }
  return {
    toBe: (e: unknown) => ok(Object.is(actual, e), `${fmt(actual)} toBe ${fmt(e)}`),
    toEqual: (e: unknown) => ok(deepEqual(actual, e), `${fmt(actual)} toEqual ${fmt(e)}`),
    toBeGreaterThan: (e: number) => ok((actual as number) > e, `${fmt(actual)} > ${e}`),
    toBeGreaterThanOrEqual: (e: number) => ok((actual as number) >= e, `${fmt(actual)} >= ${e}`),
    toBeLessThan: (e: number) => ok((actual as number) < e, `${fmt(actual)} < ${e}`),
    toContain: (e: unknown) => ok((actual as { includes(x: unknown): boolean }).includes(e), `${fmt(actual)} toContain ${fmt(e)}`),
    toMatch: (e: RegExp) => ok(e.test(String(actual)), `${fmt(actual)} toMatch ${e}`),
    toBeNull: () => ok(actual === null, `${fmt(actual)} toBeNull`),
    toBeTruthy: () => ok(Boolean(actual), `${fmt(actual)} toBeTruthy`),
  }
}

export function expect(actual: unknown) {
  return { ...matchers(actual, false), not: matchers(actual, true) }
}
