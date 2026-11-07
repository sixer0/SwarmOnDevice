/**
 * Swarm twin (row 29) of the clone's `contract/auth.ts` (studio spec §1.3; decisions U13, C53, C54).
 *
 * The clone resolved the caller from an HQ cookie, a NextAuth JWT or `x-internal-secret`
 * (`next/server`, `next-auth/jwt`, `@/lib/hq-session`). Swarm has one host and no web sessions:
 * no Postgres, no NextAuth, no HQ cookie. The only local callers are the MCP sessions inside the
 * Swarm host (Swarm's own agent, and Claude through the token-checked bridge), all acting for the
 * Swarm user. So the twin keeps:
 * - the `StudioCaller` shape, `ANONYMOUS_INTERNAL_REQUESTER`, `REQUESTER_PREFIX` and
 *   `secretEquals` byte-for-byte in behaviour;
 * - the clone's machine-caller path only: kind `INTERNAL_AGENT`, requester `agent:<agentId>`,
 *   `canWriteClassK: false`. That is the kind the clone's own MCP server always had (it reached
 *   Studio with `x-internal-secret`). No local caller is ADMIN: C54 ("Swarm has no admin caller")
 *   and the template form lock (templates spec §3 P3/P5) apply; user-template ownership is
 *   enforced by the Swarm template service (row 66), builtin templates are refused by origin.
 * `getStudioCaller` keeps its name and signature for the ported route bodies (LocalStudioApi,
 * row 31): it accepts only a matching `x-internal-secret` and otherwise throws UNAUTHORIZED.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { CallerKind } from "./enums";
import { StudioEngineError } from "./errors";

export const ANONYMOUS_INTERNAL_REQUESTER = "anonymous-internal";

export interface StudioCaller {
  kind: CallerKind;
  /** Nilai `createdBy`/`requestedBy`: getRequester(req, agentId) atau "anonymous-internal". */
  requester: string;
  /** Username WebUiUser (sesi HQ). Swarm: never set. */
  username?: string;
  /** Peran WebUiUser (sesi HQ). Swarm: never set. */
  role?: string;
  /** Email akun Google (sesi NextAuth), bila ada. Swarm: never set. */
  email?: string;
  /** agentId dari badan permintaan (maks 80, A6). */
  agentId?: string;
  /** KT-16: hanya ADMIN_SESSION. Swarm: always false. */
  canWriteClassK: boolean;
}

/** Kunci HMAC acak per proses: digest berpanjang tetap tanpa membocorkan panjang rahasia. */
const SECRET_COMPARE_KEY = randomBytes(32);

function digestOf(v: string): Buffer {
  return createHmac("sha256", SECRET_COMPARE_KEY).update(v, "utf8").digest();
}

/** Perbandingan rahasia waktu-konstan (isi dan panjang) lewat HMAC + timingSafeEqual (S87 L-01). */
export function secretEquals(provided: string, expected: string): boolean {
  return timingSafeEqual(digestOf(provided), digestOf(expected));
}

/** Prefiks requester per jenis pemanggil (S87 L-02). */
export const REQUESTER_PREFIX = { user: "user:", google: "google:", agent: "agent:" } as const;

/** Header the host sets from the MCP session (bridge `X-Studio-Agent`, spec §9.3). */
export const STUDIO_AGENT_HEADER = "x-studio-agent";

const AGENT_ID_CONTROL_RE = /[\u0000-\u001f\u007f]/;

function normalizeAgentId(agentId?: string | null): string | undefined {
  const a = (agentId ?? "").toString().trim();
  if (!a || AGENT_ID_CONTROL_RE.test(a)) return undefined;
  return a.slice(0, 80);
}

function agentRequester(agent: string | undefined): string {
  return agent ? `${REQUESTER_PREFIX.agent}${agent}` : ANONYMOUS_INTERNAL_REQUESTER;
}

/**
 * The fixed local caller of one MCP session (spec §1.3). `agentId` comes from the session
 * (`swarm` for Swarm's entry, `claude` for the bridge; register STUDIO_AGENT_ID); it is a label,
 * not an identity. Control characters or an empty value give `anonymous-internal`.
 */
export function localStudioCaller(agentId?: string | null): StudioCaller {
  const agent = normalizeAgentId(agentId);
  return { kind: "INTERNAL_AGENT", requester: agentRequester(agent), agentId: agent, canWriteClassK: false };
}

function internalSecretMatches(req: Request): boolean {
  const provided = req.headers.get("x-internal-secret");
  const expected = process.env.INTERNAL_API_SECRET;
  if (!provided || !expected) return false; // fail-closed tanpa env
  return secretEquals(provided, expected);
}

/**
 * Route-body entry point kept from the clone. Only the internal-secret branch remains: the host's
 * in-process router (LocalStudioApi) sends the per-process `INTERNAL_API_SECRET` as
 * `x-internal-secret`. `agentId` falls back to the `x-studio-agent` header. No secret -> UNAUTHORIZED.
 */
export async function getStudioCaller(req: Request, agentId?: string | null): Promise<StudioCaller> {
  if (!internalSecretMatches(req)) throw new StudioEngineError("UNAUTHORIZED", "Unauthorized");
  return localStudioCaller(agentId ?? req.headers.get(STUDIO_AGENT_HEADER));
}
