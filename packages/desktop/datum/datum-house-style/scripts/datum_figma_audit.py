#!/usr/bin/env python3
"""DATUM Figma drift audit — GSP House Style v1.6  (GSP-DS-001)

    python3 datum_figma_audit.py spec.json metadata.xml
    python3 datum_figma_audit.py spec.json metadata.xml --quiet   # exit code only

Why this exists
---------------
A DATUM SVG imports into Figma losslessly — editable vectors, real text, exact geometry at
96 dpi. That makes Figma a genuinely useful place to put a drawing in front of a client or a
colleague who needs to annotate it.

It also makes Figma a place where somebody can quietly retype a number.

The return path does not protect you. Figma's SVG export **outlines every text node** — a
166 mm figure comes back as 628 px of paths with zero `<text>` elements, so the capacities,
the IEC 81346 designations and the SUMBER line survive only as layer names on `<path>`
elements. Nothing downstream can read them: not a PDF search, not `datum_lint.py`, not a
reviewer's find-in-page. So the export can never be re-ingested, and the engine's SVG stays
the controlled artefact.

What CAN be read back losslessly is the Figma node tree via the `get_metadata` MCP tool,
where every text node still carries its string as the layer name. This script diffs that
tree against the spec the drawing was built from and reports:

  · load-bearing values from the spec that are MISSING from the Figma copy — someone
    deleted a source line, a designation, a capacity;
  · text present in Figma that is NOT in the spec — someone added or retyped something,
    which is the case that matters, because a retyped capacity is a number that no longer
    reconciles with the BoQ and nothing else in the chain will catch it.

Workflow:
    1. build the SVG from the spec           datum_diagram.py spec.json -o fig.svg
    2. upload it                             Figma MCP upload_assets (image/svg+xml)
    3. review / annotate in Figma            humans
    4. dump the node tree                    Figma MCP get_metadata → metadata.xml
    5. audit                                 THIS SCRIPT
    6. transcribe accepted changes into the SPEC — never into the Figma copy
    7. rebuild, re-lint, ship the SVG
"""

import argparse
import json
import re
import sys
import unicodedata

# Figma truncates long layer names, so a long source line is compared on its opening run
# rather than in full. Short strings must match exactly.
PREFIX_MATCH_OVER = 40


def norm(s):
    """Normalise for comparison: unicode-fold, collapse whitespace, strip trailing marks."""
    s = unicodedata.normalize("NFKC", str(s))
    s = s.replace(" ", " ").replace("‑", "-")
    return re.sub(r"\s+", " ", s).strip().rstrip(".·")


def fold(s):
    """Case-insensitive key. The engine sets some labels upper case (busbars, tier labels),
    so a case difference is a rendering choice, not drift."""
    return norm(s).casefold()


def figma_texts(xml):
    """Every text node in a get_metadata dump, as its rendered string."""
    out = []
    for m in re.finditer(r'<text\s[^>]*name="([^"]*)"', xml):
        t = norm(m.group(1))
        if t:
            out.append(t)
    return out


def spec_values(spec):
    """Every load-bearing string the drawing is supposed to assert, with its role."""
    vals = []

    def take(v, role):
        if v and str(v).strip():
            vals.append((norm(v), role))

    lang_fig = "GAMBAR" if str(spec.get("lang", "id")).lower() == "id" else "FIGURE"
    if spec.get("id"):
        take(f"{lang_fig} {spec['id']}", "nomor gambar")
    take(spec.get("title"), "kapsi")
    take(spec.get("source"), "SUMBER")
    take(spec.get("provenance"), "PROVENANS")

    for n in spec.get("nodes", []) or []:
        take(n.get("label"), f"nama simpul '{n.get('id')}'")
        take(n.get("sub"), f"spesifikasi '{n.get('id')}'")
        take(n.get("desig"), f"penandaan IEC 81346 '{n.get('id')}'")
        take(n.get("tag"), f"ID persyaratan '{n.get('id')}'")
    for a in spec.get("actors", []) or []:
        if isinstance(a, dict):
            take(a.get("label"), "pelaku")
            take(a.get("sub"), "pelaku")
    for t in spec.get("tiers", []) or []:
        take(t.get("label"), "label strata")
        take(t.get("note"), "catatan strata")
    for l in spec.get("lanes", []) or []:
        take(l.get("label"), "label lajur")
    for e in (spec.get("edges", []) or []) + (spec.get("messages", []) or []):
        take(e.get("label"), f"label sisi {e.get('from')}->{e.get('to')}")
    for b in spec.get("boundaries", []) or []:
        take(b.get("label"), "label zona")
    for g in spec.get("legend", []) or []:
        take(g.get("label"), "keterangan")
    return vals


def present(value, pool):
    """Is this spec value represented in the Figma text pool?"""
    v, fp = fold(value), [fold(p) for p in pool]
    if v in fp:
        return True
    if len(v) > PREFIX_MATCH_OVER:
        head = v[:PREFIX_MATCH_OVER]
        return any(p.startswith(head) or head in p for p in fp)
    return any(v == p or (len(v) > 3 and v in p) for p in fp)


def audit(spec, xml):
    pool = figma_texts(xml)
    vals = spec_values(spec)
    seen = {v for v, _ in vals}

    missing = [(v, r) for v, r in vals if not present(v, pool)]

    extra = []
    for t in pool:
        if t in seen:
            continue
        ft = fold(t)
        if any(ft == fold(v) or (len(ft) > 3 and ft in fold(v))
               or (len(v) > PREFIX_MATCH_OVER and fold(v)[:PREFIX_MATCH_OVER] in ft)
               for v in seen):
            continue
        extra.append(t)

    # Furniture the engine draws that the spec never states — legitimate, not drift.
    # Marks and single glyphs the ENGINE draws — provenance, symbol letters. Never drift.
    FURNITURE = {"SUMBER", "SOURCE", "PROVENANS", "PROVENANCE", "KETERANGAN", "KEY",
                 "GAMBAR", "FIGURE", "PETA", "G", "M", "S",
                 "■", "◈", "◇", "△", "Ø", "•", "|", "X"}
    extra = [t for t in extra if t.upper() not in FURNITURE and not re.fullmatch(r"\d{1,2}", t)]
    return missing, extra, len(pool), len(vals)


def main():
    ap = argparse.ArgumentParser(description="DATUM Figma drift audit")
    ap.add_argument("spec", help="the JSON spec the drawing was built from")
    ap.add_argument("metadata", help="get_metadata XML dump of the Figma node")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()

    spec = json.load(open(a.spec, encoding="utf-8"))
    xml = open(a.metadata, encoding="utf-8").read()
    missing, extra, n_pool, n_vals = audit(spec, xml)

    if not a.quiet:
        print("═" * 78)
        print("AUDIT PENYIMPANGAN FIGMA · DATUM v1.6 · GSP-DS-001")
        print("═" * 78)
        print(f"  nilai pada spec        {n_vals}")
        print(f"  simpul teks di Figma   {n_pool}")
        print()
        if not missing and not extra:
            print("  ✓ salinan Figma sepadan dengan spec. Tidak ada penyimpangan.\n")
        if missing:
            print(f"  ✗ {len(missing)} nilai spec TIDAK ADA di salinan Figma:")
            for v, r in missing[:14]:
                print(f"      [{r}] {v[:78]}")
            if len(missing) > 14:
                print(f"      … dan {len(missing)-14} lagi")
            print()
        if extra:
            print(f"  ⚠ {len(extra)} teks di Figma TIDAK ADA di spec — kemungkinan diedit peninjau:")
            for t in extra[:14]:
                print(f"      {t[:78]}")
            if len(extra) > 14:
                print(f"      … dan {len(extra)-14} lagi")
            print()
            print("  Setiap perubahan yang diterima disalin ke SPEC, bukan ke salinan Figma.")
            print("  Ekspor Figma meng-outline seluruh teks dan tidak dapat dibaca ulang.")
        print("═" * 78)
    return 1 if (missing or extra) else 0


if __name__ == "__main__":
    sys.exit(main())
