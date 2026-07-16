(function () {
  'use strict';
  var chips = document.getElementById('dep-chips');
  var amountInput = document.querySelector('input[name="amount"]');
  var preview = document.getElementById('dep-preview');
  if (!amountInput || !preview) return;

  // Tiers come from the server via data attributes: data-tiers="500:5,1000:10,5000:50"
  var tiers = [];
  try {
    tiers = (preview.getAttribute('data-tiers') || '').split(',').map(function (pair) {
      var p = pair.split(':');
      return { min: Number(p[0]), pct: Number(p[1]) };
    }).filter(function (t) { return t.min > 0 && t.pct > 0; }).sort(function (a, b) { return b.min - a.min; });
  } catch (e) {}

  function peso(n) {
    return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function updatePreview() {
    var amount = Number(amountInput.value);
    if (!isFinite(amount) || amount < 50) { preview.hidden = true; return; }
    var bonus = 0;
    var pct = 0;
    for (var i = 0; i < tiers.length; i++) {
      if (amount >= tiers[i].min) { pct = tiers[i].pct; bonus = Math.round(amount * pct) / 100; break; }
    }
    if (bonus > 0) {
      preview.innerHTML = '🎁 You\'ll receive <strong>' + peso(amount + bonus) + '</strong> total (' + peso(amount) + ' + ' + pct + '% bonus ' + peso(bonus) + ')';
    } else {
      var next = tiers.length ? tiers[tiers.length - 1] : null;
      for (var j = tiers.length - 1; j >= 0; j--) { if (tiers[j].min > amount) { next = tiers[j]; break; } }
      preview.innerHTML = next && next.min > amount
        ? 'Add ' + peso(next.min - amount) + ' more to unlock a +' + next.pct + '% bonus 🎁'
        : '';
    }
    preview.hidden = preview.innerHTML === '';
  }

  amountInput.addEventListener('input', updatePreview);

  if (chips) {
    chips.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-amount]');
      if (!btn) return;
      amountInput.value = btn.getAttribute('data-amount');
      chips.querySelectorAll('.qty-chip').forEach(function (c) { c.classList.remove('active'); });
      btn.classList.add('active');
      updatePreview();
      amountInput.focus();
    });
  }
  updatePreview();
})();
