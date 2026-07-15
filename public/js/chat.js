(function () {
  'use strict';
  var fab = document.getElementById('chat-fab');
  var panel = document.getElementById('chat-panel');
  var closeBtn = document.getElementById('chat-close');
  var body = document.getElementById('chat-body');
  var form = document.getElementById('chat-form');
  var input = document.getElementById('chat-text');
  var quick = document.getElementById('chat-quick');
  if (!fab || !panel || !form) return;

  var csrfMeta = document.querySelector('meta[name="csrf-token"]');
  var csrf = csrfMeta ? csrfMeta.getAttribute('content') : '';
  var busy = false;
  var context = null; // { loggedIn, orders }

  function toggle(open) {
    panel.hidden = !open;
    fab.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { input.focus(); loadContext(); }
  }
  fab.addEventListener('click', function () { toggle(panel.hidden); });
  closeBtn.addEventListener('click', function () { toggle(false); });

  function addMsg(role, text) {
    var div = document.createElement('div');
    div.className = 'chat-msg ' + role;
    div.textContent = text;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
    return div;
  }

  function loadContext() {
    if (context) return;
    fetch('/ai/context', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) { context = d; })
      .catch(function () { context = { loggedIn: false, orders: [] }; });
  }

  // ── Normal chat ──
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || busy) return;
    sendChat(text);
    input.value = '';
  });

  function sendChat(text) {
    busy = true;
    addMsg('user', text);
    var typing = addMsg('bot typing', 'Typing…');
    fetch('/ai/chat', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ message: text }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) { typing.remove(); addMsg('bot', data.reply || data.error || 'Sorry, something went wrong.'); })
      .catch(function () { typing.remove(); addMsg('bot', 'Connection problem — please try again in a moment.'); })
      .finally(function () { busy = false; });
  }

  // ── Report flow ──
  if (quick) {
    quick.addEventListener('click', function (e) {
      var btn = e.target.closest('.chat-chip');
      if (!btn) return;
      startReport(btn.getAttribute('data-report'));
    });
  }

  function startReport(type) {
    if (busy) return;
    addMsg('user', type);
    if (!context) { addMsg('bot typing', 'One moment…'); loadContext(); setTimeout(function () { startReport(type); }, 700); return; }

    if (!context.loggedIn) {
      var m = addMsg('bot', 'To submit a report I need you signed in. ');
      var a = document.createElement('a');
      a.href = '/login'; a.textContent = 'Sign in here'; a.className = 'chat-link';
      m.appendChild(a);
      return;
    }
    addMsg('bot', 'Got it — a "' + type + '" report. Pick the order and add a short note, then tap Submit report. 👇');
    renderReportForm(type);
  }

  function renderReportForm(type) {
    var wrap = document.createElement('div');
    wrap.className = 'chat-report';

    var sel = document.createElement('select');
    sel.className = 'chat-report-sel';
    if (context.orders.length) {
      context.orders.forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o.id; opt.textContent = o.label;
        sel.appendChild(opt);
      });
    } else {
      var opt = document.createElement('option');
      opt.value = ''; opt.textContent = 'No orders found (report without order)';
      sel.appendChild(opt);
    }

    var ta = document.createElement('textarea');
    ta.className = 'chat-report-msg';
    ta.rows = 2;
    ta.maxLength = 2000;
    ta.placeholder = 'Describe your concern…';

    var submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'btn btn-primary btn-sm chat-report-submit';
    submit.textContent = 'Submit report';

    wrap.appendChild(sel);
    wrap.appendChild(ta);
    wrap.appendChild(submit);
    body.appendChild(wrap);
    body.scrollTop = body.scrollHeight;

    submit.addEventListener('click', function () {
      var msg = ta.value.trim();
      if (msg.length < 3) { ta.focus(); ta.style.borderColor = '#ef4444'; return; }
      submit.disabled = true; submit.textContent = 'Sending…';
      fetch('/ai/report', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ request_type: type, order_id: sel.value || null, message: msg }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          wrap.remove();
          addMsg('bot', res.ok ? res.d.message : (res.d.error || 'Could not submit. Please try again.'));
        })
        .catch(function () { wrap.remove(); addMsg('bot', 'Connection problem — please try again.'); });
    });
  }
})();
