#!/usr/bin/env python3
"""DATUM de-tell lint — GSP House Style v1.3  (GSP-DS-001)

    python3 datum_lint.py <file> [<file> ...]

Accepts .docx .xlsx .pptx .svg .md .html .txt
Exit 0 = clean · 1 = one or more checks failed · 2 = unreadable / unsupported

Mechanically checkable rules are enforced here. The rest are listed at the end as
manual checks — see references/06-lint.md.
"""
import sys, re, os, zipfile, json
from collections import Counter

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'

BAD_FONTS = ('calibri', 'times new roman', 'timesnewroman', 'aptos', 'cambria math')
PROV = ('TERUKUR', 'DITURUNKAN', 'PEMASOK', 'ASUMSI', 'MEASURED', 'DERIVED', 'VENDOR', 'ASSUMED')
UNITS = (r'kVA|kWh|kW|MW|Mbps|Gbps|kbps|mm²|cm²|m²|m³|mm|cm|km|kg|ms|Hz|kHz|MHz|GHz|'
         r'TB|GB|MB|dBi|dB|°C|Ω|VA|Wh|W|V|A|m′|m|s|%|px|ppm|lux')
DEFENCE = re.compile(r'\b(TNI|Kemhan|Kementerian Pertahanan|Angkatan Laut|Angkatan Darat|'
                     r'Angkatan Udara|Mabes TNI|Arsenal|Lantamal|Koarmada)\b', re.I)
QUESTION = re.compile(r'^\s*(apa|mengapa|kenapa|bagaimana|siapa|kapan|what|why|how|which|who|when)\b',
                      re.I)

findings = []


def fail(n, where, msg):
    findings.append((n, where, msg))


# ───────────────────────── 38 · naming (SKILL.md §14) ─────────────────────────
def check_nama(path):
    """No underscore in any delivered name. Program source files are the only
    carve-out and are never lint targets, so no exemption is needed here."""
    base = os.path.basename(path)
    if '_' in base:
        fail(38, base, 'underscore in a delivered file name — a file name is the '
                       'document\'s title, not its variable name; use Title Case with '
                       'spaces and hyphens inside the document number (§14)')
    parent = os.path.basename(os.path.dirname(os.path.abspath(path)))
    if '_' in parent:
        fail(38, base, f'underscore in the containing folder name "{parent}" — '
                       f'folders take Title Case with spaces (§14)')


# ───────────────────────── text-level checks ─────────────────────────
def check_text(text, headings, where, rev_a=False):
    # Rev A (rows 102 and 102b, decision C41): checks 3, 11, 17 and 19 follow the Rev A manual
    # (rev_a_* below). rev_a=True means the caller (.docx, .xlsx, .pptx) runs them itself on
    # its paragraphs, tables, sheets or slides; otherwise (.md/.html/.txt) rev_a_text runs them
    # on this text. The v1.7 code for these four checks is retired.
    if not rev_a:
        rev_a_text(text, where)
    lang = _rev_a_lang(text)
    for h in headings:
        # 3 · Rev A TB-09 (ID p19): zero dashes in headings, — and – in ID, — in EN (EN p32)
        if '—' in h or (lang == 'id' and '–' in h):
            fail(3, where, f'em-dash in heading: "{h[:70]}"')
        if h.rstrip().endswith('?') or QUESTION.match(h):
            fail(4, where, f'question-form heading: "{h[:70]}"')

    # 16 · value and unit must be separated by a space
    for m in re.finditer(r'(?<![\w.])(\d[\d.,]*)(' + UNITS + r')(?![\w])', text):
        # an identifier is not a quantity: D-4.2A, Rev A, Bab 5B
        if re.search(r'[A-Za-z]-$', text[:m.start()]):
            continue
        # nor is a category or class designation: Cat 6A, Kategori 5e, Kelas 2B,
        # Tipe 4X, Mode 1A. The number there names a grade, not an amount.
        if re.search(r'\b(cat|cat\.|kategori|category|class|kelas|tipe|type|mode|'
                     r'grade|golongan|tier)\.?\s*$', text[:m.start()], re.I):
            continue
        if m.group(2) in ('%',) and m.group(0).count(' ') == 0:
            pass
        fail(16, where, f'no space between value and unit: "{m.group(0)}"')
        if len([f for f in findings if f[0] == 16]) > 8:
            break

    # 17 · Rev A: rev_a_check_17 (DT-30d, ID p36 / EN p37; CP-32)

    # 18 ⛔ classification vocabulary vs recipient
    if DEFENCE.search(text) and re.search(r'\bTERBATAS\b', text):
        fail(18, where, 'document addresses TNI/Kemhan but is marked TERBATAS — '
                        'the defence scheme (Permenhan 26/2017) has only '
                        'BIASA / RAHASIA / SANGAT RAHASIA')

    # 19 ⛔ Rev A: rev_a_check_19_* (DT-31a, ID p17 / EN p18; WB-21, WB-22; C22)

    # 22 · vendor claims need an Admiralty digraph
    vendor = len(re.findall(r'\[PEMASOK|\[VENDOR', text))
    digraph = len(re.findall(r'\[[A-F][1-6]\]|keandalan\s+[A-F][1-6]|[A-F][1-6]\]', text))
    if vendor and digraph == 0:
        fail(22, where, f'{vendor} vendor claim(s) carry no Admiralty digraph [A1]–[F6]')

    # 11 · Rev A: rev_a_check_11 (DT-21, ID p38 / EN p39; CP-29; BR-33). The counts are still
    # returned as in v1.7.
    nums = len(re.findall(r'(?<![\w/.-])\d[\d.,]{3,}(?![\w/-])', text))
    marks = sum(text.count(p) for p in PROV)
    return nums, marks


# ───────────────────────── Rev A checks (.xlsx, .pptx, .docx, text) ─────────────────────────
# Row 102, Swarm 1.2.0 bundled copy. GSP Manual Penulisan / Writing Manual Rev A
# (XXX/GSP/STD/XI/2026; ID 02-XI-2026, 98 pp; EN 03-XI-2026, 99 pp) replaces v1.7 for the
# checks research/15 classes CHANGED. Only the workbook and briefing paths call this block;
# rule ids WB-nn are research/12, BR-nn research/13; pages are the printed sheet numbers.
# CHANGED checks with no .xlsx/.pptx code in v1.7 (4, 14, 15, 21, 28) are not touched here.
import math

REV_A_PROV = re.compile(r'\b(?:TERUKUR|DITURUNKAN|PEMASOK|ASUMSI|MEASURED|DERIVED|VENDOR|'
                        r'ASSUMED)\b|[■◈◇△]', re.I)
REV_A_NUM = re.compile(r'(?<![\w/.-])\d[\d.,]{3,}(?![\w/-])')      # v1.7 check-11 number form
REV_A_PM = re.compile(r'toleransi|tolerance|sigma|σ|k\s*=\s*2|confidence|keyakinan|kepercayaan|'
                      r'\bSK\s*95|\bCI\s*95|interval|ketidakpastian|uncertaint|rancangan|design|'
                      r'spec', re.I)
REV_A_BOILER = re.compile(r'PT\s+GEMILANG\s+SATRIA\s+PERKASA|^\s*Jl\.\s|\bREV\s+[A-Z]\s+·|'
                          r'\bLEMBAR\s+\d+\s+DARI\b|\bSHEET\s+\d+\s+OF\b', re.I)
REV_A_SOURCE = re.compile(r'\s*(?:SUMBER|SOURCE)\b', re.I)


def _rev_a_lang(text):
    """'id' or 'en' by function-word count; Indonesian wins a tie (research/15 A2)."""
    t = text.lower()
    idw = len(re.findall(r'\b(?:dan|yang|untuk|dengan|dari|pada|tidak|atau|ini|ke|di|'
                         r'sebelum|sesudah|termasuk|nilai|sampai)\b', t))
    enw = len(re.findall(r'\b(?:the|and|of|to|for|with|from|is|are|this|not|or|'
                         r'before|after|including|value|until)\b', t))
    return 'en' if enw > idw else 'id'


def rev_a_check_03(lines, where):
    """Check 3, Rev A. TB-09 (ID p19, WAJIB): "Tanda pisah — dan – ≤ 3 per 1.000 kata, 0 di
    judul"; fixed boilerplate (issue stamp, letterhead, address) is not counted. The EN edition
    (EN p32, Table 5.x "Em dash excess, check 03") counts the em dash only. No WB/BR id: the
    rule is general. ID p33 still reads "tanda pisah panjang"; TB-09 is the rule with a code."""
    body = [ln for ln in lines if not REV_A_BOILER.search(ln)]
    text = '\n'.join(body)
    words = len(re.findall(r'\S+', text))
    lang = _rev_a_lang(text)
    dashes = text.count('—') + (text.count('–') if lang == 'id' else 0)
    if words and dashes / words * 1000 > 3:
        kind = '— and –' if lang == 'id' else '—'
        fail(3, where, f'{dashes} dashes ({kind}) in {words} words = {dashes/words*1000:.1f} '
                       f'per 1000 (max 3; boilerplate not counted; Rev A TB-09, ID p19 / EN p32)')


def rev_a_check_17(units, where):
    """Check 17, Rev A. DT-30d (ID p36; EN p37), test "BERKAS, CEK 17": the meaning of each ±
    is written within 160 characters of the sign, or on a notation line in the table SUMBER
    ("Setiap ± pada tabel ini adalah toleransi rancangan"). v1.7 accepted a keyword anywhere.
    units = [(name, text)]: one per sheet (.xlsx) or slide (.pptx); the SUMBER line of a unit
    covers that unit only. No WB/BR id: the rule is general (RAB example in research/12 WB-13)."""
    for u in units:
        name, t = u[0], u[1]
        notation_ok = u[2] if len(u) > 2 else True     # prose has no table SUMBER (False)
        if notation_ok and any(REV_A_SOURCE.match(ln) and REV_A_PM.search(ln)
                               for ln in t.split('\n')):
            continue
        for m in re.finditer('±', t):
            if not REV_A_PM.search(t[max(0, m.start() - 160):m.end() + 160]):
                fail(17, where, f'{name}: ± without a stated meaning within 160 characters or a '
                                f'SUMBER notation line near "{t[max(0, m.start()-40):m.start()+40].strip()}" '
                                f'(Rev A DT-30d, ID p36 / EN p37)')
                break


def rev_a_check_11(units, where, home):
    """Check 11, Rev A. DT-21 (ID p38; EN p39): one provenance mark per load-bearing number at
    its home (table row, SUMBER line or derivation), not at every mention. The ID file test is a
    screen, "Paragraf berkuantitas tanpa tanda ≤ 50 %" (ID p38); EN keeps it as a screen (EN p39).
    units = [(has_quantity, marked)]. For .pptx the home of a slide number is its speaker notes
    (BR-33, ID p75 / EN p77), so a mark in the notes counts. For .xlsx a sheet's SUMBER line
    marks every row of that sheet (ID p38: "kolom tabel, baris SUMBER, atau blok turunan")."""
    q = [m for has_q, m in units if has_q]
    bad = q.count(False)
    if q and bad / len(q) > 0.5:
        fail(11, where, f'{bad} of {len(q)} {home} with load-bearing numbers carry no provenance '
                        f'mark (screen max 50 %; Rev A DT-21, ID p38 / EN p39)')


# Check 19, Rev A. DT-31a (ID p17; EN p18), "UJI · BERKAS, LINT 19, PPN hanya di
# rekapitulasi": VAT = 12 % × DPP nilai lain, DPP = 11/12 × subtotal (PMK 131/2024, Turunan
# 3.7a). Table 13.1 (ID p80 "19 PPN selain 11 % efektif"; EN p82 "VAT over IDR 2 from 11 % of
# the pre-VAT subtotal"). v1.7 failed every "PPN 12 %" string, including Rev A's own recap line
# "PPN 12 % × DPP". Decision C22: rounding-aware, |PPN − round(rate × base)| ≤ 1, labels by
# the workbook language (PPN/DPP in ID, VAT/tax base in EN). Decision C27: the rate cell may hold
# 12 under a 0.0" %" format with =DPP*rate/100, so the arithmetic below uses the statutory
# factors, never the file's rate cell.
REV_A_RATE = re.compile(r'\b(PPN|VAT)\b[^0-9%\n]{0,12}(\d{1,2})\s*%', re.I)
REV_A_BASE = re.compile(r'\bDPP\b|dasar\s+pengenaan|nilai\s+lain|11\s*/\s*12|tax\s+base|'
                        r'VAT\s+base|other[- ]value', re.I)
REV_A_STAT = re.compile(r'\b(?:tarif|rate)\s*$', re.I)


def rev_a_check_19_text(text, where):
    """Rate statements. 11 % passes ("termasuk PPN 11 % efektif", ID p17). 12 % passes when the
    same line ties it to the DPP / tax base ("PPN 12 % × DPP", ID p17 / EN p18) or states the
    statutory rate ("tarif PPN 12 %", WB-22). Any other rate, or 12 % on the whole subtotal,
    fails (ID p17 "Salah: 'PPN 12 %' atas seluruh subtotal"; EN p18)."""
    for m in REV_A_RATE.finditer(text):
        rate = m.group(2)
        if rate == '11':
            continue
        ls = text.rfind('\n', 0, m.start()) + 1
        le = text.find('\n', m.end())
        before = text[ls:m.start()][-40:]
        after = text[m.end():le if le >= 0 else len(text)][:40]
        if rate == '12' and (REV_A_BASE.search(before) or REV_A_BASE.search(after)
                             or REV_A_STAT.search(before)):
            continue
        fail(19, where, f'{m.group(1).upper()} stated at {rate} % without the 11/12 base: '
                        f'"{text[ls:m.end()][-60:].strip()}" (Rev A DT-31a, ID p17 / EN p18)')


def _rev_a_round(x):
    return math.floor(x + 0.5)


def rev_a_check_19_amounts(rows, where, scope):
    """Arithmetic. rows = [(label, value)] in sheet/slide order. Subtotal = the row labelled
    "sebelum PPN" / "before VAT" (else the last subtotal row above the VAT row); DPP / tax base;
    PPN / VAT. Pass: |VAT − round(12 % × DPP)| ≤ 1 and |VAT − round(11 % × subtotal)| ≤ 1
    (C22; inside the IDR 2 of Table 13.1, EN p82). Returns the VAT amount or None."""
    sub = dpp = ppn = None
    sub_pref = False
    word = 'PPN'
    for lab, val in rows:
        if val is None:
            continue
        l = lab.strip(' \t|*#>-').lower()               # markdown table / list markup
        if re.match(r'(?:ppn|vat)\b', l) and ppn is None:
            ppn, word = val, ('VAT' if l.startswith('vat') else 'PPN')
        elif re.match(r'(?:dpp\b|tax base|vat base|dasar pengenaan)', l) and dpp is None:
            dpp = val
        elif re.match(r'(?:sub\s*-?\s*total|jumlah)', l) and ppn is None:
            pref = bool(re.search(r'sebelum\s+ppn|before\s+vat|pre-vat|excl', l))
            if pref or not sub_pref:
                sub, sub_pref = val, pref
    if ppn is None:
        return None
    base = 'tax base' if word == 'VAT' else 'DPP'
    if dpp is not None and abs(ppn - _rev_a_round(0.12 * dpp)) > 1:
        fail(19, where, f'{scope}: {word} {ppn:,.0f} is not 12 % × {base} {dpp:,.0f} '
                        f'(expected {_rev_a_round(0.12 * dpp):,.0f} ± 1; Rev A DT-31a, ID p17 / '
                        f'EN p18; decision C22)')
    if sub is not None and abs(ppn - _rev_a_round(0.11 * sub)) > 1:
        fail(19, where, f'{scope}: {word} {ppn:,.0f} differs from 11 % of the pre-{word} subtotal '
                        f'{sub:,.0f} (expected {_rev_a_round(0.11 * sub):,.0f} ± 1; Rev A Table '
                        f'13.1, ID p80 / EN p82; decision C22)')
    return ppn


class _RevAEval:
    """Minimal, side-effect-free evaluator for the arithmetic formulas a DATUM recap uses
    (+ − × ÷ ^ %, SUM, ROUND, ROUNDDOWN, ROUNDUP, ABS, MIN, MAX, INT, cell / sheet / range
    references, single-cell defined names). It never calls eval(). A cached value written by
    Excel or LibreOffice wins; anything unsupported yields None and the arithmetic is skipped."""
    TOK = re.compile(r"\s*(?:(?P<num>\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)|"
                     r"(?P<ref>(?:'(?:[^']|'')+'|[A-Za-z0-9_.\-]+)!\$?[A-Za-z]{1,3}\$?\d+"
                     r"(?::\$?[A-Za-z]{1,3}\$?\d+)?|\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)"
                     r"(?![A-Za-z0-9_(])|(?P<name>[A-Za-z_][A-Za-z0-9_.]*)|(?P<op>[-+*/^(),%;]))")

    class NoValue(Exception):
        pass

    def __init__(self, wb, wbv):
        self.wb, self.wbv, self.memo, self.busy = wb, wbv, {}, set()

    def cell(self, sheet, coord):
        key = (sheet, coord.replace('$', '').upper())
        if key in self.memo:
            return self.memo[key]
        if key in self.busy or sheet not in self.wb.sheetnames:
            return None
        v = self.wb[sheet][key[1]].value
        r = None
        if isinstance(v, bool):
            r = None
        elif isinstance(v, (int, float)):
            r = float(v)
        elif isinstance(v, str) and v.startswith('='):
            cached = None
            if self.wbv is not None:
                try:
                    cached = self.wbv[sheet][key[1]].value
                except Exception:
                    cached = None
            if isinstance(cached, (int, float)) and not isinstance(cached, bool):
                r = float(cached)
            else:
                self.busy.add(key)
                try:
                    r = self.formula(v[1:], sheet)
                except (self.NoValue, ZeroDivisionError, OverflowError, ValueError,
                        IndexError, KeyError, TypeError, RecursionError):
                    r = None
                self.busy.discard(key)
        self.memo[key] = r
        return r

    def formula(self, f, sheet):
        saved = (getattr(self, 't', None), getattr(self, 'i', 0), getattr(self, 'sheet', None))
        try:
            return self._formula(f, sheet)
        finally:                                   # a reference may evaluate another formula
            self.t, self.i, self.sheet = saved

    def _formula(self, f, sheet):
        toks, pos = [], 0
        while pos < len(f):
            if f[pos:].strip() == '':
                break
            m = self.TOK.match(f, pos)
            if not m or m.end() == pos:
                raise self.NoValue(f)
            kind = m.lastgroup
            toks.append((kind, m.group(kind)))
            pos = m.end()
        self.t, self.i, self.sheet = toks, 0, sheet
        v = self.expr()
        if self.i != len(self.t):
            raise self.NoValue(f)
        return self.scalar(v)

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else (None, None)

    def take(self, op=None):
        k, v = self.peek()
        if op is not None and v != op:
            raise self.NoValue(op)
        self.i += 1
        return k, v

    def scalar(self, v):
        if isinstance(v, list):
            if len(v) != 1:
                raise self.NoValue('range')
            v = v[0]
        if v is None:
            raise self.NoValue('blank')
        return v

    def expr(self):
        v = self.term()
        while self.peek()[1] in ('+', '-'):
            op = self.take()[1]
            r = self.scalar(self.term())
            v = self.scalar(v) + r if op == '+' else self.scalar(v) - r
        return v

    def term(self):
        v = self.power()
        while self.peek()[1] in ('*', '/'):
            op = self.take()[1]
            r = self.scalar(self.power())
            v = self.scalar(v) * r if op == '*' else self.scalar(v) / r
        return v

    def power(self):
        v = self.unary()
        while self.peek()[1] == '^':
            self.take()
            v = self.scalar(v) ** self.scalar(self.unary())
        return v

    def unary(self):
        if self.peek()[1] == '-':
            self.take()
            return -self.scalar(self.unary())
        if self.peek()[1] == '+':
            self.take()
            return self.unary()
        v = self.primary()
        while self.peek()[1] == '%':
            self.take()
            v = self.scalar(v) / 100
        return v

    def ref(self, text):
        sheet = self.sheet
        if '!' in text:
            sheet, text = text.rsplit('!', 1)
            if sheet.startswith("'"):
                sheet = sheet[1:-1].replace("''", "'")
        if ':' in text:
            a, b = text.replace('$', '').split(':')
            from openpyxl.utils.cell import range_boundaries
            c1, r1, c2, r2 = range_boundaries(f'{a}:{b}')
            from openpyxl.utils import get_column_letter
            return [self.cell(sheet, f'{get_column_letter(c)}{r}')
                    for r in range(r1, r2 + 1) for c in range(c1, c2 + 1)]
        return self.cell(sheet, text)

    def name(self, nm):
        dn = None
        try:
            dn = self.wb.defined_names.get(nm)
        except Exception:
            dn = None
        if dn is None:
            raise self.NoValue(nm)
        dest = list(dn.destinations)
        if len(dest) != 1:
            raise self.NoValue(nm)
        return self.cell(dest[0][0], dest[0][1])

    def primary(self):
        k, v = self.take()
        if k == 'num':
            return float(v)
        if k == 'ref':
            return self.ref(v)
        if v == '(':
            r = self.expr()
            self.take(')')
            return r
        if k == 'name':
            if self.peek()[1] != '(':
                return self.name(v)
            self.take('(')
            args = []
            if self.peek()[1] != ')':
                args.append(self.expr())
                while self.peek()[1] in (',', ';'):
                    self.take()
                    args.append(self.expr())
            self.take(')')
            return self.call(v.upper(), args)
        raise self.NoValue(v)

    def call(self, fn, args):
        flat = []
        for a in args:
            flat.extend(x for x in (a if isinstance(a, list) else [a]) if x is not None)
        if fn == 'SUM':
            return sum(flat)
        if fn in ('MIN', 'MAX'):
            return (min if fn == 'MIN' else max)(flat) if flat else 0.0
        if fn == 'ABS':
            return abs(self.scalar(args[0]))
        if fn == 'INT':
            return float(math.floor(self.scalar(args[0])))
        if fn in ('ROUND', 'ROUNDDOWN', 'ROUNDUP'):
            x = self.scalar(args[0])
            n = int(self.scalar(args[1])) if len(args) > 1 else 0
            x = float(f'{x:.15g}')                 # Excel rounds to 15 digits first
            s = 10 ** n
            if fn == 'ROUND':
                return math.copysign(math.floor(abs(x) * s + 0.5), x) / s
            if fn == 'ROUNDDOWN':
                return math.trunc(float(f'{x * s:.15g}')) / s
            return math.copysign(math.ceil(float(f'{abs(x) * s:.15g}')), x) / s
        raise self.NoValue(fn)


REV_A_RECAP = ('REKAP', 'RECAP')
REV_A_VAT_FREE = ('HITUNG', 'CALC', 'KENDALI', 'CHECK', 'COVER', 'PETUNJUK', 'ABOUT')


def _rev_a_sheet_rows(ws, ev):
    """[(label, value, value_cell_raw)] per row: label = first typed text cell, value = the
    first numeric or formula cell to its right."""
    out = []
    for row in ws.iter_rows():
        label, val, raw = None, None, None
        for c in row:
            v = c.value
            if v is None:
                continue
            if label is None:
                if isinstance(v, str) and not v.startswith('='):
                    label = v
                continue
            if isinstance(v, bool):
                continue
            if isinstance(v, (int, float)) or (isinstance(v, str) and v.startswith('=')):
                raw = v
                val = ev.cell(ws.title, c.coordinate)
                break
        if label is not None:
            out.append((label, val, raw))
    return out


def rev_a_check_19_xlsx(wb, wbv, where):
    """Workbook VAT. WB-22 (DT-31a, ID p17 / EN p18): the recap arithmetic above, on every
    REKAPITULASI sheet. WB-21 (DT-31a / DT-40e, ID p72 / EN p74; check 19 "PPN hanya di
    rekapitulasi"): no VAT amount row on any other sheet; another sheet may only quote it, by a
    plain reference to REKAPITULASI or by the same number. HITUNG-* rate constants and the
    KENDALI "silang PPN" are not amount rows (research/12 WB-21 reading, accepted in C22)."""
    ev = _RevAEval(wb, wbv)
    vat = None
    for ws in wb.worksheets:
        if ws.title.upper().startswith(REV_A_RECAP):
            rows = [(lab, val) for lab, val, _ in _rev_a_sheet_rows(ws, ev)]
            got = rev_a_check_19_amounts(rows, where, f'sheet "{ws.title}"')
            vat = got if vat is None else vat
    quote = re.compile(r"=\s*'?(?:REKAP|RECAP)[^'!]*'?!\$?[A-Za-z]{1,3}\$?\d+\s*$", re.I)
    for ws in wb.worksheets:
        t = ws.title.upper()
        if t.startswith(REV_A_RECAP) or t.startswith(REV_A_VAT_FREE):
            continue
        for lab, val, raw in _rev_a_sheet_rows(ws, ev):
            if raw is None or not re.match(r'\s*(?:PPN|VAT)\b', lab, re.I):
                continue
            if isinstance(raw, str) and quote.match(raw):
                continue
            if not isinstance(raw, str) and vat is not None and abs(float(raw) - vat) < 0.5:
                continue
            fail(19, where, f'sheet "{ws.title}" computes or types a VAT amount ("{lab[:40]}") '
                            f'— VAT lives only on REKAPITULASI; elsewhere quote it by reference '
                            f'(Rev A WB-21, DT-31a, ID p17, p72 / EN p18, p74)')


def rev_a_check_20(wb, where):
    """Check 20, Rev A. DT-40e (ID p72; EN p74), test "BERKAS, LINT 20, DAN MATA UNTUK
    KENDALI": zero merged cells outside COVER and PETUNJUK prose (WB-17) and zero hidden rows,
    columns or sheets (WB-18). Lint 20 does not read KENDALI; it is judged by eye (WB-20,
    ID p72 only), so KENDALI's cells are skipped, but its sheet state is still checked (a
    hidden KENDALI hides the master flag). v1.7 failed only merges over formula rows on
    RAB/AHS/HITUNG/REKAP sheets. ABOUT is the EN name v1.7 accepts for PETUNJUK (line 246)."""
    for ws in wb.worksheets:
        t = ws.title.upper()
        if ws.sheet_state != 'visible':
            fail(20, where, f'sheet "{ws.title}" is {ws.sheet_state} — hide nothing '
                            f'(Rev A WB-18, DT-40e, ID p72 / EN p74)')
        if t.startswith(('KENDALI', 'CHECK')):
            continue
        if not t.startswith(('COVER', 'PETUNJUK', 'ABOUT')):
            merged = [str(r) for r in ws.merged_cells.ranges]
            if merged:
                fail(20, where, f'sheet "{ws.title}" merges {len(merged)} range(s) '
                                f'({", ".join(merged[:4])}) — zero merged cells outside COVER '
                                f'and PETUNJUK prose (Rev A WB-17, DT-40e, ID p72 / EN p74)')
        rows = [str(r) for r, d in ws.row_dimensions.items() if d.hidden]
        cols = [str(c) for c, d in ws.column_dimensions.items() if d.hidden]
        if rows or cols:
            fail(20, where, f'sheet "{ws.title}" hides {len(rows)} row(s) and {len(cols)} '
                            f'column(s) ({", ".join((rows + cols)[:4])}) — hide nothing '
                            f'(Rev A WB-18, DT-40e, ID p72 / EN p74)')


def rev_a_xlsx(wb, wbv, where):
    """Rev A checks 3, 11, 17, 19, 20 for a workbook (called by lint_xlsx)."""
    lines, units17, units11 = [], [], []
    for ws in wb.worksheets:
        st = []
        sheet_rows, sheet_marked = [], False
        for row in ws.iter_rows():
            vals = [c.value for c in row if c.value is not None]
            typed = [v for v in vals if not (isinstance(v, str) and v.startswith('='))]
            for v in vals:
                st.append(str(v))
            texts = [v for v in typed if isinstance(v, str)]
            row_marked = any(REV_A_PROV.search(v) for v in texts)
            if texts and REV_A_SOURCE.match(texts[0]) and row_marked:
                sheet_marked = True        # the SUMBER row (label and text may sit in two cells)
            has_q = any(not isinstance(v, bool) and REV_A_NUM.search(str(v)) for v in typed)
            sheet_rows.append((has_q, row_marked))
        # COVER, PETUNJUK/ABOUT and KENDALI/CHECK quote numbers or show the colour key; a
        # number's home (DT-21) is the computing sheet, so they are not screened.
        if not ws.title.upper().startswith(('COVER', 'PETUNJUK', 'ABOUT', 'KENDALI', 'CHECK')):
            units11 += [(q, m or sheet_marked) for q, m in sheet_rows]
        units17.append((f'sheet "{ws.title}"', '\n'.join(st)))
        lines += st
    rev_a_check_03(lines, where)
    rev_a_check_11(units11, where, 'worksheet rows')
    rev_a_check_17(units17, where)
    rev_a_check_19_text('\n'.join(lines), where)
    rev_a_check_19_xlsx(wb, wbv, where)
    rev_a_check_20(wb, where)


def _rev_a_amount_rows(lines):
    """(label, value) from text lines that carry "Rp n" (ID: 1.234.567,5) or "IDR n" (EN:
    1,234,567.5)."""
    out = []
    for ln in lines:
        m = re.search(r'\b(Rp|IDR)\s*([\d.,]*\d)', ln)
        if not m:
            continue
        num = m.group(2)
        num = (num.replace('.', '').replace(',', '.') if m.group(1) == 'Rp'
               else num.replace(',', ''))
        try:
            out.append((ln[:m.start()], float(num)))
        except ValueError:
            continue
    return out


def rev_a_pptx(slides, where):
    """Rev A checks 3, 11, 17, 19 for a deck (called by lint_pptx). slides = [(n, paragraph
    lines, table row texts, notes text)]. Tables are read for the check-19 arithmetic only, so
    the text the unchanged checks see is the v1.7 text."""
    lines = [ln for _, pl, _, _ in slides for ln in pl]
    rev_a_check_03(lines, where)
    rev_a_check_11([(bool(REV_A_NUM.search('\n'.join(pl))),
                     bool(REV_A_PROV.search('\n'.join(pl)) or REV_A_PROV.search(notes)))
                    for _, pl, _, notes in slides], where, 'slides')
    rev_a_check_17([(f'slide {n}', '\n'.join(pl)) for n, pl, _, _ in slides], where)
    rev_a_check_19_text('\n'.join(lines), where)
    for n, pl, tr, _ in slides:
        rev_a_check_19_amounts(_rev_a_amount_rows(pl + tr), where, f'slide {n}')


def _rev_a_blocks(lines):
    """Split lines into blocks at blank lines."""
    blocks, cur = [], []
    for ln in lines:
        if ln.strip():
            cur.append(ln)
        elif cur:
            blocks.append(cur); cur = []
    if cur:
        blocks.append(cur)
    return blocks


def _rev_a_source_marked(lines):
    return any(REV_A_SOURCE.match(ln.strip(' |*#>')) and REV_A_PROV.search(ln) for ln in lines)


def rev_a_text(text, where):
    """Rev A checks 3, 11, 17, 19 for plain text (.md/.html/.txt, through check_text). A block
    is a run of non-blank lines (a paragraph or a table); a SUMBER/SOURCE line in the block or
    opening the next block is that block's source line (DT-15, ID p41; DT-21 ID p38)."""
    lines = text.split('\n')
    blocks = _rev_a_blocks(lines)
    rev_a_check_03(lines, where)
    units11, units17 = [], []
    for k, b in enumerate(blocks):
        nxt = blocks[k + 1] if k + 1 < len(blocks) else []
        src = [ln for ln in b if REV_A_SOURCE.match(ln.strip(' |*#>'))]
        if nxt and REV_A_SOURCE.match(nxt[0].strip(' |*#>')):
            src.append(nxt[0])
        covered = _rev_a_source_marked(src)
        units11 += [(bool(REV_A_NUM.search(ln)), bool(REV_A_PROV.search(ln)) or covered)
                    for ln in b if not REV_A_SOURCE.match(ln.strip(' |*#>'))]
        units17.append((f'block {k + 1}', '\n'.join(b + [ln for ln in src if ln not in b]), True))
    rev_a_check_11(units11, where, 'paragraphs or table rows')
    rev_a_check_17(units17, where)
    rev_a_check_19_text(text, where)
    for k, b in enumerate(blocks):
        rev_a_check_19_amounts(_rev_a_amount_rows(b), where, f'block {k + 1}')


def rev_a_docx(doc, where):
    """Rev A checks 3, 11, 17, 19 for a Word document (called by lint_docx). Body paragraphs and
    top-level tables are read in document order, the same text v1.7 read.
    3: TB-09 (ID p19; EN p32). 11: DT-21 screen (ID p38 / EN p39; CP-29): a paragraph with a
    quantity is marked by its own mark; a table row by its own mark or by the table's SUMBER line
    (a SUMBER row in the table, or the first paragraph after it). 17: DT-30d (ID p36 / EN p37;
    CP-32): within 160 characters in prose; in a table also the SUMBER notation line.
    19: DT-31a (ID p17 / EN p18), Table 13.1 (ID p80 / EN p82), C22: rate text, and the
    arithmetic on each table and on each run of consecutive paragraphs carrying Rp/IDR amounts
    (a derivation block such as Turunan 3.7a)."""
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    items = []
    for el in doc.element.body.iterchildren():
        tag = el.tag.rsplit('}', 1)[-1]
        if tag == 'p':
            items.append(('p', Paragraph(el, doc).text))
        elif tag == 'tbl':
            rows = []
            for r in Table(el, doc).rows:
                cells = []
                for c in r.cells:
                    if not cells or cells[-1] is not c._tc:
                        cells.append(c._tc)
                rows.append([''.join(t.text or '' for t in tc.iter(f'{{{W}}}t')) for tc in cells])
            items.append(('t', rows))
    lines = []
    for kind, v in items:
        lines += [v] if kind == 'p' else [c for r in v for c in r]
    rev_a_check_03(lines, where)
    units11, units17, prose, table_src = [], [], [], set()
    for k, (kind, v) in enumerate(items):
        if kind == 'p':
            if not REV_A_SOURCE.match(v):
                units11.append((bool(REV_A_NUM.search(v)), bool(REV_A_PROV.search(v))))
            if k not in table_src:                 # a table's SUMBER line is not prose
                prose.append(v)
            continue
        ka = next((j for j in range(k + 1, min(k + 4, len(items)))
                   if items[j][0] == 'p' and items[j][1].strip()), None)
        after = items[ka][1] if ka is not None else ''
        src = [' '.join(r) for r in v if r and REV_A_SOURCE.match(r[0])]
        if REV_A_SOURCE.match(after):
            src.append(after)
            table_src.add(ka)
        covered = _rev_a_source_marked(src)
        for r in v:
            rt = ' '.join(r)
            if r and REV_A_SOURCE.match(r[0]):
                continue
            units11.append((bool(REV_A_NUM.search(rt)), bool(REV_A_PROV.search(rt)) or covered))
        units17.append((f'table {sum(1 for kd, _ in items[:k + 1] if kd == "t")}',
                        '\n'.join([' '.join(r) for r in v] + src), True))
    units17.append(('text', '\n'.join(prose), False))
    rev_a_check_11(units11, where, 'paragraphs or table rows')
    rev_a_check_17(units17, where)
    rev_a_check_19_text('\n'.join(lines), where)
    run, n = [], 0
    for kind, v in items + [('end', None)]:
        if kind == 'p' and re.search(r'\b(?:Rp|IDR)\s*\d', v):
            run.append(v)
            continue
        if run:
            rev_a_check_19_amounts(_rev_a_amount_rows(run), where, 'derivation or paragraphs')
            run = []
        if kind == 't':
            n += 1
            rev_a_check_19_amounts(_rev_a_amount_rows([' '.join(r) for r in v]), where,
                                   f'table {n}')


# ───────────────────────── DOCX ─────────────────────────
def lint_docx(path):
    from docx import Document
    from docx.oxml.ns import qn
    doc = Document(path)
    where = os.path.basename(path)

    paras = [p.text for p in doc.paragraphs]
    heads = [p.text.strip() for p in doc.paragraphs
             if p.text.strip() and (p.style.name.lower().startswith('heading')
                                    or (p.runs and p.runs[0].font.size
                                        and p.runs[0].font.size.pt >= 13))]
    tbl_text = []
    for t in doc.tables:
        for r in t.rows:
            for c in r.cells:
                tbl_text.append(c.text)
    text = '\n'.join(paras + tbl_text)
    check_text(text, heads, where, rev_a=True)
    rev_a_docx(doc, where)              # Rev A checks 3, 11, 17, 19 (row 102b, C41)

    xml = zipfile.ZipFile(path).read('word/document.xml').decode('utf8', 'ignore')
    styles = zipfile.ZipFile(path).read('word/styles.xml').decode('utf8', 'ignore')

    # 5 · forbidden faces
    fonts = set(re.findall(r'w:(?:ascii|hAnsi)="([^"]+)"', xml + styles))
    for f in fonts:
        if f.lower() in BAD_FONTS:
            fail(5, where, f'forbidden typeface present: {f}')

    # 7 · vertical rules in tables. insideV is the reliable grid-table signal;
    # a left rule is a legitimate derivation block and a right rule is a revision bar.
    v = len(re.findall(r'<w:insideV[^>]*w:val="single"', xml))
    if v:
        fail(7, where, f'{v} vertical table rule(s) — DATUM tables use horizontal rules only')

    # 8 · filled header rows / 2 · filled callout boxes / 21 · pale tints
    fills = Counter(re.findall(r'w:fill="([0-9A-Fa-f]{6})"', xml))
    for hexv, cnt in fills.items():
        if hexv.upper() in ('FFFFFF', 'AUTO'):
            continue
        r, g, b = (int(hexv[i:i + 2], 16) for i in (0, 2, 4))
        lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
        if lum > 0.85:
            fail(21, where, f'fill #{hexv.upper()} is a {(1-lum)*100:.0f} % tint '
                            f'({cnt}×) — below the 15 % photocopy floor')
        if 0.85 >= lum > 0.60:
            fail(2, where, f'mid-tint fill #{hexv.upper()} ({cnt}×) — likely a callout box; '
                           f'DATUM uses the ruled aside, unfilled')

    # 14 · colour count
    cols = set(c.upper() for c in re.findall(r'w:color w:val="([0-9A-Fa-f]{6})"', xml))
    cols |= set(c.upper() for c in fills)
    cols.discard('FFFFFF')
    if len(cols) > 12:
        fail(14, where, f'{len(cols)} distinct colour values document-wide '
                        f'({", ".join(sorted(cols)[:12])}…). The hard ceiling is 5 VISIBLE PER PAGE; '
                        f'a wrapper+interior document legitimately holds ~9. Check by page.')

    # 21 · rule weights (w:sz is eighths of a point; 0.18 mm = 0.51 pt = 4.08)
    thin = [int(s) for s in re.findall(r'<w:(?:top|bottom|left|right|insideH|insideV)[^>]*'
                                       r'w:sz="(\d+)"', xml)]
    tooth = [s for s in thin if 0 < s < 4]
    if tooth:
        fail(21, where, f'{len(tooth)} rule(s) thinner than 0.18 mm — will not survive photocopying')

    # 6 · centred cover
    first = doc.paragraphs[:26]
    centred = sum(1 for p in first if p.alignment is not None and str(p.alignment).startswith('CENTER'))
    if centred >= 4:
        fail(6, where, f'{centred} centred paragraphs in the first 26 — DATUM covers are '
                       f'left-aligned on the grid')

    # 1 · KPI tile row heuristic
    for t in doc.tables:
        if len(t.rows) == 1 and 3 <= len(t.columns) <= 5:
            big = 0
            for c in t.cells:
                for p in c.paragraphs:
                    for r in p.runs:
                        if r.font.size and r.font.size.pt >= 14 and re.search(r'\d', r.text):
                            big += 1
            if big >= 3:
                fail(1, where, 'single-row table with 3–5 large numeric cells — KPI tile row')

    # 9 / 10 · unit column and source line
    for i, t in enumerate(doc.tables):
        if len(t.rows) < 4 or len(t.columns) < 4:
            continue                      # control blocks and layout grids are not data tables
        hdr = ' | '.join(c.text.strip().lower() for c in t.rows[0].cells)
        body = '\n'.join(c.text for r in t.rows for c in r.cells)
        # a data table has several quantities, not just IDs and dates
        qty = len(re.findall(r'\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+,\d+', body))
        if qty < 6:
            continue
        if not re.search(r'satuan|unit|uom|\((?:' + UNITS + r')\)|'
                         r'\[(?:' + UNITS + r')\]', hdr, re.I):
            fail(9, where, f'table {i+1} carries {qty} quantities but has no unit column')
        if not re.search(r'sumber|source', body, re.I):
            fail(10, where, f'table {i+1} has no SUMBER line')


# ───────────────────────── XLSX ─────────────────────────
def lint_xlsx(path):
    import openpyxl
    wb = openpyxl.load_workbook(path)
    try:                       # Rev A check 19: cached values, when Excel/LibreOffice saved them
        wbv = openpyxl.load_workbook(path, data_only=True)
    except Exception:
        wbv = None
    where = os.path.basename(path)
    text_all, fonts = [], set()
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for c in row:
                if c.value is not None:
                    text_all.append(str(c.value))
                if c.font and c.font.name:
                    fonts.add(c.font.name)
        # 20 ⛔ Rev A: merges and hidden rows/columns/sheets, rev_a_check_20 (WB-17, WB-18,
        # WB-20; DT-40e, ID p72 / EN p74). The v1.7 formula-row merge test is retired.
    for f in fonts:
        if f and f.lower() in BAD_FONTS:
            fail(5, where, f'forbidden typeface present: {f}')
    check_text('\n'.join(text_all), [], where, rev_a=True)
    rev_a_xlsx(wb, wbv, where)          # Rev A checks 3, 11, 17, 19, 20 (row 102)

    for ws in wb.worksheets:
        if '_' in ws.title:
            fail(38, where, f'sheet "{ws.title}" carries an underscore — sheet names are upper case with hyphens, e.g. HITUNG-KABEL (§14)')
    names = [ws.title.upper() for ws in wb.worksheets]
    if not any(n.startswith('PETUNJUK') or n.startswith('ABOUT') for n in names):
        fail(10, where, 'no PETUNJUK / About sheet — the colour key and the model\'s '
                        'qualifications are mandatory (ICAEW 7, FAST 2.06-02)')
    if not any(n.startswith('KENDALI') or n.startswith('CHECK') for n in names):
        fail(10, where, 'no KENDALI sheet — a master error flag is mandatory (ICAEW 19)')


# ───────────────────────── PPTX ─────────────────────────
def lint_pptx(path):
    from pptx import Presentation
    prs = Presentation(path)
    where = os.path.basename(path)
    text_all, fonts = [], set()
    rev_a_slides = []                   # Rev A (row 102): (n, paragraphs, table rows, notes)
    for i, sl in enumerate(prs.slides, start=1):
        stext = []
        plines, trows = [], []
        for sh in sl.shapes:
            if sh.has_text_frame:
                for p in sh.text_frame.paragraphs:
                    plines.append(''.join(r.text for r in p.runs))
                    for r in p.runs:
                        stext.append(r.text)
                        if r.font.name:
                            fonts.add(r.font.name)
            if getattr(sh, 'has_table', False):          # Rev A check 19 arithmetic only
                trows += [' '.join(c.text for c in row.cells) for row in sh.table.rows]
        notes = (sl.notes_slide.notes_text_frame.text
                 if sl.has_notes_slide and sl.notes_slide.notes_text_frame is not None else '')
        rev_a_slides.append((i, plines, trows, notes))
        joined = ' '.join(stext)
        text_all.append(joined)
        if i > 1 and re.search(r'\d[\d.,]{3,}', joined) and not re.search(r'sumber|source', joined, re.I):
            fail(10, where, f'slide {i} carries numbers but has no SUMBER line')
    for f in fonts:
        if f and f.lower() in BAD_FONTS:
            fail(5, where, f'forbidden typeface present: {f}')
    check_text('\n'.join(text_all), [], where, rev_a=True)
    rev_a_pptx(rev_a_slides, where)     # Rev A checks 3, 11, 17, 19 (row 102)


# ───────────────────────── plain text ─────────────────────────
def lint_text(path):
    t = open(path, encoding='utf8', errors='ignore').read()
    # markup hardening: CSS/JS lengths are not document prose — strip them so the
    # unit-spacing and em-dash checks see only rendered content.
    import re as _re
    t = _re.sub(r'<style.*?</style>|<script.*?</script>', ' ', t, flags=_re.S|_re.I)
    t = _re.sub(r'```.*?```', ' ', t, flags=_re.S)
    _heads_src = t                      # keep markup for heading extraction below
    t = _re.sub(r'<[^>]+>', ' ', t)     # strip tags: inline style attrs are not prose
    heads = re.findall(r'^#{1,4}\s+(.+)$', _heads_src, re.M) or \
            re.findall(r'<h[1-4][^>]*>(.*?)</h[1-4]>', _heads_src, re.S | re.I)
    check_text(t, [re.sub(r'<[^>]+>', '', h) for h in heads], os.path.basename(path))
    check_mermaid(open(path, encoding='utf8', errors='ignore').read(),
                  os.path.basename(path))
    for f in re.findall(r'font-family:\s*([^;}"]+)', t, re.I):
        if any(b in f.lower() for b in BAD_FONTS):
            fail(5, os.path.basename(path), f'forbidden typeface in CSS: {f.strip()}')


# ───────────────────────── diagram checks (23-31) ─────────────────────────
MERMAID = re.compile(r'```\s*mermaid|(?:^|\n)\s*(?:graph|flowchart|sequenceDiagram|'
                     r'classDiagram|erDiagram|stateDiagram)\s+(?:TB|TD|LR|RL|BT|v2)?\b')


def lint_svg(path):
    """Diagram-specific checks. These extend the 22 document checks; the reasoning is in
    references/08-skema-diagram.md. A drawing asserts facts, so the failure modes here are
    about false assertions (an unlabelled or misrouted line) rather than about taste."""
    where = os.path.basename(path)
    s = open(path, encoding='utf8', errors='ignore').read()

    for m in re.finditer(r'<rect([^>]*)\brx="([0-9.]+)"', s):
        if 'terminator' not in m.group(1) and float(m.group(2)) > 0:
            fail(23, where, 'rounded node corners — only an ISO 5807 stadium terminator '
                            'may carry a radius')
            break

    colours = set(re.findall(r'(?:fill|stroke)="(#[0-9A-Fa-f]{6})"', s))
    colours = {c.upper() for c in colours} - {'#FCFCFB', '#FBFAF7', '#FFFFFF'}
    if len(colours) > 5:
        fail(25, where, f'{len(colours)} colour values in one figure (max 5): '
                        f'{", ".join(sorted(colours)[:7])}')

    for w in re.findall(r'stroke-width="([0-9.]+)"', s):
        if 0 < float(w) < 0.18:
            fail(27, where, f'stroke {w} mm is below the 0.18 mm photocopy floor')
            break

    for f in re.findall(r'font-size="([0-9.]+)"', s):
        pt = float(f) / 0.3527777778
        if pt < 5.5:
            fail(28, where, f'type at {pt:.1f} pt — 5.5 pt is the floor for a figure '
                            f'that will be photocopied')
            break

    # Rev G: a figure may delegate its caption and SUMBER to the page. The engine records
    # the obligation in the SVG; 29 and 30 then belong to the sheet, not to the figure.
    owed = re.search(r'DATUM-APPARATUS-REQUIRED:\s*(.*?)\s*--', s, re.S)
    if owed:
        fail(36, where, 'apparatus delegated to the page — verify the sheet carries: '
                        + owed.group(1)[:110])
    else:
        if not re.search(r'>\s*(?:SUMBER|SOURCE)\b', s):
            fail(29, where, 'no SUMBER line — a figure without a source is decoration')
        if not re.search(r'>\s*(?:GAMBAR|FIGURE|PETA)\b', s):
            fail(30, where, 'no figure number or caption — figures are numbered per chapter')

    for f in re.findall(r'font-family="([^"]+)"', s):
        if any(b in f.lower() for b in BAD_FONTS):
            fail(5, where, f'forbidden typeface in figure: {f}')
            break


def check_mermaid(text, where):
    if MERMAID.search(text):
        fail(31, where, 'Mermaid source in a deliverable — draft in Mermaid if you like, '
                        'but ship a rendered DATUM figure (scripts/datum_diagram.py)')


CLONES = ('liberation sans', 'liberation serif', 'liberation mono',
          'arimo', 'tinos', 'cousine', 'nimbus sans', 'nimbus roman')


def lint_pdf(path):
    """Check 5 on the artefact that is actually shipped.

    Declaring the right @font-face is not the same as embedding the right face. An SVG
    placed with <img> cannot see the page's @font-face rules, so a DATUM figure silently
    renders in whatever the fallback chain resolves to — usually a metric clone of Arial
    or Courier. Only the PDF's own font table proves what a reviewer will see.
    """
    where = os.path.basename(path)
    raw = open(path, 'rb').read()
    fonts = {f.decode('latin1').split('+')[-1]
             for f in re.findall(rb'/BaseFont\s*/([A-Za-z0-9+\-]+)', raw)}
    for f in sorted(fonts):
        low = f.lower().replace('-', ' ')
        if any(b in low for b in BAD_FONTS) or any(c in low for c in CLONES):
            fail(5, where, f'embedded face {f} — a forbidden or metric-clone typeface '
                           f'reached the PDF; check the @font-face chain and any <img> SVG')
    if not any('plex' in f.lower() for f in fonts):
        fail(5, where, 'no IBM Plex face embedded — the PDF is not set in the house stack')


HANDLERS = {'.pdf': lint_pdf, '.docx': lint_docx, '.xlsx': lint_xlsx, '.pptx': lint_pptx,
            '.md': lint_text, '.html': lint_text, '.htm': lint_text, '.txt': lint_text,
            '.svg': lint_svg}

MANUAL = [
    'Print at 100 % and photocopy twice. Read at 40 cm. Anything lost fails.',
    'Is every brief headline a claim rather than a label?',
    'Is the evidence rail honest — empty where there is nothing to say?',
    'Does every derivation close with what happens if it fails?',
    'Are the cited regulations the current ones? (references/01 §2)',
    'Does the terbilang match the figure above it? Generated, never typed.',
    'Is the logo on exactly one page — the cover?',
    'Do requirement IDs, quantities and totals reconcile across the whole package?',
]


def main(argv):
    if len(argv) < 2:
        print(__doc__); return 2
    for path in argv[1:]:
        ext = os.path.splitext(path)[1].lower()
        if ext not in HANDLERS:
            print(f'!! unsupported: {path}'); return 2
        if not os.path.exists(path):
            print(f'!! not found: {path}'); return 2
        check_nama(path)
        try:
            HANDLERS[ext](path)
        except Exception as e:
            print(f'!! could not read {path}: {e}'); return 2

    print('\n' + '═' * 78)
    print('DATUM LINT · GSP House Style v1.4 · GSP-DS-001')
    print('═' * 78)
    if not findings:
        # Rev A (decision C41): "Lint berkas memeriksa 27 dari 38 cek Tabel 13.1, jadi
        # laporannya 27/27, tidak pernah 38/38" (ID p79); "reports 27/27, never 38/38" (EN p81)
        print('\n  ✓ 27/27 file-lint checks clean.\n')
    else:
        seen = set()
        for n, where, msg in sorted(findings):
            key = (n, where, msg[:60])
            if key in seen:
                continue
            seen.add(key)
            print(f'  ✗ [{n:02d}] {where} — {msg}')
        blocking = [k for k in seen if k[0] != 36]
        if blocking:
            print(f'\n  {len(blocking)} finding(s). Release is blocked until they are cleared.\n')
        else:
            print('\n  0 blocking finding(s); check 36 is a reminder, not a failure.\n')
    print('  Manual checks the script cannot make:')
    for m in MANUAL:
        print(f'    · {m}')
    print()
    return 1 if [f for f in findings if f[0] != 36] else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
