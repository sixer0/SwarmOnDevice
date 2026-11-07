#!/usr/bin/env python3
"""DATUM standards symbol library — GSP House Style v1.4  (GSP-DS-001)

    python3 datum_symbols.py --list                 # catalogue with standard references
    python3 datum_symbols.py --sheet symbols.svg    # draw every symbol as a proof sheet
    python3 datum_symbols.py --check iec:breaker    # resolve one id and print its metadata

Four libraries, each drawn to its own standard's proportions:

    iec:*   IEC 60617 DB          electrical and power, single-line and schematic
    isa:*   ANSI/ISA-5.1-2022     instrumentation, P&ID bubbles, valves, actuators
    sec:*   GSP project legend    security and surveillance site plans — SEE THE WARNING
    mil:*   MIL-STD-2525E         standard identity frames and echelon amplifiers

Why the sec:* warning matters
-----------------------------
IEC 62676 and EN 50132 govern video-surveillance system requirements, interfaces and
application guidance — DORI, image quality, recording. **Neither publishes a graphical
symbol set for site plans.** No international standard does. So `sec:*` is GSP's own
documented project legend, and every drawing that uses it must reproduce that legend and
say so. Passing a house mark off as a standard symbol is the one error that costs more
than omitting the symbol, because a reviewer who knows the standard will find it and will
then doubt every other claim on the sheet.

Geometry note
-------------
Every symbol is authored in a unit box (0..1 in both axes) and mapped onto its placed
rectangle, so a symbol keeps its proportions at any size. Ports are the terminals the
router may attach to, returned in absolute mm.
"""

import argparse
import math
import sys

MM_PT = 0.3527777778

# ─────────────────────────── catalogue metadata ───────────────────────────

STANDARDS = {
    "iec": {
        "id": "IEC 60617 DB",
        "title": "Graphical symbols for diagrams",
        "note": "Online database comprising parts 2 to 13. Symbol references below are the "
                "conventional forms; verify the exact database entry before a drawing is "
                "issued for construction.",
        "status": "current",
    },
    "isa": {
        "id": "ANSI/ISA-5.1-2022",
        "title": "Instrumentation Symbols and Identification",
        "note": "Supersedes ANSI/ISA-5.1-2009. The 2022 revision is a maintenance revision "
                "— usage clarifications and correction of errors, not a redesign.",
        "status": "current",
    },
    "sec": {
        "id": "GSP project legend",
        "title": "Security and surveillance site-plan marks",
        "note": "NOT A STANDARD. IEC 62676 (video surveillance systems) and EN 50132 govern "
                "system requirements, interfaces and application guidance, not graphical "
                "symbols. No international symbol set exists for security site plans. These "
                "marks are GSP's own and every drawing using them MUST carry the legend.",
        "status": "house",
    },
    "mil": {
        "id": "MIL-STD-2525E (31 December 2022)",
        "title": "Joint Military Symbology",
        "note": "Supersedes MIL-STD-2525D. NATO APP-6(D) 2017 shares the modern model and "
                "reads most 2525E codes. Identity is carried by FRAME SHAPE, which is why "
                "these render correctly in monochrome.",
        "status": "current",
    },
}


# ─────────────────────────── drawing helpers ───────────────────────────

class Box:
    """Maps unit coordinates (0..1, origin top-left) onto a placed rectangle in mm."""

    def __init__(self, x, y, w, h):
        self.x, self.y, self.w, self.h = x, y, w, h

    def p(self, u, v):
        return self.x + u * self.w, self.y + v * self.h

    def s(self, f):
        return f * min(self.w, self.h)


def _path(d, colour, sw, fill="none", cap="round", extra=""):
    return (f'<path d="{d}" fill="{fill}" stroke="{colour}" stroke-width="{sw:.2f}" '
            f'stroke-linecap="{cap}" stroke-linejoin="miter"{extra}/>')


def _line(b, u1, v1, u2, v2, colour, sw):
    x1, y1 = b.p(u1, v1)
    x2, y2 = b.p(u2, v2)
    return _path(f"M {x1:.2f} {y1:.2f} L {x2:.2f} {y2:.2f}", colour, sw, cap="butt")


def _circle(b, u, v, r, colour, sw, fill="none"):
    cx, cy = b.p(u, v)
    return (f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{b.s(r):.2f}" fill="{fill}" '
            f'stroke="{colour}" stroke-width="{sw:.2f}"/>')


def _text(b, u, v, s, pt, colour, weight=600, anchor="middle", face=None):
    x, y = b.p(u, v)
    face = face or "'IBM Plex Sans Condensed','IBM Plex Sans',sans-serif"
    size = pt * MM_PT
    return (f'<text x="{x:.2f}" y="{y + size * 0.35:.2f}" font-family="{face}" '
            f'font-size="{size:.3f}" font-weight="{weight}" fill="{colour}" '
            f'text-anchor="{anchor}">{s}</text>')


def _poly(b, pts, colour, sw, fill="none", close=True):
    d = "M " + " L ".join(f"{b.p(u, v)[0]:.2f} {b.p(u, v)[1]:.2f}" for u, v in pts)
    if close:
        d += " Z"
    return _path(d, colour, sw, fill, cap="butt")


# ─────────────────────────── IEC 60617 · electrical ───────────────────────────
# Conventional forms. The switching devices share one construction: a fixed contact, a
# hinged blade at 30 degrees, and a distinguishing mark that says WHICH device it is —
# which is the whole point of the family and the thing most redrawings get wrong.

def _switch_body(b, colour, sw, mark=None):
    """Common switching-device body: terminals top and bottom, blade open at 30°."""
    g = [_line(b, 0.5, 0.0, 0.5, 0.28, colour, sw),          # upper terminal lead
         _line(b, 0.5, 0.72, 0.5, 1.0, colour, sw),          # lower terminal lead
         _line(b, 0.5, 0.72, 0.76, 0.34, colour, sw)]        # the blade, swung open
    cx, cy = b.p(0.5, 0.28)
    g.append(f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{b.s(0.035):.2f}" '
             f'fill="{colour}" stroke="none"/>')
    if mark == "breaker":                                     # × on the fixed contact
        x, y = b.p(0.5, 0.28)
        r = b.s(0.11)
        g.append(_path(f"M {x-r:.2f} {y-r:.2f} L {x+r:.2f} {y+r:.2f} "
                       f"M {x+r:.2f} {y-r:.2f} L {x-r:.2f} {y+r:.2f}", colour, sw, cap="butt"))
    elif mark == "disconnector":                              # bar across the fixed contact
        g.append(_line(b, 0.36, 0.24, 0.64, 0.24, colour, sw))
    elif mark == "contactor":                                 # arc, contact held closed
        x, y = b.p(0.5, 0.30)
        r = b.s(0.13)
        g.append(_path(f"M {x-r:.2f} {y:.2f} A {r:.2f} {r:.2f} 0 0 0 {x+r:.2f} {y:.2f}",
                       colour, sw))
    return g


def iec_breaker(b, colour, sw):
    return _switch_body(b, colour, sw, "breaker")


def iec_disconnector(b, colour, sw):
    return _switch_body(b, colour, sw, "disconnector")


def iec_contactor(b, colour, sw):
    return _switch_body(b, colour, sw, "contactor")


def iec_switch(b, colour, sw):
    return _switch_body(b, colour, sw, None)


def iec_changeover(b, colour, sw):
    """Changeover contact — the honest way to draw an automatic transfer switch. There is
    no single IEC symbol for 'ATS'; it is a changeover device plus a control function, and
    drawing it as one invented block hides that."""
    g = [_line(b, 0.5, 0.72, 0.5, 1.0, colour, sw),
         _line(b, 0.26, 0.0, 0.26, 0.26, colour, sw),
         _line(b, 0.74, 0.0, 0.74, 0.26, colour, sw),
         _line(b, 0.5, 0.72, 0.30, 0.32, colour, sw)]
    for u in (0.26, 0.74):
        cx, cy = b.p(u, 0.26)
        g.append(f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{b.s(0.035):.2f}" '
                 f'fill="{colour}" stroke="none"/>')
    return g


def iec_fuse(b, colour, sw):
    return [_line(b, 0.5, 0.0, 0.5, 0.22, colour, sw),
            _line(b, 0.5, 0.78, 0.5, 1.0, colour, sw),
            _poly(b, [(0.33, 0.22), (0.67, 0.22), (0.67, 0.78), (0.33, 0.78)], colour, sw),
            _line(b, 0.5, 0.22, 0.5, 0.78, colour, sw)]


def iec_generator(b, colour, sw):
    return [_circle(b, 0.5, 0.5, 0.34, colour, sw),
            _text(b, 0.5, 0.5, "G", 8.4, colour),
            _line(b, 0.5, 0.84, 0.5, 1.0, colour, sw)]


def iec_motor(b, colour, sw):
    return [_circle(b, 0.5, 0.5, 0.34, colour, sw),
            _text(b, 0.5, 0.5, "M", 8.4, colour),
            _line(b, 0.5, 0.0, 0.5, 0.16, colour, sw)]


def iec_transformer(b, colour, sw):
    """Two-winding transformer, the two-circle form: circles overlapping on the axis."""
    return [_circle(b, 0.5, 0.36, 0.26, colour, sw),
            _circle(b, 0.5, 0.64, 0.26, colour, sw),
            _line(b, 0.5, 0.0, 0.5, 0.10, colour, sw),
            _line(b, 0.5, 0.90, 0.5, 1.0, colour, sw)]


def iec_ct(b, colour, sw):
    """Current transformer: the primary conductor passing through one winding circle."""
    return [_line(b, 0.5, 0.0, 0.5, 1.0, colour, sw),
            _circle(b, 0.74, 0.5, 0.20, colour, sw),
            _line(b, 0.94, 0.5, 1.0, 0.5, colour, sw)]


def iec_arrester(b, colour, sw):
    """Surge arrester: enclosure with the discharge arrow toward earth."""
    return [_line(b, 0.5, 0.0, 0.5, 0.20, colour, sw),
            _poly(b, [(0.32, 0.20), (0.68, 0.20), (0.68, 0.74), (0.32, 0.74)], colour, sw),
            _path(f"M {b.p(0.5, 0.28)[0]:.2f} {b.p(0.5, 0.28)[1]:.2f} "
                  f"L {b.p(0.5, 0.66)[0]:.2f} {b.p(0.5, 0.66)[1]:.2f}", colour, sw, cap="butt"),
            _poly(b, [(0.42, 0.56), (0.58, 0.56), (0.5, 0.70)], colour, sw, fill=colour),
            _line(b, 0.5, 0.74, 0.5, 1.0, colour, sw)]


def iec_earth(b, colour, sw):
    return [_line(b, 0.5, 0.0, 0.5, 0.48, colour, sw),
            _line(b, 0.22, 0.48, 0.78, 0.48, colour, sw),
            _line(b, 0.32, 0.66, 0.68, 0.66, colour, sw),
            _line(b, 0.42, 0.84, 0.58, 0.84, colour, sw)]


def iec_battery(b, colour, sw):
    g = [_line(b, 0.5, 0.0, 0.5, 0.24, colour, sw), _line(b, 0.5, 0.76, 0.5, 1.0, colour, sw)]
    for i, v in enumerate((0.32, 0.46, 0.60)):
        long = i % 2 == 0
        half = 0.30 if long else 0.16
        g.append(_line(b, 0.5 - half, v, 0.5 + half, v, colour, sw))
    g.append(_line(b, 0.34, 0.74, 0.66, 0.74, colour, sw))
    return g


def iec_lamp(b, colour, sw):
    r = 0.30
    return [_circle(b, 0.5, 0.5, r, colour, sw),
            _line(b, 0.5 - r * 0.71, 0.5 - r * 0.71, 0.5 + r * 0.71, 0.5 + r * 0.71, colour, sw),
            _line(b, 0.5 + r * 0.71, 0.5 - r * 0.71, 0.5 - r * 0.71, 0.5 + r * 0.71, colour, sw)]


def iec_busbar(b, colour, sw):
    x1, y1 = b.p(0.0, 0.5)
    x2, _ = b.p(1.0, 0.5)
    return [_path(f"M {x1:.2f} {y1:.2f} L {x2:.2f} {y1:.2f}", colour, sw * 3.0, cap="butt")]


def iec_enclosure(b, colour, sw):
    """A functional block with no dedicated IEC symbol — a UPS, a rectifier, a converter.
    Drawn as an enclosure carrying its designation, which is the standard-compliant way to
    say 'equipment identified by its reference designation' rather than inventing a glyph."""
    return [_poly(b, [(0.10, 0.14), (0.90, 0.14), (0.90, 0.86), (0.10, 0.86)], colour, sw),
            _line(b, 0.5, 0.0, 0.5, 0.14, colour, sw),
            _line(b, 0.5, 0.86, 0.5, 1.0, colour, sw)]


# ─────────────────────────── ISA-5.1 · instrumentation ───────────────────────────
# The bubble grid: SHAPE says what kind of function, the horizontal LINE says where it
# lives. Both axes are meaningful and neither may be dropped.

def _bubble(b, colour, sw, shape="circle", location="field"):
    g = []
    if shape == "circle":
        g.append(_circle(b, 0.5, 0.5, 0.40, colour, sw))
    elif shape == "shared":                                   # circle inscribed in a square
        g.append(_poly(b, [(0.10, 0.10), (0.90, 0.10), (0.90, 0.90), (0.10, 0.90)], colour, sw))
        g.append(_circle(b, 0.5, 0.5, 0.40, colour, sw))
    elif shape == "computer":                                 # hexagon
        g.append(_poly(b, [(0.10, 0.50), (0.30, 0.12), (0.70, 0.12),
                           (0.90, 0.50), (0.70, 0.88), (0.30, 0.88)], colour, sw))
    elif shape == "plc":                                      # diamond inscribed in a square
        g.append(_poly(b, [(0.10, 0.10), (0.90, 0.10), (0.90, 0.90), (0.10, 0.90)], colour, sw))
        g.append(_poly(b, [(0.50, 0.12), (0.88, 0.50), (0.50, 0.88), (0.12, 0.50)], colour, sw))
    if location == "primary":
        g.append(_line(b, 0.10, 0.50, 0.90, 0.50, colour, sw))
    elif location == "auxiliary":
        g.append(_line(b, 0.10, 0.44, 0.90, 0.44, colour, sw))
        g.append(_line(b, 0.10, 0.56, 0.90, 0.56, colour, sw))
    elif location == "inaccessible":
        x1, y1 = b.p(0.10, 0.50)
        x2, _ = b.p(0.90, 0.50)
        g.append(_path(f"M {x1:.2f} {y1:.2f} L {x2:.2f} {y1:.2f}", colour, sw,
                       extra=' stroke-dasharray="1.2 1.0"'))
    return g


def isa_field(b, c, s):        return _bubble(b, c, s, "circle", "field")
def isa_primary(b, c, s):      return _bubble(b, c, s, "circle", "primary")
def isa_auxiliary(b, c, s):    return _bubble(b, c, s, "circle", "auxiliary")
def isa_inaccessible(b, c, s): return _bubble(b, c, s, "circle", "inaccessible")
def isa_shared(b, c, s):       return _bubble(b, c, s, "shared", "primary")
def isa_shared_field(b, c, s): return _bubble(b, c, s, "shared", "field")
def isa_computer(b, c, s):     return _bubble(b, c, s, "computer", "primary")
def isa_plc(b, c, s):          return _bubble(b, c, s, "plc", "primary")


def isa_valve(b, colour, sw):
    """Control valve body — the two triangles apex to apex, with the stem."""
    return [_poly(b, [(0.14, 0.52), (0.14, 0.94), (0.50, 0.73)], colour, sw),
            _poly(b, [(0.86, 0.52), (0.86, 0.94), (0.50, 0.73)], colour, sw),
            _line(b, 0.0, 0.73, 0.14, 0.73, colour, sw),
            _line(b, 0.86, 0.73, 1.0, 0.73, colour, sw),
            _line(b, 0.5, 0.73, 0.5, 0.42, colour, sw)]


def isa_act_diaphragm(b, colour, sw):
    g = isa_valve(b, colour, sw)
    x, y = b.p(0.5, 0.42)
    r = b.s(0.24)
    g.append(_path(f"M {x-r:.2f} {y:.2f} A {r:.2f} {r*0.8:.2f} 0 0 1 {x+r:.2f} {y:.2f} Z",
                   colour, sw))
    return g


def isa_act_motor(b, colour, sw):
    g = isa_valve(b, colour, sw)
    g.append(_circle(b, 0.5, 0.26, 0.20, colour, sw))
    g.append(_text(b, 0.5, 0.26, "M", 6.4, colour))
    return g


def isa_act_solenoid(b, colour, sw):
    g = isa_valve(b, colour, sw)
    g.append(_poly(b, [(0.30, 0.10), (0.70, 0.10), (0.70, 0.42), (0.30, 0.42)], colour, sw))
    g.append(_text(b, 0.5, 0.26, "S", 6.4, colour))
    return g


# ─────────────────────────── GSP legend · security site plan ─────────────────────
# House marks. See the module docstring: no international symbol standard exists for this
# domain, so these must always be published with the drawing.

def sec_camera(b, colour, sw):
    """Camera body with its field-of-view cone. The cone angle is NOT decorative — it is
    set from the real focal length by the caller, so a coverage plan can be measured off
    the drawing rather than believed."""
    return [_poly(b, [(0.36, 0.62), (0.64, 0.62), (0.64, 0.86), (0.36, 0.86)], colour, sw),
            _poly(b, [(0.64, 0.68), (0.78, 0.62), (0.78, 0.86), (0.64, 0.80)], colour, sw),
            _poly(b, [(0.50, 0.62), (0.16, 0.10), (0.84, 0.10)], colour, sw * 0.7,
                  fill="none")]


def sec_ptz(b, colour, sw):
    g = sec_camera(b, colour, sw)
    cx, cy = b.p(0.50, 0.74)
    r = b.s(0.20)
    g.append(_path(f"M {cx-r:.2f} {cy:.2f} A {r:.2f} {r:.2f} 0 1 1 {cx:.2f} {cy+r:.2f}",
                   colour, sw * 0.8))
    return g


def sec_pir(b, colour, sw):
    return [_poly(b, [(0.30, 0.62), (0.70, 0.62), (0.70, 0.86), (0.30, 0.86)], colour, sw),
            _path(f"M {b.p(0.22,0.46)[0]:.2f} {b.p(0.22,0.46)[1]:.2f} "
                  f"A {b.s(0.34):.2f} {b.s(0.34):.2f} 0 0 1 {b.p(0.78,0.46)[0]:.2f} "
                  f"{b.p(0.78,0.46)[1]:.2f}", colour, sw * 0.7),
            _text(b, 0.5, 0.74, "IR", 5.4, colour)]


def sec_fence(b, colour, sw):
    """Fence-mounted detection: the fence line with the sensor cable zig-zag on it."""
    g = [_line(b, 0.0, 0.70, 1.0, 0.70, colour, sw)]
    for u in (0.15, 0.38, 0.61, 0.84):
        g.append(_line(b, u, 0.52, u, 0.88, colour, sw * 0.7))
    pts = []
    for i in range(9):
        pts.append((0.06 + i * 0.11, 0.34 if i % 2 == 0 else 0.52))
    d = "M " + " L ".join(f"{b.p(u,v)[0]:.2f} {b.p(u,v)[1]:.2f}" for u, v in pts)
    g.append(_path(d, colour, sw))
    return g


def sec_reader(b, colour, sw):
    return [_poly(b, [(0.34, 0.24), (0.66, 0.24), (0.66, 0.80), (0.34, 0.80)], colour, sw),
            _circle(b, 0.50, 0.42, 0.08, colour, sw),
            _line(b, 0.40, 0.62, 0.60, 0.62, colour, sw)]


def sec_barrier(b, colour, sw):
    return [_poly(b, [(0.10, 0.58), (0.24, 0.58), (0.24, 0.90), (0.10, 0.90)], colour, sw),
            _line(b, 0.24, 0.66, 0.94, 0.40, colour, sw * 1.4),
            _line(b, 0.90, 0.34, 0.98, 0.46, colour, sw * 0.7)]


def sec_mast(b, colour, sw):
    return [_line(b, 0.5, 0.24, 0.5, 0.92, colour, sw),
            _line(b, 0.34, 0.92, 0.66, 0.92, colour, sw),
            _poly(b, [(0.30, 0.24), (0.70, 0.24), (0.62, 0.10), (0.38, 0.10)], colour, sw),
            _line(b, 0.30, 0.34, 0.22, 0.44, colour, sw * 0.6),
            _line(b, 0.70, 0.34, 0.78, 0.44, colour, sw * 0.6)]


# ─────────────────────────── MIL-STD-2525E · identity frames ─────────────────────
# Identity is carried by FRAME SHAPE. That is deliberate in the standard, and it is why
# these survive DATUM's monochrome and photocopy rules without a colour being spent.

def _mil_frame(b, colour, sw, identity, dim="land"):
    u0, u1 = 0.08, 0.92
    if dim == "air":
        v0, v1 = 0.20, 0.86
        if identity == "friend":
            return [_path(f"M {b.p(u0,v1)[0]:.2f} {b.p(u0,v1)[1]:.2f} L {b.p(u0,v0+0.10)[0]:.2f} "
                          f"{b.p(u0,v0+0.10)[1]:.2f} A {b.s(0.42):.2f} {b.s(0.42):.2f} 0 0 1 "
                          f"{b.p(u1,v0+0.10)[0]:.2f} {b.p(u1,v0+0.10)[1]:.2f} L "
                          f"{b.p(u1,v1)[0]:.2f} {b.p(u1,v1)[1]:.2f}", colour, sw, cap="butt")]
        if identity == "hostile":
            return [_poly(b, [(u0, v1), (u0, 0.44), (0.50, v0), (u1, 0.44), (u1, v1)],
                          colour, sw, close=False)]
        if identity == "neutral":
            return [_poly(b, [(u0, v1), (u0, v0), (u1, v0), (u1, v1)], colour, sw, close=False)]
        return [_path(f"M {b.p(0.24,v1)[0]:.2f} {b.p(0.24,v1)[1]:.2f} "
                      f"A {b.s(0.20):.2f} {b.s(0.20):.2f} 0 1 1 {b.p(0.50,0.34)[0]:.2f} "
                      f"{b.p(0.50,0.34)[1]:.2f} A {b.s(0.20):.2f} {b.s(0.20):.2f} 0 1 1 "
                      f"{b.p(0.76,v1)[0]:.2f} {b.p(0.76,v1)[1]:.2f}", colour, sw, cap="butt")]
    # Land dimension. Aspect is load-bearing here in a way it is nowhere else in DATUM:
    # identity IS the frame shape, so a neutral square drawn slightly wide reads as a
    # friendly rectangle, and the drawing then asserts the wrong affiliation. These are
    # therefore sized in absolute mm off the short edge, not as fractions of the cell.
    s = min(b.w, b.h)
    cx, cy = b.p(0.5, 0.5)

    def rect(hw, hh):
        return _path(f"M {cx-hw:.2f} {cy-hh:.2f} L {cx+hw:.2f} {cy-hh:.2f} "
                     f"L {cx+hw:.2f} {cy+hh:.2f} L {cx-hw:.2f} {cy+hh:.2f} Z",
                     colour, sw, cap="butt")

    if identity == "friend":                       # rectangle, distinctly wider than tall
        return [rect(s * 0.48, s * 0.33)]
    if identity == "neutral":                      # square — never a rectangle
        return [rect(s * 0.38, s * 0.38)]
    if identity == "hostile":                      # diamond, point up
        r = s * 0.46
        return [_path(f"M {cx:.2f} {cy-r:.2f} L {cx+r:.2f} {cy:.2f} "
                      f"L {cx:.2f} {cy+r:.2f} L {cx-r:.2f} {cy:.2f} Z", colour, sw, cap="butt")]
    # unknown — the quatrefoil
    g, r = [], b.s(0.19)
    lobes = [(0.50, 0.26), (0.74, 0.52), (0.50, 0.78), (0.26, 0.52)]
    d = []
    for i, (u, v) in enumerate(lobes):
        cx, cy = b.p(u, v)
        d.append(f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r:.2f}" fill="none" '
                 f'stroke="{colour}" stroke-width="{sw:.2f}"/>')
    g.extend(d)
    return g


def mil_friend(b, c, s):   return _mil_frame(b, c, s, "friend")
def mil_hostile(b, c, s):  return _mil_frame(b, c, s, "hostile")
def mil_neutral(b, c, s):  return _mil_frame(b, c, s, "neutral")
def mil_unknown(b, c, s):  return _mil_frame(b, c, s, "unknown")
def mil_friend_air(b, c, s):  return _mil_frame(b, c, s, "friend", "air")
def mil_hostile_air(b, c, s): return _mil_frame(b, c, s, "hostile", "air")


ECHELON = {
    "team": "Ø", "crew": "Ø", "squad": "•", "section": "••", "platoon": "•••",
    "company": "|", "battalion": "||", "regiment": "|||", "brigade": "X",
    "division": "XX", "corps": "XXX", "army": "XXXX",
}


def echelon_mark(b, colour, echelon):
    """Echelon amplifier, centred above the frame. Size is an amplifier, never a frame
    change — a battalion and a division share a frame and differ only here."""
    sym = ECHELON.get(str(echelon).lower())
    if not sym:
        return []
    return [_text(b, 0.5, -0.06, sym, 7.0, colour, 600)]


# ─────────────────────────── registry ───────────────────────────

def _e(fn, std, ref, name, ports, aspect=1.0):
    return {"draw": fn, "std": std, "ref": ref, "name": name, "ports": ports, "aspect": aspect}

V = {"in": (0.5, 0.0), "out": (0.5, 1.0)}
H = {"in": (0.0, 0.5), "out": (1.0, 0.5)}
BOTH = {"in": (0.5, 0.0), "out": (0.5, 1.0), "left": (0.0, 0.5), "right": (1.0, 0.5)}

SYMBOLS = {
    # IEC 60617 — electrical and power
    "iec:breaker":      _e(iec_breaker, "iec", "switching device, circuit-breaker", "Pemutus daya", V),
    "iec:disconnector": _e(iec_disconnector, "iec", "switching device, disconnector", "Pemisah", V),
    "iec:contactor":    _e(iec_contactor, "iec", "switching device, contactor", "Kontaktor", V),
    "iec:switch":       _e(iec_switch, "iec", "switching device, general", "Sakelar", V),
    "iec:changeover":   _e(iec_changeover, "iec", "changeover contact", "Kontak pindah (ATS)", BOTH),
    "iec:fuse":         _e(iec_fuse, "iec", "fuse, general", "Sekring", V),
    "iec:generator":    _e(iec_generator, "iec", "generator, general", "Generator", V),
    "iec:motor":        _e(iec_motor, "iec", "motor, general", "Motor", V),
    "iec:transformer":  _e(iec_transformer, "iec", "transformer, two windings", "Transformator", V),
    "iec:ct":           _e(iec_ct, "iec", "current transformer", "Trafo arus", BOTH),
    "iec:arrester":     _e(iec_arrester, "iec", "surge arrester", "Penangkap surja", V),
    "iec:earth":        _e(iec_earth, "iec", "earth, general", "Pembumian", {"in": (0.5, 0.0)}),
    "iec:battery":      _e(iec_battery, "iec", "battery / cell", "Baterai", V),
    "iec:lamp":         _e(iec_lamp, "iec", "lamp, general", "Lampu", V),
    "iec:busbar":       _e(iec_busbar, "iec", "busbar", "Rel daya", H, aspect=4.0),
    "iec:enclosure":    _e(iec_enclosure, "iec", "item identified by reference designation",
                           "Blok fungsi (UPS, penyearah)", V),

    # ISA-5.1 — instrumentation
    "isa:field":        _e(isa_field, "isa", "discrete instrument, field mounted", "Instrumen lapangan", BOTH),
    "isa:primary":      _e(isa_primary, "isa", "discrete instrument, primary location",
                           "Instrumen ruang kendali", BOTH),
    "isa:auxiliary":    _e(isa_auxiliary, "isa", "discrete instrument, auxiliary location",
                           "Instrumen lokasi bantu", BOTH),
    "isa:inaccessible": _e(isa_inaccessible, "isa", "instrument, inaccessible / behind panel",
                           "Instrumen tak terjangkau", BOTH),
    "isa:shared":       _e(isa_shared, "isa", "shared display / shared control",
                           "Tampilan bersama", BOTH),
    "isa:shared_field": _e(isa_shared_field, "isa", "shared display, field mounted",
                           "Tampilan bersama lapangan", BOTH),
    "isa:computer":     _e(isa_computer, "isa", "computer function", "Fungsi komputer", BOTH),
    "isa:plc":          _e(isa_plc, "isa", "programmable logic control", "PLC", BOTH),
    "isa:valve":        _e(isa_valve, "isa", "control valve body", "Katup kendali", H),
    "isa:valve_diaphragm": _e(isa_act_diaphragm, "isa", "valve, diaphragm actuator",
                              "Katup aktuator diafragma", H),
    "isa:valve_motor":  _e(isa_act_motor, "isa", "valve, motor actuator", "Katup aktuator motor", H),
    "isa:valve_solenoid": _e(isa_act_solenoid, "isa", "valve, solenoid actuator",
                             "Katup aktuator solenoid", H),

    # GSP project legend — security site plan (NOT a standard)
    "sec:camera":  _e(sec_camera, "sec", "GSP legend", "Kamera tetap + kerucut pandang", BOTH),
    "sec:ptz":     _e(sec_ptz, "sec", "GSP legend", "Kamera PTZ", BOTH),
    "sec:pir":     _e(sec_pir, "sec", "GSP legend", "Detektor gerak inframerah", BOTH),
    "sec:fence":   _e(sec_fence, "sec", "GSP legend", "Sensor pagar", H, aspect=2.2),
    "sec:reader":  _e(sec_reader, "sec", "GSP legend", "Pembaca akses", BOTH),
    "sec:barrier": _e(sec_barrier, "sec", "GSP legend", "Palang kendaraan", H, aspect=1.6),
    "sec:mast":    _e(sec_mast, "sec", "GSP legend", "Tiang lampu / kamera", BOTH),

    # MIL-STD-2525E — identity frames
    "mil:friend":      _e(mil_friend, "mil", "standard identity, friend, land", "Kawan (darat)", BOTH),
    "mil:hostile":     _e(mil_hostile, "mil", "standard identity, hostile, land", "Lawan (darat)", BOTH),
    "mil:neutral":     _e(mil_neutral, "mil", "standard identity, neutral, land", "Netral (darat)", BOTH),
    "mil:unknown":     _e(mil_unknown, "mil", "standard identity, unknown, land", "Tak dikenal (darat)", BOTH),
    "mil:friend_air":  _e(mil_friend_air, "mil", "standard identity, friend, air", "Kawan (udara)", BOTH),
    "mil:hostile_air": _e(mil_hostile_air, "mil", "standard identity, hostile, air", "Lawan (udara)", BOTH),
}

DIALECTS = {"iec": "IEC 60617", "isa": "ISA-5.1", "sec": "GSP legend", "mil": "MIL-STD-2525E"}


def resolve(sym_id):
    return SYMBOLS.get(str(sym_id).strip().lower())


def dialect(sym_id):
    return str(sym_id).split(":", 1)[0].lower() if ":" in str(sym_id) else None


def render(sym_id, x, y, w, h, colour="#101418", sw=0.30, echelon=None):
    """Draw a symbol into a placed rectangle. Returns (svg_string, ports_in_mm)."""
    entry = resolve(sym_id)
    if not entry:
        raise KeyError(f"unknown symbol '{sym_id}'. Known dialects: "
                       f"{', '.join(sorted(DIALECTS))}. Use --list to see the catalogue.")
    b = Box(x, y, w, h)
    parts = entry["draw"](b, colour, sw)
    if echelon and dialect(sym_id) == "mil":
        parts += echelon_mark(b, colour, echelon)
    ports = {name: b.p(u, v) for name, (u, v) in entry["ports"].items()}
    return "".join(parts), ports


# ─────────────────────────── proof sheet ───────────────────────────

def sheet(path="datum_symbols.svg", width=166.0):
    ink, meta = "#101418", "#6B7783"
    cell_w, cell_h, gap = 24.0, 24.0, 4.0
    per_row = int((width + gap) // (cell_w + gap))
    out, y = [], 10.0
    for fam in ("iec", "isa", "sec", "mil"):
        ids = [k for k in SYMBOLS if dialect(k) == fam]
        std = STANDARDS[fam]
        out.append(f'<text x="0" y="{y:.2f}" font-family="\'IBM Plex Sans Condensed\',sans-serif" '
                   f'font-size="2.7" font-weight="600" letter-spacing="0.24" fill="{ink}">'
                   f'{std["id"].upper()} · {std["title"].upper()}</text>')
        y += 4.0
        for i, sid in enumerate(ids):
            col = i % per_row
            if col == 0 and i:
                y += cell_h + 9.0
            x = col * (cell_w + gap)
            svg, _ = render(sid, x + 3.0, y, cell_w - 6.0, cell_h, ink, 0.30,
                            echelon="battalion" if sid == "mil:friend" else None)
            out.append(svg)
            out.append(f'<text x="{x + cell_w/2:.2f}" y="{y + cell_h + 3.2:.2f}" '
                       f'font-family="\'IBM Plex Mono\',monospace" font-size="2.1" '
                       f'fill="{meta}" text-anchor="middle">{sid}</text>')
            out.append(f'<text x="{x + cell_w/2:.2f}" y="{y + cell_h + 6.2:.2f}" '
                       f'font-family="\'IBM Plex Sans Condensed\',sans-serif" font-size="2.2" '
                       f'fill="{ink}" text-anchor="middle">{SYMBOLS[sid]["name"]}</text>')
        y += cell_h + 14.0
    h = y
    doc = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}mm" height="{h:.1f}mm" '
           f'viewBox="0 0 {width} {h:.1f}"><rect width="{width}" height="{h:.1f}" '
           f'fill="#FCFCFB"/>' + "".join(out) + "</svg>")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(doc)
    return path, len(SYMBOLS)


def main():
    ap = argparse.ArgumentParser(description="DATUM standards symbol library")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--sheet", nargs="?", const="datum_symbols.svg")
    ap.add_argument("--check")
    args = ap.parse_args()

    if args.check:
        e = resolve(args.check)
        if not e:
            print(f"unknown symbol '{args.check}'")
            return 1
        std = STANDARDS[dialect(args.check)]
        print(f"{args.check}\n  name      {e['name']}\n  standard  {std['id']}\n"
              f"  reference {e['ref']}\n  ports     {', '.join(e['ports'])}\n"
              f"  status    {std['status']}\n  note      {std['note']}")
        return 0

    if args.sheet:
        path, n = sheet(args.sheet)
        print(f"wrote {path} — {n} symbols across {len(STANDARDS)} libraries")
        return 0

    for fam, std in STANDARDS.items():
        flag = "  ⚠ HOUSE LEGEND, NOT A STANDARD" if std["status"] == "house" else ""
        print(f"\n{std['id']} — {std['title']}{flag}")
        for sid, e in SYMBOLS.items():
            if dialect(sid) == fam:
                print(f"  {sid:24s} {e['name']:34s} {e['ref']}")
    print(f"\n{len(SYMBOLS)} symbols. Pick ONE dialect per drawing.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
