/**
 * Parser aritmetika aman untuk ekspresi turunan (pengganti `eval` di
 * `Derivation.result` datumbind.py). Tokenizer + recursive descent buatan
 * sendiri; TIDAK memakai evaluasi kode dinamis dalam bentuk apa pun.
 *
 * Subhimpunan Python yang didukung (presedensi Python):
 *   expr  := term (("+" | "-") term)*
 *   term  := unary (("*" | "/" | "//" | "%") unary)*
 *   unary := ("+" | "-") unary | power
 *   power := atom ("**" unary)?            (asosiatif kanan; -2**2 = -4)
 *   atom  := NUMBER | NAME | FUNC "(" expr ("," expr)* ")" | "(" expr ")"
 * FUNC = abs, round, sqrt, min, max (lingkungan `__builtins__` datumbind).
 * NAME = kunci register apa adanya (boleh berspasi; dicocokkan terpanjang
 * dulu, seperti penggantian spasi->garis bawah di Python) atau bentuk
 * garis-bawahnya. Literal angka desimal ASCII Python (`1_000`, `.5`, `1e3`).
 * Semantik float Python: `//` dan `%` mengikuti tanda pembagi, pembagian nol
 * dan overflow pangkat menjadi BindDefect, hasil akhir wajib bilangan hingga.
 */
import { BindDefect } from "./defect";
import { pyRound } from "./format";

export const ARITH_MAX_LENGTH = 4096;
export const ARITH_MAX_DEPTH = 100;

type Tok =
  | { k: "num"; v: number; at: number }
  | { k: "var"; name: string; at: number }
  | { k: "fn"; name: ArithFn; at: number }
  | { k: "op"; v: "+" | "-" | "*" | "/" | "//" | "%" | "**"; at: number }
  | { k: "(" | ")" | ","; at: number }
  | { k: "end"; at: number };

type ArithFn = "abs" | "round" | "sqrt" | "min" | "max";
const FUNCS: readonly ArithFn[] = ["abs", "round", "sqrt", "min", "max"];

const WORD_CHAR = new RegExp("[\\p{L}\\p{N}_]", "u");
const IDENT = new RegExp("^[\\p{L}_][\\p{L}\\p{N}_]*", "u");
const NUMBER = /^(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?/;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/** Karakter (code point) di posisi `i` dan sebelum `i`. */
function charAt(s: string, i: number): string | undefined {
  if (i >= s.length) return undefined;
  const cp = s.codePointAt(i);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

function charBefore(s: string, i: number): string | undefined {
  if (i <= 0) return undefined;
  const lo = s.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1];
}

function defect(expr: string, msg: string): BindDefect {
  return new BindDefect(`ekspresi "${expr}": ${msg}`);
}

function tokenize(expr: string, names: readonly string[]): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    // Nama register terpanjang dulu, berbatas kata di kedua sisi.
    if (!isWordChar(charBefore(expr, i))) {
      let hit: string | undefined;
      for (const n of names) {
        if (expr.startsWith(n, i) && !isWordChar(charAt(expr, i + n.length))) {
          hit = n;
          break;
        }
      }
      if (hit !== undefined) {
        toks.push({ k: "var", name: hit, at: i });
        i += hit.length;
        continue;
      }
    }
    const num = NUMBER.exec(expr.slice(i));
    if (num) {
      const after = charAt(expr, i + num[0].length);
      if (isWordChar(after) || after === ".") throw defect(expr, `literal angka tidak sah di posisi ${i}.`);
      const v = Number(num[0].replace(/_/g, ""));
      if (!Number.isFinite(v)) throw defect(expr, `literal angka "${num[0]}" di luar jangkauan.`);
      toks.push({ k: "num", v, at: i });
      i += num[0].length;
      continue;
    }
    const two = expr.slice(i, i + 2);
    if (two === "**" || two === "//") {
      toks.push({ k: "op", v: two, at: i });
      i += 2;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "%") {
      toks.push({ k: "op", v: ch, at: i });
      i++;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === ",") {
      toks.push({ k: ch, at: i });
      i++;
      continue;
    }
    const id = IDENT.exec(expr.slice(i));
    if (id) {
      if ((FUNCS as readonly string[]).includes(id[0])) {
        toks.push({ k: "fn", name: id[0] as ArithFn, at: i });
        i += id[0].length;
        continue;
      }
      throw defect(expr, `nama "${id[0]}" tidak terdaftar pada register dan bukan fungsi yang diizinkan.`);
    }
    throw defect(expr, `karakter "${charAt(expr, i)}" tidak diizinkan di posisi ${i}.`);
  }
  toks.push({ k: "end", at: expr.length });
  return toks;
}

/** fmod C (JS `%`) dengan koreksi tanda Python `float.__mod__`. */
function pyMod(a: number, b: number, expr: string): number {
  if (b === 0) throw defect(expr, "modulo dengan nol.");
  let mod = a % b;
  if (mod) {
    if (b < 0 !== mod < 0) mod += b;
  } else {
    mod = b < 0 ? -0 : 0;
  }
  return mod;
}

/** Port `float_floor_div` CPython. */
function pyFloorDiv(a: number, b: number, expr: string): number {
  if (b === 0) throw defect(expr, "pembagian bulat dengan nol.");
  let mod = a % b;
  let div = (a - mod) / b;
  if (mod) {
    if (b < 0 !== mod < 0) {
      mod += b;
      div -= 1;
    }
  }
  if (div) {
    let fl = Math.floor(div);
    if (div - fl > 0.5) fl += 1;
    return fl;
  }
  return a / b < 0 ? -0 : 0;
}

function pyPow(a: number, b: number, expr: string): number {
  if (a === 0 && b < 0) throw defect(expr, "nol dipangkatkan bilangan negatif.");
  if (a < 0 && !Number.isInteger(b)) throw defect(expr, "bilangan negatif dipangkatkan pecahan (hasil kompleks).");
  const r = Math.pow(a, b);
  if (!Number.isFinite(r) && Number.isFinite(a) && Number.isFinite(b)) throw defect(expr, "hasil pangkat melampaui jangkauan.");
  return r;
}

class Parser {
  private pos = 0;
  private depth = 0;

  constructor(
    private readonly expr: string,
    private readonly toks: Tok[],
    private readonly vars: ReadonlyMap<string, number>,
  ) {}

  run(): number {
    const v = this.parseExpr();
    const t = this.peek();
    if (t.k !== "end") throw defect(this.expr, `token tak terduga di posisi ${t.at}.`);
    return v;
  }

  private peek(): Tok {
    return this.toks[this.pos];
  }

  private next(): Tok {
    return this.toks[this.pos++];
  }

  private enter(): void {
    if (++this.depth > ARITH_MAX_DEPTH) throw defect(this.expr, `kedalaman bersarang melebihi ${ARITH_MAX_DEPTH}.`);
  }

  private parseExpr(): number {
    this.enter();
    let v = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t.k === "op" && (t.v === "+" || t.v === "-")) {
        this.next();
        const r = this.parseTerm();
        v = t.v === "+" ? v + r : v - r;
      } else break;
    }
    this.depth--;
    return v;
  }

  private parseTerm(): number {
    let v = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.k === "op" && (t.v === "*" || t.v === "/" || t.v === "//" || t.v === "%")) {
        this.next();
        const r = this.parseUnary();
        if (t.v === "*") v = v * r;
        else if (t.v === "/") {
          if (r === 0) throw defect(this.expr, "pembagian dengan nol.");
          v = v / r;
        } else if (t.v === "//") v = pyFloorDiv(v, r, this.expr);
        else v = pyMod(v, r, this.expr);
      } else break;
    }
    return v;
  }

  private parseUnary(): number {
    const t = this.peek();
    if (t.k === "op" && (t.v === "+" || t.v === "-")) {
      this.next();
      this.enter();
      const v = this.parseUnary();
      this.depth--;
      return t.v === "-" ? -v : v;
    }
    return this.parsePower();
  }

  private parsePower(): number {
    const base = this.parseAtom();
    const t = this.peek();
    if (t.k === "op" && t.v === "**") {
      this.next();
      this.enter();
      const exp = this.parseUnary();
      this.depth--;
      return pyPow(base, exp, this.expr);
    }
    return base;
  }

  private expect(k: "(" | ")"): void {
    const t = this.next();
    if (t.k !== k) throw defect(this.expr, `diharapkan "${k}" di posisi ${t.at}.`);
  }

  private parseAtom(): number {
    const t = this.next();
    switch (t.k) {
      case "num":
        return t.v;
      case "var": {
        const v = this.vars.get(t.name);
        if (v === undefined) throw defect(this.expr, `nama "${t.name}" tidak terdaftar.`);
        return v;
      }
      case "(": {
        const v = this.parseExpr();
        this.expect(")");
        return v;
      }
      case "fn":
        return this.parseCall(t.name);
      default:
        throw defect(this.expr, `operand diharapkan di posisi ${t.at}.`);
    }
  }

  private parseCall(fn: ArithFn): number {
    this.expect("(");
    const args: number[] = [];
    if (this.peek().k !== ")") {
      args.push(this.parseExpr());
      while (this.peek().k === ",") {
        this.next();
        if (this.peek().k === ")") break; // koma penutup diizinkan Python
        args.push(this.parseExpr());
      }
    }
    this.expect(")");
    const arity = (ok: boolean, want: string): void => {
      if (!ok) throw defect(this.expr, `${fn}() menerima ${want} argumen, diberi ${args.length}.`);
    };
    switch (fn) {
      case "abs":
        arity(args.length === 1, "1");
        return Math.abs(args[0]);
      case "sqrt":
        arity(args.length === 1, "1");
        if (args[0] < 0) throw defect(this.expr, "sqrt() atas bilangan negatif.");
        return Math.sqrt(args[0]);
      case "round":
        arity(args.length === 1 || args.length === 2, "1 atau 2");
        if (args.length === 2 && !Number.isInteger(args[1])) {
          throw defect(this.expr, "round(): argumen kedua harus bilangan bulat.");
        }
        try {
          return pyRound(args[0], args.length === 2 ? args[1] : 0);
        } catch (e) {
          throw defect(this.expr, e instanceof Error ? e.message : String(e));
        }
      case "min":
        arity(args.length >= 2, "paling sedikit 2");
        return Math.min(...args);
      case "max":
        arity(args.length >= 2, "paling sedikit 2");
        return Math.max(...args);
    }
  }
}

/**
 * Evaluasi ekspresi aritmetika atas variabel bernama tanpa eval/Function.
 * Nama variabel boleh berspasi; bentuk garis-bawah (spasi -> "_") juga dikenali.
 * Melempar BindDefect untuk sintaks tak sah, nama tak terdaftar, pembagian nol,
 * dan hasil yang bukan bilangan hingga.
 */
export function evalArith(expr: string, vars: Readonly<Record<string, number>>): number {
  if (typeof expr !== "string" || expr.trim() === "") throw new BindDefect("ekspresi turunan kosong.");
  if (expr.length > ARITH_MAX_LENGTH) throw new BindDefect(`ekspresi turunan melebihi ${ARITH_MAX_LENGTH} karakter.`);
  const map = new Map<string, number>();
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new BindDefect(`variabel "${k}" bukan bilangan hingga.`, k);
    map.set(k, v);
  }
  for (const [k, v] of Object.entries(vars)) {
    const alias = k.replace(/ /g, "_");
    if (!map.has(alias)) map.set(alias, v);
  }
  // Nama yang diawali digit, titik, atau spasi tidak dapat dirujuk (di Python pun tidak).
  const names = [...map.keys()]
    .filter((n) => n.length > 0 && !/^[\d.\s]/.test(n))
    .sort((a, b) => b.length - a.length);
  const result = new Parser(expr, tokenize(expr, names), map).run();
  if (!Number.isFinite(result)) throw new BindDefect(`ekspresi "${expr}" tidak menghasilkan bilangan hingga.`);
  return result;
}
