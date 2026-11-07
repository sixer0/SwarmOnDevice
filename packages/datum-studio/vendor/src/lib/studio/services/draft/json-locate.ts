/**
 * Penentu posisi galat sintaks JSON (DC-21, DR-03). Dipanggil hanya setelah `JSON.parse` gagal,
 * supaya `line`/`column` draf tidak bergantung pada format pesan galat mesin JS. Iteratif (tanpa
 * rekursi) agar larik bersarang sangat dalam tidak meluapkan tumpukan; O(n).
 */

const MODE_VALUE = 0;
const MODE_KEY = 1;
const MODE_AFTER = 2;
type Mode = typeof MODE_VALUE | typeof MODE_KEY | typeof MODE_AFTER;

function isWs(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}

function isHex(c: string | undefined): boolean {
  return c !== undefined && /^[0-9a-fA-F]$/.test(c);
}

/** Memindai string mulai `s[i] === '"'`; hasil = indeks sesudah penutup, atau `-(posisiGalat + 1)`. */
function scanString(s: string, i: number): number {
  let p = i + 1;
  while (p < s.length) {
    const c = s[p];
    if (c === '"') return p + 1;
    if (c === "\\") {
      const e = s[p + 1];
      if (e === "u") {
        for (let k = 2; k < 6; k++) if (!isHex(s[p + k])) return -(p + k + 1);
        p += 6;
        continue;
      }
      if (e === undefined || !'"\\/bfnrt'.includes(e)) return -(p + 1 + 1);
      p += 2;
      continue;
    }
    if (c.charCodeAt(0) < 0x20) return -(p + 1);
    p++;
  }
  return -(s.length + 1);
}

function scanNumber(s: string, i: number): number {
  let p = i;
  if (s[p] === "-") p++;
  if (s[p] === "0") p++;
  else if (isDigit(s[p])) while (isDigit(s[p])) p++;
  else return -(p + 1);
  if (s[p] === ".") {
    p++;
    if (!isDigit(s[p])) return -(p + 1);
    while (isDigit(s[p])) p++;
  }
  if (s[p] === "e" || s[p] === "E") {
    p++;
    if (s[p] === "+" || s[p] === "-") p++;
    if (!isDigit(s[p])) return -(p + 1);
    while (isDigit(s[p])) p++;
  }
  return p;
}

function scanLiteral(s: string, i: number, word: string): number {
  for (let k = 0; k < word.length; k++) if (s[i + k] !== word[k]) return -(i + k + 1);
  return i + word.length;
}

function scanScalar(s: string, i: number): number {
  const c = s[i];
  if (c === '"') return scanString(s, i);
  if (c === "-" || isDigit(c)) return scanNumber(s, i);
  if (c === "t") return scanLiteral(s, i, "true");
  if (c === "f") return scanLiteral(s, i, "false");
  if (c === "n") return scanLiteral(s, i, "null");
  return -(i + 1);
}

/**
 * Offset (indeks kode UTF-16) karakter pertama yang membuat `s` bukan JSON sah; `s.length` bila
 * masukan berakhir terlalu dini; `-1` bila `s` sah menurut tata bahasa RFC 8259.
 */
export function jsonErrorOffset(s: string): number {
  const n = s.length;
  const stack: Array<"{" | "["> = [];
  let i = 0;
  let mode: Mode = MODE_VALUE;
  for (;;) {
    while (i < n && isWs(s[i])) i++;
    if (mode === MODE_VALUE) {
      if (i >= n) return n;
      const c = s[i];
      if (c === "{" || c === "[") {
        stack.push(c);
        i++;
        while (i < n && isWs(s[i])) i++;
        if (s[i] === (c === "{" ? "}" : "]")) {
          stack.pop();
          i++;
          mode = MODE_AFTER;
        } else {
          mode = c === "{" ? MODE_KEY : MODE_VALUE;
        }
        continue;
      }
      const r = scanScalar(s, i);
      if (r < 0) return -r - 1;
      i = r;
      mode = MODE_AFTER;
      continue;
    }
    if (mode === MODE_KEY) {
      if (i >= n) return n;
      if (s[i] !== '"') return i;
      const r = scanString(s, i);
      if (r < 0) return -r - 1;
      i = r;
      while (i < n && isWs(s[i])) i++;
      if (i >= n) return n;
      if (s[i] !== ":") return i;
      i++;
      mode = MODE_VALUE;
      continue;
    }
    // MODE_AFTER
    const top = stack[stack.length - 1];
    if (top === undefined) return i < n ? i : -1;
    if (i >= n) return n;
    if (s[i] === ",") {
      i++;
      mode = top === "{" ? MODE_KEY : MODE_VALUE;
      continue;
    }
    if (s[i] === (top === "{" ? "}" : "]")) {
      stack.pop();
      i++;
      continue;
    }
    return i;
  }
}
