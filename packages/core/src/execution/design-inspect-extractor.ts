/**
 * Design inspect — the in-page defect measurement script.
 *
 * Where the DNA extractor describes a page so it can be compared with a
 * reference, this one looks for defects that need no reference: horizontal
 * overflow, text against the viewport edge, over-long lines, too many type
 * sizes or loaded families, headings that skip a level or wrap past two lines,
 * text below its contrast minimum against the background actually behind it,
 * tap targets below the WCAG 2.2 minimum, broken or unsized images, content
 * stuck invisible after load, and blank viewport-height bands. Thresholds and
 * verdicts live node-side in `design-inspect.ts`; this only measures.
 *
 * Same constraints as DESIGN_DNA_EXTRACTOR: plain JS in a template string, no
 * `${`, ES2020, under 16 KiB, bounded output.
 */
export const DESIGN_INSPECT_EXTRACTOR = String.raw`(async () => {
  var MAX_EL = 6000, MAX_SAMPLES = 6;
  var W = innerWidth, H = innerHeight, D = document, de = D.documentElement;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  if (D.readyState !== 'complete') await Promise.race([new Promise(function (r) { addEventListener('load', r, { once: true }); }), sleep(6000)]);
  try { await Promise.race([D.fonts.ready, sleep(3000)]); } catch (e) {}
  // Let entrance animations finish before calling anything "stuck".
  await sleep(1200);
  var px = function (v) { var n = parseFloat(v); return isFinite(n) ? n : 0; };
  var r1 = function (n) { return Math.round(n * 10) / 10; };
  var cv = D.createElement('canvas'); cv.width = cv.height = 1;
  var cx = cv.getContext('2d', { willReadFrequently: true });
  var cache = {};
  var rgba = function (c) {
    if (cache[c]) return cache[c];
    cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1);
    var d = cx.getImageData(0, 0, 1, 1).data; var v = [d[0], d[1], d[2], d[3] / 255]; cache[c] = v; return v;
  };
  var lum = function (v) { var f = function (c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(v[0]) + 0.7152 * f(v[1]) + 0.0722 * f(v[2]); };
  var ratio = function (a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  var sel = function (el) {
    var s = el.tagName.toLowerCase();
    if (el.id) return s + '#' + el.id.slice(0, 40);
    var c = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
    return c ? s + '.' + c.slice(0, 40) : s;
  };
  var txt = function (el) { return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48); };
  var push = function (list, item) { if (list.length < MAX_SAMPLES) list.push(item); };
  // Background actually behind an element: composite ancestors until opaque;
  // null when an image or gradient is in the way (contrast unknowable).
  // Media drawn inside an ancestor (a hero video, a background <img> sibling)
  // also sits behind the text without being one of its ancestors.
  var mediaIn = new WeakMap();
  var mediaRects = function (n) {
    var m = mediaIn.get(n);
    if (!m) { m = Array.prototype.map.call(n.querySelectorAll('img,video,canvas,picture'), function (x) { return [x, x.getBoundingClientRect()]; }); mediaIn.set(n, m); }
    return m;
  };
  var overMedia = function (el, n) {
    var q = el.getBoundingClientRect();
    return mediaRects(n).some(function (pair) { var m = pair[1]; return !el.contains(pair[0]) && m.width > 1 && m.left < q.right && m.right > q.left && m.top < q.bottom && m.bottom > q.top; });
  };
  var bgBehind = function (el) {
    var layers = [];
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var c = getComputedStyle(n);
      if (c.backgroundImage && c.backgroundImage !== 'none') return null;
      if (n !== el && overMedia(el, n)) return null;
      var v = rgba(c.backgroundColor);
      if (v[3] > 0.02) { layers.push(v); if (v[3] > 0.98) break; }
    }
    var base = [255, 255, 255];
    for (var j = layers.length - 1; j >= 0; j--) { var L = layers[j], a = L[3]; base = [L[0] * a + base[0] * (1 - a), L[1] * a + base[1] * (1 - a), L[2] * a + base[2] * (1 - a), 1]; }
    return base;
  };

  var out = {
    v: 1, url: location.href, vw: W, vh: H, docH: Math.max(de.scrollHeight, D.body ? D.body.scrollHeight : 0),
    scrollW: de.scrollWidth, overflow: [], edgeText: [], edgeCount: 0, longLines: [], longCount: 0,
    sizes: {}, families: {}, loaded: [], headings: [], contrast: [], contrastCount: 0, contrastChecked: 0,
    smallTargets: [], smallCount: 0, targetsChecked: 0, brokenImages: [], unsizedImages: 0, hiddenText: [], hiddenCount: 0,
    blankBands: [], bodySizes: {}, justified: 0, elements: 0,
    heroFold: null, heroDeadBand: 0, headingProximity: [], unboundedCount: 0, unbounded: []
  };
  // Viewport-height bands holding no visible text or media, plus 10px hero buckets (0..800px).
  var bands = Math.max(1, Math.ceil(out.docH / H)), inked = [], heroBuckets = [];
  var ink = function (y, h) {
    for (var b = Math.floor(y / H); b <= Math.floor((y + h - 1) / H) && b < bands; b++) inked[b] = true;
    var hs = Math.max(0, Math.floor(y / 10)), he = Math.min(79, Math.floor((y + h - 1) / 10));
    for (var hi = hs; hi <= he; hi++) heroBuckets[hi] = true;
  };
  var firstHeadTop = null, firstHeadBot = null, firstCtaBot = null;
  var meas = D.createElement('canvas').getContext('2d');
  var els = D.body ? D.body.getElementsByTagName('*') : [];
  var n = Math.min(els.length, MAX_EL); out.elements = els.length;
  var targets = [], small = [];
  for (var k = 0; k < n; k++) {
    var e = els[k], c = getComputedStyle(e);
    if (c.display === 'none') continue;
    var r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    var tag = e.tagName.toLowerCase(), top = r.top + scrollY;
    // Screen-reader-only helpers, decorative mock UI and inert regions are not
    // seen or operated by a sighted pointer user.
    var srOnly = r.width <= 2 || r.height <= 2 || (c.clip && c.clip !== 'auto') || /inset\(50%/.test(c.clipPath);
    // A visually hidden h1 is correct practice: it still counts for heading order.
    if (srOnly && /^h[1-6]$/.test(tag) && out.headings.length < 60) out.headings.push({ l: +tag[1], lines: 0, fs: 0, t: txt(e), y: Math.round(top) });
    if (srOnly || e.closest('[aria-hidden=true],[inert]')) continue;
    var inView = r.right > 0 && r.left < W;
    var inFooter = !!e.closest('footer,[role=contentinfo]');
    if (r.right > W + 1 && c.position !== 'fixed') {
      var clipped = false;
      for (var p = e.parentElement; p && p !== D.body; p = p.parentElement) { var pc = getComputedStyle(p); if (/hidden|clip|auto|scroll/.test(pc.overflowX)) { clipped = true; break; } }
      if (!clipped) push(out.overflow, { sel: sel(e), right: Math.round(r.right), w: Math.round(r.width) });
    }
    if (/^(img|video|canvas|picture|iframe)$/.test(tag) || (tag === 'svg' && r.width > 64)) ink(top, r.height);
    if (tag === 'img') {
      if (e.complete && e.naturalWidth === 0 && e.getAttribute('src')) push(out.brokenImages, { sel: sel(e), src: (e.getAttribute('src') || '').slice(0, 80) });
      if (!e.getAttribute('width') && !e.getAttribute('height') && !/aspect-ratio/.test(e.getAttribute('style') || '') && c.aspectRatio === 'auto') out.unsizedImages++;
    }
    var interactive = tag === 'a' || tag === 'button' || tag === 'select' || (tag === 'input' && e.type !== 'hidden') || e.getAttribute('role') === 'button';
    if (interactive && inView && c.visibility !== 'hidden' && +c.opacity > 0) {
      out.targetsChecked++;
      targets.push(r);
      var inline = tag === 'a' && c.display === 'inline' && e.parentElement && /^(p|li|td|span|dd)$/i.test(e.parentElement.tagName);
      if (!inline && (r.width < 24 || r.height < 24)) small.push([e, r]);
      var inChrome = !!e.closest('nav,header,footer,[role=navigation],[role=banner],[role=contentinfo]');
      if (!inline && !inChrome && r.height >= 28 && r.width >= 48 && top < 1400 && firstCtaBot === null) {
        firstCtaBot = Math.round(top + r.height);
      }
    }
    var own = 0;
    for (var cn = e.firstChild; cn; cn = cn.nextSibling) if (cn.nodeType === 3) own += cn.data.trim().length;
    if (!own) continue;
    var hidden = c.visibility === 'hidden' || +c.opacity < 0.05;
    // Below the fold, hidden text is usually a scroll-triggered reveal that has
    // not been scrolled to; only the first screen must be visible after load.
    if (hidden && (top >= H || !inView)) continue;
    if (hidden) {
      // Closed menus and popovers are positioned out of flow; reveal
      // animations act on in-flow content.
      var anc = e, inv = false;
      while (anc && anc !== D.body) { var ac = getComputedStyle(anc); if (ac.display === 'none' || ac.position === 'absolute' || ac.position === 'fixed') { inv = true; break; } anc = anc.parentElement; }
      if (!inv && !e.closest('[aria-hidden=true],[hidden],dialog:not([open]),[role=tooltip]')) { out.hiddenCount++; push(out.hiddenText, { sel: sel(e), t: txt(e), y: Math.round(top) }); }
      continue;
    }
    var fs = r1(px(c.fontSize));
    out.sizes[fs] = (out.sizes[fs] || 0) + own;
    var fam = c.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
    out.families[fam] = (out.families[fam] || 0) + own;
    if (/^(p|li|dd|blockquote)$/.test(tag) && !inFooter) out.bodySizes[fs] = (out.bodySizes[fs] || 0) + own;
    if (c.textAlign === 'justify' && own > 80) out.justified++;
    ink(top, r.height);
    if (((r.left >= 0 && r.left < 8) || (r.right <= W && r.right > W - 8)) && r.width < W - 4) { out.edgeCount++; push(out.edgeText, { sel: sel(e), left: Math.round(r.left), right: Math.round(W - r.right), t: txt(e) }); }
    if (/^(p|li|dd|blockquote)$/.test(tag) && own > 120 && !inFooter) {
      meas.font = c.fontStyle + ' ' + c.fontWeight + ' ' + c.fontSize + ' ' + c.fontFamily;
      var zero = meas.measureText('0').width || fs * 0.5;
      var ch = Math.round((r.width - px(c.paddingLeft) - px(c.paddingRight)) / zero);
      if (ch > 80) { out.longCount++; push(out.longLines, { sel: sel(e), ch: ch, t: txt(e) }); }
    }
    if (/^h[1-6]$/.test(tag)) {
      var lh = c.lineHeight === 'normal' ? fs * 1.2 : px(c.lineHeight);
      var lvl = +tag[1];
      if (out.headings.length < 60) out.headings.push({ l: lvl, lines: Math.max(1, Math.round(r.height / lh)), fs: fs, t: txt(e), y: Math.round(top) });
      if (lvl <= 2 && top < 1200 && (firstHeadTop === null || (lvl === 1 && firstHeadTop > top))) {
        firstHeadTop = Math.round(top);
        firstHeadBot = Math.round(top + r.height);
      }
      if (lvl >= 2 && lvl <= 4 && (c.position === 'static' || c.position === 'relative')) {
        var pv = e.previousElementSibling, nx = e.nextElementSibling;
        if (pv && nx) {
          var pr = pv.getBoundingClientRect(), nr = nx.getBoundingClientRect();
          if (pr.height > 2 && nr.height > 2) {
            var ab = r.top - pr.bottom, bl = nr.top - r.bottom;
            if (ab >= 4 && bl > 14 && bl > ab * 1.4) push(out.headingProximity, { sel: sel(e), above: Math.round(ab), below: Math.round(bl), t: txt(e) });
          }
        }
      }
    }
    var fg = rgba(c.color);
    // Gradient-clipped or transparent text has no single color to measure.
    var bg = inView && fg[3] >= 0.1 && c.webkitBackgroundClip !== 'text' && c.backgroundClip !== 'text' ? bgBehind(e) : null;
    if (bg) {
      out.contrastChecked++;
      var fgc = [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3])];
      var cr = ratio(fgc, bg);
      var large = fs >= 24 || (fs >= 18.66 && +c.fontWeight >= 700);
      if (cr < (large ? 3 : 4.5)) { out.contrastCount++; push(out.contrast, { sel: sel(e), ratio: Math.round(cr * 100) / 100, need: large ? 3 : 4.5, fs: fs, t: txt(e) }); }
    }
  }
  for (var bi = 0; bi < bands && out.blankBands.length < 20; bi++) if (!inked[bi]) out.blankBands.push(bi);
  if (firstHeadBot !== null) out.heroFold = { h1Bottom: firstHeadBot, ctaBottom: firstCtaBot };
  var hbLimit = Math.min(80, Math.floor(Math.min(800, out.docH) / 10)), firstHb = -1, lastHb = -1;
  for (var hbi = 0; hbi < hbLimit; hbi++) { if (heroBuckets[hbi]) { if (firstHb < 0) firstHb = hbi; lastHb = hbi; } }
  if (firstHb >= 0 && lastHb > firstHb) {
    var gapRun = 0, maxGap = 0;
    for (var hbj = firstHb; hbj <= lastHb; hbj++) { if (!heroBuckets[hbj]) { gapRun += 10; if (gapRun > maxGap) maxGap = gapRun; } else gapRun = 0; }
    out.heroDeadBand = maxGap;
  }
  if (W >= 1600) {
    var containers = D.querySelectorAll('main > *, body > section, article');
    for (var ci = 0; ci < containers.length; ci++) {
      var ce = containers[ci], cr2 = ce.getBoundingClientRect();
      if (cr2.width > 1640 && (ce.textContent || '').trim().length > 140 && !ce.querySelector('img,video,canvas')) {
        out.unboundedCount++; push(out.unbounded, { sel: sel(ce), w: Math.round(cr2.width) });
      }
    }
  }
  // WCAG 2.5.8 spacing exception: an undersized target passes when a 24px
  // square centred on it meets no other target.
  small.forEach(function (pair) {
    var q = pair[1], cxp = q.left + q.width / 2, cyp = q.top + q.height / 2;
    var crowded = targets.some(function (o) { return o !== q && o.left < cxp + 12 && o.right > cxp - 12 && o.top < cyp + 12 && o.bottom > cyp - 12; });
    if (crowded) { out.smallCount++; push(out.smallTargets, { sel: sel(pair[0]), w: r1(q.width), h: r1(q.height), t: txt(pair[0]) }); }
  });
  try { D.fonts.forEach(function (f) { if (f.status === 'loaded') { var nm = f.family.replace(/^["']|["']$/g, ''); if (out.loaded.indexOf(nm) < 0) out.loaded.push(nm); } }); } catch (e) {}
  return out;
})()`;
