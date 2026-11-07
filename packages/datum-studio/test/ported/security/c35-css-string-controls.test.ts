// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/security/c35-css-string-controls.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// C35 M-01 (CWE-116): `cssString` harus menyandikan setiap baris baru CSS (LF, CR, FF) dan kontrol C0/DEL,
// sehingga nilai klasifikasi tidak bisa menutup string CSS dan menyisipkan aturan. Ekspektasi literal
// (escape heksa CSS), bukan dihitung ulang dari kode produksi.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { DocMeta, ParamMap, ResolvedTemplate } from '@/lib/studio/contract';
import { cssString } from '@/lib/studio/engine/html/base/fonts';
import { pageFurnitureCss } from '@/lib/studio/engine/html/base/shell';
import { canonicalTemplate, loadFixtureDoc } from '../renderers/_kit';

/**
 * Tokenizer CSS minimal: membuang literal string "..." (escape `\` dihormati) dan gagal bila literal
 * memuat baris baru CSS mentah (CR, LF, FF), yang mengakhiri string sebagai bad-string.
 */
function outsideStrings(css: string): string {
  let out = '';
  for (let i = 0; i < css.length; i += 1) {
    const c = css[i];
    if (c !== '"' && c !== "'") {
      out += c;
      continue;
    }
    const q = c;
    for (i += 1; i < css.length && css[i] !== q; i += 1) {
      if (css[i] === '\\') i += 1;
      else if (/[\r\n\f]/.test(css[i])) throw new Error(`bad-string at ${i}: ${JSON.stringify(css.slice(i - 20, i + 20))}`);
    }
  }
  return out;
}

const PAYLOAD = 'p{color:red} q{a:';
const CONTROLS: Record<string, string> = { CR: '\r', FF: '\f', VT: '\v', NUL: '\u0000', BS: '\b', ESC: '\u001b', US: '\u001f', DEL: '\u007f', TAB: '\t' };

describe('C35 M-01 cssString: literal tetap untuk string biasa, kontrol disandikan', () => {
  it('string biasa byte-identik dengan keluaran lama (kutip, backslash, <, LF, CRLF)', () => {
    expect(cssString('Inter')).toBe('"Inter"');
    expect(cssString('Klasifikasi : TERBATAS')).toBe('"Klasifikasi : TERBATAS"');
    expect(cssString('a"b\\c<d>')).toBe('"a\\"b\\\\c\\3C d>"');
    expect(cssString('baris1\nbaris2\r\nbaris3')).toBe('"baris1\\A baris2\\A baris3"');
    expect(cssString('LEMBAR · Ü — é')).toBe('"LEMBAR · Ü — é"');
  });

  it('CR, FF dan kontrol C0 lain serta DEL menjadi escape heksa CSS', () => {
    expect(cssString('a\rb')).toBe('"a\\d b"');
    expect(cssString('a\fb')).toBe('"a\\c b"');
    expect(cssString('a\vb')).toBe('"a\\b b"');
    expect(cssString('a\u0000b')).toBe('"a\\0 b"');
    expect(cssString('a\u001fb')).toBe('"a\\1f b"');
    expect(cssString('a\u007fb')).toBe('"a\\7f b"');
    expect(cssString('a\tb')).toBe('"a\\9 b"');
    expect(cssString('a\r\r\nb')).toBe('"a\\d \\A b"');
  });

  it('keluaran tidak pernah memuat karakter kontrol mentah', () => {
    for (let cp = 0; cp <= 0x1f; cp += 1) expect(cssString(`x${String.fromCharCode(cp)}}y`)).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(cssString('x\u007f}y')).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
});

describe('C35 M-01 sink CSS halaman: klasifikasi bermusuhan tetap inert', () => {
  let base: ResolvedTemplate;
  beforeAll(async () => {
    base = await canonicalTemplate();
  });
  const tplWith = (set: ParamMap): ResolvedTemplate => ({ ...base, params: { ...base.params, ...set } });
  const metaWith = (classification: string): DocMeta => ({ ...(loadFixtureDoc('doc_nota_memo').meta as DocMeta), classification });

  for (const [name, ch] of Object.entries(CONTROLS)) {
    it(`${name}: running head (markup.ts) dan baris NOTA (shell.ts) tidak menyisipkan aturan`, () => {
      const cls = `X${ch}}} ${PAYLOAD}`;
      const css = pageFurnitureCss(tplWith({ 'render.nota.classificationLine': true }), metaWith(cls), [], 1);
      // Wave 165 row 165A for 165D (F113-12, consequence edit): the NOTA register second line is retired, so the running
      // head (right) is the sink left; was: both sinks (also `"\A" "Klasifikasi : X..."`).
      expect(css).toContain('@top-right');
      expect(css).not.toMatch(/"\\A" "[^"]*: ?X/);
      const outside = outsideStrings(css);
      expect(outside).not.toContain(PAYLOAD);
      expect(outside).not.toContain(PAYLOAD.toUpperCase());
      expect(css).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    });
  }
});
