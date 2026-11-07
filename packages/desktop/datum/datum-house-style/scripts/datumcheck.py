#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
datumcheck.py — DATUM guard rails that fire at authoring time, not at lint time.

Why this exists
---------------
`datum_lint.py` is the release gate and it works. But it can only speak after a
document is fully built, so a single missing unit column costs a full rebuild, and
the author learns about it as "table 15" rather than as "Tabel 6.1 · Neraca Core".
Measured over one real engagement, eight documents took roughly five builds each;
most of the excess came from four checks that are decidable from the arguments
alone, before a single byte of OOXML is written.

This module makes those four checks fire at the call site, with the table's own
caption in the message. It shares its codes with `datum_lint.py` so nothing new
has to be learned.

Use it two ways.

1 · Inside a builder library, on every call:

       import datumcheck as ck
       def datatable(self, tid, caption, head, widths, rows, total=None, source=''):
           ck.table(tid, caption, head, widths, rows, source)   # raises on defect
           ...

2 · As a batch check over a whole document plan, before building anything:

       python3 datumcheck.py rencana.json

Checks implemented (codes match datum_lint.py)
   03  em-dash density and em-dash in a heading
   04  question-form heading
   09  data table carrying quantities with no unit column
   10  table with no SUMBER line
   16  value and unit not separated by a space
   N1  underscore in a folder, file, sheet, table id or engineering identifier
   G1  header/row arity mismatch          (new · catches a silent column shift)
   G2  column widths not summing to a legal measure
   G3  cell text long enough to be truncated by its column
"""

import re, sys, json

class DatumDefect(Exception):
    pass

MEASURE = {128, 166}          # DATUM §6 · text column and full span
TOL = 1.5                     # mm

_QTY  = re.compile(r'\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+,\d+')
# A unit column satisfies check 09 — and so does a unit carried in the column
# heading itself, e.g. 'Daya (W)'. The message has always offered both; before
# Rev I only the first was actually accepted, which forced a redundant Satuan
# column onto tables that were already correct.
_SATUAN = r'kVA|kWh|kW|MW|Mbps|Gbps|kbps|mm²|cm²|m²|m³|mm|cm|km|kg|ms|Hz|kHz|MHz|GHz|TB|GB|MB|dBi|dB|°C|Ω|VA|Wh|W|V|A|Rp|USD|m|s|%|px|ppm|lux|unit|ttk|ls|bh'
_UNIT = re.compile(r'satuan|unit|uom|\((?:' + _SATUAN + r')\)|'
                   r'\[(?:' + _SATUAN + r')\]', re.I)
_TANYA = re.compile(r'^(apa|apakah|mengapa|kenapa|bagaimana|siapa|kapan|di\s?mana|'
                    r'berapa|why|how|what|when|where|who)\b', re.I)
_NOSPC = re.compile(r'\d(m|km|mm|kg|kV|kVA|kW|dB|Hz|mA|°C|%)\b')

def _fail(code, where, msg):
    raise DatumDefect(f'[{code}] {where} — {msg}')

# ── individual guards ──────────────────────────────────────────────────────
def heading(text, where='judul'):
    if _TANYA.match(text.strip()):
        _fail('04', where, f'judul berbentuk pertanyaan: "{text}"')
    if '—' in text:
        _fail('03', where, f'em dash pada judul: "{text}"')
    return text

def prose(text, where='paragraf', budget=None):
    n = text.count('—')
    if budget is not None and n:
        budget['em'] = budget.get('em', 0) + n
        budget['w'] = budget.get('w', 0) + len(text.split())
        if budget['w'] > 400 and budget['em'] / budget['w'] * 1000 > 3:
            _fail('03', where, f"kepadatan em dash {budget['em']/budget['w']*1000:.1f} "
                               f"per 1.000 kata melampaui 3")
    if _NOSPC.search(text):
        _fail('16', where, f'nilai dan satuan tanpa spasi: '
                           f'"{_NOSPC.search(text).group(0)}"')
    return text

def table(tid, caption, head, widths, rows, source='', where=None):
    where = where or f'{tid} · {caption[:48]}'
    nama(tid, 'penanda tabel', where)
    ncol = len(head)

    if len(widths) != ncol:
        _fail('G1', where, f'{ncol} kolom kepala tetapi {len(widths)} lebar kolom')

    s = sum(widths)
    if not any(abs(s - m) <= TOL for m in MEASURE):
        _fail('G2', where, f'jumlah lebar kolom {s:g} mm bukan 128 mm maupun 166 mm')

    for i, r in enumerate(rows):
        if r and r[0] == '§':
            continue
        if len(r) != ncol:
            _fail('G1', where, f'baris ke-{i+1} berisi {len(r)} sel terhadap {ncol} kolom')

    body = ' '.join(str(c) for r in rows for c in r if not (r and r[0] == '§'))
    qty = len(_QTY.findall(body))
    hdr = ' | '.join(h[0] if isinstance(h, (list, tuple)) else str(h) for h in head)
    if len(rows) >= 3 and ncol >= 4 and qty >= 6 and not _UNIT.search(hdr):
        _fail('09', where, f'memuat {qty} besaran tetapi tidak ada kolom satuan. '
                           f'Tambahkan kolom Satuan, atau tulis satuannya pada judul kolom.')

    if not source:
        _fail('10', where, 'tabel tanpa baris SUMBER')

    # G3 · truncation risk: ±2,05 mm per character at 8,2 pt in the reading face
    for i, r in enumerate(rows):
        if r and r[0] == '§':
            continue
        for j, c in enumerate(r):
            if not isinstance(c, str):
                continue
            muat = widths[j] / 2.05 * 3          # three lines before it looks cramped
            if len(c) > muat:
                _fail('G3', where, f'sel baris {i+1} kolom {j+1} sepanjang {len(c)} '
                                   f'karakter pada kolom {widths[j]:g} mm; '
                                   f'perkirakan {int(muat)} karakter muat. '
                                   f'Lebarkan kolom atau potong pada batas kata.')
    return True

_USUB = re.compile(r'_')

def nama(s, jenis='berkas', where=None):
    """DATUM §14 · no underscore anywhere a human reads a name."""
    where = where or jenis
    if _USUB.search(str(s)):
        _fail('N1', where, f'{jenis} "{s}" memakai garis bawah. '
                           f'Ganti dengan spasi pada nama folder dan dokumen, '
                           f'atau tanda hubung pada kode dan nama lembar.')
    return s


def figure(fid, caption, width_mm, source='', apparatus=None, where=None):
    where = where or f'{fid} · {caption[:48]}'
    nama(fid, 'penanda gambar', where)
    if not any(abs(width_mm - m) <= TOL for m in MEASURE):
        _fail('G2', where, f'lebar gambar {width_mm:g} mm bukan 128 mm maupun 166 mm')
    if not source:
        _fail('10', where, 'gambar tanpa baris SUMBER')
    if apparatus == 'figure':
        _fail('36', where, 'gambar membawa apparatus sendiri sementara halaman juga '
                           'akan mencetaknya; setel apparatus "page" pada spesifikasi')
    return True

# ── batch mode ─────────────────────────────────────────────────────────────
def pohon(paths, quiet=False):
    """Periksa seluruh rencana pohon folder sebelum satu berkas pun ditulis.

    paths: daftar jalur relatif yang DIRENCANAKAN, misalnya
           ['05 Dokumen Terbit/Kajian Teknis 025-GSP-KT-VIII-2026.docx', ...]
    Mengembalikan daftar jalur yang melanggar §14. Kosong berarti aman.
    Berkas sumber Python dikecualikan, sesuai satu-satunya carve-out §14.
    """
    salah = []
    for p in paths:
        if p.endswith('.py'):
            continue
        for bagian in str(p).replace('\\', '/').split('/'):
            if '_' in bagian:
                salah.append(p)
                break
    if salah and not quiet:
        print(f'  ✗ [N1] {len(salah)} jalur memakai garis bawah:')
        for p in salah[:20]:
            print(f'        {p}')
        if len(salah) > 20:
            print(f'        … dan {len(salah)-20} lagi')
    elif not quiet:
        print(f'  ✓ [N1] {len(paths)} jalur bersih')
    return salah


def plan(path):
    p = json.load(open(path, encoding='utf-8'))
    n = 0
    for h in p.get('headings', []):
        heading(h); n += 1
    b = {}
    for t in p.get('prose', []):
        prose(t, budget=b); n += 1
    for t in p.get('tables', []):
        table(t['id'], t['caption'], t['head'], t['widths'], t['rows'],
              t.get('source', '')); n += 1
    for f in p.get('figures', []):
        figure(f['id'], f['caption'], f['width_mm'], f.get('source', ''),
               f.get('apparatus')); n += 1
    return n

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(0)
    try:
        n = plan(sys.argv[1])
        print(f'  ✓ datumcheck — {n} unsur bersih, aman dibangun')
    except DatumDefect as e:
        print(f'  ✗ datumcheck — {e}'); sys.exit(1)
