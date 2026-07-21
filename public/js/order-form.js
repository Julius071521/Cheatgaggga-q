(function () {
  'use strict';
  var form = document.getElementById('order-form');
  if (!form) return;

  var platGrid = document.getElementById('plat-grid');
  var platInput = document.getElementById('of-platform');
  var trigger = document.getElementById('svc-trigger');
  var triggerLabel = document.getElementById('svc-trigger-label');
  var panel = document.getElementById('svc-panel');
  var searchInput = document.getElementById('svc-search');
  var listEl = document.getElementById('svc-list');
  var serviceInput = document.getElementById('of-service');
  var icons = document.getElementById('pb-icons');
  var qtyInput = document.getElementById('of-qty');
  var meta = document.getElementById('of-meta');
  var rateEl = document.getElementById('of-rate');
  var rangeEl = document.getElementById('of-range');
  var refillEl = document.getElementById('of-refill');
  var totalEl = document.getElementById('of-total');
  var submitBtn = document.getElementById('of-submit');
  var guidance = document.getElementById('of-guidance');

  var services = [];
  var current = null;
  var preselected = null;
  try { preselected = JSON.parse(form.getAttribute('data-preselected')); } catch (e) {}

  function peso(n) {
    return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtQty(n) {
    return Number(n) >= 100000000000 ? '∞' : Number(n).toLocaleString();
  }
  function iconFor(platform) {
    var tpl = icons && icons.querySelector('[data-pb="' + platform + '"] .pbadge');
    return tpl ? tpl.cloneNode(true) : null;
  }

  // ── Total / validity ──
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

  // ── Service picker (custom searchable dropdown) ──
  function closePanel() {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }
  function openPanel() {
    if (trigger.disabled) return;
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    searchInput.value = '';
    filterList('');
    setTimeout(function () { searchInput.focus(); }, 30);
  }

  function setTriggerLabel(svc) {
    triggerLabel.innerHTML = '';
    if (!svc) {
      var hint = document.createElement('span');
      hint.className = 'muted';
      hint.textContent = platInput.value ? '— Choose a service —' : '— Choose a platform first —';
      triggerLabel.appendChild(hint);
      return;
    }
    var ic = iconFor(svc.platform);
    if (ic) triggerLabel.appendChild(ic);
    var name = document.createElement('span');
    name.className = 'svc-trigger-name';
    name.textContent = '#' + svc.id + ' · ' + svc.name;
    triggerLabel.appendChild(name);
    var price = document.createElement('span');
    price.className = 'svc-trigger-price';
    price.textContent = peso(svc.ratePhp) + '/1k';
    triggerLabel.appendChild(price);
  }

  function renderList() {
    listEl.innerHTML = '';
    if (!services.length) {
      var empty = document.createElement('div');
      empty.className = 'svc-empty';
      empty.textContent = 'No services for this platform yet — check back soon!';
      listEl.appendChild(empty);
      return;
    }
    var lastCat = null;
    services.forEach(function (s) {
      var cat = s.category || 'General';
      if (cat !== lastCat) {
        lastCat = cat;
        var gh = document.createElement('div');
        gh.className = 'svc-group';
        gh.textContent = cat;
        listEl.appendChild(gh);
      }
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'svc-row';
      row.setAttribute('role', 'option');
      row.setAttribute('data-id', s.id);
      row.setAttribute('data-search', (s.name + ' ' + cat + ' #' + s.id).toLowerCase());

      var ic = iconFor(s.platform);
      if (ic) row.appendChild(ic);

      var body = document.createElement('span');
      body.className = 'svc-row-body';
      var nm = document.createElement('span');
      nm.className = 'svc-row-name';
      nm.textContent = s.name;
      var sub = document.createElement('span');
      sub.className = 'svc-row-sub';
      sub.textContent = '#' + s.id + ' · Min ' + fmtQty(s.min) + ' – Max ' + fmtQty(s.max) + (s.refill ? ' · ♻️ Refill' : '');
      body.appendChild(nm);
      body.appendChild(sub);
      row.appendChild(body);

      var pr = document.createElement('span');
      pr.className = 'svc-row-price';
      pr.textContent = peso(s.ratePhp);
      var per = document.createElement('small');
      per.textContent = '/1k';
      pr.appendChild(per);
      row.appendChild(pr);

      row.addEventListener('click', function () { selectService(s.id); closePanel(); });
      listEl.appendChild(row);
    });
  }

  function filterList(q) {
    var query = String(q || '').trim().toLowerCase();
    listEl.querySelectorAll('.svc-row').forEach(function (r) {
      r.hidden = query !== '' && r.getAttribute('data-search').indexOf(query) === -1;
    });
    // Hide category headers whose rows are all hidden.
    listEl.querySelectorAll('.svc-group').forEach(function (g) {
      var el = g.nextElementSibling;
      var visible = false;
      while (el && !el.classList.contains('svc-group')) {
        if (el.classList.contains('svc-row') && !el.hidden) { visible = true; break; }
        el = el.nextElementSibling;
      }
      g.hidden = !visible;
    });
    var any = listEl.querySelector('.svc-row:not([hidden])');
    var oldMsg = listEl.querySelector('.svc-nomatch');
    if (oldMsg) oldMsg.remove();
    if (!any && services.length) {
      var msg = document.createElement('div');
      msg.className = 'svc-empty svc-nomatch';
      msg.textContent = 'No match for "' + q + '" — try another keyword.';
      listEl.appendChild(msg);
    }
  }

  function markSelected() {
    listEl.querySelectorAll('.svc-row').forEach(function (r) {
      r.classList.toggle('selected', !!current && r.getAttribute('data-id') === String(current.id));
    });
  }

  // Quick quantity chips (Min · 100 · 500 · 1K · 5K · Max) within the range.
  var qtyChips = document.getElementById('qty-chips');
  function renderQtyChips() {
    if (!qtyChips) return;
    qtyChips.innerHTML = '';
    if (!current) { qtyChips.hidden = true; return; }
    var candidates = [current.min, 100, 500, 1000, 5000, 10000, current.max];
    var seen = {};
    var shown = 0;
    candidates.forEach(function (v) {
      if (v < current.min || v > current.max || seen[v]) return;
      seen[v] = true;
      if (shown >= 6) return;
      shown++;
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'qty-chip';
      chip.textContent = v === current.min ? 'Min ' + fmtQty(v)
        : v === current.max ? 'Max ' + fmtQty(v)
        : (v >= 1000 ? (v / 1000) + 'K' : String(v));
      chip.addEventListener('click', function () {
        qtyInput.value = v;
        updateTotal();
        qtyChips.querySelectorAll('.qty-chip').forEach(function (c) { c.classList.remove('active'); });
        chip.classList.add('active');
      });
      qtyChips.appendChild(chip);
    });
    qtyChips.hidden = shown === 0;
  }

  // Warn (don't block) when the link doesn't match the chosen platform.
  var linkInput = document.getElementById('of-link');
  var linkWarn = document.getElementById('of-linkwarn');
  var linkWarnPlat = document.getElementById('of-linkwarn-plat');
  var PLATFORM_DOMAINS = {
    instagram: ['instagram.com'], tiktok: ['tiktok.com'],
    facebook: ['facebook.com', 'fb.com', 'fb.watch'], youtube: ['youtube.com', 'youtu.be'],
    twitter: ['twitter.com', 'x.com'], telegram: ['t.me', 'telegram.me'],
    spotify: ['spotify.com'], snapchat: ['snapchat.com'], twitch: ['twitch.tv'],
    discord: ['discord.gg', 'discord.com'], linkedin: ['linkedin.com'],
  };
  function checkLink() {
    if (!linkWarn) return;
    var plat = platInput.value;
    var domains = PLATFORM_DOMAINS[plat];
    var val = (linkInput.value || '').trim();
    var mismatch = false;
    if (domains && val) {
      try {
        var host = new URL(val).hostname.toLowerCase().replace(/^www\./, '');
        mismatch = !domains.some(function (d) { return host === d || host.endsWith('.' + d); });
      } catch (e) { /* not a URL yet — the input's own validation handles it */ }
    }
    if (mismatch) {
      // Use the pretty label from the active platform button ("TikTok", not "Tiktok").
      var activeBtn = platGrid && platGrid.querySelector('.plat-btn.active span:last-child');
      linkWarnPlat.textContent = activeBtn ? activeBtn.textContent : plat.charAt(0).toUpperCase() + plat.slice(1);
      linkWarn.hidden = false;
    } else {
      linkWarn.hidden = true;
    }
  }
  if (linkInput) {
    linkInput.addEventListener('input', checkLink);
    linkInput.addEventListener('blur', checkLink);
  }

  var dripBox = document.getElementById('dripfeed-box');
  var dripToggle = document.getElementById('of-drip');
  var dripFields = document.getElementById('drip-fields');
  if (dripToggle && dripFields) {
    dripToggle.addEventListener('change', function () { dripFields.hidden = !dripToggle.checked; });
  }

  function selectService(id) {
    current = services.find(function (s) { return String(s.id) === String(id); }) || null;
    serviceInput.value = current ? current.id : '';
    setTriggerLabel(current);
    markSelected();
    if (current) {
      meta.hidden = false;
      if (guidance) guidance.hidden = false; // assistant guidance appears on select
      // Service-aware test suggestion: start at the minimum (up to ~2x, capped by max).
      var testEl = document.getElementById('ofg-testqty');
      if (testEl) {
        var lo = current.min;
        var hi = Math.min(current.max, Math.max(current.min, current.min * 2));
        testEl.textContent = hi > lo ? ('e.g. ' + fmtQty(lo) + '–' + fmtQty(hi)) : ('e.g. ' + fmtQty(lo));
      }
      rateEl.textContent = '💰 ' + peso(current.ratePhp) + ' / 1000';
      rangeEl.textContent = '📦 Min ' + fmtQty(current.min) + ' · Max ' + fmtQty(current.max);
      refillEl.textContent = current.refill ? '♻️ Refill available' : '♻️ No refill';
      qtyInput.min = current.min;
      qtyInput.max = current.max;
      if (!qtyInput.value) qtyInput.value = current.min;
    } else {
      meta.hidden = true;
      if (guidance) guidance.hidden = true;
    }
    // Drip-feed box only for services that support it.
    if (dripBox) {
      var supports = !!(current && current.dripfeed);
      dripBox.hidden = !supports;
      if (!supports && dripToggle) { dripToggle.checked = false; if (dripFields) dripFields.hidden = true; }
    }
    renderQtyChips();
    checkLink();
    updateTotal();
  }

  function loadServices(platform, thenSelect) {
    trigger.disabled = true;
    triggerLabel.innerHTML = '<span class="muted">Loading services…</span>';
    fetch('/order/services.json?platform=' + encodeURIComponent(platform), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (list) {
        services = list;
        renderList();
        trigger.disabled = false;
        if (thenSelect) selectService(thenSelect);
        else setTriggerLabel(null);
      })
      .catch(function () {
        triggerLabel.innerHTML = '<span class="muted">Could not load — refresh the page</span>';
      });
  }

  // ── Platform buttons ──
  if (platGrid) {
    platGrid.addEventListener('click', function (e) {
      var btn = e.target.closest('.plat-btn');
      if (!btn) return;
      platGrid.querySelectorAll('.plat-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      platInput.value = btn.getAttribute('data-platform');
      current = null;
      serviceInput.value = '';
      meta.hidden = true;
      if (guidance) guidance.hidden = true;
      closePanel();
      renderQtyChips();
      checkLink();
      updateTotal();
      loadServices(platInput.value);
    });
  }

  // ── Picker open/close wiring ──
  trigger.addEventListener('click', function () {
    if (panel.hidden) openPanel(); else closePanel();
  });
  searchInput.addEventListener('input', function () { filterList(searchInput.value); });
  document.addEventListener('click', function (e) {
    if (!panel.hidden && !e.target.closest('#svc-picker')) closePanel();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !panel.hidden) { closePanel(); trigger.focus(); }
  });

  qtyInput.addEventListener('input', updateTotal);

  if (preselected && preselected.platform) {
    platInput.value = preselected.platform;
    loadServices(preselected.platform, preselected.id);
  }

  // ── Confirmation modal before placing the order ──
  var modal = document.getElementById('of-confirm');
  var confirmBtn = document.getElementById('cf-confirm');
  var cancelBtn = document.getElementById('cf-cancel');
  if (modal && confirmBtn && cancelBtn) {
    var confirmed = false;
    form.addEventListener('submit', function (e) {
      if (confirmed) return; // second pass — let it submit
      e.preventDefault();
      if (!current || submitBtn.disabled) return;
      var qty = parseInt(qtyInput.value, 10) || 0;
      document.getElementById('cf-service').textContent = current.name.length > 60 ? current.name.slice(0, 60) + '…' : current.name;
      document.getElementById('cf-qty').textContent = qty.toLocaleString();
      document.getElementById('cf-total').textContent = totalEl.textContent;
      modal.hidden = false;
      document.body.style.overflow = 'hidden';
    });
    function closeModal() { modal.hidden = true; document.body.style.overflow = ''; }
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
    confirmBtn.addEventListener('click', function () {
      confirmed = true;
      closeModal();
      form.submit();
    });
  }
})();
