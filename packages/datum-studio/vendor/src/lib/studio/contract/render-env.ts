/**
 * Kontrak render-env (01_specs.md §8.4): manifest lingkungan render (S91) dan
 * hasil cek kesiapan (S92 `checkRenderEnvReadiness`, route R11).
 * Skrip cek S91 menulis RenderEnvReadiness sebagai JSON ke stdout; exit 0 bila
 * ready, 3 bila tidak, 2 salah pakai.
 */

export const RENDER_ENV_SCHEMA = "studio.render-env/v1";
export const RENDER_ENV_SOFFICE_VERSION = "24.2.3.2";
export const RENDER_ENV_CHROMIUM_REVISION = "1234";
export const RENDER_ENV_CHROMIUM_VERSION = "151.0.7922.34";

export const RENDER_ENV_EXIT = { READY: 0, USAGE: 2, NOT_READY: 3 } as const;

export interface RenderEnvManifest {
  schema: "studio.render-env/v1";
  config: "B";
  createdAt: string;
  soffice: { path: string; version: "24.2.3.2" };
  chromium: { executablePath: string; revision: "1234"; version: "151.0.7922.34" };
  /** Plex 16 + DejaVuSans + Inter (research/05:18). */
  fonts: Array<{ family: string; style: string; file: string; sha256: string; hkcuValueName: string; required: boolean }>;
  calibration: { pages: number; textIdenticalPages: number; ssimMean: number; pagesSsimGe098: number; at: string };
}

export interface RenderEnvReadiness {
  ready: boolean;
  checkedAt: string;
  manifestSha256: string | null;
  soffice: { found: boolean; version: string | null; versionOk: boolean };
  chromium: { found: boolean };
  fonts: Array<{ family: string; style: string; fileExists: boolean; sha256Ok: boolean; registered: boolean }>;
  errors: string[];
}
