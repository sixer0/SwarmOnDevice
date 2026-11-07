/**
 * Swarm addition (row 109, Prisma cut): the one import point of the vendored services for the
 * DATUM Studio store bridge (`packages/datum-studio/src/store-bridge`). Replaces every
 * Prisma client import of the clone (01_specs_studio.md §1.2).
 */
export * from "../../../../../src/store-bridge/index.ts";
