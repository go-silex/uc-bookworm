/* ── Bibliothèque — suivi de lectures papier ────────────────── */

const KEY = 'bibliotheque.v2';
const KEY_PWD = 'bibliotheque.pwd';
const KEY_API = 'bibliotheque.gemini'; // clé de secours, propre à cet appareil

/* Google retire ses modèles : on essaie du plus récent au plus ancien
   (voir api/vision.js, qui fait de même côté serveur). */
const GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'];
const VISION_PROMPT = "Cette photo montre la couverture d'un livre papier. Donne le titre exact et l'auteur tels qu'imprimés, puis classe le livre dans l'un des genres proposés. Si aucun livre n'est identifiable, mets found à false et laisse les autres champs vides.";

const GENRES = [
  { id: 'roman',    name: 'Roman',    color: '#C9F24E' },
  { id: 'essai',    name: 'Essai',    color: '#7FE39A' },
  { id: 'bio',      name: 'Bio',      color: '#7BA7FF' },
  { id: 'sf',       name: 'SF',       color: '#C596FF' },
  { id: 'polar',    name: 'Polar',    color: '#FFA36B' },
  { id: 'histoire', name: 'Histoire', color: '#FFD84D' },
  { id: 'business', name: 'Business', color: '#68E0D4' },
  { id: 'poesie',   name: 'Poésie',   color: '#FF9CBB' },
];
const genre = id => GENRES.find(g => g.id === id) || GENRES[0];

/* Trois livres, un par état : lu deux fois (une relecture, en favori),
   en cours, et à lire. Chaque écran a ainsi quelque chose à montrer. */
const SEED = [
  { title: "L'Étranger", author: 'Albert Camus',  genre: 'roman', favorite: true,
    sessions: [{ startedAt: '2019-03-02', finishedAt: '2019-03-11' }, { startedAt: '2024-02-02', finishedAt: '2024-02-11' }] },
  { title: 'Dune',       author: 'Frank Herbert', genre: 'sf',    favorite: false,
    sessions: [{ startedAt: '2026-07-06', finishedAt: null }] },
  { title: '1984',       author: 'George Orwell', genre: 'roman', favorite: false, shortlist: true, sessions: [] },
];

/* ── État ──────────────────────────────────────────────────── */

const uid = () => Math.random().toString(36).slice(2, 10);
/* Date du jour en heure locale, jamais en UTC : `toISOString()` datait de
   la veille tout ce qui se commençait entre minuit et 2 h du matin. */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* Vrai tant que l'écran n'affiche que la démo : rien de personnel n'a
   encore été saisi. Une bibliothèque distante remplace alors la démo au
   lieu de fusionner avec elle — sinon les trois livres d'exemple
   reviendraient s'inviter sur chaque nouvel appareil. */
let seeded = false;

let books = load();
let tab = 'lecture';
let openDeck = GENRES[0].id;
let openYear = null;
let hideRead = localStorage.getItem('bibliotheque.hideRead') === '1';

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (Array.isArray(raw) && raw.length) return raw;
  } catch (e) {}

  // migration depuis la v1 (startedAt / finishedAt à plat)
  try {
    const old = JSON.parse(localStorage.getItem('bibliotheque.v1'));
    if (Array.isArray(old) && old.length) {
      return old.map(b => ({
        id: b.id || uid(), title: b.title, author: b.author, cover: b.cover || null,
        genre: b.genre, favorite: !!b.favorite,
        sessions: b.startedAt ? [{ id: uid(), startedAt: b.startedAt, finishedAt: b.finishedAt || null }] : [],
      }));
    }
  } catch (e) {}

  seeded = true;
  return SEED.map(b => ({ ...b, id: uid(), cover: null, sessions: b.sessions.map(s => ({ id: uid(), ...s })) }));
}

/* Comparaison de titres tolérante (casse, accents, ponctuation) : sert à
   réunir un même livre venu de deux appareils. */
const normTitle = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/* `noCover` n'est jamais persisté (voir stripNoCover) : un livre sans
   couverture retente sa chance à chaque session, jamais en boucle. */
const stripNoCover = (k, v) => k === 'noCover' ? undefined : v;

const save = () => { localStorage.setItem(KEY, JSON.stringify(books, stripNoCover)); pushSoon(); };
const byId = id => books.find(b => b.id === id);

/* ── Synchronisation serveur ───────────────────────────────────
   Le site déployé expose /api/library (mot de passe + stockage
   distant). Sans API (usage local, serveur non configuré), tout
   continue de fonctionner en localStorage seul. */

let pwd = localStorage.getItem(KEY_PWD) || '';
let syncOn = false;
let pushTimer = null;

async function apiCall(method, body) {
  const res = await fetch('api/library', {
    method,
    headers: { authorization: 'Bearer ' + pwd, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) { const e = new Error('api ' + res.status); e.status = res.status; throw e; }
  return res.json();
}

/* Debounce avec échéance : des sauvegardes en rafale (résolution des
   couvertures…) ne repoussent jamais l'envoi au-delà de 5 s. */
let pushDeadline = 0;

function pushSoon() {
  if (!syncOn) return;
  const now = Date.now();
  if (!pushDeadline) pushDeadline = now + 5000;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null; pushDeadline = 0;
    apiCall('PUT', JSON.parse(JSON.stringify({ books }, stripNoCover))).catch(() => {});
  }, Math.max(0, Math.min(900, pushDeadline - now)));
}

/* L'app part en arrière-plan avec un envoi en attente : on flush. */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden || !pushTimer) return;
  clearTimeout(pushTimer);
  pushTimer = null; pushDeadline = 0;
  fetch('api/library', {
    method: 'PUT', keepalive: true,
    headers: { authorization: 'Bearer ' + pwd, 'content-type': 'application/json' },
    body: JSON.stringify({ books }, stripNoCover),
  }).catch(() => {});
});

/* Deux appareils, deux notes sur le même livre : on ne choisit pas à la
   place de l'auteur. Quand l'une contient déjà l'autre — le cas courant,
   une note complétée ailleurs — la plus longue suffit ; sinon on garde
   les deux, séparées. Perdre du texte écrit à la main serait pire que
   laisser deux paragraphes à recoller. */
function mergeNotes(a, b) {
  if (!a) return b || '';
  if (!b || a.includes(b)) return a;
  if (b.includes(a)) return b;
  return a + '\n\n' + b;
}

/* Union de deux bibliothèques : livres réunis par titre, lectures
   réunies par date de fin — rien n'est perdu, rien n'est doublé. */
function mergeLibraries(base, extra) {
  const out = base.map(b => ({ ...b, sessions: [...b.sessions] }));
  for (const x of extra) {
    const b = out.find(o => normTitle(o.title) === normTitle(x.title));
    if (!b) { out.push(x); continue; }
    b.favorite = b.favorite || x.favorite;
    b.shortlist = b.shortlist || x.shortlist;
    b.cover = b.cover || x.cover;
    const note = mergeNotes(b.note, x.note);
    if (note) b.note = note;
    // Deux avis n'ont pas d'horodatage pour se départager : celui de la
    // base prime, l'autre ne fait que combler une absence. Un appareil
    // resté en arrière, qui pousse ses livres sans l'avis, ne l'efface donc
    // que jusqu'au prochain démarrage de celui qui l'avait donné.
    if (!ratingOf(b) && ratingOf(x)) b.rating = ratingOf(x);
    for (const s of x.sessions) {
      /* Une lecture encore en cours ici est peut-être la même, terminée
         ailleurs : on la reconnaît à son identifiant ou à sa date de
         début. Sans ça, l'appareil resté en arrière rajoutait sa copie
         inachevée à côté de la version terminée, et le livre repartait
         « en cours » — jusque sur le serveur, donc pour toujours. */
      const dup = s.finishedAt
        ? b.sessions.some(t => t.finishedAt === s.finishedAt)
        : b.sessions.some(t => !t.finishedAt || t.id === s.id
            || (s.startedAt && t.startedAt === s.startedAt));
      if (!dup) b.sessions.push({ ...s });
    }
    b.sessions = sortSessions(b.sessions);
  }
  out.forEach(b => delete b.noCover); // d'anciennes données serveur peuvent le porter
  return out;
}

async function boot() {
  let status = 0;
  try {
    const res = await fetch('api/library', { headers: pwd ? { authorization: 'Bearer ' + pwd } : {} });
    status = res.status;
    if (res.ok) {
      const j = await res.json();
      syncOn = true;
      if (Array.isArray(j.books) && j.books.length) {
        books = seeded ? j.books : mergeLibraries(j.books, books);
        seeded = false;
      }
      save();
      render();
      resolveCovers();
      return;
    }
  } catch (e) {}

  if (status === 401) showLock();
  // 501 / 404 / hors ligne : on reste en mode local.
}

function showLock() {
  const lock = document.createElement('div');
  lock.className = 'lock';
  lock.innerHTML = `
    <div class="lock-card">
      <h1 class="sheet-title">Bibliothèque</h1>
      <p class="hint">Cette bibliothèque est privée.<br>Entrez le mot de passe pour l'ouvrir.</p>
      <input class="field" id="lock-pwd" type="password" placeholder="Mot de passe" autocomplete="current-password" enterkeyhint="go">
      <button class="btn btn-primary press" id="lock-go">Entrer</button>
      <p class="status" id="lock-err"></p>
    </div>`;
  document.body.append(lock);

  const input = lock.querySelector('#lock-pwd');
  const err = lock.querySelector('#lock-err');
  const go = async () => {
    const v = input.value.trim();
    if (!v) return;
    pwd = v; err.textContent = '…';
    try {
      const j = await apiCall('GET');
      localStorage.setItem(KEY_PWD, pwd);
      syncOn = true;
      if (Array.isArray(j.books) && j.books.length) {
        books = seeded ? j.books : mergeLibraries(j.books, books);
        seeded = false;
      }
      save();
      lock.remove();
      render();
      resolveCovers();
    } catch (e) {
      pwd = localStorage.getItem(KEY_PWD) || '';
      err.textContent = e.status === 401 ? 'Mot de passe incorrect.' : 'Connexion impossible. Réessayez.';
    }
  };
  lock.querySelector('#lock-go').onclick = go;
  input.onkeydown = e => { if (e.key === 'Enter') go(); };
  setTimeout(() => input.focus(), 60);
}

/* Toute action de l'utilisateur passe par ici : la bibliothèque n'est
   plus une simple démo, elle ne sera donc plus remplacée à la volée. */
function commit() { seeded = false; save(); render(); if (!detail.hidden && openBook) openDetail(openBook, true); }

/* Un livre est « en cours » tant que sa dernière lecture n'est pas terminée. */
function statusOf(b) {
  const last = b.sessions[b.sessions.length - 1];
  if (!last) return 'want';
  return last.finishedAt ? 'read' : 'reading';
}
const currentSession = b => { const l = b.sessions[b.sessions.length - 1]; return l && !l.finishedAt ? l : null; };

/* L'avis sur 5 : un entier de 1 à 5, absent tant qu'on n'a rien dit — on
   ne stocke jamais 0. Relu avec méfiance : une valeur venue d'ailleurs
   (autre appareil, retouche du JSON) ne doit ni casser le rendu ni s'y
   glisser telle quelle. */
const ratingOf = b => { const r = Math.round(+b.rating); return r >= 1 && r <= 5 ? r : 0; };

/* L'ordre des sessions porte le statut : une lecture en cours doit rester
   la dernière, sinon `statusOf` déclarerait le livre terminé. */
const sortSessions = list => [...list].sort((x, y) =>
  (!x.finishedAt) - (!y.finishedAt)
  || (x.startedAt || x.finishedAt || '').localeCompare(y.startedAt || y.finishedAt || ''));

/* Chaque lecture terminée est une entrée d'historique : une relecture réapparaît. */
function historyEntries() {
  const out = [];
  for (const b of books) {
    b.sessions.forEach((s, i) => {
      if (s.finishedAt) out.push({ book: b, session: s, nth: i + 1, total: b.sessions.length });
    });
  }
  return out.sort((a, c) => c.session.finishedAt.localeCompare(a.session.finishedAt));
}

/* ── Utilitaires ───────────────────────────────────────────── */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const hash = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
const fmtDate = d => d ? new Date(d + 'T12:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
const fmtMonth = d => d ? new Date(d + 'T12:00').toLocaleDateString('fr-FR', { month: 'short' }).replace('.', '') : '';
const days = (a, b) => Math.max(1, Math.round((new Date(b) - new Date(a)) / 864e5));
const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
const ordinal = n => n === 1 ? '1re' : `${n}e`;

const icon = {
  lecture:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6.5C10.5 5 8.5 4.5 4 4.5v13c4.5 0 6.5.5 8 2 1.5-1.5 3.5-2 8-2v-13c-4.5 0-6.5.5-8 2z"/><path d="M12 6.5v13"/></svg>',
  library:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/></svg>',
  heart:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20s-7.5-4.6-7.5-9.6A4.4 4.4 0 0 1 12 7.6a4.4 4.4 0 0 1 7.5 2.8C19.5 15.4 12 20 12 20z"/></svg>',
  clock:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  close:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>',
  search:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
  check:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>',
  play:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4.5l12 7.5-12 7.5z"/></svg>',
  camera:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5A2 2 0 0 1 5.5 6.5h2l1.2-2h6.6l1.2 2h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.6"/></svg>',
  pencil:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/></svg>',
  trash:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 7h15M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/><path d="M6.5 7l.8 11.4A1.6 1.6 0 0 0 8.9 20h6.2a1.6 1.6 0 0 0 1.6-1.6L17.5 7"/></svg>',
  replay:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/></svg>',
  stop:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M6.3 6.3l11.4 11.4"/></svg>',
  plus:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4.5h10a.8.8 0 0 1 .8.8v14.2l-5.8-3.9-5.8 3.9V5.3a.8.8 0 0 1 .8-.8z"/></svg>',
  more:     '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  star:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round"><path d="M12 3.6l2.49 5.58 6.07.64-4.54 4.09 1.27 5.97L12 16.83l-5.29 3.05 1.27-5.97-4.54-4.09 6.07-.64z"/></svg>',
};

/* L'avis en petit, pour les listes : rien tant qu'il n'y en a pas. */
const miniStars = b => {
  const r = ratingOf(b);
  return r ? `<span class="rate" aria-label="${r} sur 5"><b>${'★'.repeat(r)}</b>${'★'.repeat(5 - r)}</span>` : '';
};

const headHTML = title => `
  <div class="head">
    <h1 class="title">${title}</h1>
    <button class="menu-btn press" data-glass aria-label="Menu">${icon.more}</button>
  </div>`;

/* ── Couvertures ───────────────────────────────────────────── */

const PALETTES = [
  ['#2b2b31', '#4a4a55'], ['#8e2a2a', '#c8603f'], ['#1f4d5c', '#3f8ea3'],
  ['#3b3163', '#7061b4'], ['#2f5233', '#6fa267'], ['#7a4a12', '#c98f3c'],
  ['#5c2247', '#a6577f'], ['#123a5c', '#3d80ad'],
];

/* Une même couverture existe en plusieurs tailles chez les fournisseurs :
   la petite suffit dans les listes, la grande est réservée aux vues larges. */
function coverURL(src, size) {
  if (src.includes('covers.openlibrary.org')) return src.replace(/-[SML]\.jpg/, `-${size}.jpg`);
  if (src.includes('books.google')) return src.replace(/zoom=\d/, size === 'L' ? 'zoom=2' : 'zoom=1');
  return src;
}

/* Le dégradé titré est toujours posé au fond, l'image par-dessus : une
   couverture qui tarde, disparaît du catalogue ou revient en 404 laisse
   voir le titre au lieu d'une carte blanche. */
function coverHTML(book, size = 'M') {
  const [a, b] = PALETTES[hash(book.title) % PALETTES.length];
  const fallback = `<div class="fallback" style="background:linear-gradient(150deg,${a},${b})">${esc(book.title)}<small>${esc(book.author)}</small></div>`;
  if (!book.cover) return fallback;

  // En grand : la version M (souvent déjà en cache) sert de fond
  // pendant que la L arrive.
  const low = size === 'L' ? ` style="background-image:url('${esc(coverURL(book.cover, 'M'))}');background-size:cover;background-position:center"` : '';
  return fallback + `<img src="${esc(coverURL(book.cover, size))}"${low} alt="" loading="lazy" decoding="async">`;
}

/* Remplace en place les couvertures d'un livre, sans re-rendre la vue :
   le défilement et les gestes en cours ne sont jamais interrompus. */
function patchCover(b) {
  view.querySelectorAll(`[data-open="${b.id}"] .cover`).forEach(c => {
    c.innerHTML = coverHTML(b, c.closest('.hero') ? 'L' : 'M');
  });
}

/* Complète les couvertures manquantes via Open Library / Google Books. */
let resolvingCovers = false;
async function resolveCovers() {
  if (resolvingCovers) return;
  resolvingCovers = true;
  try {
    let b;
    while ((b = books.find(x => !x.cover && !x.noCover))) {
      const meta = await findMeta(b.title, b.author);
      const live = byId(b.id);
      if (!live) continue;
      if (meta.cover) live.cover = meta.cover; else live.noCover = true;
      save();
      patchCover(live);
    }
  } finally { resolvingCovers = false; }
}

/* Trois passes, du plus précis au plus large : Google Books ciblé
   (le plus riche sur les éditions françaises), Open Library
   titre + auteur, puis Google Books en recherche libre. */
async function findMeta(title, author) {
  const g1 = await googleBooks(`intitle:"${title}" inauthor:"${author || ''}"`);
  if (g1?.cover) return { cover: g1.cover };

  try {
    const url = 'https://openlibrary.org/search.json?limit=1&fields=cover_i&title='
      + encodeURIComponent(title) + '&author=' + encodeURIComponent(author || '');
    const j = await (await fetch(url)).json();
    const id = j.docs?.[0]?.cover_i;
    if (id) return { cover: `https://covers.openlibrary.org/b/id/${id}-L.jpg` };
  } catch (e) {}

  const g2 = await googleBooks(`${title} ${author || ''}`, 5);
  const withCover = (Array.isArray(g2) ? g2 : [g2]).find(x => x?.cover);
  if (withCover) return { cover: withCover.cover };

  // Dernier filet : Open Library en recherche libre (trouve souvent
  // l'édition originale quand le titre français est mal indexé).
  try {
    const j = await (await fetch('https://openlibrary.org/search.json?limit=5&fields=cover_i&q='
      + encodeURIComponent(`${title} ${author || ''}`))).json();
    const id = (j.docs || []).find(d => d.cover_i)?.cover_i;
    if (id) return { cover: `https://covers.openlibrary.org/b/id/${id}-L.jpg` };
  } catch (e) {}

  return { cover: null };
}

/* ── Verre liquide ─────────────────────────────────────────── */

const glassInstances = new Map();

function applyGlass(root = document) {
  root.querySelectorAll('[data-glass]').forEach(el => {
    if (glassInstances.has(el)) return;
    try {
      glassInstances.set(el, liquidGlass(el, {
        scale: 22, chroma: 0.07, bezel: 0.26, profile: 'lip', blur: 3, saturate: 1.7,
      }));
    } catch (e) {}
  });
}

function dropGlass(root) {
  for (const [el, inst] of glassInstances) {
    if (document.contains(el) && !(root && root.contains(el))) continue;
    inst.destroy(); glassInstances.delete(el);
  }
}

/* ── Rendu ─────────────────────────────────────────────────── */

const view = document.getElementById('view');
const tabbar = document.getElementById('tabbar');
const detail = document.getElementById('detail');
const sheet = document.getElementById('sheet');

const TABS = [
  { id: 'lecture',    label: 'Lecture',      ic: 'lecture' },
  { id: 'bibli',      label: 'Bibliothèque', ic: 'library' },
  { id: 'favoris',    label: 'Favoris',      ic: 'heart' },
  { id: 'historique', label: 'Historique',   ic: 'clock' },
];

tabbar.innerHTML = '<span class="tab-bubble" aria-hidden="true"></span>'
  + TABS.map(t =>
  `<button class="tab" data-tab="${t.id}" aria-label="${t.label}">${icon[t.ic]}</button>`).join('')
  + '<span class="tab-sep"></span>'
  + `<button class="tab tab-add" id="add" aria-label="Ajouter un livre">${icon.plus}</button>`;
tabbar.setAttribute('data-glass', '');

/* La bulle de l'onglet actif suit le doigt : sa position est interpolée
   en continu sur le défilement du pager, pas par sauts d'onglet. */
const bubble = tabbar.querySelector('.tab-bubble');
const tabBtns = [...tabbar.querySelectorAll('[data-tab]')];
function syncBubble() {
  if (!view.clientWidth) return;
  const p = Math.max(0, Math.min(TABS.length - 1, view.scrollLeft / view.clientWidth));
  const i = Math.floor(p), f = p - i;
  const a = tabBtns[i], b = tabBtns[Math.min(i + 1, tabBtns.length - 1)];
  bubble.style.transform = `translateX(${a.offsetLeft + (b.offsetLeft - a.offsetLeft) * f}px)`;
}

/* Les quatre onglets vivent côte à côte dans un pager à défilement
   natif : le doigt voit la page suivante arriver pendant le geste, et
   les scrollers internes (chapitres, années, rails) enchaînent sur le
   pager quand ils atteignent leur bord. */
function render() {
  syncTabbar();
  view.innerHTML = `
    <section class="page" data-page="lecture">${viewLecture()}</section>
    <section class="page" data-page="bibli">${viewBibli()}</section>
    <section class="page" data-page="favoris">${viewFavoris()}</section>
    <section class="page" data-page="historique">${viewHistorique()}</section>`;

  initPager();
  initDeck();
  initChapters();
  initYears();

  dropGlass();
  requestAnimationFrame(() => applyGlass(view));
}

function syncTabbar() {
  TABS.forEach(t => tabbar.querySelector(`[data-tab="${t.id}"]`).setAttribute('aria-selected', t.id === tab));
}

const tabIndex = () => Math.max(0, TABS.findIndex(t => t.id === tab));

function initPager() {
  requestAnimationFrame(() => { view.scrollLeft = tabIndex() * view.clientWidth; syncBubble(); });
  view.onscroll = () => {
    syncBubble();
    const i = Math.round(view.scrollLeft / view.clientWidth);
    const t = TABS[Math.max(0, Math.min(TABS.length - 1, i))];
    if (!t || t.id === tab) return;
    tab = t.id;
    syncTabbar();
  };
}

/* Lecture ---------------------------------------------------- */

function viewLecture() {
  const reading = books.filter(b => statusOf(b) === 'reading');
  const want = books.filter(b => statusOf(b) === 'want' && b.shortlist);

  return `
    ${headHTML('Lecture')}
    <h2 class="section">En lecture</h2>

    ${reading.length ? `
      <div class="deck-wrap">
        <div class="deck" id="deck">
          ${reading.map((b, k) => `
            <button class="hero" data-open="${b.id}" style="--p:${k}" aria-label="${esc(b.title)}">
              <span class="cover">${coverHTML(b, 'L')}</span>
            </button>`).join('')}
        </div>
        <div class="deck-cap" id="deck-cap">
          <p><b>${esc(reading[0].title)}</b> · ${esc(reading[0].author)}</p>
          ${reading.length > 1
            ? `<div class="dots">${reading.map((b, k) => `<i class="${k ? '' : 'on'}"></i>`).join('')}</div>`
            : ''}
        </div>
      </div>` : `
      <div class="grow">
        <button class="ch-empty press" data-add>
          <i>${icon.plus}</i>
          <em>Commencer un livre</em>
        </button>
      </div>`}

    <h2 class="section">À lire</h2>
    ${want.length ? `
      <div class="rail">
        ${want.map(b => `
          <button class="item press" data-open="${b.id}">
            <span class="cover">${coverHTML(b)}</span>
            <h4>${esc(b.title)}</h4>
            <p>${esc(b.author)}</p>
          </button>`).join('')}
      </div>` : `<p class="empty">Marquez un livre « À lire » depuis sa fiche :<br>vos prochaines lectures s'afficheront ici.</p>`}
  `;
}

/* La pile des livres en cours tourne sur elle-même. Le geste retenu est
   celui qui ne menait nulle part : Lecture étant le premier onglet, tirer
   vers la droite ne faisait rien. Tirer vers la gauche continue d'ouvrir la
   Bibliothèque. Toucher un livre de derrière le ramène devant : le tour de
   pile reste accessible sans geste, souris comprise. */
function initDeck() {
  const deck = document.getElementById('deck');
  if (!deck) return;
  const cards = [...deck.children];
  if (cards.length < 2) return;

  const cap = document.getElementById('deck-cap');
  const dots = [...cap.querySelectorAll('.dots i')];
  // Au-delà du quatrième, un livre ne se distingue plus de son voisin.
  deck.style.setProperty('--fan', Math.min(cards.length, 4) - 1);
  let front = 0;

  const place = () => {
    cards.forEach((c, i) => {
      const p = (i - front + cards.length) % cards.length;
      c.style.setProperty('--p', Math.min(p, 3));
      c.style.zIndex = cards.length - p;
      c.classList.toggle('deep', p > 3);
      c.classList.toggle('front', p === 0);
    });
    const b = byId(cards[front].dataset.open);
    if (b) cap.querySelector('p').innerHTML = `<b>${esc(b.title)}</b> · ${esc(b.author)}`;
    dots.forEach((d, i) => d.classList.toggle('on', i === front));
  };
  place();

  let x0 = null, y0 = 0, turned = false;

  deck.addEventListener('touchstart', e => {
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; turned = false;
  }, { passive: true });

  deck.addEventListener('touchmove', e => {
    if (x0 == null || turned) return;
    const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
    if (Math.abs(dy) > Math.abs(dx)) { x0 = null; return; } // geste vertical : pas pour nous
    if (dx > 44) { turned = true; front = (front + 1) % cards.length; place(); }
  }, { passive: true });

  deck.addEventListener('touchend', () => { x0 = null; }, { passive: true });

  deck.addEventListener('click', e => {
    // Le clic qui suit un tour de pile n'ouvre pas la fiche du livre.
    if (turned) { turned = false; e.stopPropagation(); e.preventDefault(); return; }
    const card = e.target.closest('.hero');
    if (!card || card.classList.contains('front')) return;
    e.stopPropagation(); e.preventDefault();
    front = cards.indexOf(card);
    place();
  }, true);
}

/* Bibliothèque ----------------------------------------------- */

function viewBibli() {
  const g0 = genre(openDeck);
  return `
    <div class="head">
      <h1 class="title">Bibliothèque<span class="title-genre roll" id="title-genre" style="--tone:${g0.color}"><i>/</i>${esc(g0.name)}</span></h1>
      <button class="menu-btn press" data-glass aria-label="Menu">${icon.more}</button>
    </div>
    <nav class="ch-ticks">
      ${GENRES.map(g => `<button data-tick="${g.id}" style="--tone:${g.color}"
        aria-current="${g.id === openDeck}" aria-label="${esc(g.name)}"></button>`).join('')}
      <span class="ch-count" id="ch-count"></span>
    </nav>
    <div class="chapters" id="chapters">
      ${GENRES.map(g => {
        const list = books.filter(b => b.genre === g.id && (!hideRead || statusOf(b) !== 'read'));
        const reading = list.filter(b => statusOf(b) === 'reading').length;
        const read = list.filter(b => statusOf(b) === 'read').length;
        const meta = [
          plural(list.length, 'livre'),
          read && `${read} lu${read > 1 ? 's' : ''}`,
          reading && `${reading} en cours`,
        ].filter(Boolean).join(' · ');

        return `
          <section class="chapter" data-chapter="${g.id}" data-meta="${esc(meta)}" style="--tone:${g.color}">
            ${list.length ? `
              <div class="ch-scroll">
                <div class="grid">
                  ${list.map(b => `
                    <button class="item press" data-open="${b.id}" aria-label="${esc(b.title)}">
                      <span class="cover">${coverHTML(b)}</span>
                    </button>`).join('')}
                </div>
              </div>` : `
              <button class="ch-empty press" data-add>
                <i>${icon.plus}</i>
                <em>Ajouter un livre</em>
              </button>`}
          </section>`;
      }).join('')}
    </div>`;
}

/* Fait vivre le pager de genres : position restaurée, ticks et compteur synchronisés. */
function initChapters() {
  const el = document.getElementById('chapters');
  if (!el) return;
  const count = document.getElementById('ch-count');
  const metaOf = id => el.querySelector(`[data-chapter="${id}"]`)?.dataset.meta || '';
  if (count) count.textContent = metaOf(openDeck);
  const idx = Math.max(0, GENRES.findIndex(g => g.id === openDeck));
  requestAnimationFrame(() => { el.scrollLeft = idx * el.clientWidth; });

  el.onscroll = () => {
    const i = Math.round(el.scrollLeft / el.clientWidth);
    const g = GENRES[Math.max(0, Math.min(GENRES.length - 1, i))];
    if (!g || g.id === openDeck) return;
    openDeck = g.id;
    if (count) count.textContent = metaOf(g.id);
    const label = document.getElementById('title-genre');
    if (label) {
      label.style.setProperty('--tone', g.color);
      label.innerHTML = `<i>/</i>${esc(g.name)}`;
      label.classList.remove('roll'); void label.offsetWidth; label.classList.add('roll');
    }
    view.querySelectorAll('[data-tick]').forEach(t =>
      t.setAttribute('aria-current', t.dataset.tick === g.id));
  };
}

function gridHTML(list, emptyText) {
  if (!list.length) return `<p class="empty">${emptyText}</p>`;
  return `<div class="grid">${list.map(b => `
    <button class="item press" data-open="${b.id}">
      <span class="cover">${coverHTML(b)}</span>
      <h4>${esc(b.title)}</h4>
      <p>${esc(b.author)}</p>
    </button>`).join('')}</div>`;
}

/* Favoris ---------------------------------------------------- */

function viewFavoris() {
  const list = books.filter(b => b.favorite);
  return `
    ${headHTML('Favoris')}
    <div class="scroll">${gridHTML(list, 'Marquez un livre terminé comme favori pour le retrouver ici.')}</div>`;
}

/* Historique -------------------------------------------------- */

/* Chaque année est une page : on swipe entre elles, les puces suivent. */
function viewHistorique() {
  const all = historyEntries();
  if (!all.length) return `
    ${headHTML('Historique')}
    <p class="empty">Vos lectures s'archiveront ici, année par année.</p>`;

  const years = [...new Set(all.map(e => e.session.finishedAt.slice(0, 4)))].sort().reverse();
  if (!years.includes(openYear)) openYear = years[0];

  return `
    ${headHTML('Historique')}
    <div class="years" id="ychips">
      ${years.map(y => `<button class="year-chip press" data-year="${y}" aria-selected="${y === openYear}">${y}</button>`).join('')}
    </div>
    <div class="ypages" id="ypages">
      ${years.map(y => {
        const list = all.filter(e => e.session.finishedAt.startsWith(y));
        return `
          <section class="ypage" data-ypage="${y}">
            <h2 class="section">${plural(list.length, 'lecture')} en ${y}</h2>
            <div class="scroll"><div class="rows">
              ${list.map(e => `
                <button class="row press" data-open="${e.book.id}">
                  <span class="cover">${coverHTML(e.book)}</span>
                  <span class="meta">
                    <h4>${esc(e.book.title)}${e.total > 1 ? `<span class="tag">${ordinal(e.nth)} lecture</span>` : ''}</h4>
                    <p>${esc(e.book.author)}</p>
                  </span>
                  <span class="aside">${fmtMonth(e.session.finishedAt)}${miniStars(e.book)}</span>
                </button>`).join('')}
            </div></div>
          </section>`;
      }).join('')}
    </div>`;
}

function initYears() {
  const el = document.getElementById('ypages');
  if (!el) return;
  const years = [...el.querySelectorAll('.ypage')].map(s => s.dataset.ypage);
  const idx = Math.max(0, years.indexOf(openYear));
  requestAnimationFrame(() => { el.scrollLeft = idx * el.clientWidth; });

  el.onscroll = () => {
    const i = Math.round(el.scrollLeft / el.clientWidth);
    const y = years[Math.max(0, Math.min(years.length - 1, i))];
    if (!y || y === openYear) return;
    openYear = y;
    const chips = document.getElementById('ychips');
    chips?.querySelectorAll('[data-year]').forEach(c => c.setAttribute('aria-selected', c.dataset.year === y));
    const chip = chips?.querySelector(`[data-year="${y}"]`);
    if (chip) chips.scrollTo({ left: chip.offsetLeft - chips.clientWidth / 2 + chip.offsetWidth / 2, behavior: 'smooth' });
  };
}

/* ── Fiche livre ───────────────────────────────────────────── */

let openBook = null;
let rateAsk = null; // le livre qu'on vient de terminer : ses étoiles s'annoncent

function openDetail(id, silent) {
  const b = byId(id);
  if (!b) return;
  openBook = id;
  const st = statusOf(b);
  const cur = currentSession(b);
  const done = b.sessions.filter(s => s.finishedAt);
  const last = done[done.length - 1];

  const act = (name, label, ic, kind = 'glass', extra = '') => `
    <div class="act">
      <button class="btn btn-${kind} press" ${kind === 'glass' ? 'data-glass' : ''} data-act="${name}" ${extra} aria-label="${label}">${ic}</button>
      <span>${label}</span>
    </div>`;

  /* Le cœur suit le livre partout : on tombe amoureux d'un roman en le
     lisant, pas seulement une fois refermé. */
  const fav = act('fav', 'Favori', icon.heart, 'glass', `aria-pressed="${!!b.favorite}"`);

  const actions = {
    want: act('start', 'Commencer', icon.play, 'primary')
        + act('shortlist', 'À lire', icon.bookmark, 'glass', `aria-pressed="${!!b.shortlist}"`)
        + fav,
    reading: act('finish', 'Terminé', icon.check, 'primary')
           + fav
           + act('cancel', 'Abandonner', icon.stop),
    read: fav
        + act('reread', 'Relire', icon.replay),
  }[st];

  const facts = [
    cur && ['Commencé le', fmtDate(cur.startedAt)],
    st === 'read' && ['Lectures', plural(done.length, 'fois')],
    last && ['Dernière lecture', fmtDate(last.finishedAt)],
    last && last.startedAt && ['Durée', plural(days(last.startedAt, last.finishedAt), 'jour')],
  ].filter(Boolean);

  /* L'avis se donne une fois le livre refermé : sur un livre à lire ou en
     cours de lecture, il n'aurait rien à dire. Il appartient au livre,
     comme la note — une relecture le retrouve et peut le reprendre, elle
     n'en ajoute pas un second. Juste après « Terminé », les étoiles
     arrivent une à une : c'est le moment où l'on a un avis. */
  const r = ratingOf(b);
  const fresh = rateAsk === id;
  rateAsk = null;
  const stars = st === 'read' ? `
    <div class="stars${fresh ? ' fresh' : ''}" role="group" aria-label="Votre avis">
      ${[1, 2, 3, 4, 5].map(n => `<button class="press${n <= r ? ' on' : ''}" data-rate="${n}"
        aria-pressed="${n === r}" aria-label="${plural(n, 'étoile')}">${icon.star}</button>`).join('')}
    </div>
    ${r ? '' : '<p class="stars-ask">Votre avis&nbsp;?</p>'}` : '';

  /* La note du livre, et non celle d'une lecture : on relit rarement en
     pensant autre chose au point de vouloir deux textes. */
  const note = `
    <h2 class="section">Notes</h2>
    <button class="note press" data-act="note">
      ${b.note ? `<p>${esc(b.note)}</p>` : '<em>Ajouter une note</em>'}
    </button>`;

  const history = done.length ? `
    <h2 class="section">${done.length > 1 ? 'Toutes vos lectures' : 'Votre lecture'}</h2>
    <div class="rows">
      ${done.map((s, i) => `
        <div class="row">
          <span class="meta">
            <h4>${ordinal(i + 1)} lecture</h4>
            <p>${fmtDate(s.startedAt)} → ${fmtDate(s.finishedAt)}</p>
          </span>
          <button class="aside press" data-drop="${s.id}">Retirer</button>
        </div>`).join('')}
    </div>` : '';

  dropGlass(detail);
  detail.innerHTML = `
    <button class="ov-close press" data-close>${icon.close}</button>
    <button class="ov-del press" data-act="delete" aria-label="Retirer de la bibliothèque">${icon.trash}</button>
    <button class="ov-edit press" data-act="edit" aria-label="Modifier ce livre">${icon.pencil}</button>
    <div class="art">
      <span class="cover">${coverHTML(b, 'L')}</span>
    </div>
    <div class="ov-body">
      <div class="actions icons">${actions}</div>
      ${stars}
      <div class="facts">${facts.map(([k, v]) => `<div class="fact"><span>${k}</span><strong>${esc(v)}</strong></div>`).join('')}</div>
      ${note}
      ${history}
    </div>`;

  detail.hidden = false;
  if (!silent) { detail.classList.remove('enter'); void detail.offsetWidth; detail.classList.add('enter'); }
  requestAnimationFrame(() => applyGlass(detail));

  detail.onclick = e => {
    if (e.target.closest('[data-close]')) return close(detail);
    const drop = e.target.closest('[data-drop]')?.dataset.drop;
    if (drop) {
      b.sessions = b.sessions.filter(s => s.id !== drop);
      return commit();
    }

    // Retoucher l'étoile déjà choisie retire l'avis : on peut se raviser.
    const rate = +e.target.closest('[data-rate]')?.dataset.rate;
    if (rate) {
      if (ratingOf(b) === rate) delete b.rating; else b.rating = rate;
      return commit();
    }

    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'edit') return openEditor(b.id);
    if (act === 'note') return openEditor(b.id, true);
    if (act === 'start' || act === 'reread') b.sessions.push({ id: uid(), startedAt: today(), finishedAt: null });
    if (act === 'finish') { const s = currentSession(b); if (s) { s.finishedAt = today(); rateAsk = b.id; } }
    if (act === 'cancel') b.sessions = b.sessions.filter(s => s !== currentSession(b));
    if (act === 'fav') b.favorite = !b.favorite;
    if (act === 'shortlist') b.shortlist = !b.shortlist;
    if (act === 'delete') {
      if (!confirm(`Retirer « ${b.title} » ?`)) return;
      books = books.filter(x => x.id !== b.id);
      save(); close(detail); return render();
    }
    commit();
  };
}

function close(el) {
  dropGlass(el);
  el.hidden = true;
  el.classList.remove('enter');
  if (el === detail) openBook = null;
}

/* ── Modifier un livre ─────────────────────────────────────────
   Le scan se trompe parfois de titre, devine mal un genre, ramène la
   couverture d'une autre édition ; et une date de lecture est toujours
   celle du jour où on l'a saisie. Tout ce que l'app a écrit à notre place
   doit pouvoir être repris ici — sinon la seule issue serait de supprimer
   le livre et de tout ressaisir. */

function openEditor(id, toNote) {
  const b = byId(id);
  if (!b) return;

  let g = b.genre;
  let cover = b.cover || null;
  let cands = [];
  let sess = b.sessions.map(s => ({ ...s }));

  const sessRow = (s, i) => `
    <div class="sess" data-sess="${s.id}">
      <span class="meta">
        <h4>${s.finishedAt ? `${ordinal(i + 1)} lecture` : 'Lecture en cours'}</h4>
        <span class="dates">
          <input type="date" data-k="startedAt" value="${s.startedAt || ''}" aria-label="Début">
          <input type="date" data-k="finishedAt" value="${s.finishedAt || ''}" aria-label="Fin">
        </span>
      </span>
      <button class="sess-del press" data-drop="${s.id}" aria-label="Retirer cette lecture">${icon.trash}</button>
    </div>`;

  dropGlass(sheet);
  sheet.innerHTML = `
    <button class="ov-close press" data-close>${icon.close}</button>
    <div class="ov-body">
      <h1 class="sheet-title">Modifier</h1>
      <input class="field" id="e-title" placeholder="Titre" autocomplete="off" value="${esc(b.title)}">
      <input class="field" id="e-author" placeholder="Auteur" autocomplete="off" value="${esc(b.author)}">

      <h2 class="section">Genre</h2>
      <div class="picks">
        ${GENRES.map(x => `<button class="pick press" data-g="${x.id}" aria-selected="${x.id === g}" style="background:${x.color}">${esc(x.name)}</button>`).join('')}
      </div>

      <h2 class="section">Couverture</h2>
      <div class="cover-pick" id="e-covers"></div>
      <button class="link" id="e-more">Chercher des couvertures</button>

      <h2 class="section">Lectures</h2>
      <div id="e-sessions">${sess.map(sessRow).join('')}</div>
      <button class="link" id="e-add">Ajouter une lecture passée</button>

      <h2 class="section">Notes</h2>
      <textarea class="field field-note" id="e-note" placeholder="Ce que vous en avez pensé…">${esc(b.note || '')}</textarea>

      <div class="actions"><button class="btn btn-primary press" id="e-save">Enregistrer</button></div>
    </div>`;

  sheet.hidden = false;
  sheet.classList.remove('enter'); void sheet.offsetWidth; sheet.classList.add('enter');
  requestAnimationFrame(() => applyGlass(sheet));

  const body = sheet.querySelector('.ov-body');
  const title = body.querySelector('#e-title');
  const author = body.querySelector('#e-author');
  const box = body.querySelector('#e-covers');
  const list = body.querySelector('#e-sessions');
  const note = body.querySelector('#e-note');

  // Venu du bloc « Notes » de la fiche : on ouvre directement dessus.
  if (toNote) requestAnimationFrame(() => { note.scrollIntoView({ block: 'center' }); note.focus(); });

  const drawCovers = busy => {
    const all = [cover, ...cands.filter(c => c !== cover)].filter(Boolean);
    box.innerHTML = all.map(c => `
        <button class="press" data-cover="${esc(c)}" aria-selected="${c === cover}">
          <img src="${esc(coverURL(c, 'M'))}" alt="" loading="lazy" decoding="async">
        </button>`).join('')
      + (busy ? '<div class="spinner"></div>' : '')
      + (all.length || busy ? '' : '<p class="hint">Pas encore de couverture.</p>');
  };
  drawCovers(false);

  /* Les dates saisies ne vivent que dans le DOM : on les relit avant
     toute opération qui redessine la liste. */
  const readDates = () => list.querySelectorAll('.sess').forEach(row => {
    const s = sess.find(x => x.id === row.dataset.sess);
    if (!s) return;
    s.startedAt = row.querySelector('[data-k="startedAt"]').value || null;
    s.finishedAt = row.querySelector('[data-k="finishedAt"]').value || null;
  });
  const drawSessions = () => { list.innerHTML = sess.map(sessRow).join(''); };

  sheet.onclick = async e => {
    if (e.target.closest('[data-close]')) return close(sheet);

    const pick = e.target.closest('[data-g]');
    if (pick) {
      g = pick.dataset.g;
      body.querySelectorAll('[data-g]').forEach(el => el.setAttribute('aria-selected', el.dataset.g === g));
      return;
    }

    const c = e.target.closest('[data-cover]');
    if (c) { cover = c.dataset.cover; return drawCovers(false); }

    if (e.target.closest('#e-more')) {
      drawCovers(true);
      cands = await coverCandidates(title.value.trim() || b.title, author.value.trim() || b.author);
      return drawCovers(false);
    }

    const drop = e.target.closest('[data-drop]');
    if (drop) { readDates(); sess = sess.filter(s => s.id !== drop.dataset.drop); return drawSessions(); }

    if (e.target.closest('#e-add')) {
      readDates();
      sess.push({ id: uid(), startedAt: today(), finishedAt: today() });
      return drawSessions();
    }

    if (e.target.closest('#e-save')) {
      const t = title.value.trim();
      if (!t) return title.focus();
      readDates();
      const renamed = normTitle(t) !== normTitle(b.title);
      b.title = t;
      b.author = author.value.trim() || 'Auteur inconnu';
      b.genre = g;
      b.cover = cover;
      b.sessions = sortSessions(sess);
      const n = note.value.trim();
      if (n) b.note = n; else delete b.note;
      // Titre corrigé : une couverture restée introuvable mérite un second essai.
      if (renamed && !cover) delete b.noCover;
      close(sheet);
      commit();
      resolveCovers();
    }
  };
}

/* Toutes les couvertures connues pour un titre, les deux catalogues
   confondus : la première trouvée n'est pas toujours la bonne édition. */
async function coverCandidates(title, author) {
  const q = `${title} ${author || ''}`.trim();

  const fromOL = fetch('https://openlibrary.org/search.json?limit=12&fields=cover_i&q=' + encodeURIComponent(q))
    .then(r => r.json())
    .then(j => (j.docs || []).filter(d => d.cover_i).map(d => `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`))
    .catch(() => []);

  const [gb, ol] = await Promise.all([googleBooks(q, 12), fromOL]);
  const seen = new Set();
  return [...(gb || []).map(x => x.cover), ...ol]
    .filter(c => c && !seen.has(c) && seen.add(c))
    .slice(0, 14);
}

/* ── Ajout : scan photo, recherche, saisie ─────────────────── */

let searchSeq = 0;
let lastTerm = ''; // la dernière recherche, pour pouvoir y revenir

function openSheet(prefill) {
  dropGlass(sheet);
  sheet.innerHTML = `
    <button class="ov-close press" data-close>${icon.close}</button>
    <div class="ov-body">
      <h1 class="sheet-title">Ajouter un livre</h1>
      <button class="scan-card press" data-glass id="scan">
        <span class="ic">${icon.camera}</span>
        <span>
          <h4>Photographier la couverture</h4>
          <p>Le titre, l'auteur et le genre sont reconnus automatiquement.</p>
        </span>
      </button>
      <div class="field-wrap">
        ${icon.search}
        <input id="q" type="search" placeholder="Ou chercher par titre" autocomplete="off" enterkeyhint="search">
      </div>
      <div id="results"></div>
      <input type="file" id="shot" accept="image/*" capture="environment" hidden>
    </div>`;

  sheet.hidden = false;
  sheet.classList.remove('enter'); void sheet.offsetWidth; sheet.classList.add('enter');
  requestAnimationFrame(() => applyGlass(sheet));

  const q = sheet.querySelector('#q');
  const results = sheet.querySelector('#results');
  const shot = sheet.querySelector('#shot');
  results.innerHTML = `<p class="hint">Ou <button class="link" id="manual">saisissez-le à la main</button>.</p>`;

  // Retour depuis l'étape suivante : la recherche reprend là où on l'avait laissée.
  if (prefill) {
    q.value = prefill;
    results.innerHTML = '<div class="spinner"></div>';
    searchBooks(prefill, results);
  }

  sheet.querySelector('#scan').onclick = () => shot.click();
  shot.onchange = () => { if (shot.files?.[0]) scanCover(shot.files[0]); };

  let timer;
  q.oninput = () => {
    clearTimeout(timer);
    const term = q.value.trim();
    lastTerm = term;
    if (term.length < 3) { results.innerHTML = ''; return; }
    results.innerHTML = '<div class="spinner"></div>';
    timer = setTimeout(() => searchBooks(term, results), 320);
  };

  sheet.onclick = e => {
    if (e.target.closest('[data-close]')) return close(sheet);
    if (e.target.closest('#manual')) return stepManual();
    const pick = e.target.closest('[data-pick]');
    if (pick) stepGenre(JSON.parse(decodeURIComponent(pick.dataset.pick)));
  };
}

/* Les deux catalogues sont interrogés en parallèle : Open Library est fort
   sur l'anglais, Google Books sur les éditions françaises — la fusion couvre
   les deux. */
async function searchBooks(term, box) {
  const seq = ++searchSeq;

  const openLib = fetch('https://openlibrary.org/search.json?limit=14&fields=title,author_name,cover_i,first_publish_year&q=' + encodeURIComponent(term))
    .then(r => r.json())
    .then(j => (j.docs || []).filter(d => d.title).map(d => ({
      title: d.title,
      author: (d.author_name || ['Auteur inconnu'])[0],
      cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : null,
      year: d.first_publish_year || '',
    })))
    .catch(() => []);

  const [ol, gb] = await Promise.all([openLib, googleBooks(term, 12)]);
  if (seq !== searchSeq) return;

  const seen = new Set();
  const items = [...ol, ...gb].filter(x => {
    const k = (x.title + '|' + x.author).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  if (!items.length) { box.innerHTML = `<p class="hint">Aucun résultat.<br><button class="link" id="manual">Saisir à la main</button></p>`; return; }

  box.innerHTML = `<div class="rows">${items.map(item => `
    <button class="row press" data-pick="${encodeURIComponent(JSON.stringify(item))}">
      <span class="cover">${coverHTML(item)}</span>
      <span class="meta"><h4>${esc(item.title)}</h4><p>${esc(item.author)}</p></span>
      <span class="aside">${item.year}</span>
    </button>`).join('')}</div>`;
}

/* ── Reconnaissance de la couverture ───────────────────────── */

/* Réduit la photo avant analyse : moins de tokens, moins de latence. */
function shrink(file, max = 1024) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const r = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * r); c.height = Math.round(img.height * r);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.82).split(',')[1]);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

/* Voie rapide et gratuite : le code-barres ISBN au dos du livre. */
async function readISBN(file) {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a'] });
    const codes = await det.detect(await createImageBitmap(file));
    return codes.find(c => /^97[89]/.test(c.rawValue))?.rawValue || null;
  } catch (e) { return null; }
}

/* Fiche par ISBN : Google Books d'abord (catalogue le plus large, anglais
   compris), Open Library en secours. */
async function lookupISBN(isbn) {
  const fromGoogle = await googleBooks(`isbn:${isbn}`);
  if (fromGoogle) return fromGoogle;

  try {
    const j = await (await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`)).json();
    const d = j[`ISBN:${isbn}`];
    if (!d) return null;
    return {
      title: d.title,
      author: d.authors?.[0]?.name || 'Auteur inconnu',
      cover: d.cover?.large || `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`,
    };
  } catch (e) { return null; }
}

async function googleBooks(q, n = 1) {
  try {
    const url = 'https://www.googleapis.com/books/v1/volumes?country=FR&maxResults=' + Math.min(n, 20)
      + '&q=' + encodeURIComponent(q);
    const j = await (await fetch(url)).json();
    const items = (j.items || [])
      .map(it => it.volumeInfo)
      .filter(v => v?.title)
      .map(v => ({
        title: v.title,
        author: v.authors?.[0] || 'Auteur inconnu',
        cover: v.imageLinks
          ? (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail)
              .replace('http://', 'https://').replace('&edge=curl', '').replace('zoom=1', 'zoom=2')
          : null,
        year: v.publishedDate?.slice(0, 4) || '',
      }));
    return n === 1 ? items[0] || null : items;
  } catch (e) { return n === 1 ? null : []; }
}

/* Voie vision : Gemini lit la couverture et en extrait les métadonnées.

   Deux chemins, dans cet ordre. Le serveur d'abord — la clé y est posée
   une fois à l'installation et vaut pour tous les appareils. À défaut,
   une clé collée sur cet appareil-ci : c'est le rattrapage de qui a sauté
   l'étape, pour qu'il ne bute pas sur une porte fermée.

   Le verdict du serveur ne change pas en cours de session : on ne le
   redemande donc qu'une fois. */
let visionOnServer = null; // null = pas encore su

async function readCover(b64) {
  if (visionOnServer !== false) {
    const res = await fetch('api/vision', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + pwd, 'content-type': 'application/json' },
      body: JSON.stringify({ image: b64, genres: GENRES.map(g => g.id) }),
    });
    if (res.status !== 501 && res.status !== 404) {
      visionOnServer = true;
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Erreur ${res.status}`);
      return res.json();
    }
    visionOnServer = false;
  }

  const key = localStorage.getItem(KEY_API);
  if (!key) { const e = new Error('clé absente'); e.needsKey = true; throw e; }
  return readCoverWithKey(b64, key);
}

/* Chemin de secours : le navigateur parle directement à Google. */
async function readCoverWithKey(b64, apiKey) {
  const payload = JSON.stringify({
    contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: b64 } }, { text: VISION_PROMPT }] }],
    generationConfig: {
      response_mime_type: 'application/json',
      response_schema: {
        type: 'OBJECT',
        properties: {
          found: { type: 'BOOLEAN' },
          title: { type: 'STRING' },
          author: { type: 'STRING' },
          genre: { type: 'STRING', enum: GENRES.map(g => g.id) },
        },
        required: ['found', 'title', 'author', 'genre'],
      },
    },
  });

  let res = null, msg = '';
  for (const model of GEMINI_MODELS) {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=` + encodeURIComponent(apiKey), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: payload,
    });
    if (res.ok) break;
    msg = (await res.json().catch(() => ({}))).error?.message || `Erreur ${res.status}`;
    if (!(res.status === 404 || /no longer available|not found|is not supported|does not exist/i.test(msg))) break;
    res = null;
  }

  if (!res) {
    const e = new Error(msg);
    e.badKey = /API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(msg);
    throw e;
  }
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  return text ? JSON.parse(text) : { found: false };
}

async function scanCover(file) {
  const body = sheet.querySelector('.ov-body');
  const preview = URL.createObjectURL(file);
  const showStatus = msg => {
    body.innerHTML = `
      <h1 class="sheet-title">Analyse</h1>
      <div class="shot"><img src="${preview}" alt=""></div>
      <div class="spinner"></div>
      <p class="status">${msg}</p>`;
  };
  showStatus('Lecture de la couverture…');

  // 1. Code-barres ISBN si le navigateur sait le lire.
  const isbn = await readISBN(file);
  if (isbn) {
    showStatus('ISBN trouvé, récupération de la fiche…');
    const found = await lookupISBN(isbn);
    if (found) return stepGenre(found);
  }

  // 2. Vision : serveur, ou clé de cet appareil.
  showStatus('Identification du livre…');
  try {
    const r = await readCover(await shrink(file));
    if (!r.found || !r.title) throw new Error("Aucun livre reconnu sur cette photo.");
    const meta = await findMeta(r.title, r.author);
    stepGenre({ title: r.title, author: r.author || 'Auteur inconnu', ...meta }, r.genre);
  } catch (err) {
    if (err.needsKey) return stepKey(preview);
    if (err.badKey) { localStorage.removeItem(KEY_API); return stepKey(preview, 'Cette clé a été refusée par Google. Vérifiez-la ou créez-en une autre.'); }
    body.innerHTML = `
      <h1 class="sheet-title">Analyse</h1>
      <div class="shot"><img src="${preview}" alt=""></div>
      <p class="status">${esc(err.message)}</p>
      <div class="actions">
        <button class="btn btn-primary press" id="retry">Réessayer</button>
        <button class="btn btn-glass press" data-glass id="manual">Saisir à la main</button>
      </div>`;
    requestAnimationFrame(() => applyGlass(sheet));
    body.querySelector('#retry').onclick = () => sheet.querySelector('#shot')?.click() || openSheet();
    body.querySelector('#manual').onclick = () => stepManual();
  }
}

/* Rattrapage : la reconnaissance n'est pas configurée côté serveur. On
   explique ce que ça débloque et ce que ça coûte (rien), plutôt que de
   réclamer une « clé d'API » à quelqu'un qui ignore ce que c'est. */
function stepKey(preview, problem) {
  const body = sheet.querySelector('.ov-body');
  body.innerHTML = `
    <h1 class="sheet-title">Reconnaître les couvertures</h1>
    ${preview ? `<div class="shot"><img src="${preview}" alt=""></div>` : ''}
    ${problem ? `<p class="status">${esc(problem)}</p>` : ''}
    <p class="hint" style="text-align:left;padding-top:0">
      Pour lire un livre sur une photo, l'app a besoin d'une clé Google&nbsp;:
      c'est gratuit, sans carte bancaire, et ça prend deux minutes.
    </p>
    <ol class="hint" style="text-align:left;padding-top:0">
      <li>Ouvrez <b>aistudio.google.com/apikey</b></li>
      <li>Connectez-vous avec votre compte Google</li>
      <li>Cliquez sur <b>Create API key</b></li>
      <li>Copiez la clé et collez-la ci-dessous</li>
    </ol>
    <input class="field" id="k" type="password" placeholder="AIza…" autocomplete="off" enterkeyhint="go">
    <div class="actions">
      <button class="btn btn-primary press" id="save-key">Activer</button>
      <button class="btn btn-glass press" data-glass id="manual">Saisir ce livre à la main</button>
    </div>
    <p class="hint" style="text-align:left">
      Cette clé ne vaut que pour cet appareil&nbsp;: il faudra la recoller sur
      les autres. Pour l'activer partout d'un coup, ajoutez-la plutôt à votre
      hébergement sous le nom <b>GEMINI_API_KEY</b> — voir INSTALL.md.
    </p>`;
  requestAnimationFrame(() => applyGlass(sheet));
  const save = () => {
    const v = body.querySelector('#k').value.trim();
    if (!v) return;
    localStorage.setItem(KEY_API, v);
    openSheet();
  };
  body.querySelector('#save-key').onclick = save;
  body.querySelector('#k').onkeydown = e => { if (e.key === 'Enter') save(); };
  body.querySelector('#manual').onclick = () => stepManual();
}

function stepManual() {
  const body = sheet.querySelector('.ov-body');
  body.innerHTML = `
    <h1 class="sheet-title">Nouveau livre</h1>
    <input class="field" id="m-title" placeholder="Titre" autocomplete="off">
    <input class="field" id="m-author" placeholder="Auteur" autocomplete="off">
    <div class="actions"><button class="btn btn-primary press" id="next">Continuer</button></div>`;
  body.querySelector('#m-title').focus();
  body.querySelector('#next').onclick = async () => {
    const title = body.querySelector('#m-title').value.trim();
    if (!title) return;
    const author = body.querySelector('#m-author').value.trim() || 'Auteur inconnu';
    stepGenre({ title, author, ...(await findMeta(title, author)) });
  };
}

function stepGenre(item, suggested) {
  const body = sheet.querySelector('.ov-body');
  const nowYear = new Date().getFullYear();
  const years = Array.from({ length: 12 }, (_, i) => nowYear - i);
  let genreSel = suggested || null;
  let readYear = null; // null = à lire, sinon année de lecture
  const twin = books.find(x => normTitle(x.title) === normTitle(item.title));

  body.innerHTML = `
    <h1 class="sheet-title">Dans quel genre&nbsp;?</h1>
    <div class="chosen">
      <span class="cover">${coverHTML(item)}</span>
      <span><h4>${esc(item.title)}</h4><p>${esc(item.author)}</p></span>
    </div>
    ${twin ? `<p class="status">Ce titre est déjà dans votre bibliothèque.</p>` : ''}
    <p class="hint" style="padding:12px 0 0"><button class="link" id="other">Ce n'est pas le bon livre</button></p>
    <div class="picks">
      ${GENRES.map(g => `<button class="pick press" data-g="${g.id}" aria-selected="false" style="background:${g.color}">${esc(g.name)}</button>`).join('')}
    </div>
    <h2 class="section">Statut</h2>
    <div class="years status-row">
      <button class="year-chip press" data-st="want">À lire</button>
      <button class="year-chip press" data-st="read">Déjà lu</button>
    </div>
    <div class="years" id="read-years" hidden>
      ${years.map(y => `<button class="year-chip press" data-ry="${y}">${y}</button>`).join('')}
    </div>
    <div class="actions"><button class="btn btn-primary press" id="add-book">Ajouter à la bibliothèque</button></div>`;

  const sync = () => {
    body.querySelectorAll('[data-g]').forEach(el => el.setAttribute('aria-selected', el.dataset.g === genreSel));
    body.querySelectorAll('[data-st]').forEach(el =>
      el.setAttribute('aria-selected', (el.dataset.st === 'read') === (readYear !== null)));
    body.querySelector('#read-years').hidden = readYear === null;
    body.querySelectorAll('[data-ry]').forEach(el => el.setAttribute('aria-selected', +el.dataset.ry === readYear));
    body.querySelector('#add-book').disabled = !genreSel;
  };
  sync();

  body.onclick = e => {
    if (e.target.closest('#other')) return openSheet(lastTerm);
    const g = e.target.closest('[data-g]');
    if (g) { genreSel = g.dataset.g; return sync(); }
    const st = e.target.closest('[data-st]');
    if (st) { readYear = st.dataset.st === 'read' ? nowYear : null; return sync(); }
    const ry = e.target.closest('[data-ry]');
    if (ry) { readYear = +ry.dataset.ry; return sync(); }

    if (e.target.closest('#add-book') && genreSel) {
      const sessions = readYear === null ? [] :
        [{ id: uid(), startedAt: null, finishedAt: readYear === nowYear ? today() : `${readYear}-06-30` }];
      books = [{ id: uid(), title: item.title, author: item.author, cover: item.cover || null,
                 genre: genreSel, favorite: false, sessions }, ...books];
      seeded = false;
      save();
      close(sheet);
      if (readYear === null) { tab = 'lecture'; }
      else { tab = 'historique'; openYear = String(readYear); }
      render();
      resolveCovers();
    }
  };
}

/* ── Événements globaux ────────────────────────────────────── */

tabbar.querySelector('#add').onclick = () => openSheet();

function closeMenu() { document.querySelectorAll('.menu-pop, .menu-scrim').forEach(el => el.remove()); }

/* Masquer les livres lus ne veut rien dire ailleurs que dans la
   Bibliothèque : l'Historique n'est fait que de lectures terminées, les
   Favoris s'y marquent une fois le livre refermé, et Lecture n'affiche
   que ce qui est en cours ou à venir. Proposé sur ces trois écrans, le
   bouton se cochait sans que rien ne bouge — il n'y est plus. */
function openMenu() {
  closeMenu();
  const scrim = document.createElement('div');
  scrim.className = 'menu-scrim';
  scrim.onclick = closeMenu;

  const pop = document.createElement('div');
  pop.className = 'menu-pop';
  pop.innerHTML = `
    ${tab === 'bibli' ? `<button id="toggle-read">${hideRead ? 'Afficher les livres lus' : 'Masquer les livres lus'}</button>` : ''}
    <button class="danger" id="wipe">Vider la bibliothèque</button>`;
  const toggle = pop.querySelector('#toggle-read');
  if (toggle) toggle.onclick = () => {
    closeMenu();
    hideRead = !hideRead;
    localStorage.setItem('bibliotheque.hideRead', hideRead ? '1' : '0');
    render();
  };
  pop.querySelector('#wipe').onclick = () => {
    closeMenu();
    if (confirm('Effacer tous les livres ? Cette action est définitive.')) { seeded = false; books = []; save(); render(); }
  };

  document.body.append(scrim, pop);
  pop.setAttribute('data-glass', '');
  requestAnimationFrame(() => applyGlass(document.body));
}

document.addEventListener('click', e => {
  if (e.target.closest('#detail') || e.target.closest('#sheet') || e.target.closest('.menu-pop')) return;

  if (e.target.closest('.menu-btn')) return openMenu();
  closeMenu();

  const t = e.target.closest('[data-tab]');
  if (t) {
    // re-taper l'onglet courant ramène à sa racine : premier genre, haut de liste
    if (t.dataset.tab === tab) {
      if (tab === 'bibli') {
        document.getElementById('chapters')?.scrollTo({ left: 0, behavior: 'smooth' });
        view.querySelectorAll('[data-page="bibli"] .ch-scroll').forEach(s => s.scrollTo({ top: 0, behavior: 'smooth' }));
      }
      view.querySelector(`[data-page="${tab}"] .scroll`)?.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    tab = t.dataset.tab;
    syncTabbar();
    view.scrollTo({ left: tabIndex() * view.clientWidth, behavior: 'smooth' });
    return;
  }

  if (e.target.closest('[data-add]')) return openSheet();

  const open = e.target.closest('[data-open]');
  if (open) return openDetail(open.dataset.open);

  const tick = e.target.closest('[data-tick]');
  if (tick) {
    const el = document.getElementById('chapters');
    const i = GENRES.findIndex(g => g.id === tick.dataset.tick);
    el?.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
    return;
  }

  const y = e.target.closest('[data-year]');
  if (y) {
    const el = document.getElementById('ypages');
    if (!el) return;
    const i = [...el.querySelectorAll('.ypage')].findIndex(s => s.dataset.ypage === y.dataset.year);
    if (i >= 0) el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
    return;
  }
});

/* ── Fermer une fiche en la tirant vers le bas ─────────────────
   Le glissement suit le doigt ; au-delà du seuil, la vue s'échappe. */
function makeDismissable(el) {
  let startY = null, dy = 0;

  el.addEventListener('touchstart', e => {
    startY = null; dy = 0;
    const sc = e.target.closest('.ov-body');
    if (sc && sc.scrollTop > 2) return;
    startY = e.touches[0].clientY;
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    if (startY == null) return;
    dy = e.touches[0].clientY - startY;
    if (dy > 0) { el.style.transition = 'none'; el.style.transform = `translateY(${dy}px)`; }
  }, { passive: true });

  el.addEventListener('touchend', () => {
    if (startY == null) return;
    startY = null;
    if (dy > 110) {
      el.style.transition = 'transform .3s cubic-bezier(.32,.72,0,1)';
      el.style.transform = 'translateY(105%)';
      setTimeout(() => { el.style.transition = ''; el.style.transform = ''; close(el); }, 290);
    } else {
      el.style.transition = 'transform .35s cubic-bezier(.32,.72,0,1)';
      el.style.transform = '';
      setTimeout(() => { el.style.transition = ''; }, 360);
    }
    dy = 0;
  });
}
makeDismissable(detail);
makeDismissable(sheet);

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  closeMenu();
  if (!sheet.hidden) close(sheet);
  else if (!detail.hidden) close(detail);
});

render();
applyGlass();
resolveCovers();
boot();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
