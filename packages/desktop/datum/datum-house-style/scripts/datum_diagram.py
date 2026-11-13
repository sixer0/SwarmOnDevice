#!/usr/bin/env python3
"""DATUM diagram engine — GSP House Style v1.3  (GSP-DS-001)

Turns a declarative JSON spec into a DATUM-compliant technical diagram as SVG.

    python3 datum_diagram.py spec.json -o gambar_3_1.svg
    python3 datum_diagram.py spec.json -o out.svg --png out.png
    python3 datum_diagram.py --schema          # print the spec schema
    python3 datum_diagram.py --selftest -o gallery/   # emit one sample per family

Why this exists
---------------
Every GSP skill that needed a schematic reached for a default Mermaid render: rounded
boxes, a stock palette, unlabelled arrows, no grid. That output is instantly legible as
machine-drawn, which is the one thing a tender diagram cannot afford. This engine draws
the same information the way a drawing office draws it — snapped to the DATUM page
lattice, orthogonal routing with crossing hops, one size class per tier, every edge
labelled with what flows, real text, and the caption/SUMBER apparatus attached.

Everything geometric resolves to ../tokens.json. If a literal here and a value there ever
disagree, tokens.json wins and this file is the bug.

Coordinate system: **1 SVG user unit = 1 mm.** The root carries width/height in mm, so a
166 mm figure is 166 mm on the page with no scaling step. Font sizes are converted from
points at 0.3527778 mm/pt.
"""

import argparse
import json
import math
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field

try:
    import datum_symbols as SYM
except ImportError:                       # library absent: symbols simply unavailable
    SYM = None

MM_PT = 0.3527777778  # mm per point

# ───────────────────────────── tokens ─────────────────────────────

_FALLBACK = {
    "colour": {
        "interior": {
            "paper": "#FCFCFB", "ink900": "#101418", "ink700": "#2B3640",
            "ink400": "#6B7783", "ink200": "#C3CBD1", "ink100": "#EFF2F4",
            "signal": "#B45309", "alert": "#9B1C1C", "verd": "#2F6F6B",
        }
    },
    "grid": {"full_span_mm": 166, "subcolumn_pitch_mm": 10.6667, "text_col_mm": 128},
    "type": {"baseline_pt": 13.5},
    "rules_mm": {"strong": 0.45, "mid": 0.25, "hair": 0.2, "min_for_photocopy": 0.18},
}


def load_tokens():
    here = os.path.dirname(os.path.abspath(__file__))
    for cand in (os.path.join(here, "..", "tokens.json"),
                 os.path.join(here, "tokens.json")):
        if os.path.exists(cand):
            try:
                with open(cand, encoding="utf-8") as fh:
                    return json.load(fh)
            except (OSError, ValueError):
                pass
    return _FALLBACK


TOK = load_tokens()
C = TOK.get("colour", _FALLBACK["colour"])["interior"]
GRID = TOK.get("grid", _FALLBACK["grid"])
RULES = TOK.get("rules_mm", _FALLBACK["rules_mm"])

U = float(GRID.get("subcolumn_pitch_mm", 10.6667))          # horizontal lattice unit, mm
B = float(TOK.get("type", {}).get("baseline_pt", 13.5)) * MM_PT  # vertical unit, mm (4.7625)
FULL = float(GRID.get("full_span_mm", 166))

HAIR = float(RULES.get("hair", 0.20))
MID = float(RULES.get("mid", 0.25))
STRONG = float(RULES.get("strong", 0.45))
MINRULE = float(RULES.get("min_for_photocopy", 0.18))

DIAG = TOK.get("diagram", {}) or {}

# The A4 text block: body_bottom - body_top. A figure taller than this cannot be placed on
# one page, and a figure that must be split across a page break stops being a drawing.
_G = TOK.get("grid", _FALLBACK["grid"])
MAX_FIG_H = float(_G.get("body_bottom_mm", 273)) - float(_G.get("body_top_mm", 26))


def dtok(path, default):
    """Read a nested value out of tokens.json:diagram, falling back to a literal."""
    cur = DIAG
    for key in path.split("."):
        if not isinstance(cur, dict) or key not in cur:
            return default
        cur = cur[key]
    return cur


# Geometry defaults — every one of these is a token, not a taste.
NODE_H = float(dtok("node.height_units", 3)) * B          # 14.29 mm
NODE_MIN_W = float(dtok("node.min_width_units", 2)) * U   # 21.33 mm
NODE_MAX_W = float(dtok("node.max_width_units", 5)) * U   # 53.33 mm
GAP_X = float(dtok("gap.x_units", 1)) * U                 # 10.67 mm
GAP_Y = float(dtok("gap.y_units", 3)) * B                 # 14.29 mm
TIER_LABEL_W = float(dtok("tier.label_width_mm", 26))
STROKE_NODE = float(dtok("stroke.node_mm", 0.30))
STROKE_EDGE = float(dtok("stroke.edge_mm", 0.30))
STROKE_ACCENT = float(dtok("stroke.accent_mm", 0.50))
STROKE_BAND = float(dtok("stroke.band_mm", HAIR))
ARROW_L = float(dtok("arrow.length_mm", 2.2))
ARROW_W = float(dtok("arrow.width_mm", 1.4))
JUMP_R = float(dtok("arrow.jump_radius_mm", 0.9))
CHANNEL_STEP = float(dtok("route.channel_step_mm", 1.4))

# Type sizes, in points, from tokens where present.
PT_NODE = float(dtok("type.node_pt", 7.6))
PT_SUB = float(dtok("type.sub_pt", 6.2))
PT_EDGE = float(dtok("type.edge_pt", 6.2))
PT_TIER = float(dtok("type.tier_pt", 6.8))
PT_CAPTION = float(dtok("type.caption_pt", 7.6))
PT_SOURCE = float(dtok("type.source_pt", 6.6))
PT_MICRO = float(dtok("type.micro_pt", 5.9))

F_STRUCT = "'IBM Plex Sans Condensed','IBM Plex Sans','Arial Narrow',sans-serif"
F_DATA = "'IBM Plex Mono','Consolas','Courier New',monospace"
F_READ = "'IBM Plex Serif',Georgia,serif"

WORDS = {
    "id": {"fig": "GAMBAR", "src": "SUMBER", "key": "KETERANGAN", "prov": "PROVENANS",
           "yes": "ya", "no": "tidak"},
    "en": {"fig": "FIGURE", "src": "SOURCE", "key": "KEY", "prov": "PROVENANCE",
           "yes": "yes", "no": "no"},
}

# ISO 128-2:2022 basic line types. DATUM already had semantic edge kinds; this names them
# in the drawing-office vocabulary so a reviewer reading the legend recognises the grammar,
# and adds the three that only a formal drawing needs: centre lines, hidden detail, and
# work that is adjacent or future rather than in this contract.
ISO_LINES = {
    "01.1": {"name": "continuous narrow", "dash": None, "width": HAIR},
    "01.2": {"name": "continuous wide", "dash": None, "width": STRONG},
    "02.1": {"name": "dashed narrow", "dash": "1.6 1.1", "width": HAIR},
    "04.1": {"name": "long-dashed dotted narrow", "dash": "4.0 1.2 0.4 1.2", "width": HAIR},
    "05.1": {"name": "long-dashed double-dotted narrow",
             "dash": "4.0 1.2 0.4 1.2 0.4 1.2", "width": HAIR},
}

# Edge semantics. Colour is never the only carrier — dash pattern duplicates it, so the
# distinction survives a monochrome photocopy.
EDGE_KINDS = {
    "data":     {"dash": None,          "colour": "ink900", "head": "solid"},
    "control":  {"dash": "1.6 1.1",     "colour": "ink700", "head": "open"},
    "sync":     {"dash": "0.6 0.9",     "colour": "ink400", "head": "open"},
    "accent":   {"dash": None,          "colour": "signal", "head": "solid"},
    "alert":    {"dash": "2.4 1.0",     "colour": "alert",  "head": "solid"},
    "verify":   {"dash": "3.0 1.0 0.6 1.0", "colour": "verd", "head": "solid"},
    # ISO 128-2 line types that carry drawing meaning rather than flow meaning
    "centre":   {"dash": "4.0 1.2 0.4 1.2", "colour": "ink400", "head": "none",
                 "iso": "04.1"},
    "hidden":   {"dash": "1.6 1.1", "colour": "ink400", "head": "none", "iso": "02.1"},
    "future":   {"dash": "4.0 1.2 0.4 1.2 0.4 1.2", "colour": "ink400", "head": "open",
                 "iso": "05.1"},
}


def esc(text):
    return (str(text).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def snap(value, unit):
    return round(value / unit) * unit


def snap_down(value, unit):
    """Snap toward zero. Used wherever a width is derived from the available measure —
    rounding up there is how a box ends up half a millimetre off the page."""
    return math.floor(value / unit) * unit


# ─────────────────────── text metrics & wrapping ───────────────────────

_NARROW = set("iljtfrI.,:;'|!()[]{}-")
_WIDE = set("mwMW@%")


def text_w(s, pt, face="struct"):
    """Estimated advance width in mm. IBM Plex Sans Condensed runs narrow; the mono face
    is a fixed 0.60 em. Estimates are deliberately slightly generous so a box never clips."""
    em = pt * MM_PT
    if face == "data":
        return len(s) * 0.60 * em
    total = 0.0
    for ch in s:
        if ch in _NARROW:
            total += 0.28
        elif ch in _WIDE:
            total += 0.80
        elif ch.isupper():
            total += 0.58
        elif ch.isdigit():
            total += 0.53
        elif ch == " ":
            total += 0.26
        else:
            total += 0.49
    return total * em


def wrap_balanced(s, max_mm, pt, face="data", max_lines=2):
    """Wrap so the lines come out even. The greedy wrapper fills line one and leaves a
    stub — '35 set · 5' / 'm' — and a one-character orphan under a spec string reads as a
    mistake even though nothing is technically clipped."""
    words = str(s).split()
    if len(words) < 2 or text_w(s, pt, face) <= max_mm:
        return [str(s)]
    best = None
    for cut in range(1, len(words)):
        a, b = " ".join(words[:cut]), " ".join(words[cut:])
        a = a.rstrip(" ·-,")
        b = b.lstrip(" ·-,")
        if not a or not b:
            continue
        wa, wb = text_w(a, pt, face), text_w(b, pt, face)
        if wa > max_mm or wb > max_mm:
            continue
        score = abs(wa - wb) + (6.0 if min(len(a), len(b)) < 3 else 0.0)
        if best is None or score < best[0]:
            best = (score, [a, b])
    return best[1] if best else wrap(s, max_mm, pt, face, max_lines)


def wrap(s, max_mm, pt, face="struct", max_lines=3):
    words, lines, cur = str(s).split(), [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if text_w(trial, pt, face) <= max_mm or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
            if len(lines) == max_lines:
                break
    if cur and len(lines) < max_lines:
        lines.append(cur)
    if len(lines) == max_lines and len(" ".join(lines).split()) < len(words):
        lines[-1] = lines[-1].rstrip(" ,.") + "…"
    return lines or [""]


# ───────────────────────────── model ─────────────────────────────

@dataclass
class Node:
    id: str
    label: str = ""
    sub: str = ""
    shape: str = "box"
    tier: str = ""
    lane: str = ""
    col: float = None
    row: float = None
    mark: str = ""          # provenance glyph id: TERUKUR / DITURUNKAN / PEMASOK / ASUMSI
    tag: str = ""           # REQ-xxx-nn, carried into the BoQ and the acceptance test
    symbol: str = ""        # standards symbol id, e.g. iec:breaker
    desig: str = ""         # IEC 81346 reference designation, e.g. =G01+B22-Q1
    echelon: str = ""       # MIL-STD-2525 echelon amplifier, e.g. battalion
    accent: bool = False
    x: float = 0.0
    y: float = 0.0
    w: float = 0.0
    h: float = 0.0

    @property
    def cx(self):
        return self.x + self.w / 2

    @property
    def cy(self):
        return self.y + self.h / 2


@dataclass
class Edge:
    src: str
    dst: str
    label: str = ""
    kind: str = "data"
    points: list = field(default_factory=list)
    crossing: bool = False
    label_pos: tuple = None


@dataclass
class Diagram:
    width: float = FULL
    height: float = 0.0
    nodes: list = field(default_factory=list)
    edges: list = field(default_factory=list)
    bands: list = field(default_factory=list)        # (y, h, label, note)
    lanes: list = field(default_factory=list)        # (y, h, label)
    boundaries: list = field(default_factory=list)   # (x, y, w, h, label)
    extras: list = field(default_factory=list)       # raw svg fragments
    lang: str = "id"

    def by_id(self, nid):
        for n in self.nodes:
            if n.id == nid:
                return n
        return None


# IEC 81346-1:2022 reference designation. Three aspects, each with its own prefix:
#   =  function / system      +  location      -  product / component      :  terminal
# A designation such as =G01+B22-Q1 says: in system G01, at location B22, component Q1.
# Wiring this to the REQ-xx thread is what lets a symbol on a drawing resolve to a BoQ
# line and then to an acceptance test, which is the whole point of designating anything.
DESIGNATION = re.compile(r'^(?:[=+\-:][A-Za-z0-9_.]+)+$')


def parse_designation(text):
    """Split a designation into its aspects. Returns None if it is not one."""
    if not text or not DESIGNATION.match(str(text).strip()):
        return None
    out = {"=": [], "+": [], "-": [], ":": []}
    for m in re.finditer(r'([=+\-:])([A-Za-z0-9_.]+)', str(text).strip()):
        out[m.group(1)].append(m.group(2))
    return out


PROV_GLYPH = {"TERUKUR": ("■", "ink900"), "DITURUNKAN": ("◈", "signal"),
              "PEMASOK": ("◇", "ink400"), "ASUMSI": ("△", "alert"),
              "MEASURED": ("■", "ink900"), "DERIVED": ("◈", "signal"),
              "VENDOR": ("◇", "ink400"), "ASSUMED": ("△", "alert")}


# ───────────────────────────── layout ─────────────────────────────

def _mk_nodes(spec):
    out = []
    for raw in spec.get("nodes", []):
        out.append(Node(
            id=raw["id"], label=raw.get("label", raw["id"]), sub=raw.get("sub", ""),
            shape=raw.get("shape", "box"), tier=raw.get("tier", ""),
            lane=raw.get("lane", ""), col=raw.get("col"), row=raw.get("row"),
            mark=raw.get("mark", ""), tag=raw.get("tag", ""),
            symbol=raw.get("symbol", ""), desig=raw.get("desig", ""),
            echelon=raw.get("echelon", ""),
            accent=bool(raw.get("accent", False))))
    return out


def _mk_edges(spec):
    return [Edge(src=e["from"], dst=e["to"], label=e.get("label", ""),
                 kind=e.get("kind", "data")) for e in spec.get("edges", [])]


def snap_up(value, unit):
    """Snap away from zero. Used for any width that must CONTAIN something — rounding a
    content-derived width down is how a mono spec string ends up a millimetre wider than
    the box drawn around it."""
    return math.ceil(value / unit - 1e-9) * unit


def _longest_word(nodes, pt=None):
    """Widest box any node in this set needs for its longest unbreakable token. wrap()
    only breaks on spaces, so a box narrower than its longest single word overflows however
    it is wrapped — and a diamond needs half again as much box for the same word."""
    return max([_min_box_w(n, pt) for n in nodes] or [0.0])


def _uniform_width(nodes, avail, pad=3.2, gap=None, allow_pack=True):
    """One size class per tier. Uniform width inside a band is what separates a drawing
    from a collection of boxes — the eye reads the row as one class of thing.

    Two floors are hard. A box may never be narrower than its longest unbreakable word,
    and it may never be narrower than its mono `sub` line, because neither can be wrapped
    away. When honouring those floors means the row no longer fits the measure, the answer
    is to pack the row into ranks (see `_pack`) — not to shrink boxes until they clip.
    A drawing that silently clips a label is a drawing that will be quoted wrongly."""
    if not nodes:
        return NODE_MIN_W
    gap = GAP_X if gap is None else gap
    inset = pad * 2

    need = 0.0
    for n in nodes:
        need = max(need, text_w(n.label, PT_NODE) / max(1, min(3, len(n.label.split()))))
    need += inset
    # `sub` is mono and drawn on a single line; it never wraps.
    for n in nodes:
        if n.sub:
            # A spec string may run to two lines. Forcing it onto one drives the whole
            # tier wider than the measure for the sake of one node.
            lines = 2 if len(str(n.sub).split()) > 1 else 1
            need = max(need, text_w(n.sub, PT_SUB, "data") / lines + inset)
    floor = max(_longest_word(nodes), U * 1.2)

    per = (avail - gap * (len(nodes) - 1)) / max(1, len(nodes))
    w = min(max(NODE_MIN_W, min(need, NODE_MAX_W)), max(floor, per))
    if allow_pack:
        # Never exceed the measure for a single box, but do keep the content floor.
        w = min(max(w, floor), avail)
    return snap_up(min(w, avail), U / 8)


def _pack(members, avail, w, gap):
    """Split an over-full band into ranks. A tier of fourteen sensors is drawn as two ranks
    of seven, the way a schedule of identical equipment is drawn — not as fourteen boxes
    marching off the edge of the sheet."""
    per_rank = max(1, int((avail + gap + 1e-6) // (w + gap)))
    return [members[i:i + per_rank] for i in range(0, len(members), per_rank)]


def _spread(members, left, avail, w, gap_min=None):
    """Distribute a row across the available measure. Equal gaps, but capped — a two-node
    row spread to the full 166 mm reads as two unrelated objects rather than one tier."""
    gap_min = GAP_X if gap_min is None else gap_min
    n = len(members)
    if n == 1:
        return [left + (avail - w) / 2]
    gap = (avail - n * w) / (n - 1)
    gap = max(gap_min, min(gap, GAP_X * 2.2))
    span = n * w + (n - 1) * gap
    x0 = left + max(0.0, (avail - span) / 2)
    return [x0 + i * (w + gap) for i in range(n)]


def _label_width(nodes, target_lines=2, pad=3.2, cap=None):
    """Width needed for the longest label to sit in `target_lines` lines. Used where the
    column count, not the node count, sets the available measure — a two-column flowchart
    must not be sized as if all six of its boxes shared one row."""
    cap = NODE_MAX_W if cap is None else cap
    need = NODE_MIN_W
    for n in nodes:
        need = max(need, text_w(n.label, PT_NODE) / target_lines + pad * 2)
        need = max(need, _min_box_w(n))
        if n.sub:
            lines = 2 if len(str(n.sub).split()) > 1 else 1
            need = max(need, text_w(n.sub, PT_SUB, "data") / lines + pad * 2)
    return snap_up(min(need, cap), U / 8)


# How much of a box's width is actually usable for type. Slanted and pointed shapes lose
# their corners, and text that runs over a slanted edge is the classic auto-drawn tell.
SHAPE_INSET = {"box": 6.4, "doubled": 7.6, "shadowed": 6.4, "sym-block": 6.4,
               "rack-item": 5.0, "cylinder": 7.0, "stadium": 9.0,
               "parallelogram": 12.0, "hexagon": 11.0, "diamond": 0.0, "circle": 0.0}


INSET_FRAC = 0.28   # a narrow box may spend at most this share of its width on padding


def inner_w(n):
    """Usable text width. The inset is capped as a fraction of the box, because a fixed
    6.4 mm padding inside a 9 mm box leaves 2.6 mm of usable measure — the box then clips
    every label while looking, in the code, as though it had room."""
    if n.shape == "diamond":
        return n.w * 0.58
    if n.shape == "circle":
        return min(n.w, n.h) * 0.70
    inset = SHAPE_INSET.get(n.shape, 6.4)
    return max(2.0, n.w - min(inset, n.w * INSET_FRAC))


def _min_box_w(node, pt=None):
    """Smallest box width that can hold this node's longest unbreakable word.

    Solved against the real inner_w geometry rather than guessed, because the two regimes
    behave differently: a narrow box is limited by the inset fraction, a wide one by the
    fixed inset. Getting this wrong in either direction either clips labels or inflates
    every box in the drawing."""
    pt = PT_NODE if pt is None else pt
    word = max([text_w(w, pt) for w in str(node.label).split()] or [0.0])
    if node.shape == "diamond":
        return word / 0.58 + 1.0
    if node.shape == "circle":
        return word / 0.70 + 1.0
    inset = SHAPE_INSET.get(node.shape, 6.4)
    narrow = word / (1 - INSET_FRAC)
    return narrow if narrow <= inset / INSET_FRAC else word + inset


def _node_h(n, w):
    if n.symbol:
        lines = len(wrap(n.label, w, PT_NODE))
        rows = lines + (1 if n.desig else 0) + (1 if n.sub else 0)
        return snap_up(min(w * 0.62, NODE_H) + (rows + 0.9) * B * 0.78, B)
    probe = Node(id=n.id, label=n.label, shape=n.shape)
    probe.w, probe.h = w, NODE_H
    lines = len(wrap(n.label, inner_w(probe), PT_NODE))
    extra = len(wrap_balanced(n.sub, inner_w(probe), PT_SUB)) if n.sub else 0
    head = 1 if (n.tag or n.mark) else 0   # the tag/provenance row needs its own band
    return max(NODE_H, snap((lines + extra + head) * B + B * 0.6, B))


def layout_layered(spec):
    """Tiered bands. The canonical system-architecture and network-topology drawing:
    horizontal bands read as strata, which is how reviewers already think about a system."""
    d = Diagram(lang=spec.get("lang", "id"))
    d.width = float(spec.get("width_mm", FULL))
    nodes = _mk_nodes(spec)
    tiers = spec.get("tiers") or []
    if not tiers:
        seen = []
        for n in nodes:
            if n.tier and n.tier not in seen:
                seen.append(n.tier)
        tiers = [{"id": t, "label": t} for t in seen] or [{"id": "", "label": ""}]

    left = TIER_LABEL_W if any(t.get("label") for t in tiers) else 0.0
    avail = d.width - left
    y = 0.0
    for tier in tiers:
        tid = tier.get("id", tier.get("label", ""))
        members = [n for n in nodes if (n.tier or "") == tid]
        if not members:
            continue
        members.sort(key=lambda n: (n.col if n.col is not None else 0))
        w = _uniform_width(members, avail)
        h = max(_node_h(n, w) for n in members)
        ranks = _pack(members, avail, w, GAP_X)
        band_h = len(ranks) * h + (len(ranks) - 1) * B * 1.6 + 2 * B
        yy = y + B
        for rank in ranks:
            xs = _spread(rank, left, avail, w)
            for i, n in enumerate(rank):
                n.w, n.h = w, h
                n.x = xs[i] if n.col is None else min(left + n.col * (w + GAP_X),
                                                     d.width - w)
                n.y = yy
            yy += h + B * 1.6
        d.bands.append((y, band_h, tier.get("label", ""), tier.get("note", "")))
        y += band_h + GAP_Y
    d.height = max(0.0, y - GAP_Y)
    d.nodes = [n for n in nodes if n.w]
    d.edges = _mk_edges(spec)
    _apply_boundaries(d, spec)
    return d


def layout_flow(spec):
    """Ordered process, drawn as a spine with branches.

    Stages carry an ordinal because a reader must be able to say 'stage 4 failed' and be
    understood. Decision gates are diamonds and their exits are labelled — an unlabelled
    gate exit is the most common defect in a process drawing.

    The layout follows the dominant path down a single column and pushes exception and
    rejection branches into a second column beside it. Wrapping a process into equal rows
    is what produces the crossing spaghetti that makes a flowchart look auto-generated: the
    reader loses the main path, which is the only thing the drawing exists to show."""
    d = Diagram(lang=spec.get("lang", "id"))
    d.width = float(spec.get("width_mm", FULL))
    nodes = _mk_nodes(spec)
    if not nodes:
        return d
    direction = spec.get("dir", "TB").upper()
    raw_edges = spec.get("edges", []) or []

    if spec.get("number", True):
        k = 0
        for n in nodes:
            if n.shape in ("box", "parallelogram", "cylinder", "hexagon"):
                k += 1
                n.tag = n.tag or f"{k:02d}"

    succ, pred = {}, {}
    for e in raw_edges:
        succ.setdefault(e["from"], []).append(e["to"])
        pred.setdefault(e["to"], []).append(e["from"])

    # Dominant path: from the first node, always take the first declared exit. Spec order is
    # therefore meaningful — declare the happy path first and it becomes the spine.
    spine, seen, cur = [], set(), nodes[0].id
    while cur and cur not in seen:
        spine.append(cur)
        seen.add(cur)
        cur = next((t for t in succ.get(cur, []) if t not in seen), None)

    row_of = {nid: i for i, nid in enumerate(spine)}
    branches = [n for n in nodes if n.id not in seen]
    lane_used = {}
    for n in branches:
        parent = next((p for p in pred.get(n.id, []) if p in row_of), None)
        r = row_of[parent] + 1 if parent is not None else max(row_of.values(), default=-1) + 1
        while lane_used.get(r):
            r += 1
        lane_used[r] = True
        row_of[n.id] = r

    for n in nodes:
        if n.row is not None:
            row_of[n.id] = int(n.row)

    steps = max(row_of.values(), default=0) + 1

    if direction == "LR":
        # Spine runs left to right; branches drop to a second row underneath. Same
        # structure, transposed axes — the reading order changes, the topology does not.
        gap = GAP_X * 0.9
        w = min(_label_width(nodes, 2, pad=2.6),
                (d.width - gap * (steps - 1)) / max(1, steps))
        span = steps * w + (steps - 1) * gap
        x0 = max(0.0, (d.width - span) / 2)
        h = max(_node_h(n, w) for n in nodes)
        row_y = {0: 0.0, 1: h + GAP_Y * 1.15}
        for n in nodes:
            n.w = w
            n.h = h * (1.3 if n.shape == "diamond" else 1.0)
            n.x = x0 + row_of.get(n.id, 0) * (w + gap)
            n.y = row_y[0] if n.id in seen else row_y[1]
        d.height = max(n.y + n.h for n in nodes)
    else:
        n_cols = 2 if branches else 1
        gap = GAP_X * 1.8
        w = min(_label_width(nodes, 2, cap=NODE_MAX_W * 1.15),
                (d.width - (n_cols - 1) * gap) / n_cols)
        total = n_cols * w + (n_cols - 1) * gap
        x_spine = max(0.0, (d.width - total) / 2)
        x_branch = x_spine + w + gap
        rows = {}
        for n in nodes:
            rows.setdefault(row_of.get(n.id, 0), []).append(n)
        y = 0.0
        for r in sorted(rows):
            h = max(_node_h(n, w) for n in rows[r])
            for n in rows[r]:
                n.w = w
                n.h = h * (1.3 if n.shape == "diamond" else 1.0)
                n.y = y
                if n.col is not None:
                    n.x = x_spine + int(n.col) * (w + gap)
                else:
                    n.x = x_spine if n.id in seen else x_branch
            y += max(n.h for n in rows[r]) + GAP_Y * 1.25
        d.height = max(0.0, y - GAP_Y * 1.25)

    d.nodes = nodes
    d.edges = _mk_edges(spec)
    _apply_boundaries(d, spec)
    return d


def layout_swimlane(spec):
    """Actor lanes. A process drawing that does not say who acts is a wish list; the lane
    is the accountability axis and it is why this family exists separately from flow."""
    d = Diagram(lang=spec.get("lang", "id"))
    d.width = float(spec.get("width_mm", FULL))
    nodes = _mk_nodes(spec)
    lanes = spec.get("lanes") or []
    if not lanes:
        seen = []
        for n in nodes:
            if n.lane and n.lane not in seen:
                seen.append(n.lane)
        lanes = [{"id": s, "label": s} for s in seen]

    left = TIER_LABEL_W
    avail = d.width - left
    cols = max([int(n.col or 0) for n in nodes] + [0]) + 1
    # A swimlane's connectors run between adjacent columns, so the column gap has to hold
    # the widest handover label. Sizing the gap from the annotations — rather than pushing
    # the annotations into whatever gap is left — is why this reads as a drawn process.
    avail -= 0.8  # keep the last box's right edge inside the measure, not on it
    same_row = [e.get("label", "") for e in spec.get("edges", []) or []]
    need_gap = max([text_w(l, PT_EDGE, "data") for l in same_row] + [GAP_X * 0.6]) + 2.4
    # Balance: a connector run longer than the box it leaves looks like a gap, not a step.
    floor = max(_longest_word(nodes), U * 1.1)
    w0 = avail / (cols + (cols - 1) * 0.8)
    gap = min(max(GAP_X * 0.45, need_gap), w0 * 1.15)
    if floor * cols + gap * (cols - 1) > avail:      # annotations yield before labels do
        gap = max(1.6, (avail - floor * cols) / max(1, cols - 1))
    w = snap_down(max(floor, (avail - gap * (cols - 1)) / max(1, cols)), U / 16)
    y = 0.0
    for lane in lanes:
        lid = lane.get("id", lane.get("label", ""))
        members = [n for n in nodes if (n.lane or "") == lid]
        h = max([_node_h(n, w) for n in members] + [NODE_H])
        lane_h = h + 2 * B
        for n in members:
            n.w, n.h = w, h
            n.x = left + int(n.col or 0) * (w + gap)
            n.y = y + B
        d.lanes.append((y, lane_h, lane.get("label", "")))
        y += lane_h
    d.height = y
    d.nodes = [n for n in nodes if n.w]
    d.edges = _mk_edges(spec)
    _apply_boundaries(d, spec)
    return d


def layout_sequence(spec):
    """Signalling / message order over time. Lifelines run down; time is the vertical
    axis and nothing else may use it."""
    d = Diagram(lang=spec.get("lang", "id"))
    d.width = float(spec.get("width_mm", FULL))
    actors = spec.get("actors") or []
    msgs = spec.get("messages") or spec.get("edges") or []
    n_act = max(1, len(actors))
    w = snap_down(min(NODE_MAX_W, (d.width - GAP_X * (n_act - 1)) / n_act), U / 8)
    head_h = NODE_H
    nodes = []
    for i, a in enumerate(actors):
        aid = a["id"] if isinstance(a, dict) else a
        lbl = a.get("label", aid) if isinstance(a, dict) else a
        sub = a.get("sub", "") if isinstance(a, dict) else ""
        node = Node(id=aid, label=lbl, sub=sub, shape="box")
        node.w, node.h = w, head_h
        node.x = i * (w + GAP_X)
        node.y = 0.0
        nodes.append(node)
    step = B * 2.6
    y = head_h + step
    for m in msgs:
        m["_y"] = y
        y += step
    d.height = y + B
    d.nodes = nodes
    d.extras.append(("__sequence__", msgs, head_h, d.height))
    _apply_boundaries(d, spec)
    return d


def layout_sld(spec):
    """Single-line diagram. Power and signal chains are read as a chain; the busbar is the
    only heavy stroke on the page and everything hangs off it."""
    d = Diagram(lang=spec.get("lang", "id"))
    d.width = float(spec.get("width_mm", FULL))
    nodes = _mk_nodes(spec)
    for n in nodes:
        if n.shape == "box":
            n.shape = "sym-block"
    direction = spec.get("dir", "TB").upper()
    w = snap(min(NODE_MAX_W, max(NODE_MIN_W, 3.2 * U)), U / 4)
    y = 0.0
    if direction == "TB":
        # Rows, not a single column. A standby source belongs BESIDE the transfer switch it
        # feeds, not stacked under it — that is both how a single line is drawn and how the
        # sheet stays on one page. Nodes without an explicit row take the next one.
        rows, nxt = {}, 0
        for n in nodes:
            r = int(n.row) if n.row is not None else nxt
            rows.setdefault(r, []).append(n)
            nxt = max(nxt, r) + 1
        for r in sorted(rows):
            rank = rows[r]
            for n in rank:
                is_bus = n.shape == "bus" or (n.symbol or "").lower().endswith(":busbar")
                n.w = w * 1.9 if is_bus else w
                n.h = B * 1.6 if is_bus else max(NODE_H, _node_h(n, w))
            hh = max(n.h for n in rank)
            if len(rank) == 1 and rank[0].col is None:
                rank[0].x = (d.width - rank[0].w) / 2
            else:
                span = sum(n.w for n in rank) + GAP_X * (len(rank) - 1)
                x0 = max(0.0, (d.width - span) / 2)
                for n in rank:
                    n.x = x0
                    x0 += n.w + GAP_X
            for n in rank:
                n.y = y
            y += hh + GAP_Y * (0.62 if any(n.symbol for n in rank) else 1.0)
        d.height = max(0.0, y - GAP_Y)
    else:
        x = 0.0
        for n in nodes:
            n.w, n.h = w, NODE_H
            n.x, n.y = x, 0.0
            x += w + GAP_X
        d.height = NODE_H
    d.nodes = nodes
    d.edges = _mk_edges(spec)
    _apply_boundaries(d, spec)
    return d


def layout_rack(spec):
    """Rack elevation. U positions are the whole point — a rack drawing whose units do not
    line up is worse than no drawing, because it will be built from."""
    d = Diagram(lang=spec.get("lang", "id"))
    d.width = float(spec.get("width_mm", FULL))
    units = int(spec.get("units", 42))
    u_h = float(spec.get("u_height_mm", 3.2))
    rack_w = float(spec.get("rack_width_mm", 58))
    left = 14.0
    d.height = units * u_h
    nodes = []
    for raw in spec.get("nodes", []):
        pos = int(raw.get("u", 1))
        size = int(raw.get("size", 1))
        n = Node(id=raw["id"], label=raw.get("label", raw["id"]), sub=raw.get("sub", ""),
                 shape="rack-item", mark=raw.get("mark", ""), tag=raw.get("tag", ""),
                 accent=bool(raw.get("accent")))
        n.w, n.h = rack_w, size * u_h
        n.x = left
        n.y = d.height - (pos - 1 + size) * u_h
        nodes.append(n)
    d.nodes = nodes
    d.extras.append(("__rack__", units, u_h, left, rack_w))
    return d


def layout_graph(spec):
    """Explicit lattice placement. The escape hatch: any diagram family not modelled above
    can be drawn by giving every node a col/row on the lattice. Routing, apparatus and
    house style still apply, so an unusual drawing is never an unstyled one."""
    d = Diagram(lang=spec.get("lang", "id"))
    d.width = float(spec.get("width_mm", FULL))
    nodes = _mk_nodes(spec)
    cols = max([int(n.col or 0) for n in nodes] + [0]) + 1
    gap = GAP_X if cols <= 5 else GAP_X * 0.5
    w = snap_down(max(_longest_word(nodes) + 6.4,
                      (d.width - gap * (cols - 1)) / max(1, cols)), U / 8)
    w = min(w, d.width)
    rows = {}
    for n in nodes:
        rows.setdefault(int(n.row or 0), []).append(n)
    y = 0.0
    for r in sorted(rows):
        h = max(_node_h(n, w) for n in rows[r])
        for n in rows[r]:
            n.w, n.h = w, h
            n.x = min(int(n.col or 0) * (w + gap), d.width - w)
            n.y = y
        y += h + GAP_Y
    d.height = max(0.0, y - GAP_Y)
    d.nodes = nodes
    d.edges = _mk_edges(spec)
    _apply_boundaries(d, spec)
    return d


def fit_page(d, limit=None):
    """Compress the gaps between rows — never the boxes — until the drawing fits the page.

    A tall process flow is a real thing to want, and the honest response is to tighten the
    white space between ranks rather than shrink the type or silently let the figure run
    past the bottom margin. Boxes and text keep their size, so legibility and the photocopy
    floor are untouched; only the air between rows gives."""
    limit = MAX_FIG_H if limit is None else limit
    if d.height <= limit or not d.nodes:
        return d
    rows = sorted({round(n.y, 2) for n in d.nodes})
    if len(rows) < 2:
        return d
    heights = {r: max(n.h for n in d.nodes if round(n.y, 2) == r) for r in rows}
    gaps = [rows[i + 1] - (rows[i] + heights[rows[i]]) for i in range(len(rows) - 1)]
    total_gap = sum(g for g in gaps if g > 0)
    if total_gap <= 0:
        return d
    excess = d.height - limit
    keep = max(0.42, (total_gap - excess) / total_gap)   # never crush below 42 % of the air
    newy, cursor = {}, rows[0]
    for i, r in enumerate(rows):
        newy[r] = cursor
        if i < len(rows) - 1:
            cursor += heights[r] + max(0.0, gaps[i]) * keep
    for n in d.nodes:
        n.y = newy[round(n.y, 2)]
    d.height = max(n.y + n.h for n in d.nodes)
    for i, (y, h, label, note) in enumerate(list(d.bands)):
        pass
    return d


def _apply_boundaries(d, spec):
    """Trust / network boundaries are drawn by closure — a dashed outline with a label tab,
    never a filled panel. A filled zone competes with the nodes it contains."""
    pad = B * 0.9
    for b in spec.get("boundaries", []) or []:
        members = [d.by_id(i) for i in b.get("nodes", [])]
        members = [m for m in members if m]
        if not members:
            continue
        x0 = min(m.x for m in members) - pad
        y0 = min(m.y for m in members) - pad - 2.2
        x1 = max(m.x + m.w for m in members) + pad
        y1 = max(m.y + m.h for m in members) + pad
        d.boundaries.append((x0, y0, x1 - x0, y1 - y0, b.get("label", "")))


LAYOUTS = {
    "layered": layout_layered,
    "architecture": layout_layered,
    "topology": layout_layered,
    "stack": layout_layered,
    "flow": layout_flow,
    "process": layout_flow,
    "swimlane": layout_swimlane,
    "sequence": layout_sequence,
    "sld": layout_sld,
    "single-line": layout_sld,
    "rack": layout_rack,
    "graph": layout_graph,
}


# ───────────────────────────── routing ─────────────────────────────

def route(d):
    """Orthogonal routing with fanned anchors, channel separation and crossing hops.

    Three things here do the heavy lifting visually. Anchors are fanned across a node edge
    so parallel edges leave from distinct points instead of stacking on the centre. Channels
    offset the horizontal run of each edge so two edges sharing a corridor stay legible.
    Crossing hops are the drawing-office convention that tells a reader two lines cross
    rather than join — without them a dense drawing is ambiguous, and ambiguity is the
    thing a reviewer punishes."""
    # Bias toward vertical when the drop is comparable to the sideways run. In a banded
    # drawing the tiers ARE the argument, so a tier-to-tier link that sidles out sideways
    # reads as a detour even when it is geometrically shorter.
    def is_vertical(a, b):
        return abs(b.cy - a.cy) >= abs(b.cx - a.cx) * 0.55

    sides = {}          # (node_id, side) -> list of (edge, role)
    assign = {}         # (edge_index, role) -> side
    for e in d.edges:
        a, b = d.by_id(e.src), d.by_id(e.dst)
        if not a or not b:
            continue
        if is_vertical(a, b):
            sa, sb = ("S", "N") if b.cy > a.cy else ("N", "S")
        else:
            sa, sb = ("E", "W") if b.cx > a.cx else ("W", "E")
        assign[(id(e), "out")] = sa
        assign[(id(e), "in")] = sb
        sides.setdefault((a.id, sa), []).append((e, "out"))
        sides.setdefault((b.id, sb), []).append((e, "in"))

    # Order the anchors along each side by where the far end sits. Sorting the fan this way
    # is what stops connectors from crossing each other immediately as they leave the box.
    for (nid, side), group in sides.items():
        def far(item):
            e, role = item
            other = d.by_id(e.dst if role == "out" else e.src)
            return (other.cx if side in ("N", "S") else other.cy) if other else 0
        group.sort(key=far)

    def anchor(node, side, edge, role):
        group = sides.get((node.id, side), [])
        idx = next((i for i, (g, r) in enumerate(group)
                    if g is edge and r == role), 0)
        frac = (idx + 1) / (len(group) + 1)
        if side == "N":
            return node.x + node.w * frac, node.y
        if side == "S":
            return node.x + node.w * frac, node.y + node.h
        if side == "W":
            return node.x, node.y + node.h * frac
        return node.x + node.w, node.y + node.h * frac

    channels = {}
    for e in d.edges:
        a, b = d.by_id(e.src), d.by_id(e.dst)
        if not a or not b:
            e.points = []
            continue
        s_side = assign.get((id(e), "out"), "S")
        t_side = assign.get((id(e), "in"), "N")
        if s_side in ("N", "S"):
            x1, y1 = anchor(a, s_side, e, "out")
            x2, y2 = anchor(b, t_side, e, "in")
            if abs(x1 - x2) < 0.35:
                e.points = [(x1, y1), (x1, y2)]
            else:
                key = ("h", round((y1 + y2) / 2, 1))
                n = channels.setdefault(key, 0)
                channels[key] = n + 1
                offset = ((n + 1) // 2) * CHANNEL_STEP * (1 if n % 2 == 0 else -1)
                ym = (y1 + y2) / 2 + offset
                e.points = [(x1, y1), (x1, ym), (x2, ym), (x2, y2)]
        else:
            x1, y1 = anchor(a, s_side, e, "out")
            x2, y2 = anchor(b, t_side, e, "in")
            if abs(y1 - y2) < 0.35:
                e.points = [(x1, y1), (x2, y1)]
            else:
                key = ("v", round((x1 + x2) / 2, 1))
                n = channels.setdefault(key, 0)
                channels[key] = n + 1
                offset = ((n + 1) // 2) * CHANNEL_STEP * (1 if n % 2 == 0 else -1)
                xm = (x1 + x2) / 2 + offset
                e.points = [(x1, y1), (xm, y1), (xm, y2), (x2, y2)]


def segments(e):
    return list(zip(e.points, e.points[1:]))


CLEAR_MM = 1.0   # one clearance figure, shared by the router and its corridor search


def _blocked(p, q, nodes, skip, clear=CLEAR_MM):
    """Does this axis-aligned run pass through a box it does not belong to?"""
    x0, x1 = sorted((p[0], q[0]))
    y0, y1 = sorted((p[1], q[1]))
    for n in nodes:
        if n.id in skip or n.shape == "bus":
            continue
        if (n.x - clear < x1 and n.x + n.w + clear > x0
                and n.y - clear < y1 and n.y + n.h + clear > y0):
            return n
    return None


def _corridor_x(d, y_lo, y_hi, prefer, skip):
    """Find a vertical lane, clear of every box between y_lo and y_hi, nearest `prefer`.
    This is the gutter a draughtsman drops a riser into when the direct line is occupied."""
    blockers = [n for n in d.nodes
                if n.id not in skip and n.shape != "bus"
                and n.y - 0.6 < y_hi and n.y + n.h + 0.6 > y_lo]
    candidates = [prefer]
    for n in blockers:
        candidates.append(n.x - GAP_X * 0.5)
        candidates.append(n.x + n.w + GAP_X * 0.5)
    candidates += [1.5, d.width - 1.5]
    best, best_d = None, None
    for x in candidates:
        if x < 1.2 or x > d.width - 1.2:
            continue
        if any(n.x - (CLEAR_MM + 0.3) < x < n.x + n.w + CLEAR_MM + 0.3 for n in blockers):
            continue
        dist = abs(x - prefer)
        if best_d is None or dist < best_d:
            best, best_d = x, dist
    return best


def _corridor_y(d, x_lo, x_hi, prefer, skip):
    """Find a horizontal band, clear of every box between x_lo and x_hi, nearest `prefer`.
    In a banded drawing this is the inter-tier gutter, and routing along it is what keeps
    connectors entering boxes from the top rather than sidling in past their neighbours."""
    blockers = [n for n in d.nodes
                if n.id not in skip and n.shape != "bus"
                and n.x - 0.6 < x_hi and n.x + n.w + 0.6 > x_lo]
    candidates = [prefer]
    for n in blockers:
        candidates.append(n.y - GAP_Y * 0.35)
        candidates.append(n.y + n.h + GAP_Y * 0.35)
    best, best_d = None, None
    for y in candidates:
        if y < 0.8:
            continue
        if any(n.y - (CLEAR_MM + 0.3) < y < n.y + n.h + CLEAR_MM + 0.3 for n in blockers):
            continue
        dist = abs(y - prefer)
        if best_d is None or dist < best_d:
            best, best_d = y, dist
    return best


def avoid_obstacles(d):
    """Detour any run that would cross a box that is not its own endpoint.

    A line drawn straight through an unrelated component is the single defect that most
    reliably tells a reviewer the drawing was generated rather than drafted — it asserts a
    connection that does not exist. Where a direct run is blocked, the edge drops into a
    clear vertical corridor and comes back, which is exactly what is done by hand.

    This runs over the WHOLE polyline, not just simple two-point runs: a gate with three
    branches produces multi-segment paths, and those are precisely the ones that clip the
    branch boxes stacked between the gate and its furthest exit."""
    for e in d.edges:
        a, b = d.by_id(e.src), d.by_id(e.dst)
        if not a or not b or len(e.points) < 2:
            continue
        skip = {e.src, e.dst}
        if not any(_blocked(p, q, d.nodes, skip) for (p, q) in segments(e)):
            continue

        def clear(pts):
            return not any(_blocked(p, q, d.nodes, skip) for (p, q) in zip(pts, pts[1:]))

        y_lo, y_hi = min(a.cy, b.cy), max(a.cy, b.cy)
        x_lo, x_hi = min(a.cx, b.cx), max(a.cx, b.cx)
        down = b.cy > a.cy
        a_exit = (a.cx, a.y + a.h) if down else (a.cx, a.y)
        b_entry = (b.cx, b.y) if down else (b.cx, b.y + b.h)

        # Strategy 1 — the plain dogleg: drop into a clear horizontal band between the rows
        # and travel along it. This is the first thing a draughtsman reaches for, and it
        # keeps top/bottom entry, which is what a banded drawing wants.
        yd = _corridor_y(d, x_lo, x_hi, (a_exit[1] + b_entry[1]) / 2, skip)
        if yd is not None:
            pts = [a_exit, (a.cx, yd), (b.cx, yd), b_entry]
            if clear(pts):
                e.points = pts
                continue

        # Strategy 2 — a clear vertical corridor with side entry. Right when the obstruction
        # sits directly between the two boxes and the rows are otherwise packed.
        prefer = (a.x + a.w + b.x) / 2 if b.cx > a.cx else (b.x + b.w + a.x) / 2
        xd = _corridor_x(d, y_lo, y_hi, prefer, skip)
        if xd is not None:
            ax = a.x + a.w if xd > a.cx else a.x
            bx = b.x if xd < b.cx else b.x + b.w
            pts = [(ax, a.cy), (xd, a.cy), (xd, b.cy), (bx, b.cy)]
            if clear(pts):
                e.points = pts
                continue

        # Strategy 3 — combine them: out of the source, along a band, down a corridor, into
        # the target from above. Handles a target two packed ranks below the source.
        if xd is not None:
            y1 = _corridor_y(d, min(a.cx, xd), max(a.cx, xd),
                             a_exit[1] + (B if down else -B), skip)
            y2 = _corridor_y(d, min(xd, b.cx), max(xd, b.cx),
                             b_entry[1] - (B if down else -B), skip)
            if y1 is not None and y2 is not None:
                pts = [a_exit, (a.cx, y1), (xd, y1), (xd, y2), (b.cx, y2), b_entry]
                if clear(pts):
                    e.points = pts
                    continue

        # Nothing clean was found. Leave the original route and let check() report it —
        # an unreported crossing is far worse than a reported one, because the reader
        # cannot tell it apart from a real connection.
        e.crossing = True


def self_loops(d):
    """Draw A→A as a real return loop on the node's right flank.

    A self-referencing step is a legitimate thing to draw — a retry, a re-scan, a hold —
    and the router collapses it to a zero-length stub, which reads as nothing at all."""
    for e in d.edges:
        if e.src != e.dst:
            continue
        n = d.by_id(e.src)
        if not n:
            continue
        out = min(GAP_X * 0.62, max(3.0, (d.width - (n.x + n.w)) * 0.5))
        y1, y2 = n.y + n.h * 0.28, n.y + n.h * 0.72
        e.points = [(n.x + n.w, y1), (n.x + n.w + out, y1),
                    (n.x + n.w + out, y2), (n.x + n.w, y2)]


def path_with_hops(e, all_edges):
    """Emit the polyline as a path, hopping every crossing made by another edge.
    Convention: the horizontal run hops the vertical one."""
    verticals = []
    for other in all_edges:
        if other is e or not other.points:
            continue
        for (p, q) in segments(other):
            if abs(p[0] - q[0]) < 0.05:
                verticals.append((p[0], min(p[1], q[1]), max(p[1], q[1])))

    parts = []
    pts = e.points
    if not pts:
        return ""
    parts.append(f"M {pts[0][0]:.2f} {pts[0][1]:.2f}")
    for (p, q) in segments(e):
        horizontal = abs(p[1] - q[1]) < 0.05
        if not horizontal:
            parts.append(f"L {q[0]:.2f} {q[1]:.2f}")
            continue
        y = p[1]
        lo, hi = min(p[0], q[0]), max(p[0], q[0])
        hits = sorted({vx for (vx, y0, y1) in verticals
                       if y0 - 0.2 <= y <= y1 + 0.2 and lo + JUMP_R < vx < hi - JUMP_R})
        forward = q[0] > p[0]
        if not forward:
            hits = list(reversed(hits))
        for vx in hits:
            if forward:
                parts.append(f"L {vx - JUMP_R:.2f} {y:.2f}")
                parts.append(f"A {JUMP_R:.2f} {JUMP_R:.2f} 0 0 1 {vx + JUMP_R:.2f} {y:.2f}")
            else:
                parts.append(f"L {vx + JUMP_R:.2f} {y:.2f}")
                parts.append(f"A {JUMP_R:.2f} {JUMP_R:.2f} 0 0 0 {vx - JUMP_R:.2f} {y:.2f}")
        parts.append(f"L {q[0]:.2f} {q[1]:.2f}")
    return " ".join(parts)


# ───────────────────────────── render ─────────────────────────────

def arrowhead(pts, colour, style="solid"):
    if len(pts) < 2:
        return ""
    (x1, y1), (x2, y2) = pts[-2], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    length = math.hypot(dx, dy) or 1.0
    ux, uy = dx / length, dy / length
    px, py = -uy, ux
    bx, by = x2 - ux * ARROW_L, y2 - uy * ARROW_L
    p1 = (bx + px * ARROW_W / 2, by + py * ARROW_W / 2)
    p2 = (bx - px * ARROW_W / 2, by - py * ARROW_W / 2)
    if style == "open":
        return (f'<path d="M {p1[0]:.2f} {p1[1]:.2f} L {x2:.2f} {y2:.2f} '
                f'L {p2[0]:.2f} {p2[1]:.2f}" fill="none" stroke="{colour}" '
                f'stroke-width="{STROKE_EDGE:.2f}" stroke-linejoin="miter"/>')
    return (f'<path d="M {x2:.2f} {y2:.2f} L {p1[0]:.2f} {p1[1]:.2f} '
            f'L {p2[0]:.2f} {p2[1]:.2f} Z" fill="{colour}" stroke="none"/>')


def place_edge_labels(d):
    """Give every connector label a position that touches no other label.

    Two annotations sharing a corridor is the defect a reader notices before any other,
    because it makes both unreadable and it looks like the drawing was never checked. The
    preferred spot is beside the longest run; when that is taken the label steps
    perpendicular, then slides along the run, until it finds clear air."""
    # Seed with the node boxes: a label sitting on a component is as unreadable as a label
    # sitting on another label, and it additionally obscures the thing being labelled.
    placed = [(n.x + 0.6, n.y + 0.6, n.x + n.w - 0.6, n.y + n.h - 0.6)
              for n in d.nodes if n.shape != "bus"]

    def free(box):
        x0, y0, x1, y1 = box
        if x0 < 0.4 or x1 > d.width - 0.4:      # never let an annotation leave the measure
            return False
        for (a0, b0, a1, b1) in placed:
            if x0 < a1 + 0.4 and x1 > a0 - 0.4 and y0 < b1 + 0.3 and y1 > b0 - 0.3:
                return False
        return True

    for e in d.edges:
        if not e.points or not e.label:
            continue
        (p, q) = max(segments(e), key=lambda s2: abs(s2[1][0] - s2[0][0])
                     + abs(s2[1][1] - s2[0][1]))
        horizontal = abs(p[1] - q[1]) < 0.05
        size = PT_EDGE * MM_PT
        lw = text_w(e.label, PT_EDGE, "data")
        lo, hi = (min(p[0], q[0]), max(p[0], q[0])) if horizontal else \
                 (min(p[1], q[1]), max(p[1], q[1]))
        span = hi - lo
        chosen = None
        for step in (0.0, 0.30, -0.30, 0.46, -0.46):
            for perp in (0, 1, -1, 2, -2):
                if horizontal:
                    x = (p[0] + q[0]) / 2 + span * step
                    y = p[1] - 1.15 - perp * (size * 1.35)
                    box = (x - lw / 2 - 0.7, y - size * 0.82, x + lw / 2 + 0.7, y + size * 0.30)
                    cand = (x, y, "middle", box)
                else:
                    y = (p[1] + q[1]) / 2 + size * 0.35 + span * step
                    x = p[0] + 1.5 + perp * 0.0
                    if perp:
                        x = p[0] + 1.5 if perp > 0 else p[0] - 1.5 - lw
                    box = (x - 0.7, y - size * 0.82, x + lw + 0.7, y + size * 0.30)
                    cand = (x, y, "start", box)
                if free(cand[3]):
                    chosen = cand
                    break
            if chosen:
                break
        if chosen is None:
            # Nothing clear anywhere — keep it on the run but pull it inside the measure.
            if horizontal:
                x = min(max(x, lw / 2 + 1.0), d.width - lw / 2 - 1.0)
                box = (x - lw / 2 - 0.7, y - size * 0.82, x + lw / 2 + 0.7, y + size * 0.30)
                chosen = (x, y, "middle", box)
            else:
                x = min(max(x, 1.0), d.width - lw - 1.0)
                box = (x - 0.7, y - size * 0.82, x + lw + 0.7, y + size * 0.30)
                chosen = (x, y, "start", box)
        placed.append(chosen[3])
        e.label_pos = chosen


def edge_label(e):
    """Place the label beside its run, never on it.

    A label centred on the line forces a knockout box, and a row of little white boxes
    interrupting the connectors is one of the clearest signs a diagram was emitted rather
    than drawn. Draughting practice is to sit the annotation clear of the line: above a
    horizontal run, to the right of a vertical one. The knockout stays, but shrunk to a
    thin backing so the label survives crossing a band rule without eating the drawing."""
    if not e.points or not e.label or not getattr(e, "label_pos", None):
        return ""
    x, y, anchor, (bx0, by0, bx1, by1) = e.label_pos
    return (f'<rect x="{bx0:.2f}" y="{by0:.2f}" width="{bx1 - bx0:.2f}" '
            f'height="{by1 - by0:.2f}" fill="{C["paper"]}" stroke="none"/>'
            + txt(x, y, e.label, PT_EDGE, C["ink700"], F_DATA, 400, anchor))


def shape_path(n, colour, fill, sw):
    x, y, w, h = n.x, n.y, n.w, n.h
    s = n.shape
    common = f'fill="{fill}" stroke="{colour}" stroke-width="{sw:.2f}"'
    if s == "diamond":
        return (f'<path d="M {x + w/2:.2f} {y:.2f} L {x + w:.2f} {y + h/2:.2f} '
                f'L {x + w/2:.2f} {y + h:.2f} L {x:.2f} {y + h/2:.2f} Z" {common}/>')
    if s == "stadium":
        r = h / 2
        return (f'<rect class="terminator" x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" '
                f'height="{h:.2f}" rx="{r:.2f}" {common}/>')
    if s == "parallelogram":
        k = h * 0.34
        return (f'<path d="M {x + k:.2f} {y:.2f} L {x + w:.2f} {y:.2f} '
                f'L {x + w - k:.2f} {y + h:.2f} L {x:.2f} {y + h:.2f} Z" {common}/>')
    if s == "hexagon":
        k = h * 0.30
        return (f'<path d="M {x + k:.2f} {y:.2f} L {x + w - k:.2f} {y:.2f} '
                f'L {x + w:.2f} {y + h/2:.2f} L {x + w - k:.2f} {y + h:.2f} '
                f'L {x + k:.2f} {y + h:.2f} L {x:.2f} {y + h/2:.2f} Z" {common}/>')
    if s == "cylinder":
        r = min(h * 0.18, 3.0)
        return (f'<path d="M {x:.2f} {y + r:.2f} A {w/2:.2f} {r:.2f} 0 0 1 {x + w:.2f} {y + r:.2f} '
                f'L {x + w:.2f} {y + h - r:.2f} A {w/2:.2f} {r:.2f} 0 0 1 {x:.2f} {y + h - r:.2f} Z" '
                f'{common}/>'
                f'<path d="M {x:.2f} {y + r:.2f} A {w/2:.2f} {r:.2f} 0 0 0 {x + w:.2f} {y + r:.2f}" '
                f'fill="none" stroke="{colour}" stroke-width="{sw:.2f}"/>')
    if s == "shadowed":
        o = 1.1
        return (f'<rect x="{x + o:.2f}" y="{y + o:.2f}" width="{w:.2f}" height="{h:.2f}" '
                f'fill="none" stroke="{colour}" stroke-width="{MINRULE:.2f}"/>'
                f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" {common}/>')
    if s == "doubled":
        i = 1.4
        return (f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" {common}/>'
                f'<line x1="{x + i:.2f}" y1="{y:.2f}" x2="{x + i:.2f}" y2="{y + h:.2f}" '
                f'stroke="{colour}" stroke-width="{sw:.2f}"/>')
    if s == "circle":
        r = min(w, h) / 2
        return (f'<circle cx="{n.cx:.2f}" cy="{n.cy:.2f}" r="{r:.2f}" {common}/>')
    if s == "rack-item":
        return f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" {common}/>'
    if s == "sym-block":
        return f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" {common}/>'
    if s == "bus":
        return (f'<line x1="{x:.2f}" y1="{n.cy:.2f}" x2="{x + w:.2f}" y2="{n.cy:.2f}" '
                f'stroke="{colour}" stroke-width="{STRONG * 2:.2f}" stroke-linecap="butt"/>')
    return f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" {common}/>'


def txt(x, y, s, pt, colour, face=F_STRUCT, weight=400, anchor="middle",
        tracking=0.0, upper=False):
    if s is None or s == "":
        return ""
    if upper:
        s = str(s).upper()
    size = pt * MM_PT
    ls = f' letter-spacing="{tracking * size:.3f}"' if tracking else ""
    return (f'<text x="{x:.2f}" y="{y:.2f}" font-family="{face}" font-size="{size:.3f}" '
            f'font-weight="{weight}" fill="{colour}" text-anchor="{anchor}"{ls}>{esc(s)}</text>')


def render(d, spec):
    """Draw the diagram.

    `apparatus` decides who carries the caption, legend and SUMBER line:

      "figure" (default)  the SVG is self-contained — right for a figure delivered on its
                          own, or dropped into a document that supplies no furniture.
      "page"              the SVG carries the drawing ONLY, and the page around it supplies
                          the apparatus. Needed for a dense one-sheet, where three figures
                          each repeating their own caption and source block costs about
                          65 mm of a 247 mm body — apparatus the page was going to carry
                          anyway. The obligation does not disappear: it is recorded in the
                          SVG as a machine-readable requirement and check 36 reports it,
                          so a figure can never quietly lose its source.
    """
    W = d.width
    lang = WORDS.get(d.lang, WORDS["id"])
    pad_top = 0.0
    body = []

    page_owns = str(spec.get("apparatus", "figure")).lower() == "page"

    # caption block, above the object — the reader meets the title before the drawing
    cap_h = 0.0
    fig_id = spec.get("id", "")
    title = spec.get("title", "")
    if (title or fig_id) and not page_owns:
        head = f"{lang['fig']} {fig_id}".strip()
        head_w = text_w(head, PT_CAPTION, "struct") + 3.0
        lines = wrap(title, W - head_w, PT_CAPTION)
        y = PT_CAPTION * MM_PT
        body.append(txt(0, y, head, PT_CAPTION, C["ink900"], F_STRUCT, 600,
                        "start", 0.08, upper=True))
        for i, ln in enumerate(lines):
            body.append(txt(head_w, y + i * (PT_CAPTION * MM_PT * 1.45), ln,
                            PT_CAPTION, C["ink700"], F_STRUCT, 400, "start"))
        cap_h = y + len(lines) * (PT_CAPTION * MM_PT * 1.45) + B * 0.9
    pad_top = cap_h

    g = [f'<g transform="translate(0 {pad_top:.2f})">']

    # bands — hairline strata, no fill. Reserved space reads as engineering, fill reads as slide.
    for (y, h, label, note) in d.bands:
        g.append(f'<line x1="0" y1="{y:.2f}" x2="{W:.2f}" y2="{y:.2f}" '
                 f'stroke="{C["ink200"]}" stroke-width="{STROKE_BAND:.2f}"/>')
        g.append(f'<line x1="0" y1="{y + h:.2f}" x2="{W:.2f}" y2="{y + h:.2f}" '
                 f'stroke="{C["ink200"]}" stroke-width="{STROKE_BAND:.2f}"/>')
        if label:
            lines = wrap(label, TIER_LABEL_W - 2.0, PT_TIER)
            for i, ln in enumerate(lines):
                g.append(txt(0, y + h / 2 - (len(lines) - 1) * 1.6 + i * 3.2, ln, PT_TIER,
                             C["ink400"], F_STRUCT, 600, "start", 0.09, upper=True))
            if note:
                g.append(txt(0, y + h / 2 + (len(lines)) * 3.2, note, PT_MICRO,
                             C["ink400"], F_DATA, 400, "start"))

    # lanes
    for (y, h, label) in d.lanes:
        g.append(f'<line x1="0" y1="{y:.2f}" x2="{W:.2f}" y2="{y:.2f}" '
                 f'stroke="{C["ink200"]}" stroke-width="{STROKE_BAND:.2f}"/>')
        if label:
            lines = wrap(label, TIER_LABEL_W - 2.0, PT_TIER)
            for i, ln in enumerate(lines):
                g.append(txt(0, y + h / 2 - (len(lines) - 1) * 1.6 + i * 3.2, ln, PT_TIER,
                             C["ink400"], F_STRUCT, 600, "start", 0.09, upper=True))
    if d.lanes:
        y_last = d.lanes[-1][0] + d.lanes[-1][1]
        g.append(f'<line x1="0" y1="{y_last:.2f}" x2="{W:.2f}" y2="{y_last:.2f}" '
                 f'stroke="{C["ink200"]}" stroke-width="{STROKE_BAND:.2f}"/>')
        g.append(f'<line x1="{TIER_LABEL_W - 4:.2f}" y1="0" x2="{TIER_LABEL_W - 4:.2f}" '
                 f'y2="{y_last:.2f}" stroke="{C["ink200"]}" stroke-width="{STROKE_BAND:.2f}"/>')

    # rack frame
    for ex in d.extras:
        if ex[0] == "__rack__":
            _, units, u_h, left, rack_w = ex
            H = units * u_h
            g.append(f'<rect x="{left:.2f}" y="0" width="{rack_w:.2f}" height="{H:.2f}" '
                     f'fill="none" stroke="{C["ink900"]}" stroke-width="{MID:.2f}"/>')
            for u in range(units + 1):
                y = H - u * u_h
                w_line = MINRULE if u % 5 else HAIR
                g.append(f'<line x1="{left - 2.4:.2f}" y1="{y:.2f}" x2="{left:.2f}" '
                         f'y2="{y:.2f}" stroke="{C["ink400"]}" stroke-width="{w_line:.2f}"/>')
                if u % 5 == 0 and u < units:
                    g.append(txt(left - 3.2, y - 0.6, f"{u + 1}U", PT_MICRO,
                                 C["ink400"], F_DATA, 400, "end"))

    # Boundaries — closure, drawn before nodes so nodes sit on top. The label tab is held
    # back and drawn after the connectors, with a knockout: a run entering the leftmost
    # member from above lands exactly where the tab sits, and a struck-through zone label
    # is unreadable in print even though nothing in the geometry is wrong.
    boundary_tabs = []
    for (x, y, w, h, label) in d.boundaries:
        g.append(f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" '
                 f'fill="none" stroke="{C["ink400"]}" stroke-width="{MINRULE:.2f}" '
                 f'stroke-dasharray="2.6 1.4"/>')
        if label:
            boundary_tabs.append((x + 1.6, y + 2.0, label))

    # sequence lifelines and messages
    for ex in d.extras:
        if ex[0] == "__sequence__":
            _, msgs, head_h, total_h = ex
            for n in d.nodes:
                g.append(f'<line x1="{n.cx:.2f}" y1="{head_h:.2f}" x2="{n.cx:.2f}" '
                         f'y2="{total_h:.2f}" stroke="{C["ink400"]}" '
                         f'stroke-width="{MINRULE:.2f}" stroke-dasharray="1.2 1.2"/>')
            for i, m in enumerate(msgs):
                a, b = d.by_id(m.get("from")), d.by_id(m.get("to"))
                if not a or not b:
                    continue
                y = m["_y"]
                kind = EDGE_KINDS.get(m.get("kind", "data"), EDGE_KINDS["data"])
                colour = C[kind["colour"]]
                dash = f' stroke-dasharray="{kind["dash"]}"' if kind["dash"] else ""
                g.append(f'<line x1="{a.cx:.2f}" y1="{y:.2f}" x2="{b.cx:.2f}" y2="{y:.2f}" '
                         f'stroke="{colour}" stroke-width="{STROKE_EDGE:.2f}"{dash}/>')
                g.append(arrowhead([(a.cx, y), (b.cx, y)], colour, kind["head"]))
                lbl = m.get("label", "")
                if lbl:
                    seq = f"{i + 1:02d}"
                    g.append(txt((a.cx + b.cx) / 2, y - 1.3, f"{seq} · {lbl}", PT_EDGE,
                                 C["ink700"], F_DATA, 400, "middle"))

    # edges
    for e in d.edges:
        if not e.points:
            continue
        kind = EDGE_KINDS.get(e.kind, EDGE_KINDS["data"])
        colour = C[kind["colour"]]
        sw = STROKE_ACCENT if e.kind == "accent" else STROKE_EDGE
        dash = f' stroke-dasharray="{kind["dash"]}"' if kind["dash"] else ""
        g.append(f'<path d="{path_with_hops(e, d.edges)}" fill="none" stroke="{colour}" '
                 f'stroke-width="{sw:.2f}" stroke-linejoin="miter" stroke-linecap="butt"{dash}/>')
        g.append(arrowhead(e.points, colour, kind["head"]))
        if e.label:
            g.append(edge_label(e))

    for (tx, ty, label) in boundary_tabs:
        size = PT_MICRO * MM_PT
        tw = text_w(label.upper(), PT_MICRO) + len(label) * 0.09 * size
        g.append(f'<rect x="{tx - 0.8:.2f}" y="{ty - size * 0.86:.2f}" '
                 f'width="{tw + 1.6:.2f}" height="{size * 1.16:.2f}" '
                 f'fill="{C["paper"]}" stroke="none"/>')
        g.append(txt(tx, ty, label, PT_MICRO, C["ink400"], F_STRUCT, 600,
                     "start", 0.09, upper=True))

    # nodes
    for n in d.nodes:
        colour = C["signal"] if n.accent else C["ink900"]
        sw = STROKE_ACCENT if n.accent else STROKE_NODE

        # A standards symbol replaces the box entirely. The name and the reference
        # designation then sit BELOW it, which is drawing-office practice: the symbol
        # carries the meaning and the text identifies the particular item.
        if n.symbol and SYM is not None:
            if n.symbol.lower().endswith(":busbar"):
                svg, _p = SYM.render(n.symbol, n.x, n.y, n.w, n.h, colour, sw)
                g.append(svg)
                g.append(txt(n.x + n.w, n.cy - 2.2, n.label, PT_SUB, C["ink900"],
                             F_STRUCT, 600, "end", 0.09, upper=True))
                if n.desig:
                    g.append(txt(n.x + n.w, n.cy + 3.4, n.desig, PT_SUB, C["ink700"],
                                 F_DATA, 600, "end"))
                continue
            sy_h = min(n.h * 0.58, n.w * 0.62)
            sy_w = sy_h * SYM.SYMBOLS[n.symbol.lower()]["aspect"]
            sy_w = min(sy_w, n.w * 0.94)
            svg, _ports = SYM.render(n.symbol, n.cx - sy_w / 2, n.y, sy_w, sy_h,
                                     colour, sw, echelon=n.echelon or None)
            g.append(svg)
            # The tag is the thread to the BoQ and the acceptance test. A symbol node was
            # dropping it silently — the drawing looked complete and the thread was cut.
            if n.tag:
                g.append(txt(n.cx - sy_w / 2 - 1.6, n.y + sy_h * 0.34, n.tag, PT_MICRO,
                             C["ink400"], F_DATA, 400, "end", 0.03))
            ly = n.y + sy_h + PT_NODE * MM_PT * 1.05
            for i, ln in enumerate(wrap(n.label, n.w, PT_NODE)):
                g.append(txt(n.cx, ly + i * PT_NODE * MM_PT * 1.22, ln, PT_NODE,
                             C["ink900"], F_STRUCT, 600))
                last_ly = ly + i * PT_NODE * MM_PT * 1.22
            if n.desig:
                g.append(txt(n.cx, last_ly + PT_SUB * MM_PT * 1.5, n.desig, PT_SUB,
                             C["ink700"], F_DATA, 600))
                last_ly += PT_SUB * MM_PT * 1.5
            if n.sub:
                g.append(txt(n.cx, last_ly + PT_SUB * MM_PT * 1.45, n.sub, PT_SUB,
                             C["ink400"], F_DATA, 400))
            if n.mark:
                glyph, col = PROV_GLYPH.get(n.mark.upper(), ("", "ink400"))
                if glyph:
                    mx = min(n.cx + sy_w / 2 + 2.6, d.width - 2.2)
                    g.append(txt(mx, n.y + sy_h * 0.34, glyph,
                                 PT_SUB, C[col], F_STRUCT, 400, "start"))
            continue

        g.append(shape_path(n, colour, C["paper"], sw))
        if n.shape == "bus":
            g.append(txt(n.x + n.w, n.cy - 1.6, n.label, PT_SUB, C["ink900"],
                         F_STRUCT, 600, "end", 0.09, upper=True))
            continue
        # A 1U slot is about 4 mm tall and cannot hold a name at a legible size. Real rack
        # elevations call those out to the side on a leader rather than shrinking the type
        # until it disappears at the photocopier.
        if n.shape == "rack-item" and n.h < B * 1.2:
            lx = n.x + n.w + 4.2
            g.append(f'<line x1="{n.x + n.w:.2f}" y1="{n.cy:.2f}" x2="{lx - 1.4:.2f}" '
                     f'y2="{n.cy:.2f}" stroke="{C["ink400"]}" stroke-width="{MINRULE:.2f}"/>')
            g.append(txt(lx, n.cy + PT_NODE * MM_PT * 0.34, n.label, PT_NODE,
                         C["ink900"], F_STRUCT, 600, "start"))
            if n.sub:
                g.append(txt(lx + text_w(n.label, PT_NODE) + 2.6,
                             n.cy + PT_SUB * MM_PT * 0.34, n.sub, PT_SUB,
                             C["ink400"], F_DATA, 400, "start"))
            continue
        avail = inner_w(n)
        lines = wrap(n.label, avail, PT_NODE)
        sub_lines = wrap_balanced(n.sub, avail, PT_SUB) if n.sub else []
        total = len(lines) + len(sub_lines)
        line_h = PT_NODE * MM_PT * 1.28
        y0 = n.cy - (total - 1) * line_h / 2 + PT_NODE * MM_PT * 0.34
        if n.tag or n.mark:
            y0 += 1.35   # the tag row owns the top of the box; the name sits clear of it
        for i, ln in enumerate(lines):
            g.append(txt(n.cx, y0 + i * line_h, ln, PT_NODE, C["ink900"], F_STRUCT, 600))
        for j, sl in enumerate(sub_lines):
            g.append(txt(n.cx, y0 + (len(lines) + j) * line_h, sl, PT_SUB,
                         C["ink400"], F_DATA, 400))
        # The tag row clears the shape's own geometry — a cylinder's cap and a stadium's
        # shoulder both eat the top corners, and an ID printed across them is unreadable.
        if n.shape == "cylinder":
            drop_y = min(n.h * 0.18, 3.0) + 1.6   # clear the cap arc at any node height
        else:
            drop_y = {"stadium": 2.2, "parallelogram": 2.0, "hexagon": 1.6}.get(n.shape, 0.0)
        ty = n.y + 2.4 + drop_y
        tx = n.x + 1.6 + (n.h * 0.34 if n.shape == "parallelogram" else 0.0)
        if n.tag:
            g.append(txt(tx, ty, n.tag, PT_MICRO, C["ink400"], F_DATA, 400, "start", 0.03))
        if n.desig:
            g.append(txt(n.cx, n.y + n.h - 1.6, n.desig, PT_SUB, C["ink700"],
                         F_DATA, 600, "middle"))
        if n.mark:
            glyph, col = PROV_GLYPH.get(n.mark.upper(), ("", "ink400"))
            if glyph:
                g.append(txt(n.x + n.w - 1.6, ty + 0.2, glyph, PT_SUB, C[col],
                             F_STRUCT, 400, "end"))

    g.append("</g>")
    body.extend(g)

    y = pad_top + d.height

    # legend — a key row, never a boxed legend. Only present when symbols demand it.
    legend = (spec.get("legend") or []) if not page_owns else []
    if legend:
        y += B * 1.4
        x = 0.0
        body.append(txt(x, y, lang["key"], PT_MICRO, C["ink400"], F_STRUCT, 600,
                        "start", 0.09, upper=True))
        x += text_w(lang["key"], PT_MICRO) + 4.0
        for item in legend:
            sym = item.get("symbol", "solid")
            lbl = item.get("label", "")
            kind = EDGE_KINDS.get(sym)
            if kind:
                dash = f' stroke-dasharray="{kind["dash"]}"' if kind["dash"] else ""
                body.append(f'<line x1="{x:.2f}" y1="{y - 0.7:.2f}" x2="{x + 6.0:.2f}" '
                            f'y2="{y - 0.7:.2f}" stroke="{C[kind["colour"]]}" '
                            f'stroke-width="{STROKE_EDGE:.2f}"{dash}/>')
                x += 7.2
            elif sym in PROV_GLYPH:
                glyph, col = PROV_GLYPH[sym]
                body.append(txt(x, y, glyph, PT_SUB, C[col], F_STRUCT, 400, "start"))
                x += 3.4
            body.append(txt(x, y, lbl, PT_MICRO, C["ink700"], F_STRUCT, 400, "start"))
            x += text_w(lbl, PT_MICRO) + 6.0
        y += B * 0.6

    # source apparatus — a figure without a source line is decoration
    src = "" if page_owns else spec.get("source", "")
    prov = "" if page_owns else spec.get("provenance", "")
    if src or prov:
        y += B * 0.9
        body.append(f'<line x1="0" y1="{y - 2.4:.2f}" x2="{W:.2f}" y2="{y - 2.4:.2f}" '
                    f'stroke="{C["ink200"]}" stroke-width="{HAIR:.2f}"/>')
        lead = f"{lang['src']}  "
        lead_w = text_w(lead, PT_SOURCE, "struct")
        body.append(txt(0, y, lang["src"], PT_SOURCE, C["ink900"], F_STRUCT, 600,
                        "start", 0.06, upper=True))
        text = src
        if prov:
            text = f"{src}   {lang['prov']} {prov}" if src else f"{lang['prov']} {prov}"
        for i, ln in enumerate(wrap(text, W - lead_w, PT_SOURCE, max_lines=4)):
            body.append(txt(lead_w, y + i * (PT_SOURCE * MM_PT * 1.5), ln, PT_SOURCE,
                            C["ink400"], F_STRUCT, 400, "start"))
            last = i
        y += (last + 1) * (PT_SOURCE * MM_PT * 1.5)

    H = y + B * 0.4
    head = (f'<svg xmlns="http://www.w3.org/2000/svg" version="1.1" '
            f'width="{W:.2f}mm" height="{H:.2f}mm" viewBox="0 0 {W:.2f} {H:.2f}">')
    defs = ('<defs>'
            '<pattern id="h45" width="1.6" height="1.6" patternUnits="userSpaceOnUse" '
            'patternTransform="rotate(45)">'
            f'<line x1="0" y1="0" x2="0" y2="1.6" stroke="{C["ink400"]}" stroke-width="0.20"/>'
            '</pattern>'
            '<pattern id="h135" width="1.6" height="1.6" patternUnits="userSpaceOnUse" '
            'patternTransform="rotate(135)">'
            f'<line x1="0" y1="0" x2="0" y2="1.6" stroke="{C["ink400"]}" stroke-width="0.20"/>'
            '</pattern>'
            '</defs>')
    bg = f'<rect x="0" y="0" width="{W:.2f}" height="{H:.2f}" fill="{C["paper"]}"/>'
    note = ""
    if page_owns:
        req = {"caption": f"{lang['fig']} {spec.get('id','')} {spec.get('title','')}".strip(),
               "source": spec.get("source", ""), "provenance": spec.get("provenance", ""),
               "legend": " · ".join(f"{i.get('symbol','')}={i.get('label','')}"
                                    for i in (spec.get("legend") or []))}
        inner = " | ".join(f"{k}={v}" for k, v in req.items() if v).replace("--", "- -")
        note = f"<!-- DATUM-APPARATUS-REQUIRED: {esc(inner)} -->"
    return "\n".join([head, defs, bg] + [b for b in body if b] + [note, "</svg>"])


# ───────────────────────────── checks ─────────────────────────────

def check(svg, spec, d):
    """Self-lint. These are the diagram-specific extensions of the DATUM de-tell lint;
    the same numbering appears in references/06-lint.md."""
    out = []
    for m in re.finditer(r'<rect([^>]*)\brx="([0-9.]+)"', svg):
        if 'class="terminator"' not in m.group(1) and float(m.group(2)) > 0:
            out.append("23 · rounded node corners — only a flowchart terminator "
                       "(stadium) may carry a radius")
            break
    unlabelled = [f"{e.src}→{e.dst}" for e in d.edges if not e.label]
    if unlabelled and spec.get("require_edge_labels", True):
        out.append(f"24 · {len(unlabelled)} edge(s) carry no label: "
                   f"{', '.join(unlabelled[:6])} — every arrow states what flows")
    colours = set(re.findall(r'(?:fill|stroke)="(#[0-9A-Fa-f]{6})"', svg))
    colours.discard(C["paper"])
    if len(colours) > 5:
        out.append(f"25 · {len(colours)} colour values on one figure (max 5)")
    # One accented SUBJECT, not one accented element. An accent edge that lands on or leaves
    # the accented node is part of the same story and costs nothing extra; an accent floating
    # somewhere else is a second story, and two stories in one figure means neither is read.
    accent_ids = {n.id for n in d.nodes if n.accent}
    stray = [e for e in d.edges
             if e.kind == "accent" and e.src not in accent_ids and e.dst not in accent_ids]
    subjects = len(accent_ids) + len(stray)
    if subjects > int(spec.get("max_accents", 1)):
        out.append(f"26 · {subjects} accented subjects — one accent per figure, "
                   f"marking the single element the reader must not miss")
    for m in re.findall(r'stroke-width="([0-9.]+)"', svg):
        if 0 < float(m) < MINRULE:
            out.append(f"27 · stroke {m} mm below the {MINRULE} mm photocopy floor")
            break
    for m in re.findall(r'font-size="([0-9.]+)"', svg):
        if float(m) / MM_PT < 5.5:
            out.append(f"28 · type at {float(m)/MM_PT:.1f} pt — 5.5 pt is the floor")
            break
    crossers = [f"{e.src}->{e.dst}" for e in d.edges if getattr(e, "crossing", False)]
    if crossers:
        out.append(f"32 · {len(crossers)} connector(s) still cross an unrelated component "
                   f"({', '.join(crossers[:4])}) — a crossing line asserts a connection that "
                   f"does not exist; simplify the tier or split the figure")
    page_owns = str(spec.get("apparatus", "figure")).lower() == "page"
    if page_owns:
        missing = [k for k in ("id", "title", "source") if not spec.get(k)]
        if missing:
            out.append(f"36 · apparatus delegated to the page but the spec supplies no "
                       f"{', '.join(missing)} — the page cannot carry what was never stated")
        else:
            out.append("36 · APPARATUS OWED BY PAGE — caption, source and any legend must "
                       "appear beside this figure on the sheet; verify before release")
    # The page takes over checks 29 and 30 and nothing else. Checks 33, 34 and 35 are
    # assertions the drawing makes about itself; no page can discharge them, so they run
    # for a composed sheet exactly as they do for a self-contained figure.
    if not page_owns and not spec.get("source") and not spec.get("provenance"):
        out.append("29 · no SUMBER line — a figure without a source is decoration")
    syms = [n.symbol for n in d.nodes if n.symbol]
    if syms and SYM is not None:
        house = [x for x in syms if SYM.dialect(x) == "sec"]
        if house and not spec.get("legend"):
            out.append(f"34 · figure uses {len(house)} GSP house-legend mark(s) but publishes "
                       f"no legend. No international standard defines security site-plan "
                       f"symbols; an unpublished house mark reads as a standard symbol and "
                       f"is a credibility defect")
        used = sorted({SYM.dialect(x) for x in syms})
        if len(used) > 1:
            out.append(f"35 · mixed symbol dialects ({', '.join(used)}) — one notation per drawing")
    if d.height > MAX_FIG_H + 0.5:
        out.append(f"33 · figure is {d.height:.0f} mm tall against a {MAX_FIG_H:.0f} mm A4 text "
                   f"block — it cannot be placed on one page; split it or turn it landscape")
    if not page_owns and (not spec.get("id") or not spec.get("title")):
        out.append("30 · no figure number or caption — figures are numbered per chapter")
    return out


# ───────────────────────────── build ─────────────────────────────

def validate(spec):
    """Reject a spec that cannot be drawn truthfully.

    These are refusals, not warnings. A connector whose endpoint does not exist would be
    silently dropped, and the reader would see a component with no interface where the
    author believed one was shown — a drawing that asserts something the author never
    checked. Duplicate identifiers are the same failure wearing a different hat: the edge
    resolves to whichever node happens to be first, so the drawing is correct by accident."""
    problems = []
    fam = str(spec.get("family", "layered")).lower()
    if fam not in LAYOUTS:
        problems.append(f"unknown family '{fam}'. Known: {', '.join(sorted(LAYOUTS))}")

    ids = [n.get("id") for n in spec.get("nodes", [])]
    ids += [a.get("id") if isinstance(a, dict) else a for a in spec.get("actors", []) or []]
    seen, dupes = set(), set()
    for i in ids:
        if i in seen:
            dupes.add(i)
        seen.add(i)
    if dupes:
        problems.append(f"duplicate node id(s): {', '.join(sorted(str(d) for d in dupes))} — "
                        f"edges would resolve to whichever came first")
    for i, n in enumerate(spec.get("nodes", [])):
        if not n.get("id"):
            problems.append(f"node #{i} has no id")

    for e in (spec.get("edges", []) or []) + (spec.get("messages", []) or []):
        for end in ("from", "to"):
            ref = e.get(end)
            if ref not in seen:
                problems.append(f"edge {e.get('from')}->{e.get('to')} references unknown "
                                f"node '{ref}'")
    for b in spec.get("boundaries", []) or []:
        for ref in b.get("nodes", []):
            if ref not in seen:
                problems.append(f"boundary '{b.get('label','')}' references unknown node '{ref}'")

    syms = [n.get("symbol") for n in spec.get("nodes", []) if n.get("symbol")]
    if syms and SYM is None:
        problems.append("spec uses symbols but datum_symbols.py could not be imported")
    elif syms:
        for sid in syms:
            if not SYM.resolve(sid):
                problems.append(f"unknown symbol '{sid}' — run "
                                f"`python3 scripts/datum_symbols.py --list`")
        dialects = {SYM.dialect(x) for x in syms if SYM.resolve(x)}
        if len(dialects) > 1:
            problems.append(
                f"mixed symbol dialects in one drawing: {', '.join(sorted(dialects))}. "
                f"Pick ONE notation and hold it — mixing shape vocabularies destroys the "
                f"shape/meaning contract for every other figure in the document")
    for n in spec.get("nodes", []):
        dg = n.get("desig")
        if dg and not DESIGNATION.match(str(dg).strip()):
            problems.append(f"node '{n.get('id')}' designation '{dg}' is not an IEC 81346 "
                            f"reference designation (=function +location -product, "
                            f"e.g. =G01+B22-Q1)")

    if problems:
        raise SystemExit("spec rejected — the drawing would assert something unverified:\n  "
                         + "\n  ".join(problems))


def build(spec):
    validate(spec)
    fam = str(spec.get("family", "layered")).lower()
    d = LAYOUTS[fam](spec)
    if fam in ("flow", "process", "sld", "single-line", "graph") and not d.bands and not d.lanes:
        fit_page(d)
        d.boundaries = []
        _apply_boundaries(d, spec)
    if fam == "topology":
        for n in d.nodes:
            if n.shape == "box" and n.sub and re.search(r'\b(sw|switch|core)\b', n.label, re.I):
                n.shape = "doubled"
    route(d)
    avoid_obstacles(d)
    self_loops(d)
    place_edge_labels(d)
    return d, render(d, spec)


SCHEMA = """DATUM diagram spec — JSON

{
  "family":   "layered | topology | stack | flow | swimlane | sequence | sld | rack | graph",
  "id":       "3.1",                     figure number, chapter-prefixed
  "title":    "one sentence, ends with a full stop",
  "source":   "document + clause the drawing was built from",
  "provenance": "topologi [DITURUNKAN] · kapasitas [PEMASOK, keandalan B2]",
  "lang":     "id | en",
  "width_mm": 166,                       128 for text-column width, 166 for full span
  "dir":      "TB | LR",                 flow and sld only
  "per_row":  3,                          flow only
  "max_accents": 1,

  "tiers":  [ {"id":"edge","label":"TINGKAT 1 · POLSEK","note":"1.847 lokasi"} ],
  "lanes":  [ {"id":"penyidik","label":"PENYIDIK"} ],
  "actors": [ {"id":"ue","label":"Perangkat","sub":"UE"} ],          sequence only

  "nodes": [
    {"id":"cam", "label":"Ruang Pemeriksaan", "sub":"2 kamera · 1 mik",
     "tier":"edge", "lane":"penyidik", "col":0, "row":0,
     "shape":"box | stadium | diamond | parallelogram | cylinder | hexagon |
              doubled | shadowed | circle | bus | sym-block",
     "mark":"TERUKUR | DITURUNKAN | PEMASOK | ASUMSI",
     "tag":"REQ-CAP-01", "accent":false,
     "u":12, "size":2}                                              rack only
  ],

  "edges": [
    {"from":"cam","to":"nvr","label":"H.265 · 4 Mbps",
     "kind":"data | control | sync | accent | alert | verify"}
  ],
  "messages": [ {"from":"ue","to":"bts","label":"Attach Request","kind":"data"} ],

  "boundaries": [ {"label":"ZONA TEPERCAYA POLDA","nodes":["nvr","idx"]} ],
  "legend":     [ {"symbol":"data","label":"aliran bukti"},
                  {"symbol":"control","label":"kendali"},
                  {"symbol":"DITURUNKAN","label":"nilai turunan"} ]
}

Shapes carry meaning; pick one notation and hold it. Mixing UML and flowchart shapes in
one drawing is the fastest way to look like the drawing was assembled rather than drawn.
"""


def _samples():
    return {
        "layered": {
            "family": "layered", "id": "4.1",
            "title": "Arsitektur federasi bukti digital empat tingkat.",
            "source": "Kajian Teknis 000/GSP/KT/VIII/2026 §4.2",
            "provenance": "topologi [DITURUNKAN] · kapasitas tautan [PEMASOK, keandalan B2]",
            "tiers": [
                {"id": "t1", "label": "TINGKAT 1 · POLSEK", "note": "1.847 lokasi"},
                {"id": "t2", "label": "TINGKAT 2 · POLRES", "note": "514 lokasi"},
                {"id": "t3", "label": "TINGKAT 3 · POLDA", "note": "34 lokasi"},
                {"id": "t4", "label": "TINGKAT 4 · MABES", "note": "1 lokasi"}],
            "nodes": [
                {"id": "ruang", "label": "Ruang Pemeriksaan", "sub": "2 kamera · 1 mik",
                 "tier": "t1", "mark": "TERUKUR", "tag": "REQ-CAP-01"},
                {"id": "gw", "label": "Gerbang Kriptografi", "sub": "AES-256",
                 "tier": "t1", "tag": "REQ-SEC-03"},
                {"id": "nvr", "label": "Simpan Bukti", "sub": "48 TB · RAID 6",
                 "tier": "t2", "mark": "DITURUNKAN"},
                {"id": "idx", "label": "Indeks Kustodi", "sub": "SHA-256",
                 "tier": "t2", "accent": True, "tag": "REQ-INT-01"},
                {"id": "asr", "label": "Transkripsi Otomatis", "sub": "GPU L40S",
                 "tier": "t3", "mark": "PEMASOK"},
                {"id": "arsip", "label": "Arsip Polda", "shape": "cylinder", "tier": "t3"},
                {"id": "pusat", "label": "Simpul Nasional", "sub": "replikasi 3×",
                 "tier": "t4", "mark": "DITURUNKAN"}],
            "edges": [
                {"from": "ruang", "to": "gw", "label": "H.265 · 4 Mbps"},
                {"from": "gw", "to": "nvr", "label": "TLS 1.3", "kind": "data"},
                {"from": "gw", "to": "idx", "label": "cap waktu", "kind": "accent"},
                {"from": "nvr", "to": "asr", "label": "antrean kerja"},
                {"from": "idx", "to": "arsip", "label": "manifes", "kind": "control"},
                {"from": "asr", "to": "pusat", "label": "transkrip"},
                {"from": "arsip", "to": "pusat", "label": "replikasi", "kind": "sync"}],
            "boundaries": [{"label": "ZONA TEPERCAYA POLDA", "nodes": ["asr", "arsip"]}],
            "legend": [{"symbol": "data", "label": "aliran bukti"},
                       {"symbol": "control", "label": "kendali"},
                       {"symbol": "sync", "label": "replikasi"},
                       {"symbol": "DITURUNKAN", "label": "nilai turunan"}]},
        "flow": {
            "family": "flow", "id": "6.2", "dir": "TB", "per_row": 3,
            "title": "Alur penerimaan dan verifikasi barang bukti digital.",
            "source": "SOP Bareskrim 12/2026 pasal 8",
            "nodes": [
                {"id": "a", "label": "Terima Media", "shape": "stadium"},
                {"id": "b", "label": "Hitung Cap Digital", "sub": "SHA-256"},
                {"id": "c", "label": "Cap Cocok?", "shape": "diamond"},
                {"id": "d", "label": "Catat Berita Acara", "shape": "parallelogram"},
                {"id": "e", "label": "Kembalikan ke Penyidik", "shape": "box"},
                {"id": "f", "label": "Simpan Terkunci", "shape": "cylinder"}],
            "edges": [
                {"from": "a", "to": "b", "label": "media fisik"},
                {"from": "b", "to": "c", "label": "nilai cap"},
                {"from": "c", "to": "d", "label": "ya"},
                {"from": "c", "to": "e", "label": "tidak", "kind": "alert"},
                {"from": "d", "to": "f", "label": "salinan kerja"}]},
        "swimlane": {
            "family": "swimlane", "id": "6.3",
            "title": "Tanggung jawab rantai kustodi per pelaku.",
            "source": "KUHAP 2025 pasal 132 · SOP internal GSP",
            "lanes": [{"id": "p", "label": "PENYIDIK"}, {"id": "l", "label": "LABFOR"},
                      {"id": "j", "label": "JAKSA"}],
            "nodes": [
                {"id": "s1", "label": "Sita Media", "lane": "p", "col": 0},
                {"id": "s2", "label": "Serah Terima", "lane": "p", "col": 1},
                {"id": "s3", "label": "Akuisisi Citra", "lane": "l", "col": 2},
                {"id": "s4", "label": "Analisis", "lane": "l", "col": 3},
                {"id": "s5", "label": "Berkas Perkara", "lane": "j", "col": 4}],
            "edges": [
                {"from": "s1", "to": "s2", "label": "BA sita"},
                {"from": "s2", "to": "s3", "label": "BA serah"},
                {"from": "s3", "to": "s4", "label": "citra kerja"},
                {"from": "s4", "to": "s5", "label": "laporan"}]},
        "sequence": {
            "family": "sequence", "id": "5.4",
            "title": "Urutan penangkapan identitas pada mode semi-aktif.",
            "source": "3GPP TS 24.301 §5.5.1",
            "actors": [{"id": "ue", "label": "Perangkat", "sub": "UE"},
                       {"id": "bts", "label": "Sel Palsu", "sub": "eNodeB"},
                       {"id": "core", "label": "Inti Jaringan", "sub": "MME"}],
            "messages": [
                {"from": "ue", "to": "bts", "label": "Attach Request"},
                {"from": "bts", "to": "core", "label": "Identity Request", "kind": "control"},
                {"from": "core", "to": "bts", "label": "Identity Response"},
                {"from": "bts", "to": "ue", "label": "Attach Reject", "kind": "alert"}]},
        "sld": {
            "family": "sld", "id": "7.1", "dir": "TB",
            "title": "Diagram satu garis catu daya ruang server.",
            "source": "SNI 0225:2020 (PUIL) pasal 525",
            "nodes": [
                {"id": "pln", "label": "PLN", "sub": "20 kV"},
                {"id": "ats", "label": "ATS", "sub": "630 A"},
                {"id": "gen", "label": "Genset", "sub": "500 kVA", "mark": "PEMASOK"},
                {"id": "mdp", "label": "MDP", "shape": "bus"},
                {"id": "ups", "label": "UPS", "sub": "160 kVA · 15 mnt", "accent": True},
                {"id": "rak", "label": "Rak Server", "sub": "12 rak"}],
            "edges": [
                {"from": "pln", "to": "ats", "label": "utama"},
                {"from": "gen", "to": "ats", "label": "cadangan", "kind": "control"},
                {"from": "ats", "to": "mdp", "label": "630 A"},
                {"from": "mdp", "to": "ups", "label": "200 A"},
                {"from": "ups", "to": "rak", "label": "160 kVA"}]},
        "rack": {
            "family": "rack", "id": "7.3", "units": 24, "u_height_mm": 4.0,
            "title": "Elevasi rak inti, ruang server Polda.",
            "source": "Konfigurasi HW 000/GSP/HW/VIII/2026",
            "nodes": [
                {"id": "sw1", "label": "Switch Inti", "sub": "48× 10G", "u": 24, "size": 1},
                {"id": "fw", "label": "Firewall", "sub": "HA aktif", "u": 22, "size": 1},
                {"id": "srv", "label": "Server Aplikasi", "sub": "2× 2U", "u": 18, "size": 4},
                {"id": "sto", "label": "Penyimpanan", "sub": "48 TB RAID 6", "u": 10,
                 "size": 6, "accent": True},
                {"id": "ups", "label": "UPS", "sub": "6 kVA", "u": 1, "size": 3}]},
        "topology": {
            "family": "topology", "id": "3.2",
            "title": "Topologi jaringan pengawasan sisi timur.",
            "source": "Register koordinat Rev B",
            "provenance": "lebar pita [DITURUNKAN] · perangkat [PEMASOK, keandalan B2]",
            "tiers": [{"id": "f", "label": "LAPANGAN"}, {"id": "a", "label": "AGREGASI"},
                      {"id": "c", "label": "INTI"}],
            "nodes": [
                {"id": "c1", "label": "Kamera B01–B12", "sub": "12 unit", "tier": "f"},
                {"id": "c2", "label": "Kamera B13–B24", "sub": "12 unit", "tier": "f"},
                {"id": "c3", "label": "Kamera B25–B35", "sub": "11 unit", "tier": "f"},
                {"id": "s1", "label": "Switch Akses A", "sub": "PoE 370 W", "tier": "a"},
                {"id": "s2", "label": "Switch Akses B", "sub": "PoE 370 W", "tier": "a"},
                {"id": "core", "label": "Switch Inti", "sub": "10G SFP+", "tier": "c",
                 "accent": True},
                {"id": "nvr", "label": "NVR", "sub": "96 TB", "tier": "c"}],
            "edges": [
                {"from": "c1", "to": "s1", "label": "48 Mbps"},
                {"from": "c2", "to": "s1", "label": "48 Mbps"},
                {"from": "c3", "to": "s2", "label": "44 Mbps"},
                {"from": "s1", "to": "core", "label": "10 Gbps"},
                {"from": "s2", "to": "core", "label": "10 Gbps"},
                {"from": "core", "to": "nvr", "label": "140 Mbps puncak"}],
            "legend": [{"symbol": "data", "label": "aliran video"}]},
        "graph": {
            "family": "graph", "id": "8.1",
            "title": "Peta ketergantungan modul perangkat lunak.",
            "source": "Arsitektur perangkat lunak Rev A",
            "nodes": [
                {"id": "ui", "label": "Antarmuka", "col": 1, "row": 0},
                {"id": "api", "label": "Gerbang API", "col": 1, "row": 1},
                {"id": "auth", "label": "Otentikasi", "col": 0, "row": 2},
                {"id": "db", "label": "Basis Data", "shape": "cylinder", "col": 2, "row": 2}],
            "edges": [
                {"from": "ui", "to": "api", "label": "HTTPS"},
                {"from": "api", "to": "auth", "label": "token"},
                {"from": "api", "to": "db", "label": "SQL"}]},
    }


def png_commands(svg_path, png_path, width_px=2000):
    """Argument lists for the PNG converters, tried in order. Each path is one argument and no
    shell is involved, so quotes, $(...) and backticks in a file name stay part of the name
    (Swarm 1.2.0 decision C103, row 48 M2: this replaced os.system with a shell string). A
    path that starts with "-" gets "./" so a converter cannot read it as an option."""
    svg = os.path.join(".", svg_path) if str(svg_path).startswith("-") else str(svg_path)
    png = os.path.join(".", png_path) if str(png_path).startswith("-") else str(png_path)
    return (["rsvg-convert", "-w", str(int(width_px)), "-o", png, svg],
            ["inkscape", "--export-type=png", f"--export-width={int(width_px)}",
             f"--export-filename={png}", svg])


def to_png(svg_path, png_path, width_px=2000):
    for cmd in png_commands(svg_path, png_path, width_px):
        try:
            rc = subprocess.run(cmd, stderr=subprocess.DEVNULL, check=False).returncode
        except OSError:          # converter not installed: try the next one (was rc 127)
            continue
        if rc == 0 and os.path.exists(png_path):
            return True
    try:
        import cairosvg
        cairosvg.svg2png(url=svg_path, write_to=png_path, output_width=width_px)
        return True
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser(description="DATUM diagram engine")
    ap.add_argument("spec", nargs="?", help="path to a JSON spec, or - for stdin")
    ap.add_argument("-o", "--out", default=None, help="output .svg path (or dir for --selftest)")
    ap.add_argument("--png", default=None, help="also write a PNG here")
    ap.add_argument("--schema", action="store_true", help="print the spec schema")
    ap.add_argument("--selftest", action="store_true", help="emit one sample per family")
    ap.add_argument("--check", action="store_true", help="run the diagram lint and report")
    args = ap.parse_args()

    if args.schema:
        print(SCHEMA)
        return 0

    if args.selftest:
        outdir = args.out or "datum_diagram_gallery"
        os.makedirs(outdir, exist_ok=True)
        bad = 0
        for name, spec in _samples().items():
            d, svg = build(spec)
            path = os.path.join(outdir, f"{name}.svg")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(svg)
            issues = check(svg, spec, d)
            status = "clean" if not issues else "; ".join(issues)
            bad += len(issues)
            print(f"{name:10s} {d.width:6.1f} × {len(svg.splitlines()):4d} lines  → {path}   {status}")
        print(f"\n{len(_samples())} families emitted, {bad} lint finding(s).")
        return 0 if bad == 0 else 1

    if not args.spec:
        ap.print_help()
        return 2
    raw = sys.stdin.read() if args.spec == "-" else open(args.spec, encoding="utf-8").read()
    spec = json.loads(raw)
    d, svg = build(spec)
    out = args.out or (os.path.splitext(args.spec)[0] + ".svg" if args.spec != "-" else "out.svg")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(svg)
    print(f"wrote {out}  ({d.width:.1f} mm wide, {len(d.nodes)} nodes, {len(d.edges)} edges)")
    if args.png:
        print("PNG written" if to_png(out, args.png) else
              "PNG renderer unavailable — install rsvg-convert, inkscape or cairosvg")
    issues = check(svg, spec, d)
    if args.check or issues:
        for i in issues:
            print(f"  LINT {i}")
        if issues:
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
