'use strict';
// Lightweight EN / Filipino i18n for the public marketing surface. Strings are
// looked up by key; a missing key falls back to English, then to the key
// itself, so partial coverage never breaks a page. Extend DICT to translate
// more pages over time.
const DICT = {
  en: {
    'nav.how': 'How it works', 'nav.services': 'Services', 'nav.faq': 'FAQ',
    'nav.dashboard': 'Dashboard', 'nav.signin': 'Sign in', 'nav.signup': 'Sign up free',
    'hero.eyebrow': '🇵🇭 Made for Pinoy creators & businesses',
    'hero.title_a': 'Boost your', 'hero.title_b': 'social media', 'hero.title_c': 'in minutes, not months.',
    'hero.sub': 'Followers, likes, views, and engagement for every major platform — instant automated delivery at low peso prices.',
    'hero.chip1': '⚡ Instant delivery', 'hero.chip2': '₱ Peso pricing', 'hero.chip3': '💳 GCash · Maya · BPI', 'hero.chip4': '🕐 24/7 support',
    'hero.cta1': "Get started — it's free", 'hero.cta2': 'Browse services',
    'hero.proof_a': 'Trusted by', 'hero.proof_b': 'members', 'hero.proof_c': 'orders delivered',
    'stat.orders': 'Total orders', 'stat.members': 'Happy members', 'stat.services': 'Services available', 'stat.completed': 'Orders completed',
    'cta.final_title': 'Ready to grow?', 'cta.final_btn': 'Create my free account',
  },
  fil: {
    'nav.how': 'Paano gumagana', 'nav.services': 'Mga serbisyo', 'nav.faq': 'FAQ',
    'nav.dashboard': 'Dashboard', 'nav.signin': 'Mag-sign in', 'nav.signup': 'Libreng sign up',
    'hero.eyebrow': '🇵🇭 Para sa mga Pinoy creator at negosyo',
    'hero.title_a': 'Palakasin ang iyong', 'hero.title_b': 'social media', 'hero.title_c': 'sa minuto, hindi buwan.',
    'hero.sub': 'Followers, likes, views, at engagement para sa lahat ng platform — instant at automatic na delivery sa murang presyo sa piso.',
    'hero.chip1': '⚡ Instant na delivery', 'hero.chip2': '₱ Presyo sa piso', 'hero.chip3': '💳 GCash · Maya · BPI', 'hero.chip4': '🕐 24/7 na suporta',
    'hero.cta1': 'Magsimula — libre ito', 'hero.cta2': 'Tingnan ang serbisyo',
    'hero.proof_a': 'Pinagkakatiwalaan ng', 'hero.proof_b': 'miyembro', 'hero.proof_c': 'order na naihatid',
    'stat.orders': 'Kabuuang order', 'stat.members': 'Masayang miyembro', 'stat.services': 'Serbisyong available', 'stat.completed': 'Tapos na order',
    'cta.final_title': 'Handa nang lumago?', 'cta.final_btn': 'Gawin ang libreng account',
  },
};

function normalize(lang) { return lang === 'fil' || lang === 'tl' ? 'fil' : 'en'; }

function translator(lang) {
  const l = normalize(lang);
  return (key) => (DICT[l] && DICT[l][key]) || DICT.en[key] || key;
}

// Express middleware: sets res.locals.lang + res.locals.t from the `lang` cookie.
function middleware(req, res, next) {
  const cookie = String(req.headers.cookie || '');
  const m = /(?:^|;\s*)lang=(en|fil)/.exec(cookie);
  const lang = normalize(m ? m[1] : 'en');
  res.locals.lang = lang;
  res.locals.t = translator(lang);
  next();
}

module.exports = { middleware, translator, normalize };
