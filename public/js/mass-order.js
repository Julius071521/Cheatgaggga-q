(function () {
  'use strict';
  var form = document.getElementById('mass-form');
  if (!form) return;

  var platformSel = document.getElementById('mo-platform');
  var serviceSel = document.getElementById('mo-service');
  var linksEl = document.getElementById('mo-links');
  var qtyInput = document.getElementById('mo-qty');
  var meta = document.getElementById('mo-meta');
  var rateEl = document.getElementById('mo-rate');
  var rangeEl = document.getElementById('mo-range');
  var totalEl = document.getElementById('mo-total');
  var countEl = document.getElementById('mo-count');
  var submitBtn = document.getElementById('mo-submit');

  var services = [];
  var current = null;

  function peso(n) {
    return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function linkCount() {
    var seen = {};
    return linksEl.value.split(/\r?\n/).map(function (l) { return l.trim(); })
      .filter(function (l) { return l && /^https?:\/\//i.test(l) && !seen[l] && (seen[l] = 1); }).length;
  }

  function update() {
    var n = linkCount();
    var qty = parseInt(qtyInput.value, 10);
    countEl.textContent = '(' + n + ' link' + (n === 1 ? '' : 's') + ')';
    if (!current || !qty || qty < 1 || !n) {
      totalEl.textContent = '₱0.00'; submitBtn.disabled = true; return;
    }
    var per = Math.max(0.01, Math.ceil((current.ratePhp * qty) / 1000 * 100) / 100);
    totalEl.textContent = peso(per * n);
    var inRange = qty >= current.min && qty <= current.max;
    submitBtn.disabled = !inRange || n === 0;
    qtyInput.setCustomValidity(inRange ? '' : 'Quantity must be between ' + current.min + ' and ' + current.max);
  }

  function selectService(id) {
    current = services.find(function (s) { return String(s.id) === String(id); }) || null;
    if (current) {
      meta.hidden = false;
      rateEl.textContent = '💰 ' + peso(current.ratePhp) + ' / 1000';
      rangeEl.textContent = '📦 Min ' + current.min.toLocaleString() + ' · Max ' + current.max.toLocaleString();
      qtyInput.min = current.min; qtyInput.max = current.max;
      if (!qtyInput.value) qtyInput.value = current.min;
    } else { meta.hidden = true; }
    update();
  }

  function loadServices(platform) {
    serviceSel.disabled = true;
    serviceSel.innerHTML = '<option value="">Loading…</option>';
    fetch('/order/services.json?platform=' + encodeURIComponent(platform), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (list) {
        services = list;
        if (!list.length) { serviceSel.innerHTML = '<option value="">No services for this platform yet</option>'; return; }
        var groups = {};
        list.forEach(function (s) { (groups[s.category || 'Other'] = groups[s.category || 'Other'] || []).push(s); });
        serviceSel.innerHTML = '<option value="">— Choose a service —</option>';
        Object.keys(groups).forEach(function (g) {
          var og = document.createElement('optgroup'); og.label = g;
          groups[g].forEach(function (s) {
            var opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = '#' + s.id + ' · ' + s.name + ' — ' + peso(s.ratePhp) + '/1k';
            og.appendChild(opt);
          });
          serviceSel.appendChild(og);
        });
        serviceSel.disabled = false;
      })
      .catch(function () { serviceSel.innerHTML = '<option value="">Could not load — refresh</option>'; });
  }

  platformSel.addEventListener('change', function () {
    current = null; meta.hidden = true; update();
    if (platformSel.value) loadServices(platformSel.value);
    else { serviceSel.disabled = true; serviceSel.innerHTML = '<option value="">— Choose a platform first —</option>'; }
  });
  serviceSel.addEventListener('change', function () { selectService(serviceSel.value); });
  qtyInput.addEventListener('input', update);
  linksEl.addEventListener('input', update);
})();
