(function () {
  'use strict';
  var form = document.getElementById('order-form');
  if (!form) return;

  var platformSel = document.getElementById('of-platform');
  var serviceSel = document.getElementById('of-service');
  var qtyInput = document.getElementById('of-qty');
  var meta = document.getElementById('of-meta');
  var rateEl = document.getElementById('of-rate');
  var rangeEl = document.getElementById('of-range');
  var refillEl = document.getElementById('of-refill');
  var totalEl = document.getElementById('of-total');
  var submitBtn = document.getElementById('of-submit');

  var services = [];
  var current = null;
  var preselected = null;
  try { preselected = JSON.parse(form.getAttribute('data-preselected')); } catch (e) {}

  function peso(n) {
    return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function updateTotal() {
    var qty = parseInt(qtyInput.value, 10);
    if (!current || !qty || qty < 1) {
      totalEl.textContent = '₱0.00';
      submitBtn.disabled = true;
      return;
    }
    // Same rounding as the server: round UP to the centavo.
    var charge = Math.max(0.01, Math.ceil((current.ratePhp * qty) / 1000 * 100) / 100);
    totalEl.textContent = peso(charge);
    var inRange = qty >= current.min && qty <= current.max;
    submitBtn.disabled = !inRange;
    qtyInput.setCustomValidity(inRange ? '' : 'Quantity must be between ' + current.min + ' and ' + current.max);
  }

  function selectService(id) {
    current = services.find(function (s) { return String(s.id) === String(id); }) || null;
    if (current) {
      meta.hidden = false;
      rateEl.textContent = '💰 ' + peso(current.ratePhp) + ' / 1000';
      rangeEl.textContent = '📦 Min ' + current.min.toLocaleString() + ' · Max ' + current.max.toLocaleString();
      refillEl.textContent = current.refill ? '♻️ Refill available' : '♻️ No refill';
      qtyInput.min = current.min;
      qtyInput.max = current.max;
      if (!qtyInput.value) qtyInput.value = current.min;
    } else {
      meta.hidden = true;
    }
    updateTotal();
  }

  function loadServices(platform, thenSelect) {
    serviceSel.disabled = true;
    serviceSel.innerHTML = '<option value="">Loading…</option>';
    fetch('/order/services.json?platform=' + encodeURIComponent(platform), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (list) {
        services = list;
        if (!list.length) {
          serviceSel.innerHTML = '<option value="">No services for this platform yet</option>';
          return;
        }
        var groups = {};
        list.forEach(function (s) {
          var g = s.category || 'Other';
          (groups[g] = groups[g] || []).push(s);
        });
        serviceSel.innerHTML = '<option value="">— Choose a service —</option>';
        Object.keys(groups).forEach(function (g) {
          var og = document.createElement('optgroup');
          og.label = g;
          groups[g].forEach(function (s) {
            var opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = '#' + s.id + ' · ' + s.name + ' — ' + peso(s.ratePhp) + '/1k';
            og.appendChild(opt);
          });
          serviceSel.appendChild(og);
        });
        serviceSel.disabled = false;
        if (thenSelect) {
          serviceSel.value = String(thenSelect);
          selectService(thenSelect);
        }
      })
      .catch(function () {
        serviceSel.innerHTML = '<option value="">Could not load services — refresh the page</option>';
      });
  }

  platformSel.addEventListener('change', function () {
    current = null;
    meta.hidden = true;
    updateTotal();
    if (platformSel.value) loadServices(platformSel.value);
    else {
      serviceSel.disabled = true;
      serviceSel.innerHTML = '<option value="">— Choose a platform first —</option>';
    }
  });

  serviceSel.addEventListener('change', function () { selectService(serviceSel.value); });
  qtyInput.addEventListener('input', updateTotal);

  if (preselected && preselected.platform) {
    loadServices(preselected.platform, preselected.id);
  }
})();
