/**
 * Obfuscation fon odttf (ECMA-376 Part 2, Embedded Font Obfuscation; port
 * `obfuscate()` RL scripts/embed_fonts.py, tanpa Word COM).
 *
 * Kunci = 16 byte dari 32 digit heksa GUID `w:fontKey` (tanda hubung dibuang)
 * dibaca terbalik (byte terakhir string = kunci[0]). 32 byte pertama berkas
 * fon di-XOR dengan kunci (dua putaran 16 byte); sisa berkas tidak berubah.
 * Operasinya simetris: fungsi yang sama memulihkan TTF asli dari odttf.
 */
import { createHash } from "node:crypto";

import { StudioEngineError } from "../../../contract/errors";

/** Panjang awalan fon yang diobfuskasi (byte). */
export const OBFUSCATED_PREFIX_BYTES = 32;

const GUID_PARTS_RE =
  /^\{?([0-9A-Fa-f]{8})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{12})\}?$/;

/** Kunci XOR 16 byte dari GUID (`{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`, kurung opsional). */
export function guidKeyBytes(guid: string): Uint8Array {
  const m = GUID_PARTS_RE.exec(typeof guid === "string" ? guid.trim() : "");
  if (!m) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `GUID kunci fon tidak sah: ${String(guid)}`);
  }
  const hex = m.slice(1, 6).join("");
  const key = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    key[15 - i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return key;
}

/** XOR 32 byte pertama `ttf` dengan kunci GUID. Masukan tidak diubah; keluaran salinan baru. */
export function obfuscateFont(ttf: Uint8Array, guid: string): Uint8Array {
  if (!(ttf instanceof Uint8Array)) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", "obfuscateFont: masukan fon harus Uint8Array");
  }
  if (ttf.length < OBFUSCATED_PREFIX_BYTES) {
    throw new StudioEngineError(
      "ASSET_TYPE_UNSUPPORTED",
      `obfuscateFont: berkas fon terlalu pendek (${ttf.length} byte < ${OBFUSCATED_PREFIX_BYTES})`,
    );
  }
  const key = guidKeyBytes(guid);
  const out = new Uint8Array(ttf);
  for (let i = 0; i < OBFUSCATED_PREFIX_BYTES; i++) {
    out[i] ^= key[i % 16];
  }
  return out;
}

/** Kebalikan obfuscateFont (operasi XOR simetris); dinamai terpisah agar maksud pemanggil jelas. */
export function deobfuscateFont(odttf: Uint8Array, guid: string): Uint8Array {
  return obfuscateFont(odttf, guid);
}

/** Domain pemisah derivasi GUID; ubah versinya hanya bila skema derivasi berubah. */
const GUID_DOMAIN = "studio.docx.odttf/v1";

/**
 * GUID kunci deterministik dari isi fon: sha256(domain, keluarga, slot, sha256 isi)
 * dipotong 16 byte, dibentuk sebagai UUID versi 5 varian RFC 4122, huruf besar,
 * berkurung. Fon dan slot yang sama selalu menghasilkan GUID yang sama.
 */
export function deriveFontGuid(contentSha256Hex: string, family: string, slot: string): string {
  const h = createHash("sha256")
    .update(`${GUID_DOMAIN}\n${family}\n${slot}\n${contentSha256Hex.toLowerCase()}`, "utf8")
    .digest();
  const b = Uint8Array.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}}`;
}
