(function () {
  // Labels arrive as "2026-07-07" (daily) or "2026-07" (monthly). Render a
  // short human date; the previous slice(5) turned "Jul 07" into "ul 07".
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function shortDate(raw) {
    var m = String(raw == null ? '' : raw).match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
    if (!m) return String(raw || '');
    var mon = MONTHS[Number(m[2]) - 1] || m[2];
    return m[3] ? mon + ' ' + m[3] : mon + " '" + m[1].slice(2);
  }

  'use strict';
  // CSP-safe: data comes from data-* attributes on the containers, not an
  // inline <script> (the site's CSP has no 'unsafe-inline').
  function readData(id, attr) {
    var el = document.getElementById(id);
    if (!el) return null;
    try { return JSON.parse(el.getAttribute(attr) || '[]'); } catch (e) { return []; }
  }
  var MONTHLY = readData('chart-monthly', 'data-monthly') || [];
  var DAILY = readData('chart-daily', 'data-daily') || [];

  var peso = function (n) { return '₱' + Number(n).toLocaleString('en-PH', { maximumFractionDigits: 0 }); };
  var NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs) { var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function tip(box) { var t = document.createElement('div'); t.className = 'chart-tip'; box.appendChild(t); return t; }
  function showTip(t, box, x, y, html) {
    t.innerHTML = html; t.style.display = 'block';
    var bw = box.clientWidth, tw = t.offsetWidth;
    t.style.left = Math.min(Math.max(0, x - tw / 2), bw - tw) + 'px';
    t.style.top = Math.max(0, y - t.offsetHeight - 10) + 'px';
  }

  // Line chart: monthly revenue (blue) vs profit (green).
  function lineChart(boxId, rows) {
    var box = document.getElementById(boxId); if (!box || !rows.length) { if (box) box.innerHTML = '<p class="empty-note">No data yet.</p>'; return; }
    var W = Math.max(560, box.clientWidth), H = 260, P = { t: 16, r: 74, b: 26, l: 10 };
    // The viewBox is a fixed 560 units wide but the box is only ~330px on a
    // phone, so every length is scaled down by that ratio when painted. Label
    // sizes are given in CSS pixels and converted here, otherwise a "10" label
    // renders at about 6px and is unreadable.
    var px = function (n) { return Math.round(n * W / Math.max(1, box.clientWidth || W)); };
    var max = Math.max(1, Math.max.apply(null, rows.map(function (d) { return Math.max(d.r, d.p); })));
    var iw = W - P.l - P.r, ih = H - P.t - P.b;
    var X = function (i) { return P.l + (rows.length === 1 ? iw / 2 : i * iw / (rows.length - 1)); };
    var Y = function (v) { return P.t + ih - (v / max) * ih; };
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img' });
    for (var g = 0; g <= 3; g++) {
      var gy = P.t + ih * g / 3;
      svg.appendChild(el('line', { x1: P.l, x2: P.l + iw, y1: gy, y2: gy, stroke: 'var(--border)', 'stroke-width': 1 }));
      var lab = el('text', { x: P.l + iw + 6, y: gy + 4, 'font-size': px(12), fill: 'var(--text-soft)' });
      lab.textContent = peso(max * (1 - g / 3)); svg.appendChild(lab);
    }
    [['r', '#2563eb'], ['p', '#10b981']].forEach(function (S) {
      var path = rows.map(function (d, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(d[S[0]]).toFixed(1); }).join(' ');
      svg.appendChild(el('path', { d: path, fill: 'none', stroke: S[1], 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      var last = rows[rows.length - 1];
      var dl = el('text', { x: X(rows.length - 1) + 6, y: Y(last[S[0]]) + 4, 'font-size': px(12), 'font-weight': 700, fill: 'var(--text)' });
      dl.textContent = peso(last[S[0]]); svg.appendChild(dl);
    });
    [0, Math.floor((rows.length - 1) / 2), rows.length - 1].forEach(function (i) {
      if (i < 0 || i >= rows.length) return;
      var t = el('text', { x: X(i), y: H - 8, 'font-size': px(12), fill: 'var(--text-soft)', 'text-anchor': 'middle' });
      t.textContent = rows[i].l; svg.appendChild(t);
    });
    var hover = el('g', {}); svg.appendChild(hover);
    box.appendChild(svg);
    var t = tip(box);
    svg.addEventListener('mousemove', function (ev) {
      var rect = svg.getBoundingClientRect();
      var fx = (ev.clientX - rect.left) * (W / rect.width);
      var i = Math.round((fx - P.l) / (iw / Math.max(1, rows.length - 1)));
      i = Math.max(0, Math.min(rows.length - 1, i));
      hover.innerHTML = '';
      hover.appendChild(el('line', { x1: X(i), x2: X(i), y1: P.t, y2: P.t + ih, stroke: 'var(--border)', 'stroke-width': 1 }));
      [['r', '#2563eb'], ['p', '#10b981']].forEach(function (S) {
        hover.appendChild(el('circle', { cx: X(i), cy: Y(rows[i][S[0]]), r: 4.5, fill: S[1], stroke: 'var(--surface)', 'stroke-width': 2 }));
      });
      showTip(t, box, X(i) * (rect.width / W), P.t, '<strong>' + rows[i].l + '</strong><br>Revenue: ' + peso(rows[i].r) + '<br>Profit: ' + peso(rows[i].p));
    });
    svg.addEventListener('mouseleave', function () { hover.innerHTML = ''; t.style.display = 'none'; });
  }

  // Bar chart: daily revenue.
  function barChart(boxId, rows) {
    var box = document.getElementById(boxId); if (!box || !rows.length) { if (box) box.innerHTML = '<p class="empty-note">No data yet.</p>'; return; }
    var W = Math.max(560, box.clientWidth), H = 220, P = { t: 14, r: 74, b: 26, l: 10 };
    var px = function (n) { return Math.round(n * W / Math.max(1, box.clientWidth || W)); };
    var max = Math.max(1, Math.max.apply(null, rows.map(function (d) { return d.r; })));
    var iw = W - P.l - P.r, ih = H - P.t - P.b;
    var bw = Math.max(3, iw / rows.length - 2);
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img' });
    for (var g = 0; g <= 2; g++) {
      var gy = P.t + ih * g / 2;
      svg.appendChild(el('line', { x1: P.l, x2: P.l + iw, y1: gy, y2: gy, stroke: 'var(--border)', 'stroke-width': 1 }));
      var lab = el('text', { x: P.l + iw + 6, y: gy + 4, 'font-size': px(12), fill: 'var(--text-soft)' });
      lab.textContent = peso(max * (1 - g / 2)); svg.appendChild(lab);
    }
    var t = tip(box);
    rows.forEach(function (d, i) {
      var x = P.l + i * (iw / rows.length) + 1;
      var h = Math.max(1, (d.r / max) * ih);
      var bar = el('rect', { x: x, y: P.t + ih - h, width: bw, height: h, rx: 2, fill: '#2563eb' });
      var hit = el('rect', { x: x - 1, y: P.t, width: bw + 2, height: ih, fill: 'transparent' });
      hit.addEventListener('mousemove', function () {
        var rect = svg.getBoundingClientRect();
        showTip(t, box, (x + bw / 2) * (rect.width / W), P.t, '<strong>' + d.l + '</strong><br>' + peso(d.r));
        bar.setAttribute('fill', '#0ea5e9');
      });
      hit.addEventListener('mouseleave', function () { t.style.display = 'none'; bar.setAttribute('fill', '#2563eb'); });
      svg.appendChild(bar); svg.appendChild(hit);
    });
    [0, rows.length - 1].forEach(function (i) {
      if (i < 0) return;
      var tx = el('text', { x: P.l + i * (iw / rows.length) + bw / 2, y: H - 8, 'font-size': px(12), fill: 'var(--text-soft)', 'text-anchor': i === 0 ? 'start' : 'middle' });
      // slice(5) chopped "Jul 07" into "ul 07" — format from the raw date instead.
      tx.textContent = shortDate(rows[i].l); svg.appendChild(tx);
    });
    box.appendChild(svg);
  }

  lineChart('chart-monthly', MONTHLY);
  barChart('chart-daily', DAILY);
})();
