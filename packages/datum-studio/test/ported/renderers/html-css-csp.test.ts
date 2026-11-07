// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/html-css-csp.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S72: perakit HTML (S21-S24): determinisme sha256, CSP + artefak mandiri
// (tanpa skrip, tanpa URL eksternal), token CSS `:root` dari parameter templat,
// escape teks adversarial, dan penjaga `enforceStandalone`.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { ResolvedTemplate } from '@/lib/studio/contract';
import { STUDIO_HTML_CSP, assembleHtml, enforceStandalone } from '@/lib/studio/engine/html/assemble';
import { FIXTURES, canonicalTemplate, loadFixtureDoc, makeCtx, sha256, snapshotOf, type FixtureName } from './_kit';

let tpl: ResolvedTemplate;
const html = new Map<FixtureName, string>();

async function render(f: FixtureName, t: ResolvedTemplate = tpl, mutate?: (d: ReturnType<typeof loadFixtureDoc>) => void) {
  const doc = loadFixtureDoc(f);
  mutate?.(doc);
  const { ctx, logs } = makeCtx(snapshotOf(doc), t);
  return { html: await assembleHtml(ctx, { preview: false }), logs };
}

beforeAll(async () => {
  tpl = await canonicalTemplate();
  for (const f of FIXTURES) html.set(f, (await render(f)).html);
}, 120_000);

/** Isi deklarasi `:root{...}` pertama. */
function rootVars(h: string): Map<string, string> {
  const m = /:root\{([^}]*)\}/.exec(h);
  const out = new Map<string, string>();
  if (!m) return out;
  for (const d of m[1].split(';')) {
    const i = d.indexOf(':');
    if (i > 0) out.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
  }
  return out;
}

const mmOf = (v: string | undefined) => Number(/^([0-9.]+)mm$/.exec(v ?? '')?.[1] ?? NaN);

describe.each(FIXTURES)('HTML %s', (f) => {
  it('render kedua identik byte demi byte (sha256)', async () => {
    const again = (await render(f)).html;
    expect(sha256(again)).toBe(sha256(html.get(f)!));
  }, 60_000);

  it('CSP meta ada di awal <head> dengan kebijakan Studio; tanpa elemen skrip atau handler on*', () => {
    const h = html.get(f)!;
    const head = /<head>([\s\S]*?)<\/head>/i.exec(h)?.[1] ?? '';
    const metas = [...head.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/gi)];
    expect(metas).toHaveLength(1);
    const csp = metas[0][1];
    expect(csp).toBe(STUDIO_HTML_CSP);
    for (const d of ["default-src 'none'", "script-src 'none'", "connect-src 'none'", 'img-src data:', 'font-src data:', "base-uri 'none'"]) {
      expect(csp).toContain(d);
    }
    // CSP mendahului semua <style>/<link>/<img> di head.
    expect(head.indexOf('Content-Security-Policy')).toBeLessThan(Math.max(0, head.search(/<(style|link|img)\b/i)));
    expect(/<script\b/i.test(h)).toBe(false);
    expect(/<(iframe|object|embed|link|base)\b/i.test(h)).toBe(false);
    expect(/<[a-z][^>]*\son[a-z]+\s*=/i.test(h)).toBe(false);
  });

  it('tanpa rujukan jaringan: src/href/url() hanya data: atau #fragmen; @font-face semua data:', () => {
    const h = html.get(f)!;
    const refs = [
      ...[...h.matchAll(/\s(?:src|href|xlink:href|poster|srcset)\s*=\s*"([^"]*)"/gi)].map((m) => m[1]),
      ...[...h.matchAll(/url\(\s*['"]?([^'")]*)/gi)].map((m) => m[1]),
    ];
    const external = refs.filter((r) => !/^(data:|#)/i.test(r.trim()) && r.trim() !== '');
    expect(external).toEqual([]);
    const faces = [...h.matchAll(/@font-face\{[^}]*\}/g)].map((m) => m[0]);
    expect(faces.length).toBeGreaterThan(0);
    for (const ff of faces) expect(ff).toMatch(/src:url\(data:font\/(ttf|otf|woff2?);base64,/);
  });

  it('tanpa karakter kendali C0 (kecuali TAB/LF/CR) di keluaran', () => {
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(html.get(f)!)).toBe(false);
  });
});

describe('token CSS :root dari parameter templat', () => {
  it('setiap color.interior.* / color.wrapper.* / color.brief.* menjadi variabel --nama / --w-nama / --b-nama bernilai heks parameter', () => {
    const vars = rootVars(html.get('doc_nota_tables')!);
    const groups: Array<[string, string]> = [
      ['color.interior.', '--'],
      ['color.wrapper.', '--w-'],
      ['color.brief.', '--b-'],
    ];
    let n = 0;
    for (const [prefix, vp] of groups) {
      for (const [k, v] of Object.entries(tpl.params)) {
        if (!k.startsWith(prefix) || typeof v !== 'string' || !/^#?[0-9A-Fa-f]{6}$/.test(v)) continue;
        n++;
        expect(vars.get(`${vp}${k.slice(prefix.length)}`)?.toUpperCase(), k).toBe(`#${v.replace('#', '').toUpperCase()}`);
      }
    }
    expect(n).toBeGreaterThan(5);
  });

  it('geometri A4: lebar halaman 210 mm = margin dalam + kolom teks + parit + rel + margin luar; bentang penuh = kolom + parit + rel', () => {
    const v = rootVars(html.get('doc_nota_tables')!);
    expect(v.get('--page-w')).toBe('210mm');
    expect(v.get('--page-h')).toBe('297mm');
    const sum = mmOf(v.get('--m-inner')) + mmOf(v.get('--col')) + mmOf(v.get('--gut')) + mmOf(v.get('--rail')) + mmOf(v.get('--m-outer'));
    expect(sum).toBeCloseTo(210, 3);
    expect(mmOf(v.get('--full'))).toBeCloseTo(mmOf(v.get('--col')) + mmOf(v.get('--gut')) + mmOf(v.get('--rail')), 3);
    expect(mmOf(v.get('--col'))).toBe(Number(tpl.params['grid.textColumnMm']));
  });

  it('mengubah satu parameter warna mengubah variabel CSS yang sesuai (CSS mengikuti templat, bukan konstanta)', async () => {
    const key = Object.keys(tpl.params).find((k) => k.startsWith('color.interior.'))!;
    const t2: ResolvedTemplate = { ...tpl, params: { ...tpl.params, [key]: '123456' } };
    const { html: h2 } = await render('doc_nota_tables', t2);
    expect(rootVars(h2).get(`--${key.slice('color.interior.'.length)}`)).toBe('#123456');
  }, 60_000);
});

describe('escape HTML masukan adversarial', () => {
  const PAYLOAD = `<script>alert(1)</script><img src=x onerror=alert(2)> " onmouseover="x" ' & </p>`;
  const CONTROL = `ctl\u0001\u0008\u000B\u001Fend`;

  it('payload di paragraf, judul dan nomor dokumen ter-escape; tidak ada tag/atribut baru; kendali C0 dibuang', async () => {
    const { html: h, logs } = await render('doc_nota_tables', tpl, (d) => {
      (d.chapters[0].intro![0] as { text: string }).text = `${PAYLOAD} ${CONTROL}`;
      d.meta.title = `Judul ${PAYLOAD} ${CONTROL}`;
      d.meta.author = `Penulis ${PAYLOAD}`;
    });
    expect(logs.filter((l) => l.level === 'error')).toEqual([]);
    expect(/<script\b/i.test(h)).toBe(false);
    expect(/<img\s+src=x/i.test(h)).toBe(false);
    // Atribut handler hanya berbahaya di dalam tag nyata; sebagai teks ter-escape ia aman.
    expect(/<[a-z][^>]*\son(?:error|mouseover)\s*=/i.test(h)).toBe(false);
    expect(h).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(/<title>[^<]*&lt;script&gt;/.test(h)).toBe(true);
    // Kebijakan S22 (blocks/escape.ts): kendali C0 dibuang karena tidak sah di HTML.
    const ctl = [...h.matchAll(/.{0,40}[\u0000-\u0008\u000B\u000C\u000E-\u001F].{0,20}/g)].map((m) => JSON.stringify(m[0]));
    expect(ctl, 'konteks kendali C0 di HTML').toEqual([]);
  }, 60_000);
});

describe('enforceStandalone (jaring terakhir)', () => {
  it('menetralkan skrip, handler, URL eksternal, @import, meta refresh dan melaporkannya', () => {
    const dirty =
      '<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=https://evil.example/">' +
      '<style>@import url("https://evil.example/x.css");body{background:url(https://evil.example/b.png)}</style>' +
      '<link rel="stylesheet" href="https://evil.example/s.css"></head><body>' +
      '<script>alert(1)</script><img src="https://evil.example/p.png" onerror="alert(2)">' +
      '<a href="javascript:alert(3)">x</a><p>teks src= url( aman</p></body></html>';
    const { html: out, violations } = enforceStandalone(dirty);
    const kinds = new Set(violations.map((v) => v.kind));
    for (const k of ['forbiddenElement', 'eventHandler', 'externalUrl', 'cssImport', 'metaRefresh']) expect(kinds.has(k as never), k).toBe(true);
    expect(/<script\b/i.test(out)).toBe(false);
    expect(/onerror\s*=/i.test(out)).toBe(false);
    expect(out.includes('evil.example')).toBe(false);
    expect(/javascript:/i.test(out)).toBe(false);
    expect(out).toContain('<p>teks src= url( aman</p>');
  });

  it('HTML bersih tidak diubah dan tanpa pelanggaran', () => {
    const clean = '<!DOCTYPE html><html><head><style>p{color:#000}</style></head><body><img src="data:image/png;base64,AAAA"><p>a</p></body></html>';
    const r = enforceStandalone(clean);
    expect(r.violations).toEqual([]);
    expect(r.html).toBe(clean);
  });
});
