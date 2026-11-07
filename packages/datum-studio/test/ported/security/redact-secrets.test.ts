// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/security/redact-secrets.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// FIX-SEC N-06 (SR-57, D-247): redactSecrets menyamarkan userinfo URL
// (`user:pass@`), seluruh nilai Authorization (Basic/Bearer/skema lain), dan
// kunci `pwd`; perilaku lama (Bearer, JWT, kunci rahasia, path profil) tetap.
// Semua nilai di bawah adalah contoh palsu khusus uji.
import { describe, expect, it } from '../_vitest';
import { REDACTED, redactSecrets, sanitizeJson, sanitizeRoute } from '@/lib/studio/http/sanitize';

const CASES: Array<{ label: string; input: string; leaks: string[]; keeps?: string[] }> = [
  {
    label: 'postgres URL user:pass@',
    input: 'connect failed postgresql://fakeuser:fakepass123@127.0.0.1:5432/db_x',
    leaks: ['fakeuser', 'fakepass123'],
    keeps: ['postgresql://[redacted]@127.0.0.1:5432/db_x'],
  },
  {
    label: 'https URL dengan token userinfo',
    input: 'clone https://ghp_FAKEtoken0000@github.example/x.git',
    leaks: ['ghp_FAKEtoken0000'],
    keeps: ['https://[redacted]@github.example/x.git'],
  },
  {
    label: 'URL userinfo tanpa kata sandi',
    input: 'redis://onlyuser@localhost:6379',
    leaks: ['onlyuser'],
  },
  {
    label: 'Authorization: Basic <b64>',
    input: 'header Authorization: Basic ZmFrZTpmYWtlcGFzcw== sent',
    leaks: ['ZmFrZTpmYWtlcGFzcw=='],
    keeps: ['Authorization: [redacted]', 'sent'],
  },
  {
    label: 'Authorization: Bearer <token>',
    input: 'Authorization: Bearer abc.def-ghi_FAKE',
    leaks: ['abc.def-ghi_FAKE'],
  },
  {
    label: 'authorization=Digest ... (skema lain)',
    input: 'authorization=Digest fakeDigestValue123',
    leaks: ['fakeDigestValue123'],
  },
  {
    label: 'Proxy-Authorization berkutip',
    input: 'Proxy-Authorization: "Basic ZmFrZTpwcm94eQ=="',
    leaks: ['ZmFrZTpwcm94eQ=='],
  },
  {
    label: 'Basic tanpa nama header',
    input: 'using Basic ZmFrZTpmYWtlcGFzcw== now',
    leaks: ['ZmFrZTpmYWtlcGFzcw=='],
  },
  {
    label: 'pwd= dan passphrase:',
    input: 'Server=x;Uid=u;pwd=FakePwd!9;passphrase: fakephrase',
    leaks: ['FakePwd!9', 'fakephrase'],
  },
  {
    label: 'Bearer lama tetap',
    input: 'got Bearer fakeBearer123 back',
    leaks: ['fakeBearer123'],
  },
  {
    label: 'JWT tetap',
    input: 'jwt eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl end',
    leaks: ['eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl'],
  },
  {
    label: 'password= tetap',
    input: 'password=FakeSecret1&next=/studio',
    leaks: ['FakeSecret1'],
    keeps: ['next=/studio'],
  },
  {
    label: 'path profil user tetap',
    input: 'at C:\\Users\\someone\\repo\\x.ts',
    leaks: ['someone'],
    keeps: ['%USERPROFILE%'],
  },
];

describe('redactSecrets N-06', () => {
  it.each(CASES)('$label', ({ input, leaks, keeps }) => {
    const out = redactSecrets(input);
    for (const l of leaks) expect(out).not.toContain(l);
    expect(out.includes(REDACTED) || out.includes('%USERPROFILE%')).toBe(true); // ada penanda
    for (const k of keeps ?? []) expect(out).toContain(k);
  });

  it('teks tanpa rahasia tidak berubah', () => {
    const s = 'render ok in 120 ms for /studio/documents/abc (Basic plan)';
    expect(redactSecrets(s)).toBe(s);
  });

  it('idempoten: menyamarkan dua kali = sekali', () => {
    for (const { input } of CASES) {
      const once = redactSecrets(input);
      expect(redactSecrets(once)).toBe(once);
    }
  });

  it('dipakai juga oleh sanitizeJson dan sanitizeRoute', () => {
    const j = sanitizeJson({ msg: 'db postgresql://u1:p1secret@h/db', pwd: 'x' }) as Record<string, string>;
    expect(j.msg).not.toContain('p1secret');
    expect(j.pwd).toBe(REDACTED);
    expect(sanitizeRoute('/x?pwd=abc&ok=1', 200)).toBe(`/x?pwd=${REDACTED}&ok=1`);
  });
});
