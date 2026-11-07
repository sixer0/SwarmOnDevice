// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/structure/fixhr3-d16-rail-authority.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture dokumen kontrak dibaca bebas-bentuk di uji */
// FIX-HR3 (D-332 C3): D16 hanya menjadikan syarat rel bukti NOT_APPLICABLE bila
// `device.evidenceRail.enabled = false` berasal dari lapis yang dikendalikan ADMIN
// (preset/templat ADMIN untuk kunci lapis lanjutan, atau templat terbatas D-98).
// Bila USER dapat mematikan rel sendiri, D16 tetap ketat (konten tanpa rel = FAIL)
// dengan pesan yang menjelaskan alasannya. Jalur override dokumen ikut dilindungi.
//
// Klasifikasi registri saat ini: P4S-07 kelas B, lapis `advanced` (hanya ADMIN).
// Kasus "USER dapat mematikannya" disimulasikan dengan menaikkan lapis kunci ke
// `essential` di registri selama satu uji (dipulihkan di `finally`), yaitu skenario
// reklasifikasi yang harus otomatis membuat D16 kembali ketat.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, ParamSurface, ResolvedTemplate, StudioDocV1 } from '@/lib/studio/contract';
import { lintStructure } from '@/lib/studio/engine/lint/structure';
import { EVIDENCE_RAIL_ENABLED_KEY, evidenceRailOffAuthority, isUserWritableParam } from '@/lib/studio/engine/lint/structure/checks-d';
import { PARAMS_BY_KEY } from '@/lib/studio/params';
import { ESSENTIAL_KNOBS } from '@/lib/studio/registry/essentials';
import { gateInlineDocOverrides } from '@/lib/studio/services/render/common';
import { checkTemplateWrite, type ParamChange } from '@/lib/studio/services/skeleton/access';
import { canonicalTemplate, makeDoc, snapshotOf, withParams } from '../engine-core/fixtures';
import { catchEngine } from './_kit';

const KEY = EVIDENCE_RAIL_ENABLED_KEY;
const USER = { kind: 'USER_SESSION' as const };
const ADMIN = { kind: 'ADMIN_SESSION' as const };
/** Profil efektif yang melepas cek penolak G1 = templat terbatas D-98. */
const RESTRICTED = { 'lint.enforcementOverride': { G1: 'report' } };

/** Jalankan `fn` dengan lapis kunci rel disetel sementara (simulasi reklasifikasi registri). */
function withSurface<T>(surface: ParamSurface, fn: () => T): T {
  const def = PARAMS_BY_KEY.get(KEY) as { surface: ParamSurface | undefined } | undefined;
  if (!def) throw new Error(`kunci ${KEY} tidak ada di registri`);
  const prev = def.surface;
  def.surface = surface;
  try {
    return fn();
  } finally {
    def.surface = prev;
  }
}

let KAN: ResolvedTemplate;
beforeAll(() => {
  KAN = canonicalTemplate();
});

/** Templat dengan rencana SERAH yang mewajibkan/terlarang rel (isolasi aturan F5). */
function planTpl(entry: { required: string[]; forbidden: string[] }, params: Record<string, unknown> = {}): ResolvedTemplate {
  const base = withParams(KAN, params);
  const sectionPlan = { ...(base.sectionPlan as any), SERAH: { required: entry.required, optional: [], forbidden: entry.forbidden } };
  return { ...base, sectionPlan } as ResolvedTemplate;
}
function serahDoc(opts: { rail?: boolean; overrides?: Record<string, unknown> } = {}): NormDocSnapshot {
  const doc = makeDoc({ tier: 'SERAH' }) as any;
  if (opts.rail) {
    const para = doc.chapters[0].blocks?.find((b: any) => b.type === 'paragraph') ?? doc.chapters[0].sections?.[0]?.blocks?.find((b: any) => b.type === 'paragraph');
    para.rail = [{ kind: 'mark', mark: 'TERUKUR' }];
  }
  if (opts.overrides) doc.overrides = opts.overrides;
  return snapshotOf(doc as StudioDocV1);
}
const d16 = (snap: NormDocSnapshot, tpl: ResolvedTemplate) => lintStructure(snap, tpl, 'SERAH').filter((i) => i.checkId === 'D16');
const railFails = (issues: ReturnType<typeof d16>) => issues.filter((i) => i.status === 'FAIL' && /"evidenceRail"/.test(i.detail ?? ''));
const REQUIRED = { required: ['chapter', 'evidenceRail'], forbidden: [] };

describe('registri: kelas kunci device.evidenceRail.enabled (USER tidak dapat mengubahnya)', () => {
  it('P4S-07 kelas B, lapis advanced, tanpa kenop esensial yang menulisnya', () => {
    const d = PARAMS_BY_KEY.get(KEY)!;
    expect({ id: d.id, class: d.class, surface: d.surface, default: d.default }).toEqual({ id: 'P4S-07', class: 'B', surface: 'advanced', default: true });
    expect(ESSENTIAL_KNOBS.filter((k) => k.keys.includes(KEY))).toEqual([]);
    expect(isUserWritableParam(KEY)).toBe(false);
  });

  it('kenop USER "Rel bukti" (EK-G08) hanya menulis layout.railMode, yang tidak melonggarkan D16', () => {
    const knob = ESSENTIAL_KNOBS.find((k) => k.id === 'EK-G08')!;
    expect(knob.keys).toEqual(['layout.railMode']);
    expect(isUserWritableParam('layout.railMode')).toBe(true);
    const issues = d16(serahDoc(), planTpl(REQUIRED, { 'layout.railMode': 'B' }));
    expect(railFails(issues)).toHaveLength(1);
  });

  it('kunci tidak dikenal registri dianggap dapat ditulis USER (gagal tertutup)', () => {
    expect(isUserWritableParam('device.bogus.enabled')).toBe(true);
  });

  it('jalur tulis templat: USER 403 PARAM_SURFACE_FORBIDDEN, ADMIN boleh', () => {
    const c = [{ key: KEY, value: false, previous: true } as ParamChange];
    const e = catchEngine(() => checkTemplateWrite(USER, { isPreset: false, restricted: false, slug: 'tpl-user' }, c));
    expect(e.code).toBe('PARAM_SURFACE_FORBIDDEN');
    expect(() => checkTemplateWrite(ADMIN, { isPreset: false, restricted: false, slug: 'tpl-admin' }, c)).not.toThrow();
  });

  it('jalur override dokumen (render inline): kunci dikupas untuk USER walau kebijakan allow, dipertahankan untuk ADMIN', () => {
    const base = withParams(KAN, { 'ingest.inlineFormat': 'allow' });
    const doc = { ...(makeDoc({ tier: 'SERAH' }) as any), overrides: { [KEY]: false } } as StudioDocV1;
    const u = gateInlineDocOverrides(base, doc, USER, { trusted: true, pointer: '' });
    expect(u.stripped).toEqual([`/overrides/${KEY}`]);
    expect(u.doc.overrides?.[KEY]).toBeUndefined();
    const a = gateInlineDocOverrides(base, doc, ADMIN, { trusted: true, pointer: '' });
    expect(a.stripped).toEqual([]);
    expect(a.doc.overrides?.[KEY]).toBe(false);
  });
});

describe('D16: rel mati dari lapis ADMIN = NOT_APPLICABLE', () => {
  it('preset/templat ADMIN mematikan rel (kunci lanjutan) = PASS NOT_APPLICABLE dengan asal', () => {
    const issues = d16(serahDoc(), planTpl(REQUIRED, { [KEY]: false }));
    expect(issues.map((i) => i.status)).toEqual(['PASS']);
    expect(issues[0].detail).toContain('evidenceRail NOT_APPLICABLE');
    expect(issues[0].detail).toContain(`${KEY} = false`);
    expect(issues[0].detail).toContain('preset atau templat yang disimpan ADMINISTRATOR');
    expect(issues[0].detail).toContain('hanya ADMINISTRATOR yang dapat mengubahnya');
  });

  it('templat terbatas D-98 mematikan rel = NOT_APPLICABLE, juga bila kunci dapat ditulis USER', () => {
    withSurface('essential', () => {
      expect(isUserWritableParam(KEY)).toBe(true);
      const issues = d16(serahDoc(), planTpl(REQUIRED, { [KEY]: false, ...RESTRICTED }));
      expect(issues.map((i) => i.status)).toEqual(['PASS']);
      expect(issues[0].detail).toContain('evidenceRail NOT_APPLICABLE');
      expect(issues[0].detail).toContain('templat terbatas D-98 (melepas G1)');
    });
  });

  it('override dokumen (hanya pemanggil tepercaya) pada kunci lanjutan = NOT_APPLICABLE dengan asal override', () => {
    const issues = d16(serahDoc({ overrides: { [KEY]: false } }), planTpl(REQUIRED, { [KEY]: false }));
    expect(issues.map((i) => i.status)).toEqual(['PASS']);
    expect(issues[0].detail).toContain('override dokumen pemanggil tepercaya (KD-26)');
  });
});

describe('D16: rel mati dari lapis yang dapat diubah USER = tetap ketat', () => {
  it('templat USER mematikan rel (kunci esensial, tidak terbatas) + wajib + tanpa rel = FAIL dengan penjelasan', () => {
    withSurface('essential', () => {
      const issues = d16(serahDoc(), planTpl(REQUIRED, { [KEY]: false }));
      const fails = railFails(issues);
      expect(fails).toHaveLength(1);
      expect(fails[0].detail).toMatch(/^section wajib tier SERAH "evidenceRail" tidak ada \(Tabel 3\.2\); rel bukti dimatikan templat/);
      expect(fails[0].detail).toContain('dapat diubah USER dan templat tidak terbatas D-98');
      expect(fails[0].detail).toContain('tambahkan baris rel');
      expect(issues.some((i) => (i.detail ?? '').includes('NOT_APPLICABLE'))).toBe(false);
    });
  });

  it('templat USER mematikan rel + rel terlarang + konten memuat rel = FAIL (tidak dikecualikan)', () => {
    withSurface('essential', () => {
      const issues = d16(serahDoc({ rail: true }), planTpl({ required: ['chapter'], forbidden: ['evidenceRail'] }, { [KEY]: false }));
      const fails = issues.filter((i) => i.status === 'FAIL' && /"evidenceRail" terlarang/.test(i.detail ?? ''));
      expect(fails).toHaveLength(1);
      expect(fails[0].detail).toContain('dapat diubah USER');
    });
  });

  it('templat USER mematikan rel + konten memuat rel wajib = PASS biasa (tanpa NOT_APPLICABLE)', () => {
    withSurface('essential', () => {
      const issues = d16(serahDoc({ rail: true }), planTpl(REQUIRED, { [KEY]: false }));
      expect(issues.map((i) => i.status)).toEqual(['PASS']);
      expect(issues[0].detail).toMatch(/^2 section wajib tier SERAH ada/);
      expect(issues[0].detail).not.toContain('NOT_APPLICABLE');
    });
  });

  it('override dokumen pada kunci yang dapat ditulis USER = FAIL (asal tidak dapat dibuktikan tepercaya)', () => {
    withSurface('essential', () => {
      const fails = railFails(d16(serahDoc({ overrides: { [KEY]: false } }), planTpl(REQUIRED, { [KEY]: false })));
      expect(fails).toHaveLength(1);
      expect(fails[0].detail).toContain('rel bukti dimatikan override dokumen');
    });
  });

  it('helper asal: kunci esensial pada templat terbuka = adminControlled false', () => {
    withSurface('essential', () => {
      const a = evidenceRailOffAuthority({ params: { [KEY]: false } as any, doc: makeDoc({ tier: 'SERAH' }) });
      expect(a.adminControlled).toBe(false);
    });
    const b = evidenceRailOffAuthority({ params: { [KEY]: false } as any, doc: makeDoc({ tier: 'SERAH' }) });
    expect(b.adminControlled).toBe(true);
  });
});

describe('D16: rel menyala = ketat (tidak berubah)', () => {
  it('bawaan (menyala) + wajib + tanpa rel = FAIL tanpa catatan asal', () => {
    const fails = railFails(d16(serahDoc(), planTpl(REQUIRED)));
    expect(fails.map((f) => f.detail)).toEqual(['section wajib tier SERAH "evidenceRail" tidak ada (Tabel 3.2)']);
  });

  it('menyala eksplisit + terlarang + konten memuat rel = FAIL tanpa catatan asal', () => {
    const issues = d16(serahDoc({ rail: true }), planTpl({ required: ['chapter'], forbidden: ['evidenceRail'] }, { [KEY]: true }));
    expect(issues.filter((i) => i.status === 'FAIL').map((f) => f.detail)).toEqual([
      'section "evidenceRail" terlarang pada tier SERAH (tidak aktif atau tidak dapat dirender)',
    ]);
  });

  it('simulasi lapis dipulihkan setelah uji', () => {
    expect(PARAMS_BY_KEY.get(KEY)!.surface).toBe('advanced');
  });
});
