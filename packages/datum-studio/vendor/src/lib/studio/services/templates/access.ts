/**
 * Templat TERBATAS (F-047, D-98; baris INT-P).
 *
 * Templat yang profil efektifnya (termasuk pewarisan rantai `baseVersionId`,
 * karena dibaca dari `resolvedParams`) melepas cek penolak
 * (`lint.enforcementOverride` = release|report|off untuk cek registri
 * `blocksIngest`) hanya boleh dipakai untuk ingest / validate / render baru
 * oleh pemanggil tepercaya:
 *  - sesi ADMINISTRATOR (`caller.kind === "ADMIN_SESSION"`), atau
 *  - harness/CLI server tanpa sesi HTTP (`opts.trustedHarness === true`; flag
 *    hanya diset kode server, route tidak pernah menyalinnya dari body/header).
 * Pemanggil lain -> `StudioEngineError("FORBIDDEN")` 403.
 *
 * Status terbatas DIHITUNG dari parameter efektif setiap kali (bukan flag
 * tersimpan yang dapat dihapus user biasa); mengubahnya berarti mengubah
 * `lint.enforcementOverride`, kunci kelas K (hanya ADMIN_SESSION, KT-16).
 * Templat kanonik dan profil tanpa pelepasan tetap terbuka untuk semua.
 */
import type { ParamMap, ResolvedTemplate, StudioCaller } from "../../contract";
import { StudioEngineError } from "../../contract/errors";
import { releasedBlockingChecks } from "../../engine/lint/structure/enforcement";
import { templatesLog } from "./log";

/** Kode log saat pemanggil tidak tepercaya memakai templat terbatas. */
export const TEMPLATE_RESTRICTED_DENIED = "TEMPLATE_RESTRICTED_DENIED";

export interface TemplateRestriction {
  /** true = hanya ADMINISTRATOR/harness (D-98). */
  restricted: boolean;
  /** Cek penolak yang dilepas profil (kosong bila tidak terbatas). */
  releasedChecks: string[];
}

export interface TemplateAccessOptions {
  /** Harness/CLI server tanpa sesi HTTP (lihat `services/ingest/trust.ts`). */
  trustedHarness?: boolean;
}

/**
 * Predikat PERAN admin (S85 R-12): sesi ADMINISTRATOR saja, tanpa
 * `trustedHarness`. Dipakai untuk hak peran (ubah profil kanonik, impor profil,
 * refresh render-env); kepercayaan konten memakai `isTrustedCaller`.
 */
export function isAdminCaller(caller: Pick<StudioCaller, "kind"> | null | undefined): boolean {
  return caller?.kind === "ADMIN_SESSION";
}

/** Satu sumber predikat kepercayaan (dipakai juga gerbang penanda benchmark ingest). */
export function isTrustedCaller(caller: Pick<StudioCaller, "kind"> | null | undefined, opts: TemplateAccessOptions = {}): boolean {
  return opts.trustedHarness === true || caller?.kind === "ADMIN_SESSION";
}

/** Status terbatas dari parameter efektif versi templat (`resolvedParams`). Tidak melempar. */
export function templateRestriction(params: ParamMap | Readonly<Record<string, unknown>> | null | undefined): TemplateRestriction {
  const released = params && typeof params === "object" ? releasedBlockingChecks({ params: params as ParamMap }) : [];
  return { restricted: released.length > 0, releasedChecks: released };
}

/**
 * Tolak (403 FORBIDDEN) pemakaian templat terbatas oleh pemanggil tidak
 * tepercaya; selain itu kembalikan status terbatasnya. Penolakan dicatat ke
 * log tahan lama templat (`TEMPLATE_RESTRICTED_DENIED`).
 */
export function assertTemplateUsable(
  tpl: Pick<ResolvedTemplate, "params" | "templateId" | "versionId" | "versionNo">,
  caller: Pick<StudioCaller, "kind" | "requester"> & { agentId?: string } | null | undefined,
  opts: TemplateAccessOptions & { slug?: string; purpose?: string; correlationId?: string } = {},
): TemplateRestriction {
  const r = templateRestriction(tpl.params);
  if (!r.restricted || isTrustedCaller(caller, opts)) return r;
  const label = `${opts.slug ?? tpl.templateId} v${tpl.versionNo}`;
  templatesLog({
    level: "warn",
    message: `templat terbatas ditolak untuk pemanggil tidak tepercaya (${opts.purpose ?? "pemakaian"})`,
    code: TEMPLATE_RESTRICTED_DENIED,
    correlationId: opts.correlationId,
    context: {
      templateId: tpl.templateId,
      versionId: tpl.versionId,
      versionNo: tpl.versionNo,
      slug: opts.slug ?? null,
      purpose: opts.purpose ?? null,
      callerKind: caller?.kind ?? null,
      requester: caller?.requester ?? null,
      agentId: caller?.agentId ?? null,
      releasedChecks: r.releasedChecks,
    },
  });
  throw new StudioEngineError(
    "FORBIDDEN",
    `Templat ${label} terbatas: profilnya melepas cek penolak (${r.releasedChecks.join(", ")}) sehingga hanya dapat dipakai ADMINISTRATOR atau harness server (D-98)`,
    { reason: "TEMPLATE_RESTRICTED", templateId: tpl.templateId, versionNo: tpl.versionNo, releasedChecks: r.releasedChecks },
  );
}
