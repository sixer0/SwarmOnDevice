/**
 * Pembersih keluaran dan log (IP-08, IP-09): path profil user, baris stack,
 * dan nilai rahasia (token, cookie, kata sandi) tidak pernah keluar ke klien
 * maupun tersimpan dari masukan klien.
 */

/** Ganti `C:\Users\<nama>` dengan `%USERPROFILE%` agar nama akun tidak bocor. */
export function redactPaths(s: string): string {
  return s.replace(/[A-Za-z]:\\Users\\[^\\/\s)"']+/gi, "%USERPROFILE%");
}

/** Buang baris bingkai stack ("    at ...") lalu potong. */
export function stripStack(s: string, max: number): string {
  const lines = s
    .split(/\r?\n/)
    .filter((l) => !/^\s+at\s/.test(l) && !/^\s*Error:\s*$/.test(l))
    .join("\n")
    .trim();
  const red = redactPaths(lines);
  return red.length > max ? `${red.slice(0, max)}...` : red;
}

/** Nama kunci yang nilainya tidak boleh disimpan (dibandingkan tanpa `-`/`_`, huruf kecil). */
const SECRET_KEY_RE = /(token|cookie|authorization|auth|password|passwd|passphrase|pwd|secret|session|apikey|credential|bearer|jwt|signature|csrf)/;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key.toLowerCase().replace(/[-_\s]/g, ""));
}

export const REDACTED = "[redacted]";

/**
 * FIX-SEC N-06 (SR-57, D-247): kredensial userinfo URL
 * (`postgresql://user:pass@host`, `https://token@host`) -> `scheme://[redacted]@`.
 * Skema RFC 3986; userinfo = semua sebelum `@` pertama di otoritas (tanpa `/`,
 * spasi, atau kutip).
 */
const URL_USERINFO_RE = /\b([A-Za-z][A-Za-z0-9+.-]{1,30}:\/\/)[^\s/?#@"'<>]+@/g;

/**
 * Seluruh nilai header `Authorization` / `Proxy-Authorization` (skema apa pun:
 * Basic, Bearer, Digest, Token, ...), bukan hanya kata skemanya. Nilai berkutip
 * disamarkan utuh; tanpa kutip: skema opsional + kredensial sampai pemisah.
 */
const AUTH_HEADER_RE =
  /\b((?:proxy-)?authorization)(\s*[=:]\s*)("[^"]*"|'[^']*'|(?:[A-Za-z][A-Za-z0-9._~+-]*[ \t]+)?[^\s&;,"']+)/gi;

/** Kredensial skema Basic (base64) yang muncul tanpa nama header. */
const AUTH_SCHEME_RE = /\b(Basic)[ \t]+[A-Za-z0-9+/]{8,}={0,2}/g;

/**
 * Samarkan rahasia di dalam teks bebas: `Bearer <x>`, nilai header
 * Authorization utuh (Basic/Bearer/...), userinfo URL (`user:pass@`), JWT (tiga
 * segmen base64url), pasangan `kunci=nilai` / `kunci: nilai` dengan kunci
 * rahasia (termasuk `pwd`/`passphrase`), serta path profil user.
 */
export function redactSecrets(s: string): string {
  return redactPaths(
    s
      .replace(URL_USERINFO_RE, (_m, scheme: string) => `${scheme}${REDACTED}@`)
      .replace(AUTH_HEADER_RE, (_m, k: string, sep: string) => `${k}${sep}${REDACTED}`)
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
      .replace(AUTH_SCHEME_RE, (_m, scheme: string) => `${scheme} ${REDACTED}`)
      .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, REDACTED)
      .replace(
        /\b([A-Za-z0-9_-]*(?:token|cookie|password|passwd|passphrase|pwd|secret|session|api[-_]?key|authorization|credential|jwt|csrf)[A-Za-z0-9_-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;,"']+)/gi,
        (_m, k: string, sep: string, v: string) => (v === REDACTED ? `${k}${sep}${v}` : `${k}${sep}${REDACTED}`),
      ),
  );
}

/** Route/URL klien: pertahankan path; nilai query berkunci rahasia disamarkan, fragmen dibuang. */
export function sanitizeRoute(raw: string, max: number): string {
  const noHash = raw.split("#")[0] ?? "";
  const q = noHash.indexOf("?");
  let out = noHash;
  if (q >= 0) {
    const base = noHash.slice(0, q);
    const parts = noHash
      .slice(q + 1)
      .split("&")
      .filter(Boolean)
      .map((p) => {
        const eq = p.indexOf("=");
        const k = eq >= 0 ? p.slice(0, eq) : p;
        let dk = k;
        try {
          dk = decodeURIComponent(k);
        } catch {
          /* kunci tidak terdekode: pakai mentah */
        }
        return isSecretKey(dk) ? `${k}=${REDACTED}` : p;
      });
    out = parts.length ? `${base}?${parts.join("&")}` : base;
  }
  out = redactSecrets(out);
  return out.length > max ? out.slice(0, max) : out;
}

export interface SanitizeLimits {
  maxDepth: number;
  maxKeys: number;
  maxArray: number;
  maxString: number;
}

export const DEFAULT_SANITIZE_LIMITS: SanitizeLimits = { maxDepth: 4, maxKeys: 30, maxArray: 20, maxString: 500 };

/**
 * Salinan JSON aman dari nilai bebas klien: kunci rahasia -> `[redacted]`,
 * teks disamarkan dan dipotong, kedalaman/jumlah kunci/elemen dibatasi.
 * Fungsi, simbol, dan nilai non-JSON dibuang.
 */
export function sanitizeJson(v: unknown, limits: SanitizeLimits = DEFAULT_SANITIZE_LIMITS, depth = 0): unknown {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const r = redactSecrets(v);
    return r.length > limits.maxString ? `${r.slice(0, limits.maxString)}...` : r;
  }
  if (depth >= limits.maxDepth) return "[truncated]";
  if (Array.isArray(v)) {
    const out = v.slice(0, limits.maxArray).map((x) => sanitizeJson(x, limits, depth + 1));
    if (v.length > limits.maxArray) out.push(`[+${v.length - limits.maxArray} more]`);
    return out;
  }
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(v as Record<string, unknown>);
    for (const [k, val] of entries.slice(0, limits.maxKeys)) {
      const key = k.length > 80 ? k.slice(0, 80) : k;
      out[key] = isSecretKey(k) ? REDACTED : sanitizeJson(val, limits, depth + 1);
    }
    if (entries.length > limits.maxKeys) out["[truncated]"] = entries.length - limits.maxKeys;
    return out;
  }
  return undefined;
}
