// Row 42: the original Studio tests import from "vitest". Vitest is not installed in Swarm; the
// ported copies run under bun:test through this shim (W1 in test/ported/README.md).
// bun:test's `vi` lacks hoisted/mocked/resetModules; the shim adds them with vitest's meaning
// where bun can honour it: hoisted runs the factory, mocked is the identity type cast,
// resetModules is a no-op (bun has no module registry reset).
import { vi as bunVi } from "bun:test";

export { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test } from "bun:test";
export type { Mock } from "bun:test";

type BunVi = typeof bunVi;
type Shim = BunVi & {
  hoisted<T>(factory: () => T): T;
  mocked<T>(item: T, options?: unknown): T;
  resetModules(): void;
};

export const vi: Shim = Object.assign({}, bunVi, {
  hoisted<T>(factory: () => T): T {
    return factory();
  },
  mocked<T>(item: T): T {
    return item;
  },
  resetModules(): void {},
}) as Shim;
