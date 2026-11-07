// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/docx-fonts-embedded.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S72: fon tertanam di PAKET DOCX keluaran (bukan rencana): setiap
// `word/fonts/*.odttf` dipulihkan dengan GUID `w:fontKey` (implementasi
// independen ECMA-376), dibaca tabel `name`-nya, lalu dibandingkan dengan
// `w:font/@w:name` di fontTable.xml dan keluarga `w:rFonts` yang dipakai
// document.xml (D-74, D-104, D-109). Benchmark: IBM Plex Sans Cond 4 slot.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { ResolvedTemplate } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import {
  benchmarkTemplate,
  canonicalTemplate,
  deobfuscateOdttf,
  findAll,
  loadFixtureDoc,
  makeCtx,
  parseXml,
  partText,
  sfntFamilies,
  snapshotOf,
  unzip,
  type XNode,
} from './_kit';

const SLOTS = ['w:embedRegular', 'w:embedBold', 'w:embedItalic', 'w:embedBoldItalic'] as const;

interface EmbeddedFace {
  font: string;
  slot: (typeof SLOTS)[number];
  family?: string;
  typoFamily?: string;
  sfntOk: boolean;
}

interface Pkg {
  embedded: EmbeddedFace[];
  rFonts: Set<string>;
  fontNames: Set<string>;
  /** keluarga -> slot embed* yang dibutuhkan run (gaya dari w:b / w:i langsung). */
  usedStyles: Map<string, Set<string>>;
}

async function renderPkg(tpl: ResolvedTemplate): Promise<Pkg> {
  const snap = snapshotOf(loadFixtureDoc('doc_terbit_report'));
  const { ctx } = makeCtx(snap, tpl);
  const d = await assembleDocxDetailed(ctx);
  const parts = unzip(d.bytes);
  const table = parseXml(partText(parts, 'word/fontTable.xml')).root!;
  const relsXml = parts['word/_rels/fontTable.xml.rels'] ? partText(parts, 'word/_rels/fontTable.xml.rels') : '<Relationships/>';
  const rels = Object.fromEntries(findAll(parseXml(relsXml).root, 'Relationship').map((r) => [r.attrs.Id, r.attrs.Target]));
  const embedded: EmbeddedFace[] = [];
  const fontNames = new Set<string>();
  for (const font of findAll(table, 'w:font') as XNode[]) {
    fontNames.add(font.attrs['w:name']);
    for (const slot of SLOTS) {
      const e = font.children.find((c) => c.name === slot);
      if (!e) continue;
      const target = rels[e.attrs['r:id']];
      const odttf = parts[`word/${target}`];
      expect(odttf, `${font.attrs['w:name']} ${slot} -> ${target}`).toBeDefined();
      const ttf = deobfuscateOdttf(odttf, e.attrs['w:fontKey']);
      const info = sfntFamilies(ttf);
      embedded.push({
        font: font.attrs['w:name'],
        slot,
        family: info.family,
        typoFamily: info.typoFamily,
        sfntOk: info.sfntVersion === 0x00010000 || info.sfntVersion === 0x4f54544f,
      });
    }
  }
  const rFonts = new Set<string>();
  const usedStyles = new Map<string, Set<string>>();
  const docParts = Object.keys(parts).filter((p) => /^word\/(document|header\d*|footer\d*|styles)\.xml$/.test(p));
  for (const p of docParts) {
    const root = parseXml(partText(parts, p)).root;
    for (const rf of findAll(root, 'w:rFonts')) {
      for (const k of ['w:ascii', 'w:hAnsi']) if (rf.attrs[k]) rFonts.add(rf.attrs[k]);
    }
    for (const r of findAll(root, 'w:r')) {
      const rPr = r.children.find((c) => c.name === 'w:rPr');
      const fam = rPr?.children.find((c) => c.name === 'w:rFonts')?.attrs['w:ascii'];
      if (!rPr || !fam) continue;
      const on = (n: string) => {
        const x = rPr.children.find((c) => c.name === n);
        return !!x && !['0', 'false', 'off'].includes(x.attrs['w:val'] ?? '');
      };
      const slot = on('w:b') ? (on('w:i') ? 'w:embedBoldItalic' : 'w:embedBold') : on('w:i') ? 'w:embedItalic' : 'w:embedRegular';
      usedStyles.set(fam, (usedStyles.get(fam) ?? new Set()).add(slot));
    }
  }
  return { embedded, rFonts, fontNames, usedStyles };
}

const norm = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

describe.each([
  ['kanonik', canonicalTemplate],
  ['benchmark manual000', benchmarkTemplate],
] as const)('fon tertanam DOCX, profil %s', (name, load) => {
  let pkg: Pkg;
  beforeAll(async () => {
    pkg = await renderPkg(await load());
  }, 120_000);

  it('ada fon tertanam dan setiap odttf pulih menjadi sfnt sah dengan kunci w:fontKey', () => {
    expect(pkg.embedded.length, name).toBeGreaterThan(0);
    for (const e of pkg.embedded) expect(e.sfntOk, `${e.font} ${e.slot}`).toBe(true);
  });

  // row42 SKIP S3 (U9.7, C31; studio spec §2 F; row 108 relabel twin engine/docx/fonts/relabel.ts): the relabelled
  // (modified IBM Plex) faces are not shipped, so Bold slots embed the standard SemiBold files whose nameID 1/16 is
  // "IBM Plex Serif SemiBold" and the benchmark "IBM Plex Sans Cond" alias is not built. This case asserts the
  // relabelled behaviour. The accepted risk is recorded in spec §2 F (Word may synthesise bold).
  it.skip('nama keluarga wajah tertanam (nameID 1 atau 16) = w:font/@w:name di SEMUA slot', () => {
    const bad = pkg.embedded
      .filter((e) => norm(e.family) !== norm(e.font) && norm(e.typoFamily) !== norm(e.font))
      .map((e) => `${e.font}/${e.slot} [${e.family} | ${e.typoFamily}]`);
    expect(bad).toEqual([]);
  });

  it('setiap keluarga w:rFonts (ascii/hAnsi) yang punya fon tertanam terdaftar di fontTable dengan nama persis', () => {
    const embeddedFamilies = new Set(pkg.embedded.map((e) => e.font));
    expect([...embeddedFamilies].filter((f) => !pkg.fontNames.has(f))).toEqual([]);
    // Minimal satu keluarga yang dipakai teks punya wajah tertanam (dokumen mandiri dari fon terpasang).
    expect([...pkg.rFonts].some((f) => embeddedFamilies.has(f))).toBe(true);
  });

  // D-109: profil kanonik juga harus MEMAKAI wajah tebal tertanam (dokumen mandiri dari fon
  // terpasang). Bila slot bold keluarga yang dipakai teks tidak ditanam, LibreOffice memakai
  // fon terpasang di mesin (temuan S72-F1 bila merah).
  it('setiap kombinasi keluarga+gaya yang dipakai run (w:b/w:i) punya slot tertanam yang sesuai, untuk keluarga yang ditanam', () => {
    const bySlot = new Map<string, Set<string>>();
    for (const e of pkg.embedded) bySlot.set(e.font, (bySlot.get(e.font) ?? new Set()).add(e.slot));
    const missing = [...pkg.usedStyles]
      .filter(([font]) => bySlot.has(font))
      .flatMap(([font, styles]) => [...styles].filter((slot) => !bySlot.get(font)!.has(slot)).map((slot) => `${font}: ${slot}`))
      .sort();
    expect(missing).toEqual([]);
  });
});

// row42 SKIP S3 (U9.7, C31; row 108 relabel twin): the "IBM Plex Sans Cond" relabelled family is not built in Swarm.
describe.skip('benchmark: IBM Plex Sans Cond (F-049, D-104/D-109)', () => {
  it('IBM Plex Sans Cond ditanam di 4 slot dengan nama keluarga persis "IBM Plex Sans Cond"', async () => {
    const pkg = await renderPkg(await benchmarkTemplate());
    const cond = pkg.embedded.filter((e) => e.font === 'IBM Plex Sans Cond');
    expect(cond.map((e) => e.slot).sort()).toEqual([...SLOTS].sort());
    for (const e of cond) expect([e.family, e.typoFamily], e.slot).toContain('IBM Plex Sans Cond');
  }, 120_000);
});
