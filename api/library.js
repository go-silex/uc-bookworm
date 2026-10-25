/* ── API bibliothèque : une seule ressource, le JSON des livres ──
   Auth    : mot de passe unique (env LIBRARY_PASSWORD) en Bearer.
   Stockage: Vercel Blob, store public, chemin fixe `library.json`.

   Le store est public au sens de Vercel (qui a l'URL lit le fichier),
   mais cette URL ne quitte jamais le serveur : le navigateur ne parle
   qu'à /api/library, qui exige le mot de passe. Le secret est donc
   l'identifiant aléatoire du store, jamais exposé.

   Le chemin ne dépend PAS du mot de passe : on peut changer ce dernier
   sans perdre sa bibliothèque. */

import { put, list } from '@vercel/blob';
import { createHash, timingSafeEqual } from 'node:crypto';

const BLOB_PATH = 'library.json';
const sha = s => createHash('sha256').update(s).digest();

function authorized(req) {
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const want = process.env.LIBRARY_PASSWORD || '';
  if (!got || !want) return false;
  return timingSafeEqual(sha(got), sha(want));
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

  if (req.method === 'GET') {
    const { blobs } = await list({ prefix: BLOB_PATH });
    const hit = blobs.find(b => b.pathname === BLOB_PATH);
    if (!hit) return res.status(200).json({ books: null });
    const data = await (await fetch(hit.url + '?t=' + Date.now(), { cache: 'no-store' })).json();
    return res.status(200).json({ books: data });
  }

  if (req.method === 'PUT') {
    const books = req.body && req.body.books;
    if (!Array.isArray(books)) return res.status(400).json({ error: 'bad payload' });
    await put(BLOB_PATH, JSON.stringify(books), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
      cacheControlMaxAge: 0,
    });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('allow', 'GET, PUT');
  return res.status(405).json({ error: 'method not allowed' });
}
