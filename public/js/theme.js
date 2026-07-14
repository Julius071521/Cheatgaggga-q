// Runs synchronously in <head> to avoid a flash of the wrong theme.
(function () {
  var saved;
  try { saved = localStorage.getItem('theme'); } catch (e) { saved = null; }
  var theme = saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
})();
