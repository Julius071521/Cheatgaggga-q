(function () {
  'use strict';
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── Confirmation for destructive actions (CSP-safe) ──────
  // The site's CSP sets script-src-attr 'none', which blocks inline
  // onsubmit/onclick handlers — so confirmations MUST live here, delegated off
  // data-attributes. Any form/link with [data-confirm] asks first; forms whose
  // data-confirm-type="type" require the user to type CONFIRM (very destructive).
  document.addEventListener('submit', function (e) {
    var el = e.target.closest ? e.target.closest('[data-confirm]') : null;
    if (!el) return;
    var msg = el.getAttribute('data-confirm') || 'Are you sure?';
    if (el.hasAttribute('data-confirm-type')) {
      var answer = window.prompt(msg + '\n\nType CONFIRM to proceed:');
      if (String(answer || '').trim().toUpperCase() !== 'CONFIRM') { e.preventDefault(); return false; }
    } else if (!window.confirm(msg)) {
      e.preventDefault(); return false;
    }
    return true;
  });
  document.addEventListener('click', function (e) {
    // Links/buttons that confirm before navigating.
    var c = e.target.closest ? e.target.closest('a[data-confirm], button[data-confirm]') : null;
    if (c && !c.closest('form')) {
      if (!window.confirm(c.getAttribute('data-confirm') || 'Are you sure?')) { e.preventDefault(); return false; }
    }
    // Select-on-click inputs (e.g. copy a referral link) — replaces onclick.
    var s = e.target.closest ? e.target.closest('[data-select]') : null;
    if (s && s.select) s.select();

    // Order "Report" → open the shared body-level dialog (works on mobile,
    // unlike a form trapped inside a horizontally-scrolling table).
    var rep = e.target.closest ? e.target.closest('[data-report]') : null;
    var sheet = document.getElementById('report-sheet');
    if (rep && sheet) {
      var form = document.getElementById('report-form');
      form.setAttribute('action', '/orders/' + rep.getAttribute('data-order-id') + '/ticket');
      var lbl = document.getElementById('report-order-label');
      if (lbl) lbl.textContent = rep.getAttribute('data-order-code') || '';
      var ta = form.querySelector('textarea'); if (ta) ta.value = '';
      if (sheet.showModal) sheet.showModal(); else sheet.setAttribute('open', '');
    }
    if (e.target.closest && e.target.closest('[data-report-close]') && sheet) {
      if (sheet.close) sheet.close(); else sheet.removeAttribute('open');
    }

    // Order "★ Review" → open the review dialog (Completed orders only).
    var rv = e.target.closest ? e.target.closest('[data-review]') : null;
    var rsheet = document.getElementById('review-sheet');
    if (rv && rsheet) {
      var rform = document.getElementById('review-form');
      rform.setAttribute('action', '/orders/' + rv.getAttribute('data-order-id') + '/review');
      var rlbl = document.getElementById('review-order-label');
      if (rlbl) rlbl.textContent = rv.getAttribute('data-order-code') || '';
      rform.querySelectorAll('input[name="rating"]').forEach(function (i) { i.checked = false; });
      var rta = rform.querySelector('textarea'); if (rta) rta.value = '';
      if (rsheet.showModal) rsheet.showModal(); else rsheet.setAttribute('open', '');
    }
    if (e.target.closest && e.target.closest('[data-review-close]') && rsheet) {
      if (rsheet.close) rsheet.close(); else rsheet.removeAttribute('open');
    }
  });

  // ── Theme toggle ─────────────────────────────────────────
  var themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('theme', next); } catch (e) {}
    });
  }

  // ── Mobile nav ───────────────────────────────────────────
  var burger = document.getElementById('nav-burger');
  var links = document.getElementById('nav-links');
  if (burger && links) {
    burger.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    links.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') links.classList.remove('open');
    });
  }

  // ── Sticky nav shadow ────────────────────────────────────
  var nav = document.getElementById('site-nav');
  if (nav) {
    var onScroll = function () { nav.classList.toggle('scrolled', window.scrollY > 8); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // ── Flash dismiss ────────────────────────────────────────
  document.querySelectorAll('.flash-close').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var flash = btn.closest('.flash');
      if (flash) flash.remove();
    });
  });

  // ── Copy buttons ─────────────────────────────────────────
  document.querySelectorAll('.copy-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy') || '';
      var done = function () {
        var old = btn.textContent;
        btn.textContent = '✓ Copied';
        setTimeout(function () { btn.textContent = old; }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () {});
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (e) {}
        ta.remove();
      }
    });
  });

  // ── API key show/hide ────────────────────────────────────
  var keyToggle = document.getElementById('api-key-toggle');
  var keyEl = document.getElementById('api-key');
  if (keyToggle && keyEl) {
    var shown = false;
    keyToggle.addEventListener('click', function () {
      shown = !shown;
      keyEl.textContent = shown ? keyEl.getAttribute('data-full') : keyEl.getAttribute('data-masked');
      keyToggle.textContent = shown ? 'Hide' : 'Show';
    });
  }

  // ── Animated counters ────────────────────────────────────
  function animateCount(el) {
    var target = parseInt(el.getAttribute('data-count'), 10) || 0;
    if (reduceMotion) { el.textContent = target.toLocaleString(); return; }
    var duration = parseInt(el.getAttribute('data-count-duration'), 10) || 1800;
    var start = null;
    function tick(ts) {
      if (!start) start = ts;
      var p = Math.min(1, (ts - start) / duration);
      var eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      el.textContent = Math.round(target * eased).toLocaleString();
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // ── Scroll reveals + counter triggers ────────────────────
  var revealEls = document.querySelectorAll('[data-reveal]');
  revealEls.forEach(function (el) {
    var delay = el.getAttribute('data-reveal-delay');
    if (delay) el.style.setProperty('--reveal-delay', delay + 'ms');
  });

  if ('IntersectionObserver' in window) {
    var seen = new WeakSet();
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        if (el.hasAttribute('data-reveal')) el.classList.add('revealed');
        if (el.hasAttribute('data-count') && !seen.has(el)) {
          seen.add(el);
          animateCount(el);
        }
        io.unobserve(el);
      });
    }, { threshold: 0.18, rootMargin: '0px 0px -30px 0px' });

    revealEls.forEach(function (el) { io.observe(el); });
    document.querySelectorAll('[data-count]').forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('revealed'); });
    document.querySelectorAll('[data-count]').forEach(animateCount);
  }

  // ── Hero parallax on mouse (floating icons) ──────────────
  var floats = document.querySelectorAll('.float-icon[data-depth]');
  if (floats.length && !reduceMotion && window.matchMedia('(pointer: fine)').matches) {
    var hero = document.querySelector('.hero');
    if (hero) {
      hero.addEventListener('mousemove', function (e) {
        var cx = window.innerWidth / 2;
        var cy = window.innerHeight / 2;
        var dx = (e.clientX - cx) / cx;
        var dy = (e.clientY - cy) / cy;
        floats.forEach(function (el) {
          var depth = parseFloat(el.getAttribute('data-depth')) || 10;
          el.style.marginLeft = (dx * depth) + 'px';
          el.style.marginTop = (dy * depth) + 'px';
        });
      });
    }
  }

  // ── Tilt effect on the hero phone card ───────────────────
  var tilt = document.querySelector('.tilt');
  if (tilt && !reduceMotion && window.matchMedia('(pointer: fine)').matches) {
    tilt.addEventListener('mousemove', function (e) {
      var r = tilt.getBoundingClientRect();
      var x = (e.clientX - r.left) / r.width - 0.5;
      var y = (e.clientY - r.top) / r.height - 0.5;
      tilt.style.transform = 'perspective(700px) rotateY(' + (x * 8) + 'deg) rotateX(' + (-y * 8) + 'deg)';
      tilt.style.animation = 'none';
    });
    tilt.addEventListener('mouseleave', function () {
      tilt.style.transform = '';
      tilt.style.animation = '';
    });
  }

  // ── Dashboard sidebar: mobile drawer + desktop collapse ──
  var shell = document.getElementById('app-shell');
  if (shell) {
    var burger = document.getElementById('app-burger');
    var scrim = document.getElementById('app-scrim');
    var collapseBtn = document.getElementById('as-collapse');
    var sidebar = document.getElementById('app-sidebar');

    function setDrawer(open) {
      shell.classList.toggle('nav-open', open);
      if (scrim) scrim.hidden = !open;
      if (burger) burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      document.body.style.overflow = open ? 'hidden' : '';
      if (open && sidebar) {
        var first = sidebar.querySelector('a, button');
        if (first) first.focus();
      }
    }
    if (burger) burger.addEventListener('click', function () { setDrawer(!shell.classList.contains('nav-open')); });
    if (scrim) scrim.addEventListener('click', function () { setDrawer(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && shell.classList.contains('nav-open')) { setDrawer(false); if (burger) burger.focus(); }
    });
    // Following a link inside the drawer should close it (same-page anchors too).
    if (sidebar) sidebar.addEventListener('click', function (e) {
      if (e.target.closest('a') && window.matchMedia('(max-width: 1000px)').matches) setDrawer(false);
    });

    // Collapsed state is a preference, so it survives navigation.
    try {
      if (localStorage.getItem('apex.sidebar') === 'collapsed') shell.classList.add('collapsed');
    } catch (_) {}
    if (collapseBtn) collapseBtn.addEventListener('click', function () {
      var nowCollapsed = !shell.classList.contains('collapsed');
      shell.classList.toggle('collapsed', nowCollapsed);
      collapseBtn.setAttribute('aria-label', nowCollapsed ? 'Expand sidebar' : 'Collapse sidebar');
      try { localStorage.setItem('apex.sidebar', nowCollapsed ? 'collapsed' : 'open'); } catch (_) {}
    });
  }
})();
