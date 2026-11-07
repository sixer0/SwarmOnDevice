// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/registry/dc06-contract-registry.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// DC-06 (D-367): registri kontrak — section type `contractRecord` (05 §6.1, AM-10), jenis slot
// (05 §6.2, AM-01, AM-11), registri jenis kontrak C58 (05 §1.2, §4, §6.3, §6.4, §16), validator
// kerangka CH-06 (05 §5.4), dan barel registri (D-368: chart.custom DC-26).
// Ekspektasi = literal register masterplan/05_document_contract_specs.md, BUKAN keluaran kode.
// Murni, tanpa DB.
import { describe, expect, it } from '../_vitest';
import {
  AGENT_WORK_REPORT_STATUSES,
  CARD_ID_PATTERN,
  CONTRACT_ACTOR_PATTERN,
  CONTRACT_EVIDENCE_KINDS,
  CONTRACT_ITEM_STATUSES,
  CONTRACT_KEY_PATTERN,
  CONTRACT_KINDS,
  CONTRACT_OUTLINE_KEYS,
  CONTRACT_REF_RELS,
  CONTRACT_REPORTED_AT_PATTERN,
  CONTRACT_VERDICTS,
  FINAL_FILENAME_PATTERN,
  SCHEMA_V2_CHECK_IDS,
} from '@/lib/studio/contract';
import * as registry from '@/lib/studio/registry';
import { CHART_CUSTOM_FORMS } from '@/lib/studio/registry/charts';
import {
  CONTRACT_KIND_DEFS,
  CONTRACT_RECORD_SECTION_TYPE,
  getContractKindDef,
  isContractKind,
  requiredOutlineChapterKeys,
} from '@/lib/studio/registry/contracts';
import { SECTION_REGISTRY, SECTION_REGISTRY_COUNT, SECTION_REGISTRY_GROUP_COUNTS, getSectionType } from '@/lib/studio/registry/sections';
import { contractRecordSkeletonIssues, SLOT_KIND_BY_TYPE, SLOT_KINDS, SLOT_SECTION_TYPES } from '@/lib/studio/registry/slots';
import { implicitSkeleton, validateSkeleton } from '@/lib/studio/services/skeleton/skeleton';
import { canonicalSectionPlan } from '@/lib/studio/services/templates/profile';

describe('section type contractRecord + pin hitungan (05 §6.1, AM-10)', () => {
  it('pin SECTION_REGISTRY_COUNT = panjang array = 52', () => {
    expect(SECTION_REGISTRY_COUNT).toBe(52);
    expect(SECTION_REGISTRY).toHaveLength(SECTION_REGISTRY_COUNT);
  });

  it('pin kelompok = hitungan nyata per grup: DOCUMENT 30, PAGE_DEVICE 7, CHANNEL 15', () => {
    expect(SECTION_REGISTRY_GROUP_COUNTS).toEqual({ DOCUMENT: 30, PAGE_DEVICE: 7, CHANNEL: 15 });
    for (const [group, n] of Object.entries(SECTION_REGISTRY_GROUP_COUNTS)) {
      expect(SECTION_REGISTRY.filter((s) => s.group === group), group).toHaveLength(n);
    }
    const sum = Object.values(SECTION_REGISTRY_GROUP_COUNTS).reduce((a, b) => a + b, 0);
    expect(sum).toBe(SECTION_REGISTRY_COUNT);
  });

  it('entri contractRecord sama persis dengan tabel 05 §6.1', () => {
    expect(getSectionType('contractRecord')).toEqual({
      key: 'contractRecord',
      catalogId: 'S30',
      group: 'DOCUMENT',
      register: 'INTERIOR',
      name: 'Catatan Kontrak',
      elements: ['status', 'penanggung jawab', 'rujukan tugas', 'waktu lapor', 'kartu', 'butir', 'bukti', 'rujukan dokumen'],
      paramRefs: [],
      ruleRefs: ['D-139', 'D-344'],
      // Register: semua tier. Deviasi DC-06 (needs-review): kosong agar rencana kanonik tidak
      // menurunkan slot implisit contractRecord untuk templat non-kontrak (lihat uji di bawah).
      activeTiers: [],
      renderable: true,
      sourceRef: 'register 05 §6.1',
    });
  });

  it('kunci dan catalogId registri tetap unik; S30 hanya dipakai contractRecord', () => {
    expect(new Set(SECTION_REGISTRY.map((s) => s.key)).size).toBe(SECTION_REGISTRY.length);
    expect(new Set(SECTION_REGISTRY.map((s) => s.catalogId)).size).toBe(SECTION_REGISTRY.length);
    expect(SECTION_REGISTRY.filter((s) => s.catalogId === 'S30').map((s) => s.key)).toEqual(['contractRecord']);
  });
});

describe('rencana kanonik dan kerangka implisit tidak memuat contractRecord (CH-06)', () => {
  it('canonicalSectionPlan: contractRecord terlarang di setiap tier; kerangka implisit tanpa slot record', () => {
    const plan = canonicalSectionPlan();
    for (const tier of ['NOTA', 'TERBIT', 'SERAH'] as const) {
      expect(plan[tier].forbidden, tier).toContain('contractRecord');
      expect(implicitSkeleton(plan, tier).slots.map((s) => s.sectionType), tier).not.toContain('contractRecord');
    }
  });
});

describe('jenis slot contractRecord (05 §6.2, AM-01, AM-11)', () => {
  it('C33 SLOT_SECTION_TYPES 8 -> 9 dan setiap jenis punya tepat satu SlotKindDef', () => {
    expect(SLOT_SECTION_TYPES).toHaveLength(9);
    expect(SLOT_SECTION_TYPES).toContain('contractRecord');
    expect(SLOT_KINDS.map((k) => k.sectionType).sort()).toEqual([...SLOT_SECTION_TYPES].sort());
    for (const t of SLOT_SECTION_TYPES) expect(getSectionType(t), t).toBeDefined();
  });

  it('aturan slot sama persis dengan 05 §6.2', () => {
    expect(SLOT_KIND_BY_TYPE.get('contractRecord')).toEqual({
      sectionType: 'contractRecord',
      contentModes: ['INPUT'],
      defaultContentMode: 'INPUT',
      repeatable: false,
      singlePerSkeleton: true,
      admitsAllowed: [],
      defaultAdmits: [],
      implicitSlotKey: 'record',
    });
  });
});

describe('registri jenis kontrak C58 (05 §1.2, §4, §6.3, §6.4)', () => {
  const def = getContractKindDef('agentWorkReport')!;

  it('satu entri per anggota E44; tahap 1 = agentWorkReport saja', () => {
    expect(CONTRACT_KINDS).toEqual(['agentWorkReport']);
    expect(CONTRACT_KIND_DEFS.map((d) => d.kind)).toEqual([...CONTRACT_KINDS]);
    expect(CONTRACT_KIND_DEFS.every((d) => d.stage === 'active')).toBe(true);
    expect(isContractKind('agentWorkReport')).toBe(true);
    for (const reserved of ['missionContract', 'phaseReport', 'waveBlueprint', 'completionReport', '', null, 7]) {
      expect(isContractKind(reserved), String(reserved)).toBe(false);
    }
  });

  it('templat CK-01: laporan-kerja-agen, NOTA, typeCode LAP (CQ-1), format bawaan HTML (C40)', () => {
    expect(def.templateSlug).toBe('laporan-kerja-agen');
    expect(def.tier).toBe('NOTA');
    expect(def.typeCode).toBe('LAP');
    expect(def.defaultFormats).toEqual(['HTML']);
  });

  it('kerangka SL-08..SL-10 (05 §6.3) dan setiap sectionType adalah jenis slot sah', () => {
    expect(def.skeleton).toEqual([
      { slotKey: 'record', sectionType: 'contractRecord', label: 'Catatan Laporan', required: true, repeatable: false },
      { slotKey: 'content', sectionType: 'chapter', label: 'Isi Laporan', required: true, repeatable: true },
      { slotKey: 'references', sectionType: 'sourceRegister', label: 'Referensi', required: false, repeatable: false },
    ]);
    for (const s of def.skeleton) {
      const kind = SLOT_KIND_BY_TYPE.get(s.sectionType);
      expect(kind, s.sectionType).toBeDefined();
      expect(s.repeatable && !kind!.repeatable, `${s.slotKey} berulang pada jenis tak berulang`).toBe(false);
    }
  });

  it('outline wajib 5 bab E50 (CO-01..CO-05, 05 §4.4); kunci bab numerik C33a', () => {
    expect(def.outline).toEqual([
      { chapterKey: '1', outlineKey: 'ringkasan', title: 'Ringkasan', required: true },
      { chapterKey: '2', outlineKey: 'rincian', title: 'Rincian kerja', required: true },
      { chapterKey: '3', outlineKey: 'bukti', title: 'Bukti', required: true },
      { chapterKey: '4', outlineKey: 'isu', title: 'Isu terbuka', required: true },
      { chapterKey: '5', outlineKey: 'lanjut', title: 'Langkah berikut', required: true },
    ]);
    expect(def.outline.map((o) => o.outlineKey)).toEqual([...CONTRACT_OUTLINE_KEYS]);
    for (const o of def.outline) expect(o.chapterKey).toMatch(/^[1-9][0-9]{0,2}$/);
    expect(requiredOutlineChapterKeys('agentWorkReport')).toEqual(['1', '2', '3', '4', '5']);
    expect(requiredOutlineChapterKeys('missionContract')).toEqual([]);
  });

  it('set status persis register E45 (CS-01..CS-05, 05 §4.1) beserta label', () => {
    expect(def.statuses).toEqual([
      { code: 'draft', label: 'Draf' },
      { code: 'complete', label: 'Selesai' },
      { code: 'partial', label: 'Sebagian' },
      { code: 'blocked', label: 'Terhambat' },
      { code: 'needs-review', label: 'Perlu tinjauan' },
    ]);
    expect(def.statuses.map((s) => s.code)).toEqual([...AGENT_WORK_REPORT_STATUSES]);
  });

  it('status butir E46 (CI-01..CI-07) dan vonis E47 (CD-01..CD-04, label = kode)', () => {
    expect(def.itemStatuses).toEqual([
      { code: 'todo', label: 'Belum mulai' },
      { code: 'ready', label: 'Siap' },
      { code: 'running', label: 'Berjalan' },
      { code: 'review', label: 'Ditinjau' },
      { code: 'done', label: 'Selesai' },
      { code: 'blocked', label: 'Terhambat' },
      { code: 'cancelled', label: 'Dibatalkan' },
    ]);
    expect(def.itemStatuses.map((s) => s.code)).toEqual([...CONTRACT_ITEM_STATUSES]);
    expect(def.verdicts).toEqual(['PASS', 'CAUTION', 'FAIL', 'NEEDS_REVIEW'].map((c) => ({ code: c, label: c })));
    expect(def.verdicts.map((s) => s.code)).toEqual([...CONTRACT_VERDICTS]);
  });

  it('rel rujukan E48, jenis bukti E49, pola C34-C37 + C51, batas C39', () => {
    expect(def.refRels).toEqual(['basis', 'evidence', 'output', 'supersedes']);
    expect(def.refRels).toEqual([...CONTRACT_REF_RELS]);
    expect(def.evidenceKinds).toEqual(['file', 'command', 'commit', 'correlation']);
    expect(def.evidenceKinds).toEqual([...CONTRACT_EVIDENCE_KINDS]);
    expect(def.patterns).toEqual({
      cardId: CARD_ID_PATTERN,
      key: CONTRACT_KEY_PATTERN,
      actor: CONTRACT_ACTOR_PATTERN,
      reportedAt: CONTRACT_REPORTED_AT_PATTERN,
      finalFileName: FINAL_FILENAME_PATTERN,
    });
    expect(def.patterns.cardId).toBe('^t_[0-9a-f]{8}$');
    expect(def.limits).toEqual({ cardIds: 64, items: 500, dependsOn: 32, refs: 100, evidence: 200, refText: 500 });
  });

  it('label medan dan kolom tabel (05 §6.4)', () => {
    expect(def.labels.fields).toEqual({
      status: 'Status',
      verdict: 'Vonis',
      owner: 'Penanggung jawab',
      initiator: 'Pemberi tugas',
      taskRef: 'Rujukan tugas',
      reportedAt: 'Waktu lapor',
      due: 'Tenggat',
      phase: 'Fase',
      cardIds: 'Kartu',
    });
    expect(def.labels.itemColumns).toEqual(['Kunci', 'Judul', 'Status', 'Penanggung jawab', 'Fase', 'Tenggat', 'Bergantung pada']);
    expect(def.labels.evidenceColumns).toEqual(['Jenis', 'Rujukan', 'sha256', 'Ukuran', 'Baris', 'Kode keluar', 'Butir', 'Catatan']);
    expect(def.labels.refColumns).toEqual(['Hubungan', 'Dokumen', 'Paragraf', 'Revisi']);
  });
});

describe('alias generator (05 §16)', () => {
  const a = getContractKindDef('agentWorkReport')!.aliases;

  it('GA-01..GA-54: 54 judul; tujuan hanya bab CO 1..5 atau slot references; contoh per bab', () => {
    expect(Object.keys(a.headings)).toHaveLength(54);
    const allowed = new Set(['content:1', 'content:2', 'content:3', 'content:4', 'content:5', 'references']);
    for (const [h, t] of Object.entries(a.headings)) expect(allowed.has(t), `${h} -> ${t}`).toBe(true);
    expect(a.headings['ringkasan']).toBe('content:1');
    expect(a.headings['putusan']).toBe('content:1');
    expect(a.headings['strategi uji']).toBe('content:2');
    expect(a.headings['cara menjalankan']).toBe('content:3');
    expect(a.headings['analisis cakupan dan celah']).toBe('content:4');
    expect(a.headings['catatan ci']).toBe('content:5');
    expect(a.headings['N referensi']).toBe('references');
    const perTarget = (t: string) => Object.values(a.headings).filter((v) => v === t).length;
    expect([1, 2, 3, 4, 5].map((n) => perTarget(`content:${n}`))).toEqual([10, 11, 14, 12, 5]);
    expect(perTarget('references')).toBe(2);
  });

  it('GL-01..GL-11 label baris; ARTEFAK juga ke evidence[]; STATUS ke status', () => {
    expect(a.lineLabels).toEqual({
      'RINGKAS:': 'content:1',
      'JALUR:': 'content:2',
      'ARTEFAK:': 'content:3+evidence',
      'HAMBAT:': 'content:4',
      'LIMIT:': 'content:4',
      'RENCANA:': 'content:5',
      'ESTIMASI:': 'content:5',
      'STATUS:': 'status',
      'CATATAN:': 'content:2',
      'GERBANG:': 'content:3',
      'RUJUKAN:': 'content:3',
    });
  });

  it('GF-01..GF-11 kunci kepala -> medan CF', () => {
    expect(a.headerKeys).toEqual({
      status: 'status',
      agent: 'owner',
      profil: 'owner',
      writer: 'owner',
      date: 'reportedAt',
      tanggal: 'reportedAt',
      created: 'reportedAt',
      row: 'taskRef',
      task_id: 'taskRef',
      kartu: 'cardIds',
      verdict: 'verdict',
      vonis: 'verdict',
    });
  });

  it('GS/GI/GV: setiap tujuan anggota set tertutup; nilai sengaja tanpa alias tidak ditebak (CW-02)', () => {
    expect(a.statuses).toEqual({
      complete: 'complete',
      completed: 'complete',
      draft: 'draft',
      'working-draft': 'draft',
      partial: 'partial',
      'partial-handoff': 'partial',
      blocked: 'blocked',
      'needs-review': 'needs-review',
      perlu_revisi: 'needs-review',
    });
    expect(Object.keys(a.itemStatuses)).toHaveLength(12);
    expect(a.itemStatuses['sisa']).toBe('todo');
    expect(a.itemStatuses['closed-as-cancelled']).toBe('cancelled');
    expect(a.verdicts).toEqual({ PASS: 'PASS', CAUTION: 'CAUTION', FAIL: 'FAIL', NEEDS_REVIEW: 'NEEDS_REVIEW', 'NEEDS-REVIEW': 'NEEDS_REVIEW' });
    for (const v of Object.values(a.statuses)) expect(AGENT_WORK_REPORT_STATUSES).toContain(v);
    for (const v of Object.values(a.itemStatuses)) expect(CONTRACT_ITEM_STATUSES).toContain(v);
    for (const v of Object.values(a.verdicts)) expect(CONTRACT_VERDICTS).toContain(v);
    for (const no of ['usulan', 'active', 'milik', 'lihat', 'relevan', 'prov', 'all', 'closed', 'parked']) {
      expect(a.statuses[no], no).toBeUndefined();
      expect(a.itemStatuses[no], no).toBeUndefined();
    }
    for (const no of ['SETUJU', 'SAH-', 'PARTIAL', 'ALL_OK', 'DONE', 'pass']) expect(a.verdicts[no], no).toBeUndefined();
  });
});

describe('validator kerangka CH-06 SKELETON_CONTRACT_RECORD (05 §5.4)', () => {
  const ck01 = getContractKindDef('agentWorkReport')!.skeleton;
  const plain = [{ sectionType: 'chapter', repeatable: true }];

  it('checkId terdaftar di E41 (AM-04)', () => {
    expect(SCHEMA_V2_CHECK_IDS).toContain('SKELETON_CONTRACT_RECORD');
  });

  it('kerangka CK-01 dengan contractKind terdaftar lolos; kerangka non-kontrak lolos tanpa contractKind', () => {
    expect(contractRecordSkeletonIssues(ck01, 'agentWorkReport')).toEqual([]);
    expect(contractRecordSkeletonIssues(plain, null)).toEqual([]);
    expect(contractRecordSkeletonIssues(plain, undefined)).toEqual([]);
  });

  it('slot contractRecord pada templat tanpa contractKind -> CH-06 di pointer slot', () => {
    expect(contractRecordSkeletonIssues(ck01, null)).toEqual([
      expect.objectContaining({ pointer: '/template/skeleton/slots/0', checkId: 'SKELETON_CONTRACT_RECORD', keyword: 'dependentRequired' }),
    ]);
  });

  it('contractKind tidak terdaftar (mis. jenis dicadangkan) diperlakukan sama dengan tanpa contractKind', () => {
    const issues = contractRecordSkeletonIssues(ck01, 'missionContract');
    expect(issues.map((i) => [i.pointer, i.checkId])).toEqual([['/template/skeleton/slots/0', 'SKELETON_CONTRACT_RECORD']]);
  });

  it('lebih dari satu slot contractRecord -> CH-06 pada slot kedua', () => {
    const slots = [...ck01, { sectionType: CONTRACT_RECORD_SECTION_TYPE, repeatable: false }];
    expect(contractRecordSkeletonIssues(slots, 'agentWorkReport')).toEqual([
      expect.objectContaining({ pointer: '/template/skeleton/slots/3', checkId: 'SKELETON_CONTRACT_RECORD', keyword: 'maxContains' }),
    ]);
  });

  it('repeatable = true -> CH-06; pointerBase dapat diganti pemanggil', () => {
    const slots = [{ sectionType: 'contractRecord', repeatable: true }];
    expect(contractRecordSkeletonIssues(slots, 'agentWorkReport', '/slots')).toEqual([
      expect.objectContaining({ pointer: '/slots/0', checkId: 'SKELETON_CONTRACT_RECORD', keyword: 'const' }),
    ]);
  });

  it('validator kerangka bersama (SKELETON_*) menerima slot CK-01 dari registri slot', () => {
    const slots = ck01.map((s, i) => ({
      slotKey: s.slotKey,
      sectionType: s.sectionType,
      label: s.label,
      position: i + 1,
      required: s.required,
      positionLocked: s.slotKey === 'record',
      repeatable: s.repeatable,
      ...(s.repeatable ? { minItems: 1 } : {}),
      contentMode: 'INPUT' as const,
      tiers: [],
      admits: s.sectionType === 'chapter' ? [...(SLOT_KIND_BY_TYPE.get('chapter')!.defaultAdmits as string[])] : [],
      essentials: {},
    }));
    const out = validateSkeleton({ slots });
    expect(out.slots.map((s) => [s.slotKey, s.sectionType])).toEqual([
      ['record', 'contractRecord'],
      ['content', 'chapter'],
      ['references', 'sourceRegister'],
    ]);
  });

  it('validator kerangka bersama menolak contractRecord berulang (SKELETON_REPEATABLE) dan ganda (SKELETON_SECTION_TYPE)', () => {
    const base = { label: 'Catatan', required: true, positionLocked: false, contentMode: 'INPUT' as const, tiers: [], admits: [], essentials: {} };
    const ids = (slots: unknown[]) => {
      try {
        validateSkeleton({ slots } as never);
        return [];
      } catch (e) {
        return ((e as { details?: { issues?: Array<{ checkId?: string }> } }).details?.issues ?? []).map((i) => i.checkId);
      }
    };
    expect(ids([{ ...base, slotKey: 'record', sectionType: 'contractRecord', position: 1, repeatable: true }])).toContain('SKELETON_REPEATABLE');
    expect(
      ids([
        { ...base, slotKey: 'record', sectionType: 'contractRecord', position: 1, repeatable: false },
        { ...base, slotKey: 'record2', sectionType: 'contractRecord', position: 2, repeatable: false },
      ]),
    ).toContain('SKELETON_SECTION_TYPE');
  });
});

describe('barel registri (index.ts)', () => {
  it('mengekspor registri kontrak dan validator CH-06', () => {
    expect(registry.CONTRACT_KIND_DEFS).toBe(CONTRACT_KIND_DEFS);
    expect(typeof registry.getContractKindDef).toBe('function');
    expect(typeof registry.contractRecordSkeletonIssues).toBe('function');
  });

  it('D-368: mengekspor chart.custom milik DC-26', () => {
    expect(registry.CHART_CUSTOM_FORMS).toBe(CHART_CUSTOM_FORMS);
    expect(registry.CHART_CUSTOM_FORM_COUNT).toBe(registry.CHART_CUSTOM_FORMS.length);
    expect(registry.CHART_CUSTOM_FORM_IDS).toHaveLength(registry.CHART_CUSTOM_FORM_COUNT);
    expect(registry.CHART_CUSTOM_DATA_SHAPES).toEqual(['categorical', 'series', 'xy']);
    expect(typeof registry.resolveChartCustom).toBe('function');
  });
});
