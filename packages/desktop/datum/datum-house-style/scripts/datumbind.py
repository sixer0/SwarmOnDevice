#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
datumbind.py — DATUM quantity register, number binding, derivation arithmetic, and audit.

A DATUM document is prose wrapped around numbers. Reference 11 of the engineering arsenal
forbids a number computed outside the workbook and pasted in. That rule has always governed
spreadsheets. It governs prose with equal force, and until this module existed it did not
hold: every figure in a .docx was typed into its generator as a string literal.

Measured on one real engagement — eight documents, five drawings, eleven calculation
scripts — there were 120 numeric literals across six generators. One model correction then
forced three re-issues and still let two defects reach the finished files: a superseded value
that survived in a document nobody re-opened, and a percentage truncated rather than rounded
because it was typed rather than generated.

Four things live here.

  Register     named quantities, formatted to the house numeral convention
  Derivation   a derivation block whose arithmetic is CHECKED, not merely displayed
  audit_docx   every number in a finished file traced back to the register
  audit_retired  refuses a file that still carries a value the model has withdrawn

Naming: this file carries no underscore, per DATUM §14. The older modules keep theirs only
because `import` requires it.

    from datumbind import Register, Derivation
    N = Register('model/quantities.json')

    D.p(f"Nilai pekerjaan {N.rp('nilai total')}, membebaskan {N.rp('ruang nilai')} "
        f"atau {N.pct('ruang persen')} terhadap basis terkendali.")

    d = Derivation('Turunan D-03 · Ruang nilai yang terbuka', N)
    d.line('nilai basis terkendali',            'nilai basis')
    d.line('nilai skenario',                    'nilai skenario')
    d.result('ruang nilai yang terbuka', 'nilai basis - nilai skenario', 'ruang nilai')
    D.derivation(d.label, d.lines, d.note)      # raises if the arithmetic disagrees
"""

import json, re, os, sys, math

__all__ = ['Register', 'Derivation', 'BindDefect', 'fmt']


class BindDefect(Exception):
    pass


# ── Indonesian numeral convention · DATUM §10 ──────────────────────────────
def fmt(v, dec=0):
    """Thousands separator '.', decimal separator ',' — never the reverse."""
    s = f'{v:,.{dec}f}'
    return s.replace(',', '\x00').replace('.', ',').replace('\x00', '.')


def _withunit(s, unit):
    """Currency leads, every other unit trails — DATUM §10."""
    if not unit:
        return s
    return f'{unit} {s}' if unit in ('Rp', 'USD', 'EUR', 'SGD') else f'{s} {unit}'


class Register:
    """The single named registry of every load-bearing number in a document set.

    Emitted by the calculation chain as its last step. Never written by hand.
    """

    PAT = re.compile(r'(?<![\w,.])\d{1,3}(?:\.\d{3})+(?:,\d+)?(?![\w.])|'
                     r'(?<![\w,.])\d+,\d+(?![\w.])')

    def __init__(self, path=None, data=None):
        self.d = data if data is not None else (
            json.load(open(path, encoding='utf-8')) if path else {})
        self.used = set()
        self.path = path

    # ── emission ───────────────────────────────────────────────────────────
    @staticmethod
    def emit(path, entries):
        """entries: {'name': (value, dec, unit, mark, source)}  ·  mark per DATUM §8."""
        MARKS = {'TERUKUR', 'DITURUNKAN', 'PEMASOK', 'ASUMSI', None}
        out = {}
        for k, t in entries.items():
            v, dec, unit, mark, src = (list(t) + [None] * 5)[:5]
            if isinstance(mark, str):
                # the glyph may be supplied or omitted; both mean the same thing
                mark = mark.replace('■', '').replace('◈', '').replace('◇', '') \
                           .replace('△', '').strip().upper() or None
            if mark not in MARKS:
                raise BindDefect(f'besaran "{k}" membawa tanda asal "{mark}" '
                                 f'yang tidak dikenal DATUM §8')
            if mark is None:
                raise BindDefect(f'besaran "{k}" tanpa tanda asal. '
                                 f'Angka penting tanpa tanda adalah cacat.')
            out[k] = {'v': v, 'dec': dec or 0, 'unit': unit, 'mark': mark, 'src': src}
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        json.dump(out, open(path, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
        return out

    # ── resolution ─────────────────────────────────────────────────────────
    def _get(self, k):
        if k not in self.d:
            near = [x for x in self.d if x.split()[0:1] == k.split()[0:1]][:4]
            raise BindDefect(f'besaran "{k}" tidak terdaftar pada register. '
                             f'Daftarkan pada rantai perhitungan, jangan diketik.'
                             + (f' Mirip: {", ".join(near)}' if near else ''))
        self.used.add(k)
        return self.d[k]

    def v(self, k):            return self._get(k)['v']
    def mark(self, k):         return self._get(k)['mark']
    def src(self, k):          return self._get(k).get('src') or ''

    def n(self, k, dec=None):
        e = self._get(k)
        return fmt(e['v'], e['dec'] if dec is None else dec)

    def u(self, k, dec=None):
        """value and unit, separated by a space — DATUM §10 requires the space."""
        e = self._get(k)
        return _withunit(fmt(e['v'], e['dec'] if dec is None else dec), e.get('unit'))

    def rp(self, k):
        e = self._get(k)
        return 'Rp ' + fmt(e['v'], e.get('dec', 0))

    def pct(self, k, dec=2):
        return fmt(self._get(k)['v'], dec) + ' %'

    # ── audits ─────────────────────────────────────────────────────────────
    def unused(self):
        return sorted(set(self.d) - self.used)

    def _known(self):
        out = set()
        for e in self.d.values():
            v = e['v']
            if not isinstance(v, (int, float)):
                continue
            for dec in range(0, 4):
                out.add(fmt(v, dec))
            out.add(fmt(round(v), 0))
        return out

    def audit_text(self, text, allow=()):
        return sorted({m.group(0) for m in self.PAT.finditer(text)}
                      - self._known() - set(allow))

    @staticmethod
    def _text_of(path):
        from docx import Document
        d = Document(path)
        parts = [p.text for p in d.paragraphs]
        parts += [c.text for t in d.tables for r in t.rows for c in r.cells]
        for s in d.sections:
            for blk in (s.header, s.footer):
                parts += [p.text for p in blk.paragraphs]
        return ' '.join(parts)

    def audit_docx(self, path, allow=(), quiet=False):
        stray = self.audit_text(self._text_of(path), allow)
        if not quiet:
            nm = os.path.basename(path)
            print((f'  ✗ [BIND] {nm} — {len(stray)} angka tidak tertelusur: '
                   + ', '.join(stray[:12]) + ('…' if len(stray) > 12 else ''))
                  if stray else f'  ✓ [BIND] {nm} — seluruh angka tertelusur ke register')
        return stray

    def audit_retired(self, path, retired, quiet=False):
        txt = self._text_of(path)
        hit = [s for s in retired if s in txt]
        if not quiet:
            nm = os.path.basename(path)
            print(f'  ✗ [BIND] {nm} — memuat angka yang sudah ditarik: ' + ', '.join(hit)
                  if hit else f'  ✓ [BIND] {nm} — tidak memuat angka yang sudah ditarik')
        return hit


class Derivation:
    """A derivation block whose arithmetic is verified against the register.

    DATUM §8 says a derivation shows the actual arithmetic. It never said the shown
    arithmetic has to agree with the computed result, and on a long document it silently
    stops agreeing. This class closes that: `result()` evaluates the stated expression
    against the register and refuses to build if it disagrees with the named conclusion.
    """

    def __init__(self, label, reg, width=54, note=None):
        self.label, self.R, self.w = label, reg, width
        self.lines, self.note = [], note
        self._checked = False

    def text(self, s):
        self.lines.append(s); return self

    def line(self, uraian, key=None, dec=None, unit=True, value=None):
        if key is not None:
            e = self.R._get(key)
            s = _withunit(fmt(e['v'], e['dec'] if dec is None else dec),
                          e.get('unit') if unit else None)
        else:
            s = value if isinstance(value, str) else fmt(value, dec or 0)
        self.lines.append(f'{uraian:<{self.w}.{self.w}s}{s:>18s}')
        return self

    def result(self, uraian, expr, key, dec=None, tol=0.51, unit=True):
        """`expr` is arithmetic over register names, e.g. 'nilai basis - nilai skenario'."""
        env = {k.replace(' ', '_'): e['v'] for k, e in self.R.d.items()}
        safe = expr
        for k in sorted(self.R.d, key=len, reverse=True):
            safe = safe.replace(k, k.replace(' ', '_'))
        try:
            got = eval(safe, {'__builtins__': {}, 'abs': abs, 'round': round,
                              'sqrt': math.sqrt, 'min': min, 'max': max}, env)
        except Exception as ex:
            raise BindDefect(f'{self.label}: ekspresi "{expr}" tidak dapat dihitung ({ex})')
        e = self.R._get(key)
        want = e['v']
        if abs(got - want) > tol:
            raise BindDefect(
                f'{self.label}: aritmetika blok derivasi tidak cocok. '
                f'"{expr}" menghasilkan {fmt(got, 2)} sedangkan besaran "{key}" '
                f'bernilai {fmt(want, 2)}; selisih {fmt(got - want, 2)}. '
                f'Perbaiki modelnya atau perbaiki ekspresinya, jangan perbaiki tampilannya.')
        s = _withunit(fmt(want, e['dec'] if dec is None else dec),
                      e.get('unit') if unit else None)
        self.lines.append(f'{uraian:<{self.w}.{self.w}s}{s:>18s}')
        self._checked = True
        return self

    def verdict(self, uraian, key, limit, ok='MEMENUHI', bad='TIDAK MEMENUHI', dec=None):
        e = self.R._get(key)
        v = e['v']
        s = _withunit(fmt(v, e['dec'] if dec is None else dec), e.get('unit'))
        tag = ok if v <= limit else bad
        self.lines.append(f'{uraian:<{self.w}.{self.w}s}{s:>18s}   {tag}')
        return self

    def closes(self, note):
        """DATUM §8: every derivation closes with what happens if the assumption fails."""
        self.note = note; return self

    def build(self):
        if not self._checked:
            raise BindDefect(f'{self.label}: blok derivasi tanpa satu pun baris result(); '
                             f'aritmetikanya tidak pernah diuji.')
        if not self.note:
            raise BindDefect(f'{self.label}: blok derivasi tidak ditutup dengan pernyataan '
                             f'apa yang terjadi bila asumsinya gagal (DATUM §8).')
        return self.label, self.lines, self.note


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(0)
    reg = Register(sys.argv[1]); rc = 0
    for f in sys.argv[2:]:
        if reg.audit_docx(f): rc = 1
    sys.exit(rc)
