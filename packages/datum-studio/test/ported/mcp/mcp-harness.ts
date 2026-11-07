// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/mcp/mcp-harness.ts (see test/ported/README.md).
// Harness bersama uji server MCP Studio (MCP-01, dipindah dari mcp-server.test.ts pada MCP-04): fs memori
// yang mencatat setiap tulis dan setiap panggilan (spy M-2), server Studio tiruan (R3 berkeadaan + rute baca),
// dan klien SDK lewat InMemoryTransport.
/* eslint-disable @typescript-eslint/no-explicit-any -- jawaban JSON-RPC/structuredContent bebas bentuk */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { HttpFetch } from '../../../vendor/scripts/studio/_http-client';
import { loadConfig, type StudioMcpConfig } from '../../../vendor/scripts/studio/mcp/config';
import type { NodeFs } from '../../../vendor/scripts/studio/mcp/safety';
import { createStudioMcpServer } from '../../../vendor/scripts/studio/mcp/server';
import { DOC, FINAL, MD, MISSION, statefulServer } from '../draft/r3-stateful-harness';

export const SECRET = 'rahasia-uji-mcp01-JANGAN-TERCETAK-7f3a';
export const BASE = 'http://127.0.0.1:9021';
export const ROOT = path.resolve('/mcp-uji-root');
export const OUTSIDE = path.resolve('/di-luar-akar');
export const FILE_ID = 'cmvvfile0000000000000r3f2a';

/** fs memori: mencatat setiap tulis (bukti nol tulis) dan setiap panggilan (spy: nol panggilan fs untuk UNC). */
export function memNodeFs(files: Record<string, string> = {}, dirs: string[] = [ROOT]) {
  const store = new Map<string, Buffer>(Object.entries(files).map(([k, v]) => [path.resolve(k), Buffer.from(v, 'utf8')]));
  const dirSet = new Set(dirs.map((d) => path.resolve(d)));
  const writes: string[] = [];
  const calls: string[] = [];
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const nfs: NodeFs = {
    realpath: (p) => {
      calls.push(`realpath ${p}`);
      return path.resolve(p);
    },
    exists: (p) => {
      calls.push(`exists ${p}`);
      return store.has(path.resolve(p)) || dirSet.has(path.resolve(p));
    },
    stat: (p) => {
      calls.push(`stat ${p}`);
      const r = path.resolve(p);
      if (store.has(r)) return { isFile: true, isDirectory: false, size: store.get(r)!.length };
      if (dirSet.has(r)) return { isFile: false, isDirectory: true, size: 0 };
      throw enoent();
    },
    readFile: (p) => {
      calls.push(`readFile ${p}`);
      const b = store.get(path.resolve(p));
      if (!b) throw enoent();
      return b;
    },
    writeFileExclusive: (p, d) => {
      calls.push(`wx ${p}`);
      writes.push(`wx ${p}`);
      if (store.has(path.resolve(p))) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      store.set(path.resolve(p), Buffer.from(d));
    },
    writeFileAtomic: (p, d) => {
      calls.push(`atomic ${p}`);
      writes.push(`atomic ${p}`);
      store.set(path.resolve(p), Buffer.from(d));
    },
    copyFileExclusive: (src, dest) => {
      calls.push(`copy ${src} ${dest}`);
      writes.push(`copy ${dest}`);
      const b = store.get(path.resolve(src));
      if (!b) throw enoent();
      if (store.has(path.resolve(dest))) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      store.set(path.resolve(dest), Buffer.from(b));
    },
    mkdirp: (p) => {
      calls.push(`mkdir ${p}`);
      writes.push(`mkdir ${p}`);
      dirSet.add(path.resolve(p));
    },
  };
  return { nfs, writes, calls, store, read: (p: string) => store.get(path.resolve(p))?.toString('utf8') ?? null };
}

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  redirect: string;
  body?: any;
}

export function reply(r: { status: number; body?: unknown; headers?: Record<string, string>; bytes?: Buffer }) {
  const h = new Map(Object.entries({ 'x-correlation-id': `cid-srv-${Math.random().toString(16).slice(2, 10)}`, ...(r.headers ?? {}) }));
  return {
    status: r.status,
    headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null },
    text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)),
    arrayBuffer: async () => {
      const b = r.bytes ?? Buffer.alloc(0);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
  };
}

type Extra = Record<string, (c: Call) => { status: number; body?: unknown; headers?: Record<string, string>; bytes?: Buffer } | undefined>;

/** Rute baca tambahan + 3xx/galat, lalu jatuh ke server berkeadaan R3. */
export function studioMock(extra: Extra = {}) {
  const s = statefulServer(MD());
  const calls: Call[] = [];
  const f: HttpFetch = async (url, init) => {
    const c: Call = { method: init.method, url, headers: init.headers, redirect: init.redirect, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}`;
    const h = extra[key]?.(c);
    if (h === undefined) {
      if (key === 'POST /api/studio/validate') return reply({ status: 200, body: { valid: true, issues: [] } });
      // MCP-D4 M-2: pra-cek studio_report_submit (GET R04 ?mission=&docKey=): bawaan = laporan belum ada.
      if (key === 'GET /api/studio/documents') return reply({ status: 200, body: { documents: [], nextCursor: null } });
      if (key === `GET /api/studio/documents/${DOC}`) {
        return reply({
          status: 200,
          body: {
            document: { id: DOC, docNumber: '040/GSP/LAP/XI/2026', title: 'Laporan', currentRevisionNo: s.rev(), templateId: 'tpl', hermesTaskId: null },
            revision: { revisionNo: s.rev(), snapshotSha256: 'a'.repeat(64) },
            tree: { big: true },
            slots: [{ slotKey: 'record' }],
            completeness: { status: 'COMPLETE', slots: [{ big: 1 }] },
            outputs: [{ id: FILE_ID, format: 'HTML', finalFileName: FINAL, relPath: 'docs/x/y.html', mime: 'text/html' }],
            lint: { verdict: 'PASS', findings: Array.from({ length: 50 }, (_, i) => ({ rule: `R${i}`, message: 'x'.repeat(100) })) },
          },
        });
      }
      return s.f(url, init);
    }
    return reply(h);
  };
  return { f, calls, s };
}

/** Log stderr server per uji (dikosongkan di beforeEach). */
export const logs: string[] = [];

export async function connect(o: { fetch?: HttpFetch; nfs?: NodeFs; config?: Partial<StudioMcpConfig>; env?: Record<string, string> } = {}) {
  const config: StudioMcpConfig = { ...loadConfig({ INTERNAL_API_SECRET: SECRET, STUDIO_BASE_URL: BASE, STUDIO_MCP_FILE_ROOTS: ROOT, ...(o.env ?? {}) }, ROOT), ...o.config };
  // row42 W12 (row 29 _repo-alias twin): REPO_ROOT comes from the host env STUDIO_VENDOR_ROOT, read once at first import
  // (fail closed to /var/empty). The clone derived it from the repo; here the server's own repoRoot seam gets the vendor root.
  const server = createStudioMcpServer({ config, fetchImpl: o.fetch ?? (async () => Promise.reject(new Error('jaringan tidak boleh dipanggil'))), nfs: o.nfs ?? memNodeFs().nfs, log: (l) => logs.push(l), repoRoot: path.resolve(__dirname, '..', '..', '..', 'vendor') });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'uji-mcp01', version: '0.0.1' });
  await client.connect(ct);
  const outputs: string[] = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    outputs.push(JSON.stringify(r));
    return { ...r, data: r.structuredContent, text: r.content?.[0]?.text as string, bytes: Buffer.byteLength(JSON.stringify(r)) };
  };
  return { client, call, outputs };
}

export const NEW_MD = MD({ basis: null }).replace(`mission: ${MISSION}`, 'mission: 2026-11-01_mcp01').replace(/docKey: .*/, 'docKey: lapkerja-mcp01-uji');
