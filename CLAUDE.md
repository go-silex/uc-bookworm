# Bibliothèque — notes pour un agent

## Si quelqu'un te demande d'installer cette app

Va lire **[INSTALL.md](INSTALL.md)** et déroule-le. Il est écrit pour toi : étapes exactes, diagnostic des erreurs, recette d'acceptation. La personne en face ne connaît probablement pas la ligne de commande — exécute, ne dicte pas.

**Le déploiement se fait sur Vercel, et nulle part ailleurs.** Ce n'est pas une préférence : les hébergeurs statiques n'exécutent pas `api/library.js`, l'app bascule alors silencieusement en stockage navigateur, et la personne perdra sa bibliothèque le jour où elle videra son cache. Ne propose pas d'alternative, même si on te demande « plus simple ».

## Si tu viens modifier le code

**Pas de build, pas de framework, pas de dépendance côté navigateur.** `index.html` charge deux scripts classiques et une feuille de style. C'est délibéré : n'introduis ni bundler, ni TypeScript, ni React. `@vercel/blob` est la seule dépendance npm et ne sert qu'à la fonction serverless.

Pour lancer : `npx serve` puis ouvrir `localhost:3000`. **Jamais en `file://`** — les appels réseau sont bloqués et l'app reste vide.

### La carte

| Fichier | |
|---|---|
| `app.js` | toute l'application, ~1500 lignes, un seul scope global |
| `style.css` | tout le style |
| `glass.js` | `liquidGlass(el, opts)` — filtre SVG de réfraction. Chromium seulement, dégrade en flou simple ailleurs |
| `api/library.js` | la sync, la seule partie serveur avec la suivante |
| `api/vision.js` | la reconnaissance de couverture — la clé Gemini vit ici, jamais dans le navigateur |
| `sw.js` | ne met en cache que les images de couverture, rien d'autre |

Les sections de `app.js`, dans l'ordre : constantes et `SEED` → état et `load()` → sync serveur → état dérivé → utilitaires → couvertures → verre liquide → cœur du rendu → les 4 vues → détail d'un livre → modifier un livre → ajout → reconnaissance de couverture → étapes du flux d'ajout → événements globaux → séquence de démarrage.

### Le modèle de données

```js
{ id, title, author, cover, genre, favorite, shortlist, note, rating,
  sessions: [{ id, startedAt, finishedAt }] }
```

**Tout le reste est dérivé.** Le statut d'un livre (`statusOf`) se déduit de sa dernière session : aucune session → « à lire », une session sans `finishedAt` → « en cours », sinon « lu ». L'historique est la liste de toutes les sessions terminées. C'est ce qui fait que les relectures fonctionnent naturellement — n'ajoute pas de champ `status`, il désynchroniserait tout.

`noCover` est un drapeau transitoire, jamais persisté (voir `stripNoCover`) : un livre sans couverture retente à chaque session, jamais en boucle.

### Les pièges

- **`save()` déclenche une écriture réseau** via `pushSoon()`. L'appeler dans une boucle est coûteux — le debounce à échéance (900 ms, plafond 5 s) est là pour ça, ne le contourne pas.
- **`mergeLibraries()` ne doit jamais perdre de données.** Elle réunit par titre normalisé et par `finishedAt`. Toute modification ici mérite d'être testée à deux appareils.
- **Les chemins sont relatifs** (`api/library`, `./sw.js`, `./manifest.json`) : l'app tourne ainsi depuis n'importe quel sous-dossier, y compris servie en local. Ne les repasse pas en absolu.
- **L'écran de mot de passe ne protège que l'API.** Tout ce qui est dans le code source est public. Ne mets jamais de donnée personnelle dans `app.js` — c'est arrivé, ça a fuité.
- **Le store Blob est privé, sauf sur les installations d'avant octobre 2026.** Le bouton Deploy crée un store `private` : `library.json` ne se lit qu'avec les identifiants du store, qui restent côté serveur — donc seulement à travers `/api/library` et son mot de passe. Les anciennes installations ont un store public, et le mode ne change pas après création : `api/library.js` le reconnaît (à l'URL que renvoie `list()`) et continue d'y lire et d'écrire. Ne retire pas ce repli, ce sont de vraies bibliothèques. Et ne renvoie jamais l'URL d'un blob au navigateur : sur un store public, c'est elle le secret.
- **`GET /api/library` ne répond `{ books: null }` que si `list()` ne voit aucun fichier.** Un « vide » à tort ferait pousser par l'appareil sa bibliothèque locale, ou la démo, par-dessus celle du serveur. Dans le doute, une erreur : le client reste en local et ne pousse rien.
- **Les deux API répondent `501` quand elles ne sont pas configurées** — `library` fait basculer le client en local, `vision` fait proposer la saisie manuelle. Ce sont des contrats, pas des pannes : ne les transforme pas en erreurs.
- **La clé du serveur ne doit jamais revenir côté navigateur.** `api/vision.js` la masque jusque dans les messages d'erreur remontés par Google.
- **Le scan a deux chemins**, `readCover()` : le serveur d'abord, puis une clé propre à l'appareil (`KEY_API`) en rattrapage. Le serveur prime toujours quand il répond. Ne supprime pas le rattrapage — c'est ce qui évite le cul-de-sac à qui a sauté l'étape d'installation.
- Le rendu se fait par `innerHTML` : **toute donnée utilisateur passe par `esc()`**.
- **La pile de l'écran Lecture n'est pas un scroller** (`initDeck`). Les couvertures sont empilées en absolu ; `--p` porte la profondeur de chacune, `--fan` recentre l'éventail. Le geste retenu est celui qui ne servait à rien — vers la droite, Lecture étant le premier onglet ; vers la gauche appartient au pager et mène à la Bibliothèque, ne le lui prends pas. Les écouteurs sont passifs exprès : le pager continue de voir le geste.
- **`coverHTML()` pose toujours le dégradé titré au fond**, l'image par-dessus. Une couverture qui tarde ou revient en 404 laisse donc voir le titre. Ne remets pas l'image seule.
- **La note appartient au livre, pas à la lecture.** C'était un choix : on relit rarement en pensant assez différemment pour vouloir deux textes. Deux appareils qui écrivent chacun la leur passent par `mergeNotes()`, qui réunit plutôt que de trancher — `mergeLibraries()` ne doit jamais perdre de texte écrit à la main.
- **L'ordre de `sessions` porte le statut** : une lecture en cours doit rester la dernière. Toute écriture qui réordonne passe par `sortSessions()` — `mergeLibraries()` comprise, qui triait autrefois sur la seule date de début.
- **Une lecture en cours peut être la même, terminée ailleurs.** `mergeLibraries()` la reconnaît à son identifiant ou à sa date de début, sinon l'appareil resté en arrière rajoute sa copie inachevée à côté de la version terminée et le livre repart « en cours », serveur compris.
- **L'avis (`rating`, entier de 1 à 5) appartient au livre, comme la note**, et ne s'affiche qu'une fois le livre lu — ni sur un livre à lire, ni pendant une lecture, relecture comprise. Absent = pas d'avis : ne stocke jamais `0`, et lis-le toujours par `ratingOf()`, qui écarte les valeurs aberrantes. Deux avis n'ont pas d'horodatage pour se départager : dans `mergeLibraries()`, celui de la base prime, l'autre ne comble qu'une absence.
- **« Masquer les livres lus » n'agit que sur la Bibliothèque**, seul écran où un livre lu se mêle aux autres. Le menu ne l'offre donc que là (`openMenu`) : ailleurs, cocher l'option ne faisait rien.

### L'interface est en français

Les libellés sont écrits en dur dans `app.js`. Une traduction impliquerait de les extraire dans un dictionnaire — c'est une contribution bienvenue, mais ce n'est pas fait.
