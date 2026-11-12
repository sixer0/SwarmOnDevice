/**
 * Skrip ukur tata letak yang dievaluasi Playwright di halaman (S25 -> lint R S45).
 *
 * Ditulis sebagai string statis (bukan fungsi TS) agar transpiler (SWC/esbuild
 * `keepNames`) tidak menyisipkan helper seperti `__name` yang tidak ada di halaman.
 * Ini kode milik modul, bukan masukan pengguna; argumennya hanya angka hasil
 * `JSON.stringify`. JavaScript halaman tetap mati (`javaScriptEnabled:false`);
 * evaluasi Playwright berjalan lewat protokol, bukan lewat skrip konten.
 *
 * Konvensi markup yang dibaca (dokumentasikan ke S21/S24):
 * - Halaman: `.page` atau `[data-page]` (pola RL datum_render.py check_page). Tanpa
 *   halaman, dokumen dianggap alir (kind "document").
 * - Area isi halaman: `.body` (bila ada); batas bawah: `.reg` (bila ada), selain
 *   itu tepi bawah lembar `pageHeightMm` dari atas halaman.
 * - Alamat blok: atribut `data-address` (alias `data-addr`) pada leluhur terdekat.
 * - Label figur: `data-figure`, `aria-label`, atau `id` pada svg / figure terdekat.
 */

export interface MeasureScriptArgs {
  pageWidthMm: number;
  pageHeightMm: number;
  maxElements: number;
}

export const MEASURE_SCRIPT = String.raw`(function (o) {
  // Swarm row 151c (C161 L1): stable references from the DOM prototypes, taken before any page member is read.
  // Markup can shadow document members by name (<img name="body">) and form members (<input name="closest">);
  // a prototype getter or method called on the node cannot be shadowed (page JavaScript is off). Page markers
  // (.page, .reg, .body) count only on HTML elements, so SVG content cannot pose as a page or its furniture.
  var DOC = document;
  var GOPD = Object.getOwnPropertyDescriptor;
  var DP = Document.prototype, EP = Element.prototype, NP = Node.prototype;
  function getter(P, n) { var g = GOPD(P, n).get; return function (x) { return g.call(x); }; }
  function method(P, n) { var f = P[n]; return function (x, a) { return f.call(x, a); }; }
  var docBody = getter(DP, 'body')(DOC), docEl = getter(DP, 'documentElement')(DOC);
  if (!(docBody instanceof HTMLBodyElement) || !(docEl instanceof HTMLHtmlElement)) return { paged: false, pageCount: 0, truncated: true, untrusted: true, elements: [] };
  var qsa = method(EP, 'querySelectorAll'), matches = method(EP, 'matches'), attr = method(EP, 'getAttribute');
  var clientRects = method(EP, 'getClientRects'), bcr = method(EP, 'getBoundingClientRect'), contains = method(NP, 'contains');
  var tagOf = getter(EP, 'tagName'), parentEl = getter(NP, 'parentElement'), firstChild = getter(NP, 'firstChild'), nextSib = getter(NP, 'nextSibling');
  var nodeType = getter(NP, 'nodeType'), nodeValue = getter(NP, 'nodeValue'), textOf = getter(NP, 'textContent');
  var clientW = getter(EP, 'clientWidth'), scrollW = getter(EP, 'scrollWidth'), scrollH = getter(EP, 'scrollHeight');
  function tagLc(el) { return String(tagOf(el)).toLowerCase(); }
  function up(el, sel) { for (var e = el; e; e = parentEl(e)) if (e instanceof HTMLElement && matches(e, sel)) return e; return null; }
  function firstHtml(root, sel) { var l = qsa(root, sel); for (var i = 0; i < l.length; i++) if (l[i] instanceof HTMLElement) return l[i]; return null; }
  var PX = 96 / 25.4;
  var out = [];
  var truncated = false;
  var SEL = '.page,[data-page]';
  function mm(v) { return Math.round((v / PX) * 100) / 100; }
  function push(e) { if (out.length >= o.maxElements) { truncated = true; return; } out.push(e); }
  function addrOf(el) {
    var a = up(el, '[data-address],[data-addr]');
    if (!a) return undefined;
    return attr(a, 'data-address') || attr(a, 'data-addr') || undefined;
  }
  function cls(el) { var c = attr(el, 'class'); return (c ? String(c) : '').trim(); }
  function label(el) { var c = cls(el); return (c ? c.split(/\s+/)[0] : tagLc(el)).slice(0, 40); }
  function hex(c) {
    if (!c) return null;
    var m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(c);
    if (!m) return null;
    if (m[4] !== undefined) {
      var a = m[4].charAt(m[4].length - 1) === '%' ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      if (a === 0) return null;
    }
    var s = '#';
    for (var i = 1; i <= 3; i++) { var h = Math.round(parseFloat(m[i])).toString(16).toUpperCase(); s += h.length < 2 ? '0' + h : h; }
    return s;
  }
  function visible(el, cs) {
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    return clientRects(el).length > 0;
  }
  var allPages = Array.prototype.slice.call(qsa(docEl, SEL)).filter(function (p) { return p instanceof HTMLElement; });
  var pages = allPages.filter(function (p) { var q = parentEl(p); return !q || !up(q, SEL); });
  var paged = pages.length > 0;
  var sx = window.scrollX, sy = window.scrollY;
  function pageOf(el) {
    if (!paged) return -1;
    var p = up(el, SEL);
    while (p && parentEl(p) && up(parentEl(p), SEL)) p = up(parentEl(p), SEL);
    return p ? pages.indexOf(p) : -1;
  }
  var pageRects = pages.map(function (p) { return bcr(p); });
  function box(el, r) {
    var i = pageOf(el);
    var ox = i >= 0 ? pageRects[i].left : -sx, oy = i >= 0 ? pageRects[i].top : -sy;
    var e = { xMm: mm(r.left - ox), yMm: mm(r.top - oy), widthMm: mm(r.width), heightMm: mm(r.height) };
    if (i >= 0) e.page = i + 1;
    var a = addrOf(el); if (a) e.address = a;
    return e;
  }
  function addColour(set, c) { var h = hex(c); if (h) set[h] = 1; }
  function colourSetFor(root) {
    var set = {};
    var els = qsa(root, '*');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], cs = getComputedStyle(el);
      if (!visible(el, cs)) continue;
      var isSvg = el instanceof SVGElement;
      if (isSvg) {
        if (tagLc(el) === 'svg' || tagLc(el) === 'g' || tagLc(el) === 'defs') continue;
        if (cs.fill && cs.fill !== 'none' && cs.fill.indexOf('url(') !== 0 && parseFloat(cs.fillOpacity) > 0) addColour(set, cs.fill);
        if (cs.stroke && cs.stroke !== 'none' && cs.stroke.indexOf('url(') !== 0 && parseFloat(cs.strokeWidth) > 0 && parseFloat(cs.strokeOpacity) > 0) addColour(set, cs.stroke);
        continue;
      }
      var hasText = false;
      for (var n = firstChild(el); n; n = nextSib(n)) if (nodeType(n) === 3 && /\S/.test(nodeValue(n))) { hasText = true; break; }
      if (hasText) addColour(set, cs.color);
      addColour(set, cs.backgroundColor);
      var sides = ['Top', 'Right', 'Bottom', 'Left'];
      for (var k = 0; k < 4; k++) {
        if (parseFloat(cs['border' + sides[k] + 'Width']) > 0 && cs['border' + sides[k] + 'Style'] !== 'none' && cs['border' + sides[k] + 'Style'] !== 'hidden') addColour(set, cs['border' + sides[k] + 'Color']);
      }
    }
    return Object.keys(set).sort();
  }

  // 1. Halaman / dokumen + warna terlihat per halaman (DATUM-14).
  var overflowed = {};
  if (paged) {
    pages.forEach(function (p, i) {
      var r = pageRects[i];
      push({ kind: 'page', page: i + 1, xMm: mm(r.left + sx), yMm: mm(r.top + sy), widthMm: mm(r.width), heightMm: mm(r.height), colors: colourSetFor(p), label: label(p) });
    });
  } else {
    var de = docEl;
    // Swarm row 206 (1.2.3, P3): the flow layout width as laid out (layoutWidthPx = documentElement.clientWidth, what a
    // classic scrollbar leaves), the viewport (innerWidth) and the sheet; DATUM-37 says NOT_RUN when the layout is
    // narrower than the sheet, as the host's OVERLAP_CLIP says UNKNOWN FLOW_LAYOUT_UNMEASURABLE (overlap-clip.ts).
    push({ kind: 'document', xMm: 0, yMm: 0, widthMm: mm(scrollW(de)), heightMm: mm(scrollH(de)), colors: colourSetFor(docBody), overflow: scrollW(de) > clientW(de) + 1, layoutWidthPx: clientW(de), viewportPx: Number(window.innerWidth) || 0, sheetWidthMm: o.pageWidthMm });
  }

  // 2. Luapan lembar (DATUM-37, pola check_page RL): terburuk per halaman+label+sumbu.
  var worst = {};
  function note(el, r, axis, over, pi) {
    if (over <= 0.5) return;
    var k = pi + '|' + label(el) + '|' + axis;
    if (!worst[k] || worst[k].over < over) worst[k] = { el: el, r: r, axis: axis, over: over };
  }
  if (paged) {
    pages.forEach(function (p, i) {
      var pr = pageRects[i];
      var limitB = pr.top + o.pageHeightMm * PX, limitR = pr.left + o.pageWidthMm * PX;
      var reg = firstHtml(p, '.reg');
      var floor = reg ? bcr(reg).top : limitB;
      var scope = firstHtml(p, '.body') || p;
      var els = qsa(scope, '*');
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        if (reg && (el === reg || contains(reg, el))) continue;
        if (!clientRects(el).length) continue;
        var b = bcr(el);
        if (b.height < 1 && b.width < 1) continue;
        note(el, b, 'bottom', b.bottom - floor, i);
        note(el, b, 'right', b.right - limitR, i);
      }
    });
  } else {
    var lim = clientW(docEl);
    var all = qsa(docBody, '*');
    for (var q = 0; q < all.length; q++) {
      var e2 = all[q];
      if (!clientRects(e2).length) continue;
      var b2 = bcr(e2);
      note(e2, b2, 'right', b2.right - lim, -1);
    }
  }
  Object.keys(worst).sort(function (a, b) { return worst[b].over - worst[a].over; }).forEach(function (k) {
    var w = worst[k], e = box(w.el, w.r);
    e.kind = 'overflow'; e.overflow = true; e.axis = w.axis; e.overflowMm = mm(w.over); e.label = label(w.el); e.tag = tagLc(w.el);
    if (e.page) overflowed[e.page] = 1;
    push(e);
  });
  if (paged) out.forEach(function (e) { if (e.kind === 'page') e.overflow = !!overflowed[e.page]; });

  // 3. Blok teks: lebar ukur, jumlah baris, karakter per baris (DATUM-15), ukuran fon terhitung.
  //    Isi yang terpotong di kotaknya sendiri (scrollWidth > clientWidth) ditandai kind "clip".
  var blocks = qsa(docBody, '*');
  for (var bi = 0; bi < blocks.length; bi++) {
    var el = blocks[bi];
    if (el instanceof SVGElement) continue;
    var cs = getComputedStyle(el);
    if (!visible(el, cs)) continue;
    if (clientW(el) > 0 && scrollW(el) > clientW(el) + 1 && cs.display !== 'inline') {
      var cb = box(el, bcr(el));
      cb.kind = 'clip'; cb.overflow = true; cb.axis = 'right'; cb.overflowMm = mm(scrollW(el) - clientW(el)); cb.label = label(el); cb.tag = tagLc(el);
      push(cb);
    }
    if (cs.display === 'inline' || cs.display === 'contents') continue;
    var direct = false;
    for (var tn = firstChild(el); tn; tn = nextSib(tn)) if (nodeType(tn) === 3 && /\S/.test(nodeValue(tn))) { direct = true; break; }
    if (!direct) continue;
    var range = DP.createRange.call(DOC);
    range.selectNodeContents(el);
    var rects = range.getClientRects();
    var lines = [];
    for (var ri = 0; ri < rects.length; ri++) {
      var rr = rects[ri];
      if (rr.width < 0.5 || rr.height < 0.5) continue;
      var mid = rr.top + rr.height / 2, hit = null;
      for (var li = 0; li < lines.length; li++) if (mid >= lines[li].top && mid <= lines[li].bottom) { hit = lines[li]; break; }
      if (hit) { hit.left = Math.min(hit.left, rr.left); hit.right = Math.max(hit.right, rr.right); hit.top = Math.min(hit.top, rr.top); hit.bottom = Math.max(hit.bottom, rr.bottom); }
      else lines.push({ left: rr.left, right: rr.right, top: rr.top, bottom: rr.bottom });
    }
    if (!lines.length) continue;
    var text = (textOf(el) || '').replace(/\s+/g, ' ').trim();
    var widths = lines.map(function (l) { return l.right - l.left; });
    var total = widths.reduce(function (s, v) { return s + v; }, 0);
    var maxW = Math.max.apply(null, widths);
    var cpl = text.length;
    if (lines.length > 1 && total > 0) cpl = (text.length * (total - widths[widths.length - 1]) / total) / (lines.length - 1);
    var pl = parseFloat(cs.paddingLeft) || 0, pr2 = parseFloat(cs.paddingRight) || 0;
    var tb = box(el, bcr(el));
    tb.kind = 'text'; tb.tag = tagLc(el); tb.label = label(el);
    // Swarm row 165K (C199): kind of the enclosing Studio unit (data-unit), so DATUM-15 can leave front matter out.
    var un = up(el, '[data-unit]'); if (un) tb.unit = String(attr(un, 'data-unit') || '').slice(0, 40);
    tb.fontSizePt = Math.round(parseFloat(cs.fontSize) * 0.75 * 100) / 100;
    tb.measureMm = mm(clientW(el) - pl - pr2);
    tb.lineCount = lines.length; tb.charCount = text.length;
    tb.charsPerLine = Math.round(cpl * 10) / 10; tb.maxLineWidthMm = mm(maxW);
    push(tb);
  }

  // 4. Figur SVG (warna per figur DATUM-25, tinggi DATUM-33) dan teks SVG terhitung (DATUM-28).
  var svgs = Array.prototype.slice.call(qsa(docEl, 'svg')).filter(function (s) { var q = parentEl(s); return !q || !method(EP, 'closest')(q, 'svg'); });
  svgs.forEach(function (s) {
    var cs = getComputedStyle(s);
    if (!visible(s, cs)) return;
    var fe = box(s, bcr(s));
    var host = up(s, 'figure,[data-figure]');
    fe.kind = 'figure'; fe.tag = 'svg';
    fe.label = String(attr(s, 'data-figure') || (host && (attr(host, 'data-figure') || attr(host, 'id'))) || attr(s, 'aria-label') || attr(s, 'id') || 'svg').slice(0, 80);
    fe.colors = colourSetFor(s);
    push(fe);
    var texts = qsa(s, 'text');
    for (var ti = 0; ti < texts.length; ti++) {
      var t = texts[ti], tcs = getComputedStyle(t);
      if (!visible(t, tcs)) continue;
      var m = t.getScreenCTM();
      var scale = m ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) : 1;
      var te = box(t, bcr(t));
      te.kind = 'svgText'; te.tag = 'text'; te.label = fe.label;
      te.fontSizePt = Math.round(parseFloat(tcs.fontSize) * scale * 0.75 * 100) / 100;
      push(te);
    }
  });

  // 5. Gambar raster: ukuran tampil vs piksel asli (pxGuard DATUM-39 di hilir).
  var imgs = qsa(docEl, 'img');
  for (var ii = 0; ii < imgs.length; ii++) {
    var im = imgs[ii], ics = getComputedStyle(im);
    if (!visible(im, ics)) continue;
    var ie = box(im, bcr(im));
    ie.kind = 'image'; ie.tag = 'img'; ie.label = label(im);
    ie.naturalWidthPx = im.naturalWidth; ie.naturalHeightPx = im.naturalHeight;
    push(ie);
  }

  // 6. Tabel: kotak tabel untuk perbandingan dengan lebar ukur.
  var tables = qsa(docEl, 'table');
  for (var tj = 0; tj < tables.length; tj++) {
    var tbl = tables[tj], tcs2 = getComputedStyle(tbl);
    if (!visible(tbl, tcs2)) continue;
    var te2 = box(tbl, bcr(tbl));
    te2.kind = 'table'; te2.tag = 'table'; te2.label = label(tbl);
    var par = parentEl(tbl);
    te2.overflow = !!par && bcr(tbl).right > bcr(par).right + 0.5;
    push(te2);
  }

  return { paged: paged, pageCount: paged ? pages.length : 0, truncated: truncated, elements: out };
})`;

/** Bangun ekspresi evaluasi; argumen hanya angka. */
export function measureExpression(a: MeasureScriptArgs): string {
  const args = {
    pageWidthMm: Number(a.pageWidthMm),
    pageHeightMm: Number(a.pageHeightMm),
    maxElements: Math.trunc(Number(a.maxElements)),
  };
  return `${MEASURE_SCRIPT}(${JSON.stringify(args)})`;
}

/** Kotak halaman `.page`/`[data-page]` tingkat atas dalam px CSS dokumen (untuk pratinjau). */
export const PAGE_RECTS_SCRIPT = String.raw`(function () {
  var SEL = '.page,[data-page]';
  var sx = window.scrollX, sy = window.scrollY;
  return Array.prototype.slice.call(document.querySelectorAll(SEL))
    .filter(function (p) { return !p.parentElement || !p.parentElement.closest(SEL); })
    .map(function (p) { var r = p.getBoundingClientRect(); return { x: r.left + sx, y: r.top + sy, width: r.width, height: r.height }; });
})()`;

/** Tunggu fon dokumen siap (data: @font-face dan fon sistem). */
export const FONTS_READY_SCRIPT = "document.fonts.ready.then(function () { return document.fonts.size; })";

/** Tinggi dan lebar dokumen dalam px CSS. */
export const DOC_SIZE_SCRIPT =
  "({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })";
