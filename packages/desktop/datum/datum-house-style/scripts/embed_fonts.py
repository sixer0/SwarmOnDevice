#!/usr/bin/env python3
"""Embed TrueType fonts into an OOXML file (.docx / .pptx) using the
MS obfuscated-font (.odttf) scheme, so the document renders identically on any
machine regardless of what the recipient has installed.

Obfuscation per ECMA-376 Part 4 / MS-OFFCRYPTO: the 16 bytes derived from the
font GUID are XORed over the first 32 bytes of the font file (twice, 16+16).
"""
import zipfile, shutil, re, uuid, os, sys
from lxml import etree

NS = {
    'ct': 'http://schemas.openxmlformats.org/package/2006/content-types',
    'r':  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'w':  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    'pr': 'http://schemas.openxmlformats.org/package/2006/relationships',
}
W = '{%s}' % NS['w']
R = '{%s}' % NS['r']
FONT_RELTYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/font'
ODTTF_CT = 'application/vnd.openxmlformats-officedocument.obfuscatedFont'


def obfuscate(data: bytes, guid: str) -> bytes:
    key = bytes.fromhex(guid.strip('{}').replace('-', ''))[::-1]   # 16 bytes, reversed
    out = bytearray(data)
    for i in range(32):
        out[i] ^= key[i % 16]
    return bytes(out)


def embed(path_in, path_out, families):
    """families: {'IBM Plex Serif': {'Regular': ttf, 'Bold': ttf, 'Italic': ttf, 'BoldItalic': ttf}, ...}"""
    zin = zipfile.ZipFile(path_in)
    names = zin.namelist()
    part = 'word' if any(n.startswith('word/') for n in names) else 'ppt'
    items = {n: zin.read(n) for n in names}
    zin.close()

    # ── content types: register the odttf extension ──
    ct = etree.fromstring(items['[Content_Types].xml'])
    if not ct.xpath('//ct:Default[@Extension="odttf"]', namespaces=NS):
        d = etree.SubElement(ct, '{%s}Default' % NS['ct'])
        d.set('Extension', 'odttf'); d.set('ContentType', ODTTF_CT)
        ct.insert(0, d)
    items['[Content_Types].xml'] = etree.tostring(ct, xml_declaration=True,
                                                  encoding='UTF-8', standalone=True)

    # ── fontTable.xml (Word only) ──
    ftpath = f'{part}/fontTable.xml'
    if ftpath not in items:
        ft = etree.Element(W + 'fonts', nsmap={'w': NS['w'], 'r': NS['r']})
    else:
        ft = etree.fromstring(items[ftpath])
    ft.set(etree.QName('http://www.w3.org/2000/xmlns/', 'r').text
           if False else 'ignorable_placeholder', '') if False else None

    relpath = f'{part}/_rels/fontTable.xml.rels'
    if relpath in items:
        rels = etree.fromstring(items[relpath])
    else:
        rels = etree.Element('{%s}Relationships' % NS['pr'], nsmap={None: NS['pr']})

    existing = [int(m.group(1)) for e in rels for m in [re.match(r'rId(\d+)', e.get('Id') or '')] if m]
    rid = max(existing or [0])

    slotmap = {'Regular': 'embedRegular', 'Bold': 'embedBold',
               'Italic': 'embedItalic', 'BoldItalic': 'embedBoldItalic'}
    fidx = 0
    for fam, slots in families.items():
        fel = None
        for f in ft.findall(W + 'font'):
            if f.get(W + 'name') == fam:
                fel = f; break
        if fel is None:
            fel = etree.SubElement(ft, W + 'font'); fel.set(W + 'name', fam)
            for tag, val in (('charset', '00'), ('family', 'auto'), ('pitch', 'variable')):
                e = etree.SubElement(fel, W + tag); e.set(W + 'val', val)
        for slot, ttf in slots.items():
            if not os.path.exists(ttf):
                continue
            fidx += 1; rid += 1
            guid = '{%s}' % str(uuid.uuid4()).upper()
            target = f'fonts/font{fidx}.odttf'
            items[f'{part}/{target}'] = obfuscate(open(ttf, 'rb').read(), guid)
            rel = etree.SubElement(rels, '{%s}Relationship' % NS['pr'])
            rel.set('Id', f'rId{rid}'); rel.set('Type', FONT_RELTYPE); rel.set('Target', target)
            e = etree.SubElement(fel, W + slotmap[slot])
            e.set(R + 'id', f'rId{rid}'); e.set(W + 'fontKey', guid); e.set(W + 'subsetted', '0')

    items[ftpath] = etree.tostring(ft, xml_declaration=True, encoding='UTF-8', standalone=True)
    items[relpath] = etree.tostring(rels, xml_declaration=True, encoding='UTF-8', standalone=True)

    # ── document.xml.rels must reference fontTable ──
    drel = f'{part}/_rels/document.xml.rels'
    if drel in items:
        dr = etree.fromstring(items[drel])
        if not dr.xpath("//*[contains(@Type,'fontTable')]"):
            ids = [int(m.group(1)) for e in dr for m in [re.match(r'rId(\d+)', e.get('Id') or '')] if m]
            e = etree.SubElement(dr, '{%s}Relationship' % NS['pr'])
            e.set('Id', f'rId{max(ids or [0]) + 1}')
            e.set('Type', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable')
            e.set('Target', 'fontTable.xml')
            items[drel] = etree.tostring(dr, xml_declaration=True, encoding='UTF-8', standalone=True)

    # ── settings.xml: turn embedding on ──
    spath = f'{part}/settings.xml'
    if spath in items:
        s = etree.fromstring(items[spath])
        for tag in ('embedTrueTypeFonts', 'saveSubsetFonts'):
            if not s.findall(W + tag):
                e = etree.Element(W + tag)
                if tag == 'saveSubsetFonts':
                    e.set(W + 'val', 'false')
                s.insert(0, e)
        items[spath] = etree.tostring(s, xml_declaration=True, encoding='UTF-8', standalone=True)

    with zipfile.ZipFile(path_out, 'w', zipfile.ZIP_DEFLATED) as z:
        for n, d in items.items():
            z.writestr(n, d)
    return path_out


TTF = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'fonts') + os.sep
PLEX = {
    'IBM Plex Serif': {'Regular': TTF + 'IBMPlexSerif-Regular.ttf', 'Bold': TTF + 'IBMPlexSerif-SemiBold.ttf',
                       'Italic': TTF + 'IBMPlexSerif-Italic.ttf', 'BoldItalic': TTF + 'IBMPlexSerif-SemiBoldItalic.ttf'},
    'IBM Plex Sans Cond': {'Regular': TTF + 'IBMPlexSansCond-Regular.ttf', 'Bold': TTF + 'IBMPlexSansCond-SemiBold.ttf',
                           'Italic': TTF + 'IBMPlexSansCond-Italic.ttf', 'BoldItalic': TTF + 'IBMPlexSansCond-SemiBoldItalic.ttf'},
    'IBM Plex Mono': {'Regular': TTF + 'IBMPlexMono-Regular.ttf', 'Bold': TTF + 'IBMPlexMono-SemiBold.ttf',
                      'Italic': TTF + 'IBMPlexMono-Italic.ttf', 'BoldItalic': TTF + 'IBMPlexMono-SemiBoldItalic.ttf'},
    'IBM Plex Sans': {'Regular': TTF + 'IBMPlexSans-Regular.ttf', 'Bold': TTF + 'IBMPlexSans-SemiBold.ttf',
                      'Italic': TTF + 'IBMPlexSans-Italic.ttf', 'BoldItalic': TTF + 'IBMPlexSans-SemiBoldItalic.ttf'},
}

if __name__ == '__main__':
    embed(sys.argv[1], sys.argv[2], PLEX)
    print('embedded ->', sys.argv[2])
