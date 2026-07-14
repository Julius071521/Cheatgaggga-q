(function () {
  'use strict';
  var fab = document.getElementById('chat-fab');
  var panel = document.getElementById('chat-panel');
  var closeBtn = document.getElementById('chat-close');
  var body = document.getElementById('chat-body');
  var form = document.getElementById('chat-form');
  var input = document.getElementById('chat-text');
  if (!fab || !panel || !form) return;

  var csrfMeta = document.querySelector('meta[name="csrf-token"]');
  var csrf = csrfMeta ? csrfMeta.getAttribute('content') : '';
  var busy = false;

  function toggle(open) {
    panel.hidden = !open;
    fab.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) input.focus();
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

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || busy) return;
    busy = true;
    input.value = '';
    addMsg('user', text);
    var typing = addMsg('bot typing', 'Typing…');

    fetch('/ai/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ message: text }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        typing.remove();
        addMsg('bot', data.reply || data.error || 'Sorry, something went wrong. Please try again.');
      })
      .catch(function () {
        typing.remove();
        addMsg('bot', 'Connection problem — please try again in a moment.');
      })
      .finally(function () { busy = false; });
  });
})();
