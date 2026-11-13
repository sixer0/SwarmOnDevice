/**
 * Row 151 (decision U24 A, C130; spec masterplan/01_specs_output_verification.md §3.2 part 2): the fixed page script
 * `swarm.verify.overlap`, run by the render bridge's `checkPage` op on a stored Studio HTML output.
 *
 * This file has NO imports on purpose: desktop main imports `OVERLAP_SCRIPT` the way start.ts:12 imports
 * `MEASURE_SCRIPT`, and the bridge allow-lists the script by the sha256 of its exact text (desktop
 * src/main/datum-render/scripts.ts:17-31). Row 152 adds `{ "swarm.verify.overlap": OVERLAP_SCRIPT }` to
 * STUDIO_BRIDGE_EXTRA_SCRIPTS (start.ts:18). Any change to the text changes its sha256 and needs no other edit there.
 *
 * Written as a static ES5 string, like engine/browser/measure.ts:25, so no transpiler helper (`__name`) leaks into the
 * page. Page JavaScript stays off (Emulation.setScriptExecutionDisabled, electron-renderer.ts); this text runs only
 * through CDP Runtime.evaluate, with a JSON argument of numbers built by the host (`overlapExpression`).
 *
 * What it measures (spec §3.2):
 * - Ink boxes: every line box of each visible element with direct text (Range client rects per text node, as
 *   measure.ts does for `text`), plus the box of each top-level `svg` and each `img`. Text inside an SVG is the
 *   figure's own business (FIGURE_FIT), so it is not an ink box here.
 * - Owner of a box: the nearest ancestor with `data-block`, else the nearest block-level ancestor. Studio marks figure,
 *   table and derivation wrappers with `data-block-id` instead (engine/html/tables/figure.ts, table.ts; a rendered
 *   fixture has 11 `data-block` and 5 `data-block-id`), so both attributes mark a block here (row 151 deviation, reported).
 * - Skipped: anything inside `.reg` (register furniture, measure.ts convention), the screen furniture copy
 *   `.st-screen` (engine/html/base/css.ts:243, :395), and the draft marker `.st-draft-mark`
 *   (row 151c, C161 L2: `[aria-hidden="true"]` is no longer a skip, and a marker counts only on an HTML element;
 *   an svg/img root is judged by its parent, so a class on the root cannot hide a figure)
 *   (engine/html/assemble/classes.ts:39, positioned over the unit at :71-72). The placeholder classes
 *   `st-placeholder` / `st-slot-empty` (classes.ts:33, :35) sit in the flow and are EMPTY_SLOTS' finding, not skipped.
 * - OVERLAP: pairs on the same page (paged) or in the whole document (flow), skipping pairs with the same owner and
 *   pairs where one owner contains the other; a pair counts when the intersection is > minAreaMm2 and > minFrac x the
 *   smaller box. One finding per owner pair and page (the largest intersection).
 * - UNBREAKABLE_TOO_TALL (flow only): each img, top-level svg, tr and element with computed break-inside avoid that is
 *   taller than the page content height = pageHeightMm - the top and bottom margins of the first unnamed @page rule
 *   (CSSOM CSSPageRule; first @page of any name when there is no unnamed one). An element taller than the whole sheet
 *   is a finding even when no margin can be read; otherwise unreadable margins with candidates present set
 *   `marginsUnreadable` (host: UNKNOWN MARGINS_UNREADABLE).
 * - More than maxBoxes ink boxes on one page (or in a flow document): `truncated` (host: UNKNOWN MEASURE_TRUNCATED).
 * Row 151c (C161 L1): every DOM member is read through its prototype (stable references), so named elements cannot
 *   shadow document.body / querySelectorAll / createRange or a form's members; if the document's body is not an
 *   HTMLBodyElement the script returns { untrusted } (host: UNKNOWN VERIFY_INTERNAL).
 * - Row 205 (1.2.3, HB-1): the layout viewport as laid out: `viewportPx` (window.innerWidth, the sheet width the host
 *   asked for) and `layoutWidthPx` (documentElement.clientWidth, what is left after a classic scrollbar). The host reads
 *   a flow document as unmeasurable when the two differ (UNKNOWN FLOW_LAYOUT_UNMEASURABLE, overlap-clip.ts).
 * Returns { paged, pageCount, truncated, marginsUnreadable, contentHeightMm, boxes, scanned, findingsTotal, findings[],
 *   viewportPx, layoutWidthPx }.
 */

export const OVERLAP_SCRIPT_NAME = "swarm.verify.overlap"

export interface OverlapScriptArgs {
  pageWidthMm: number
  pageHeightMm: number
  maxBoxes: number
  minAreaMm2: number
  minFrac: number
}

export const OVERLAP_SCRIPT = String.raw`(function (o) {
  // Row 151c (C161 L1/L2): stable references, taken from the DOM prototypes before any page member is read.
  // Markup can shadow members of document and of form elements by name (<img name="body">, <form><input
  // name="closest">); a prototype getter or method called on the node cannot be shadowed, and page JavaScript is
  // off, so the prototypes themselves are intact. Engine markers (.page, .reg, data-block ...) count only on HTML
  // elements: SVG content can carry any class or attribute, so it never decides what is a page, an owner or furniture.
  var DOC = document;
  var GOPD = Object.getOwnPropertyDescriptor;
  var DP = Document.prototype, EP = Element.prototype, NP = Node.prototype;
  function getter(P, n) { var g = GOPD(P, n).get; return function (x) { return g.call(x); }; }
  function method(P, n) { var f = P[n]; return function (x, a) { return f.call(x, a); }; }
  var docBody = getter(DP, 'body')(DOC), docEl = getter(DP, 'documentElement')(DOC), docSheets = getter(DP, 'styleSheets')(DOC);
  if (!(docBody instanceof HTMLBodyElement) || !(docEl instanceof HTMLHtmlElement)) return { untrusted: 'document members are not the document body' };
  var qsa = method(EP, 'querySelectorAll'), matches = method(EP, 'matches'), closestAny = method(EP, 'closest'), attr = method(EP, 'getAttribute');
  var clientRects = method(EP, 'getClientRects'), bcr = method(EP, 'getBoundingClientRect'), contains = method(NP, 'contains');
  var tagOf = getter(EP, 'tagName'), parentEl = getter(NP, 'parentElement'), firstChild = getter(NP, 'firstChild'), nextSib = getter(NP, 'nextSibling');
  var nodeType = getter(NP, 'nodeType'), nodeValue = getter(NP, 'nodeValue');
  var range = DP.createRange.call(DOC);
  var PX = 96 / 25.4;
  var SEL = '.page,[data-page]';
  var SKIP = '.reg,.st-screen,.st-draft-mark';
  var BLOCK = { 'block': 1, 'list-item': 1, 'table': 1, 'table-row': 1, 'table-cell': 1, 'table-caption': 1, 'flex': 1, 'grid': 1, 'flow-root': 1 };
  var MAX_FINDINGS = 200;
  function mm(v) { return Math.round((v / PX) * 100) / 100; }
  function isHtml(el) { return el instanceof HTMLElement; }
  /** Nearest HTML element at or above el matching sel (engine markers only count on HTML elements). */
  function up(el, sel) { for (var e = el; e; e = parentEl(e)) if (isHtml(e) && matches(e, sel)) return e; return null; }
  function cls(el) { var c = attr(el, 'class'); return (c ? String(c) : '').trim(); }
  function label(el) { var c = cls(el); return (c ? c.split(/\s+/)[0] : String(tagOf(el)).toLowerCase()).slice(0, 40); }
  function addrOf(el) {
    var a = up(el, '[data-address],[data-addr]');
    if (!a) return null;
    return attr(a, 'data-address') || attr(a, 'data-addr') || null;
  }
  function visible(el) {
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    return clientRects(el).length > 0;
  }
  // Furniture is skipped only below an engine marker on an HTML element; aria-hidden is never a skip (L2).
  function skipped(el) { return !!(el && up(el, SKIP)); }
  function inSvg(el) { var p = parentEl(el); return !!(p && closestAny(p, 'svg')); }
  var allPages = Array.prototype.slice.call(qsa(docEl, SEL)).filter(isHtml);
  var pages = allPages.filter(function (p) { var q = parentEl(p); return !q || !up(q, SEL); });
  var paged = pages.length > 0;
  function pageOf(el) {
    if (!paged) return 0;
    var p = up(el, SEL);
    while (p && parentEl(p) && up(parentEl(p), SEL)) p = up(parentEl(p), SEL);
    return p ? pages.indexOf(p) + 1 : 0;
  }
  function ownerOf(el) {
    var b = up(el, '[data-block],[data-block-id]');
    if (b) return b;
    for (var e = el; e && e !== docEl; e = parentEl(e)) {
      if (e === docBody) return e;
      if (BLOCK[getComputedStyle(e).display]) return e;
    }
    return docBody;
  }

  // 1. Ink boxes, grouped by page (0 = flow document or outside any sheet). aria-hidden elements are ink too.
  var groups = {};
  var counts = {};
  var truncated = false;
  var boxes = 0;
  var scanned = 0;
  function add(el, r, kind) {
    if (r.width < 0.5 || r.height < 0.5) return;
    var pg = pageOf(el);
    counts[pg] = (counts[pg] || 0) + 1;
    if (counts[pg] > o.maxBoxes) { truncated = true; return; }
    (groups[pg] = groups[pg] || []).push({ l: r.left, t: r.top, r: r.right, b: r.bottom, owner: ownerOf(el), el: el, kind: kind });
    boxes++;
  }
  var all = qsa(docBody, '*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var tag = String(tagOf(el)).toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'template' || tag === 'noscript') continue;
    if (inSvg(el)) continue;
    scanned++;
    // A figure root (svg, img) is judged by its parent: a class or attribute on the root itself never hides it.
    if (tag === 'svg' || tag === 'img') { if (!skipped(parentEl(el)) && visible(el)) add(el, bcr(el), tag); continue; }
    if (skipped(el) || !visible(el)) continue;
    for (var n = firstChild(el); n; n = nextSib(n)) {
      if (nodeType(n) !== 3 || !/\S/.test(nodeValue(n))) continue;
      range.selectNodeContents(n);
      var rects = range.getClientRects();
      for (var k = 0; k < rects.length; k++) add(el, rects[k], 'text');
    }
  }

  // 2. Overlap pairs per group: sweep by top edge, compare only boxes whose vertical spans meet.
  var findings = [];
  var findingsTotal = 0;
  var MIN_AREA_PX = o.minAreaMm2 * PX * PX;
  Object.keys(groups).forEach(function (key) {
    var list = groups[key].sort(function (a, b) { return a.t - b.t; });
    var best = new Map();
    var ownerIds = new Map();
    function oid(x) { if (!ownerIds.has(x)) ownerIds.set(x, ownerIds.size); return ownerIds.get(x); }
    for (var a = 0; a < list.length; a++) {
      var A = list[a];
      for (var b = a + 1; b < list.length && list[b].t < A.b; b++) {
        var B = list[b];
        if (A.owner === B.owner || contains(A.owner, B.owner) || contains(B.owner, A.owner)) continue;
        var w = Math.min(A.r, B.r) - Math.max(A.l, B.l);
        var h = Math.min(A.b, B.b) - Math.max(A.t, B.t);
        if (w <= 0 || h <= 0) continue;
        var area = w * h;
        var smaller = Math.min((A.r - A.l) * (A.b - A.t), (B.r - B.l) * (B.b - B.t));
        if (area <= MIN_AREA_PX || area <= o.minFrac * smaller) continue;
        var ia = oid(A.owner), ib = oid(B.owner);
        var pk = ia < ib ? ia + '|' + ib : ib + '|' + ia;
        var prev = best.get(pk);
        if (!prev || prev.area < area) best.set(pk, { area: area, frac: smaller > 0 ? area / smaller : 1, A: A, B: B });
      }
    }
    best.forEach(function (v) {
      findingsTotal++;
      if (findings.length >= MAX_FINDINGS) return;
      var first = v.A.t <= v.B.t ? v.A : v.B, second = first === v.A ? v.B : v.A;
      findings.push({
        code: 'OVERLAP',
        page: paged && key !== '0' ? Number(key) : null,
        address: addrOf(first.owner) || addrOf(first.el),
        label: label(first.owner),
        kind: first.kind,
        address2: addrOf(second.owner) || addrOf(second.el),
        label2: label(second.owner),
        kind2: second.kind,
        areaMm2: Math.round((v.area / (PX * PX)) * 100) / 100,
        frac: Math.round(v.frac * 1000) / 1000
      });
    });
  });

  // 3. Unbreakable too tall (flow layout only).
  function lengthMm(v) {
    if (v === undefined || v === null) return null;
    var s = String(v).trim().toLowerCase();
    if (s === '0') return 0;
    var m = /^(-?\d+(?:\.\d+)?)(mm|cm|in|pt|pc|px|q)$/.exec(s);
    if (!m) return null;
    var x = parseFloat(m[1]);
    var f = { mm: 1, cm: 10, 'in': 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, q: 0.25 }[m[2]];
    return x * f;
  }
  function pageRules() {
    var out = [];
    function walk(rules) {
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        if (r.type === 6) out.push(r);
        else if (r.cssRules) { try { walk(r.cssRules); } catch (e) {} }
      }
    }
    for (var s = 0; s < docSheets.length; s++) {
      try { walk(docSheets[s].cssRules); } catch (e) {}
    }
    return out;
  }
  function contentHeightMm() {
    // Swarm 1.2.7 row 40 (T-13): the first selector-less rule may be a margin-box rule without margins (the
    // chapter-scope DRAF watermark); pick the first selector-less rule whose margins read, then any rule whose
    // margins read, else null (MARGINS_UNREADABLE).
    var rules = pageRules();
    function vertical(r) {
      var t = lengthMm(r.style.getPropertyValue('margin-top'));
      var b = lengthMm(r.style.getPropertyValue('margin-bottom'));
      return t === null || b === null ? null : t + b;
    }
    var pass, i, v;
    for (pass = 0; pass < 2; pass++) {
      for (i = 0; i < rules.length; i++) {
        if (pass === 0 && rules[i].selectorText) continue;
        v = vertical(rules[i]);
        if (v !== null) return o.pageHeightMm - v;
      }
    }
    return null;
  }
  var marginsUnreadable = false;
  var contentH = null;
  if (!paged) {
    contentH = contentHeightMm();
    var candidates = 0;
    for (var j = 0; j < all.length; j++) {
      var c = all[j];
      var ct = String(tagOf(c)).toLowerCase();
      if (inSvg(c) || (ct === 'svg' || ct === 'img' ? skipped(parentEl(c)) : skipped(c)) || !visible(c)) continue;
      var bi = getComputedStyle(c).breakInside;
      if (!(ct === 'img' || ct === 'svg' || ct === 'tr' || bi === 'avoid' || bi === 'avoid-page')) continue;
      candidates++;
      var hMm = bcr(c).height / PX;
      var limit = contentH === null ? o.pageHeightMm : contentH;
      if (hMm > limit + 0.5) {
        findingsTotal++;
        if (findings.length < MAX_FINDINGS) {
          findings.push({ code: 'UNBREAKABLE_TOO_TALL', page: null, address: addrOf(c), label: label(c), kind: ct, heightMm: mm(hMm * PX), limitMm: Math.round(limit * 100) / 100, overMm: Math.round((hMm - limit) * 100) / 100 });
        }
      }
    }
    if (contentH === null && candidates > 0) marginsUnreadable = true;
  }

  return {
    paged: paged,
    pageCount: paged ? pages.length : 0,
    truncated: truncated,
    marginsUnreadable: marginsUnreadable,
    contentHeightMm: contentH === null ? null : Math.round(contentH * 100) / 100,
    boxes: boxes,
    scanned: scanned,
    findingsTotal: findingsTotal,
    findings: findings,
    viewportPx: Number(window.innerWidth) || 0,
    layoutWidthPx: getter(EP, 'clientWidth')(docEl)
  };
})`

/** Default argument of spec §3.2 (`maxBoxes: 5000, minAreaMm2: 1.0, minFrac: 0.10`). */
export const OVERLAP_DEFAULT_ARGS: Readonly<Omit<OverlapScriptArgs, "pageWidthMm" | "pageHeightMm">> = Object.freeze({
  maxBoxes: 5000,
  minAreaMm2: 1.0,
  minFrac: 0.1,
})

/** Argument object sent as `arg` of the bridge checkPage request (numbers only). */
export function overlapArgs(pageWidthMm: number, pageHeightMm: number, over: Partial<OverlapScriptArgs> = {}): OverlapScriptArgs {
  return {
    pageWidthMm: Number(over.pageWidthMm ?? pageWidthMm),
    pageHeightMm: Number(over.pageHeightMm ?? pageHeightMm),
    maxBoxes: Math.trunc(Number(over.maxBoxes ?? OVERLAP_DEFAULT_ARGS.maxBoxes)),
    minAreaMm2: Number(over.minAreaMm2 ?? OVERLAP_DEFAULT_ARGS.minAreaMm2),
    minFrac: Number(over.minFrac ?? OVERLAP_DEFAULT_ARGS.minFrac),
  }
}
