// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/docx-xml-escape.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S72: escape XML tunggal (`engine/docx/package/xml.ts`, D-110/D-112): karakter
// tak sah XML 1.0, kutip, entitas; satu sumber escape di engine/docx; dan uji
// ujung-ke-ujung masukan adversarial (payload injeksi) -> document.xml tetap
// well-formed dan teks kembali utuh.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from '../_vitest';
import type { ResolvedTemplate } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { escapeXml as blocksEscapeXml } from '@/lib/studio/engine/docx/blocks/xml';
import { escapeXml, escapeXmlStrict, stripInvalidXmlChars } from '@/lib/studio/engine/docx/package/xml';
import { REPO, canonicalTemplate, findAll, loadFixtureDoc, makeCtx, parseXml, partText, snapshotOf, unzip, wText } from './_kit';

const C0 = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).join('');
const LONE_HIGH = '\uD83D';
const LONE_LOW = '\uDE00';
const PAIR = '😀'; // U+1F600

describe('pemeriksa XML uji (kontrol negatif)', () => {
  it('menolak XML rusak yang umum', () => {
    expect(parseXml('<a><b></a>').errors.length).toBeGreaterThan(0);
    expect(parseXml('<a>x & y</a>').errors.length).toBeGreaterThan(0);
    expect(parseXml('<a t="1" t="2"/>').errors.length).toBeGreaterThan(0);
    expect(parseXml('<a>\u0001</a>').errors.length).toBeGreaterThan(0);
    expect(parseXml(`<a>${LONE_HIGH}</a>`).errors.length).toBeGreaterThan(0);
    expect(parseXml('<a x="<"/>').errors.length).toBeGreaterThan(0);
    expect(parseXml('<a>&amp;&#65;&#x42;</a>').errors).toEqual([]);
  });
});

describe('escapeXml (paket, bawaan header/footer/styles)', () => {
  it('meng-escape & < > " dan membiarkan apostrof (atribut berkutip ganda)', () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe(`a&amp;b&lt;c&gt;d&quot;e'f`);
  });
  it('tidak meng-escape ganda entitas yang sudah ada', () => {
    expect(escapeXml('&amp;')).toBe('&amp;amp;');
  });
  it('membuang kontrol C0 kecuali TAB/LF/CR serta U+FFFE/U+FFFF', () => {
    expect(escapeXml(`x${C0}￾￿y`)).toBe('x\t\n\ry');
  });
  it('hasil selalu sah sebagai isi teks dan nilai atribut berkutip ganda', () => {
    const nasty = `${C0}<"'&>]]>￾`;
    expect(parseXml(`<a v="${escapeXml(nasty)}">${escapeXml(nasty)}</a>`).errors).toEqual([]);
  });
});

describe('escapeXmlStrict + stripInvalidXmlChars (aturan ketat blok teks)', () => {
  it('meng-escape kelima karakter termasuk apostrof', () => {
    expect(escapeXmlStrict(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });
  it('membuang surrogate tunggal tetapi mempertahankan pasangan surrogate utuh', () => {
    expect(stripInvalidXmlChars(`a${LONE_HIGH}b${LONE_LOW}c${PAIR}d`)).toBe(`abc${PAIR}d`);
    expect(stripInvalidXmlChars(`${LONE_LOW}${LONE_HIGH}`)).toBe('');
  });
  it('membuang kontrol C0 kecuali TAB/LF/CR dan nonkarakter FFFE/FFFF', () => {
    expect(stripInvalidXmlChars(`x${C0}￾￿y`)).toBe('x\t\n\ry');
  });
  it('blocks/xml.ts mengekspor fungsi escape paket yang sama (bukan salinan)', () => {
    expect(blocksEscapeXml).toBe(escapeXmlStrict);
  });
});

describe('satu sumber escape di engine/docx (IP-38, D-112)', () => {
  function tsFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith('.ts') ? [p] : [];
    });
  }
  it('hanya package/xml.ts yang mengganti & -> &amp; (tidak ada escape lokal lain)', () => {
    const root = path.join(REPO, 'src', 'lib', 'studio', 'engine', 'docx');
    const offenders = tsFiles(root)
      .filter((f) => /replace\(\s*\/&\/g\s*,\s*["']&amp;["']\)|["']&["']\s*:\s*["']&amp;["']/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(root, f).replace(/\\/g, '/'));
    expect(offenders).toEqual(['package/xml.ts']);
  });
});

describe('ujung-ke-ujung: payload adversarial di dokumen', () => {
  let tpl: ResolvedTemplate;
  beforeAll(async () => {
    tpl = await canonicalTemplate();
  }, 60_000);

  const PAYLOAD = `</w:t></w:r><w:r><w:t>INJ</w:t> ]]> <![CDATA[x]]> "q" 'a' & &amp; <script>`;
  const CONTROL = `ctl${'\u0001\u0008\u000B\u001F'}${LONE_HIGH}end`;

  it('teks paragraf berisi payload dan karakter tak sah -> document.xml well-formed, teks kembali persis (tanpa karakter tak sah)', async () => {
    const doc = loadFixtureDoc('doc_nota_tables');
    const target = doc.chapters[0].intro![0] as { text: string };
    target.text = `${PAYLOAD} ${CONTROL}`;
    doc.meta.title = `Judul ${PAYLOAD} ${CONTROL}`;
    const snap = snapshotOf(doc);
    const { ctx, logs } = makeCtx(snap, tpl);
    const d = await assembleDocxDetailed(ctx);
    expect(logs.filter((l) => l.level === 'error')).toEqual([]);
    const parts = unzip(d.bytes);
    for (const p of Object.keys(parts).filter((x) => x.endsWith('.xml'))) {
      expect(parseXml(partText(parts, p)).errors, p).toEqual([]);
    }
    const root = parseXml(d.documentXml).root!;
    // Injeksi tidak menciptakan run/paragraf baru berisi "INJ" sebagai teks tersendiri.
    expect(findAll(root, 'w:t').some((t) => t.text === 'INJ')).toBe(false);
    const text = wText(root);
    expect(text).toContain(PAYLOAD);
    expect(text).toContain('ctlend');
    // Judul dokumen di docProps/core.xml (dc:title) juga utuh dan bersih.
    const core = parseXml(partText(parts, 'docProps/core.xml')).root!;
    const title = findAll(core, 'dc:title')[0]?.text ?? '';
    expect(title).toContain(PAYLOAD);
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(title)).toBe(false);
  }, 60_000);
});
