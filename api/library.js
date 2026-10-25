/* ── API bibliothèque : une seule ressource, le JSON des livres ──
   Auth    : mot de passe unique (env LIBRARY_PASSWORD) en Bearer.
   Stockage: Vercel Blob, store privé, chemin fixe `library.json`.

   Le store est privé : Vercel refuse toute lecture qui ne présente pas
   les identifiants du store, et ces identifiants ne quittent jamais le
   serveur. Le navigateur ne parle qu'à /api/library, qui exige le mot
   de passe. Connaître l'adresse du fichier ne suffit pas à le lire.

   Les installations d'avant octobre 2026 ont un store public, et le
   mode d'un store ne se change pas après création. Là, qui a l'URL du
   fichier le lit ; elle ne quitte jamais le serveur, son identifiant
   aléatoire tient lieu de secret. L'API reconnaît ces stores et
   continue de s'en servir : ne retire pas ce repli, ce sont de vraies
   bibliothèques.

   Le chemin ne dépend PAS du mot de passe : on peut changer ce dernier
   sans perdre sa bibliothèque. */

import { put, get, list } from '@vercel/blob';
import { createHash, timingSafeEqual } from 'node:crypto';

const BLOB_PATH = 'library.json';
const sha = s => createHash('sha256').update(s).digest();

/* Mode du store, appris au premier échange et gardé tant que l'instance
   vit : 'private', 'public', ou null tant qu'on ne le sait pas. */
let access = null;

function authorized(req) {
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const want = process.env.LIBRARY_PASSWORD || '';
  if (!got || !want) return false;
  return timingSafeEqual(sha(got), sha(want));
}

// Lecture d'origine (useCache: false) : un autre appareil vient peut-être
// d'écrire, le cache pourrait servir l'ancienne version pendant 60 s.
async function readPrivate() {
  const r = await get(BLOB_PATH, { access: 'private', useCache: false });
  return r ? new Response(r.stream).json() : null;
}

async function readLibrary() {
  if (access !== 'public') {
    try {
      const data = await readPrivate();
      if (data) { access = 'private'; return data; }
    } catch (e) {
      if (access === 'private') throw e; // store privé connu : vraie panne
    }
  }

  /* Rien en privé : store public, ou bibliothèque jamais écrite. Seul
     list() tranche, il voit le fichier quel que soit le mode. Répondre
     « vide » à tort serait grave : l'appareil pousserait alors sa propre
     bibliothèque (ou la démo) par-dessus celle du serveur. */
  const { blobs } = await list({ prefix: BLOB_PATH });
  const hit = blobs.find(b => b.pathname === BLOB_PATH);
  if (!hit) return null;

  if (!new URL(hit.url).hostname.endsWith('.public.blob.vercel-storage.com')) {
    const data = await readPrivate();
    if (!data) throw new Error('library.json listé mais illisible');
    access = 'private';
    return data;
  }

  access = 'public';
  return (await fetch(hit.url + '?t=' + Date.now(), { cache: 'no-store' })).json();
}

/* Le mode d'un store vide ne se lit nulle part : on écrit en privé, et
   Vercel refuse l'écriture si le store est public — on réécrit alors
   en public. Une écriture refusée n'écrit rien. */
async function writeLibrary(books) {
  const body = JSON.stringify(books);
  const opts = {
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 0,
  };
  if (access !== 'public') {
    try {
      await put(BLOB_PATH, body, { ...opts, access: 'private' });
      access = 'private';
      return;
    } catch (e) {
      if (access === 'private') throw e;
    }
  }
  await put(BLOB_PATH, body, { ...opts, access: 'public' });
  access = 'public';
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');

  // Déploiement statique ou store non lié : le client bascule en local.
  // Un store se reconnaît à son jeton (BLOB_READ_WRITE_TOKEN) ou, quand
  // Vercel le relie par OIDC, à son identifiant (BLOB_STORE_ID).
  const store = process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID;
  if (!process.env.LIBRARY_PASSWORD || !store)
    return res.status(501).json({ configured: false });

  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  if (req.method === 'GET')
    return res.status(200).json({ books: await readLibrary() });

  if (req.method === 'PUT') {
    const books = req.body && req.body.books;
    if (!Array.isArray(books)) return res.status(400).json({ error: 'bad payload' });
    await writeLibrary(books);
    return res.status(200).json({ ok: true });
  }

  res.setHeader('allow', 'GET, PUT');
  return res.status(405).json({ error: 'method not allowed' });
}
