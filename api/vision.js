/* ── Reconnaissance de couverture ────────────────────────────────
   Le navigateur envoie la photo, le serveur interroge Gemini avec
   SA clé. Personne n'a de clé à coller sur son téléphone, et la clé
   ne se promène jamais côté client.

   Facultatif : sans GEMINI_API_KEY, on répond 501 et l'app propose
   la saisie manuelle. Le reste de l'application est intact. */

import { createHash, timingSafeEqual } from 'node:crypto';

/* Google retire ses modèles sans prévenir — `gemini-2.5-flash` a disparu
   un an après avoir été écrit ici. On essaie donc plusieurs générations,
   de la plus récente à la plus ancienne, et la première qui répond gagne.
   Un dépôt que personne ne met à jour continue ainsi de fonctionner.
   GEMINI_MODEL force un modèle précis et court-circuite la liste. */
const MODELS = process.env.GEMINI_MODEL
  ? [process.env.GEMINI_MODEL]
  : ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'];

/* Le modèle n'existe pas / plus : inutile d'insister, on passe au suivant. */
const modelGone = (status, msg) =>
  status === 404 || /no longer available|not found|is not supported|does not exist/i.test(msg);
const PROMPT = "Cette photo montre la couverture d'un livre papier. Donne le titre exact et l'auteur tels qu'imprimés, puis classe le livre dans l'un des genres proposés. Si aucun livre n'est identifiable, mets found à false et laisse les autres champs vides.";

const sha = s => createHash('sha256').update(s).digest();

/* Même mot de passe que la bibliothèque : sans ça, n'importe qui
   pourrait épuiser le quota Gemini du propriétaire. Pas de mot de passe
   = pas de scan serveur (voir le handler), jamais une porte ouverte. */
function authorized(req) {
  const want = process.env.LIBRARY_PASSWORD || '';
  if (!want) return false;
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!got) return false;
  return timingSafeEqual(sha(got), sha(want));
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  // Sans clé, ou sans mot de passe pour la protéger : l'app bascule sur
  // la clé propre à l'appareil, comme sur un hébergement statique.
  if (!process.env.GEMINI_API_KEY || !process.env.LIBRARY_PASSWORD)
    return res.status(501).json({ configured: false });
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  const { image, genres } = req.body || {};
  if (typeof image !== 'string' || !image) return res.status(400).json({ error: 'bad payload' });
  const enum_ = Array.isArray(genres) && genres.length ? genres : ['roman'];

  const payload = JSON.stringify({
    contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: image } }, { text: PROMPT }] }],
    generationConfig: {
      response_mime_type: 'application/json',
      response_schema: {
        type: 'OBJECT',
        properties: {
          found: { type: 'BOOLEAN' },
          title: { type: 'STRING' },
          author: { type: 'STRING' },
          genre: { type: 'STRING', enum: enum_ },
        },
        required: ['found', 'title', 'author', 'genre'],
      },
    },
  });

  let r, msg = '';
  for (const model of MODELS) {
    r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=` +
        encodeURIComponent(process.env.GEMINI_API_KEY),
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload },
    );
    if (r.ok) break;
    msg = (await r.json().catch(() => ({})))?.error?.message || `Erreur ${r.status}`;
    if (!modelGone(r.status, msg)) break; // vraie erreur : inutile d'essayer les autres
    r = null;
  }

  // Plus aucun modèle (r nul) ou vraie erreur (r lu, non ok) : on renvoie
  // le message de Google. La clé du serveur ne doit jamais y transparaître.
  if (!r || !r.ok) return res.status(502).json({ error: msg.replace(/AIza[\w-]+/g, '…') });

  const data = await r.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  if (!text) return res.status(200).json({ found: false });

  try {
    return res.status(200).json(JSON.parse(text));
  } catch {
    return res.status(502).json({ error: 'réponse illisible' });
  }
}
