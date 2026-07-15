(function () {
  'use strict';
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
})();
