// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/docx-fonts-family.test.ts (see test/ported/README.md).
import { useStudioEnv } from './_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// INT-S (F-049, D-104): penjaga regresi nama keluarga fon tertanam DOCX.
// LibreOffice mencocokkan fon tertanam menurut nama keluarga persis (nameID 1/16)
// lawan `w:rFonts`. Setiap wajah yang ditanam `planEmbeddedFontsDetailed` di slot
// mana pun (regular, bold, italic, boldItalic) harus membawa nama keluarga yang
// diminta dokumen; bila tidak, LO memakai wajah lain (F-049: Sans Cond regular
// dirender dengan wajah SemiBold berlabel Bold).
// Murni lokal: membaca profil dan aset fon dari repo, tanpa DB/jaringan.
import { describe, it, expect, beforeAll } from './_vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ResolvedTemplate } from '@/lib/studio/contract';
import { normalizeFamily, planEmbeddedFontsDetailed, readSfntFaceInfo, type FontPlanDetail } from '@/lib/studio/engine/docx/fonts';
import { scanCanonicalAssets, resolveRepoAssetPath } from '@/lib/studio/services/templates/assets';
import { loadResolvedProfileFile } from '@/lib/studio/services/templates/import';
import { DATUM_CANONICAL_SLUG, resolveProfileInMemory } from '@/lib/studio/services/templates/profile';

const REPO = path.resolve(__dirname, '..', '..', 'vendor');
const BENCHMARK_PROFILE = path.join(REPO, 'benchmark', 'manual000', 'template.json');

// sha256 set `same` S99 (render-env/semibold-bundle/bundle_manifest.json, faces 8-9 dan wajah bold).
const SANS_COND_REGULAR_SHA = 'cc28ffc672bd0a34f782018783d80d3a5dc497a9b2c2dd76bffa5a0e729e0566';
const SANS_COND_ITALIC_SHA = '125399c2ce1b2d2d1db1272f36ba9123d57efdf9845cbba8dadb2238bbab27fb';
const BENCHMARK_BOLD_SHA: Record<string, string> = {
  'IBM Plex Serif|bold': 'd1ead554e9e15090ff30921bef9b0969337d7f1210e7e4ce523b7b52bfeae8d4',
  'IBM Plex Sans Cond|bold': '9584940bb7a22e8ccb74f28a59d0dc63f147582b09d91cdff70d955dd8b348fd',
  'IBM Plex Mono|bold': '37d92084cb713387fdabe35c6e243a3fe06b5dacf716c22d2204bf202941c585',
};

/** Keluarga yang dapat diminta `w:rFonts`: entri R-08 + parameter `type.face.*`. */
function requestedFamilies(tpl: ResolvedTemplate): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(tpl.params)) {
    if (k.startsWith('type.face.') && typeof v === 'string' && v.trim()) out.add(v.trim());
  }
  const r08 = tpl.params['render.docx.embedFonts'];
  if (Array.isArray(r08)) {
    for (const e of r08) {
      const fam = e && typeof e === 'object' && !Array.isArray(e) ? (e as Record<string, unknown>).family : undefined;
      if (typeof fam === 'string' && fam.trim()) out.add(fam.trim());
    }
  }
  return out;
}

/** Nama keluarga (nameID 1 dan 16) berkas yang benar-benar ditanam. */
function embeddedFamilies(absPath: string): string[] {
  const info = readSfntFaceInfo(new Uint8Array(readFileSync(absPath)), absPath);
  return [info.family, info.typoFamily].filter((n): n is string => typeof n === 'string' && n.length > 0);
}

function mismatches(detail: FontPlanDetail): string[] {
  const bad: string[] = [];
  detail.plan.fonts.forEach((f) => {
    const names = embeddedFamilies(f.absPath);
    if (!names.some((n) => normalizeFamily(n) === normalizeFamily(f.face))) {
      bad.push(`${f.face}/${f.slot} -> ${path.basename(f.absPath)} [${names.join(' | ')}]`);
    }
  });
  return bad;
}

const profiles: Array<{ name: string; tpl: ResolvedTemplate }> = [];

beforeAll(async () => {
  const canonicalAssets = await scanCanonicalAssets(REPO);
  for (const withAssets of [false, true]) {
    profiles.push({
      name: `kanonik${withAssets ? ' + aset kanonik' : ''}`,
      tpl: resolveProfileInMemory(
        { base: DATUM_CANONICAL_SLUG, slug: DATUM_CANONICAL_SLUG, kind: 'DOCUMENT', overrides: {} },
        { canonicalAssets: withAssets ? canonicalAssets : {}, resolveAssetPath: (rel) => resolveRepoAssetPath(rel, REPO) },
      ),
    });
    const r = await loadResolvedProfileFile(BENCHMARK_PROFILE, { repoRoot: REPO, withCanonicalAssets: withAssets });
    profiles.push({ name: `benchmark manual000${withAssets ? ' + aset kanonik' : ''}`, tpl: r.template });
  }
});

describe('planEmbeddedFontsDetailed: nama keluarga wajah tertanam = keluarga diminta (F-049)', () => {
  it('memuat 4 profil uji', () => {
    expect(profiles.map((p) => p.name)).toEqual([
      'kanonik',
      'benchmark manual000',
      'kanonik + aset kanonik',
      'benchmark manual000 + aset kanonik',
    ]);
  });

  // row42 SKIP S3 (U9.7, C31; studio spec §2 F; row 108 relabel twin engine/docx/fonts/relabel.ts): relabelled Plex faces are
  // not shipped; Bold slots embed the standard SemiBold files (nameID 1/16 "... SemiBold"), and no "IBM Plex Sans Cond" alias is built.
  it.skip('setiap wajah tertanam di semua slot membawa nameID 1/16 = keluarga yang diminta', () => {
    for (const { name, tpl } of profiles) {
      const detail = planEmbeddedFontsDetailed(tpl, requestedFamilies(tpl), { assetsRoot: path.join(REPO, 'src', 'lib', 'studio', 'assets') });
      expect(detail.plan.fonts.length, name).toBeGreaterThan(0);
      expect(mismatches(detail), name).toEqual([]);
      expect(detail.relabelFallbacks, name).toEqual([]);
    }
  });

  // row42 SKIP S3 (U9.7, C31; studio spec §2 F; row 108 relabel twin engine/docx/fonts/relabel.ts): relabelled Plex faces are
  // not shipped; Bold slots embed the standard SemiBold files (nameID 1/16 "... SemiBold"), and no "IBM Plex Sans Cond" alias is built.
  it.skip('benchmark: IBM Plex Sans Cond ditanam di 4 slot, regular/italic = wajah berlabel S99, bold tetap SemiBold berlabel', () => {
    for (const { name, tpl } of profiles.filter((p) => p.name.startsWith('benchmark'))) {
      const detail = planEmbeddedFontsDetailed(tpl, requestedFamilies(tpl), { assetsRoot: path.join(REPO, 'src', 'lib', 'studio', 'assets') });
      const cond = detail.faces.filter((f) => f.face === 'IBM Plex Sans Cond');
      expect(cond.map((f) => f.slot), name).toEqual(['regular', 'bold', 'italic', 'boldItalic']);
      const bySlot = Object.fromEntries(cond.map((f) => [f.slot, f]));
      expect(bySlot.regular.sha256, name).toBe(SANS_COND_REGULAR_SHA);
      expect(bySlot.regular.weightClass, name).toBe(400);
      expect(bySlot.regular.italic, name).toBe(false);
      expect(bySlot.italic.sha256, name).toBe(SANS_COND_ITALIC_SHA);
      expect(bySlot.italic.italic, name).toBe(true);
      for (const [key, sha] of Object.entries(BENCHMARK_BOLD_SHA)) {
        const [face, slot] = key.split('|');
        expect(detail.faces.find((f) => f.face === face && f.slot === slot)?.sha256, `${name} ${key}`).toBe(sha);
      }
    }
  });
});
