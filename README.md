FIN DU DEV JAI LA FLEMME HESITEZ PAS A FORK ET POSTER SUR LE STORE ETC HF !!!!


PATCH NOTE EN BAS

[Chrome Web Store](https://chromewebstore.google.com/detail/wikimasters-prix-moyen-co/pkcnhclbagpfmlmolfcgedcmbccffgci)

[firefox addons](https://addons.mozilla.org/en-US/firefox/addon/wikimasters-tools-prix-moyen/)
merci à rodrigorod pour le port firefox

# WikiMastersTools-kzfamily

Add-on créé par la kzfamily.

**100% vibecodé**

## Installation (Chrome / Chromium / Opera / Brave)

1. Télécharger ou cloner le dépôt :

```bash
git clone https://github.com/qkerman/WikiMastersTools-kzfamily.git
```

Ou télécharger en haut à droite "code" > telecharger le zip

2. Ouvrir `chrome://extensions/` dans Chrome / Chromium.
3. Activer **Mode développeur**.
4. Cliquer sur **Charger l’extension non empaquetée**.
5. Sélectionner le dossier `WikiMastersTools-kzfamily` (dézippé) qui contient `manifest.json`.
6. Refresh WikiMasters.

## Installation (Firefox)

1. Ouvrir Firefox et aller sur `about:debugging#/runtime/this-firefox`.
2. Cliquer sur **Charger un module temporaire...** (Load Temporary Add-on...).
3. Sélectionner le fichier [manifest.json](manifest.json) situé dans le dossier de l'extension.
4. Rafraîchir WikiMasters (F5).

Si rien ne s'affiche : `about:addons` > l'extension > **Autorisations**, puis activer l'accès aux données de wiki-masters.com. Firefox 140 ou plus récent est requis.

> Pour empaqueter l'extension pour Firefox (AMO ou distribution) :  
> `npx web-ext build --ignore-files "tests/**" "*.md"` (le fichier zip sera généré dans `web-ext-artifacts/`).

## Mise à jour

```bash
cd ~/Downloads/WikiMastersTools-kzfamily
git pull
```

Ou retélécharger manuellement et remplacer le dossier.

Puis cliquer sur **Recharger** dans `chrome://extensions/` et faire un F5 sur WikiMasters.

## Tests de régression

Avec Node.js 22 ou plus récent, sans dépendance à installer :

```bash
node --test tests/*.test.js
```

Les tests couvrent les prix par rareté, les exemplaires en double, le cache et la file de
chargement, les délais réseau, les limitations du serveur, l'arrêt des paquets et les
ouvertures concurrentes entre onglets. Les réponses réseau sont simulées ; aucun
paquet réel n'est consommé par ces tests.

## Patch note

*Heure de Paris*

- **24/11/2026 — v4.44.0** — Profil d'un joueur : au survol d'une carte (vitrine ou collection), un bouton « ♡ Souhait » ouvre « Toutes les cartes » dans un nouvel onglet, cherche la carte et ouvre sa fiche : il ne reste qu'à cliquer « Ajouter à la liste de souhaits ». L'ajout reste un clic sur le bouton du site, l'extension n'écrit rien elle-même. Désactivable dans les paramètres (« Souhait depuis un profil »). « Plus chères » : les étiquettes et favoris ajoutés après le dernier chargement complet de la collection apparaissent dès que tu vois la carte dans ta collection (en la parcourant ou en la cherchant) : l'extension reprend leur état dans les pages que le site affiche, sans requête de plus.
- **24/11/2026 — v4.43.0** — Ouverture d'un paquet : le récap « Prix moyens du paquet » apparaît dès la première carte retournée, et non plus seulement à la dernière. Il ne liste que les cartes déjà dévoilées, pour ne rien gâcher : un clic sur « Voir le prix » charge le prix de la carte que tu regardes.
- **24/11/2026 — v4.42.0** — « Plus chères » retire les cartes que tu ne possèdes plus. Quand tu ouvres le Marché, le site indique pour chaque annonce (dont tes 50 dernières ventes) si tu as encore la carte : l'extension lit cette réponse, sans requête de plus, et sort les cartes vendues de la collection mémorisée.
- **23/11/2026 — v4.41.0** — Vue « GIFs » : un clic sur une carte ouvre sa fiche du site (étiquettes, favori, enchères). L'extension cherche son titre dans la collection comme si tu le tapais, ouvre la fiche, puis la liste des GIF revient quand tu la fermes. La recherche du site est remise comme avant à la fermeture de la vue.
- **23/11/2026 — v4.40.0** — « Plus chères » : sous chaque prix, le nombre de ventes sur 30 jours (en orange sous 2 ventes), pour repérer un prix qui repose sur une vente isolée. Nouvelle case « ≥ 2 ventes / 30 j » pour masquer ces cartes. Un prix chargé avant cette version affiche « ventes ? (clic) » : un clic l'actualise avec son nombre de ventes.
- **23/11/2026 — v4.39.0** — « Plus chères » : nouvelle étiquette « Sans prix » avec toutes les cartes de la collection sans prix, les plus rares d'abord : jamais chargées, ou chargées sans moyenne pour leur rareté (« — ») il y a plus d'un jour. Un clic sur « Voir le prix » d'une ligne charge son prix (une requête par clic), et la ligne se met à jour.
- **23/11/2026 — v4.38.0** — Les prix remarchent : le site ne donne plus de résumé des ventes. Le prix affiché est maintenant le même que dans l'onglet « Marché » d'une carte : la moyenne de la semaine en cours (ou de la dernière semaine avec des ventes), pour chaque rareté. Mode conforme au règlement du site (pas d'automatisation) :
  - les prix ne se chargent plus tout seuls. Un prix inconnu affiche « Voir le prix » : un clic le charge, une carte à la fois, au plus une requête toutes les 4 s. Un prix déjà chargé reste affiché pour toujours (cliquer dessus l'actualise s'il a plus d'un jour) ;
  - sur la page d'une annonce du Marché, le cadre « Prix moyen » affiche aussi « Voir le prix » quand le prix est inconnu : un clic le charge ;
  - les pages d'une annonce et des échanges ne redemandent plus elles-mêmes ce que le site vient de charger : l'extension lit seulement ses réponses ;
  - au premier blocage du site (« Trop de requêtes automatisées »), tout s'arrête au moins 10 minutes, sans relance automatique ;
  - « Tout ouvrir », l'ouverture automatique des paquets et « Charger les prix » sont retirés. À l'ouverture d'un paquet, l'extension n'envoie plus aucune requête et ne retient plus celle du site : elle lit seulement les cartes reçues ;
  - « Mes enchères » ne se rafraîchit plus en boucle : bouton « Actualiser » ;
  - une mise en vente refusée n'est plus relancée automatiquement ;
  - les chargements de pages (étiquettes, familles, recherche « Mot entier » limitée à 10 pages) vont au rythme d'une page toutes les 1,5 s et s'arrêtent dès que le site refuse.
- **16/11/2026 — v4.37.0** — Familles : nouvelle case « Mot entier » dans la recherche de cartes. « tri » trouve « Tri par tas » mais plus « actrice » ni « triangle » (titre ou catégorie, sans tenir compte des majuscules ni des accents). Les résultats arrivent sur une seule page, après parcours des 20 premières pages du site au maximum.
- **16/11/2026 — v4.36.2** — GIFs : seules les illustrations fournies par le site comptent, comme ça tout le monde voit les mêmes cartes GIF. Les images retrouvées sur Wikimedia par l'extension ne sont plus prises en compte, et le bouton de recherche des images manquantes est retiré du bouton « GIFs » (l'affichage des images manquantes dans la collection ne change pas).
- **16/11/2026 — v4.36.1** — Recherche des images manquantes (bouton « GIFs ») beaucoup plus rapide : Wikipédia est d'abord interrogé par lots de 50 titres, en français puis en anglais. Seules les cartes encore sans image passent ensuite par la recherche complète, une à une. Pour les cartes trouvées par lot, l'image de Wikipédia est retenue avant celle de Wikidata.
- **16/11/2026 — v4.36.0** — Collection : nouveau bouton « GIFs » qui affiche, sous forme de cartes, celles dont l'illustration est un GIF. Pour les cartes sans illustration du site, un bouton cherche leurs images sur Wikidata et Wikipédia en arrière-plan (une carte par seconde, pause d'une minute si ces sites refusent). Une recherche d'image en erreur n'est plus mémorisée comme « pas d'image » pendant 7 jours. Option « Cartes GIF » dans les réglages.
- **16/11/2026 — v4.35.0** — « Plus chères » : nouvelle étiquette « GIFs » dans le menu des étiquettes, qui affiche les cartes dont l'illustration est un GIF (celle du site, ou celle retrouvée sur Wikimedia). Calculée par l'extension, elle n'ajoute rien à ton compte.
- **13/11/2026 — v4.34.2** — « Plus chères » : les cartes déjà en vente sont marquées « Déjà en vente » dès l'ouverture, au lieu de l'apprendre seulement après un clic sur « Vendre » qui échoue.
- **13/11/2026 — v4.34.1** — Corrections sur les nouveautés de la v4.34.0, trouvées par une relecture :
  - Voir un prix sur le Marketplace ou miser dans « Mes enchères » ne change plus la rareté ni le nombre d'exemplaires mémorisés d'une carte déjà possédée (ça pouvait fausser le prix retenu pour « Plus chères » et sa valeur estimée).
  - Les bonnes affaires du Marketplace ne se chargent plus en arrière-plan en dehors de la page Marketplace (recherche des Familles, page « Mes enchères » qui masque le Marketplace en CSS mais le laisse actif) ; l'écart affiché utilise désormais la bonne annonce quand plusieurs portent le même titre.
  - Un prix de vente fixe est arrondi à l'entier le plus proche.
  - Une moyenne de 0 W n'est plus gardée 7 jours ni affichée comme un dépassement dans « Mes enchères ».
  - L'écart « sur 7 jours » de la valeur de la collection n'est enregistré que lorsque toutes les cartes connues ont un prix, et ne compare plus avec un jour trop ancien.
  - Les statistiques de valeur des paquets se chargent aussi quand le récapitulatif est désactivé, et ignorent un prix expiré en attendant le prix à jour.
  - Le prix d'une annonce Marketplace consultée, d'un paquet qui vient de s'ouvrir ou d'un échange affiché passe devant un chargement de fond en cours.
  - « Mes enchères » ne reconstruit plus sa liste à chaque prix reçu dans la même rafale.
- **13/11/2026 — v4.34.0** — Nouveautés :
  - **« Plus chères » :**
    - Le prix de vente se règle en « % de la moyenne » (100 % par défaut) ou en prix fixe. Chaque bouton affiche son propre montant, et les réglages sont mémorisés.
    - Nouveaux filtres « Doublons uniquement » et rareté.
    - Valeur estimée de la collection : total, détail par rareté, cartes sans prix, et écart sur 7 jours quand le classement est complet.
  - **Échanges :** l'écart de valeur s'affiche sous les deux totaux (« +340 W pour toi (+18 %) »), avec « estimation partielle » s'il manque des prix.
  - **Statistiques de tirage :** valeur moyenne par paquet, meilleur paquet et total tiré, comptés dès que les prix du paquet sont connus.
  - **Chargement des prix :** les cartes les plus chères passent en premier. Une carte qui vaut moins de 5 W reste valide 7 jours, comme les communes.
  - **Mes enchères :**
    - Le prix moyen de chaque carte est affiché, et le bouton « Miser » passe en orange quand la mise dépasse la moyenne.
    - La page interroge le site toutes les 15 s, ou toutes les 7 s quand une enchère finit dans moins de 2 min.
    - Elle tient compte des blocages du site vus par le chargement des prix, dans les deux sens.
  - **Marketplace :** chaque annonce de la liste affiche la moyenne et l'écart avec son prix actuel (« −35 % » en vert, « +20 % » et plus en rouge). Au plus 20 prix L, UR ou SR manquants sont chargés par page, en priorité. Option dans les réglages.
- **13/11/2026 — v4.33.3** — Performances :
  - **Lancement de « Charger les prix » :** la page n'est plus parcourue une fois par carte, mais une seule fois pour tout le lot. Le gel au lancement disparaît.
  - **Ouverture de paquets :** chaque paquet ouvert ne recopie plus la collection mémorisée que dans IndexedDB (une copie au lieu de trois ou quatre). Les autres onglets relisent IndexedDB au lieu de recevoir toute la collection.
  - **Prix de la collection :** les prix affichés sont formatés sans recréer un formateur à chaque fois.
  - **Démarrage :** le nettoyage quotidien du cache des prix attend 5 s après l'ouverture de la page.
  - **Infobulle des prix :** elle n'annonce plus « cache 24 h », car les communes sont gardées 7 jours.
- **13/11/2026 — v4.33.2** — Sécurité des WikiBidous :
  - **Ventes :** un double clic sur « Plus chères » n'ouvre plus deux classements. Une même carte ne peut plus être mise en vente deux fois en même temps. Une vente en cours garde son état si un filtre redessine la liste. Un exemplaire favori demande confirmation même quand son identifiant est déjà connu.
  - **Paquets :** un blocage du site (403/429) sans réponse lisible fait attendre puis réessayer, au lieu d'annoncer un paquet peut-être consommé. L'ouverture automatique ne compte plus comme « interrompu » le cycle laissé à un autre onglet.
  - **Mes enchères :** plus de surenchère sur sa propre mise quand l'identifiant du joueur n'est pas lisible dans le cookie. Au retour sur la page, plus d'anciens montants avec des boutons « Miser » actifs, et plus de bip après l'avoir quittée.
- **13/11/2026 — v4.33.1** — « Plus chères » : nouveau filtre « Sans étiquette », sélectionné par défaut à l'ouverture. Mise en vente : la durée « 24 h », qui n'existe pas sur le site, n'est plus proposée.
- **12/11/2026 — v4.33.0** — La collection mémorisée quitte localStorage (~10 Mo partagés avec les prix) pour IndexedDB, dont la limite se compte en centaines de Mo ou plus. Elle y est déplacée automatiquement au premier chargement, et les onglets ouverts se tiennent à jour entre eux. Libère environ 60 % de la place pour les prix.
- **12/11/2026 — v4.32.0** — Stockage plein (« exceeded the quota ») : la collection mémorisée, qui occupait ~70 % de la place, est enregistrée dans un format compact (valeurs par défaut omises, début commun des adresses d'images mis en commun) et réécrite automatiquement au premier chargement. Les prix n'enregistrent plus de champ inutile. Les nouveaux prix sont de nouveau sauvegardés, ce qui évite de recharger les mêmes cartes à chaque « Uniquement les cartes non chargées ».
- **10/11/2026 — v4.31.6** — Son des notifications : plus d'avertissement « AudioContext was not allowed to start » dans la console tant que la page n'a reçu aucun geste de l'utilisateur.
- **10/11/2026 — v4.31.5** — Chargement des prix en arrière-plan : les pauses de la file et de la lecture de la collection passent par un Web Worker, car Chrome ralentit les minuteurs d'un onglet masqué (jusqu'à un par minute après 5 min). Retour automatique à `setTimeout` si le Worker est indisponible.
- **09/11/2026 — v4.31.4** — Chargement des prix : l'espacement ne descend plus sous 1,8 s par carte (un prix toutes les ~2 s passe sans blocage, ~1,4 s est bloqué par le site) et ne retombe plus à « sans pause » en accélérant.
- **09/11/2026 — v4.31.3** — Chargement des prix : le temps passé sans requête (lecture de la collection, page ouverte avant le lancement) n'est plus compté dans la série réussie qui sert à calculer le rythme. Il faussait l'estimation de la limite du site (12 s par carte au lieu d'environ 1,5 s). Ancien rythme enregistré ignoré.
- **09/11/2026 — v4.31.2** — Chargement des prix : une série de requêtes trop courte pour en déduire la limite du site ne ralentit plus l'espacement à chaque blocage (il pouvait grimper jusqu'à 15 s par carte), l'espacement redescend plus vite quand tout passe, et l'ancien rythme enregistré est ignoré.
- **09/11/2026 — v4.31.1** — Suppression de la mention « bouton sponsorisé par » (lien Twitch) affichée sous les boutons et les prix.
- **09/11/2026 — v4.31.0** — Nouveau bouton « Vider le cache » dans les paramètres (section Données) : supprime les prix, la collection mémorisée, les images retrouvées et le rythme de chargement appris, sans toucher aux réglages, aux familles ni aux statistiques de tirage.
- **09/11/2026 — v4.30.3** — Quand le site est lent : délais d'attente relevés (60 s par page de collection, 25 s par prix) pour ne plus abandonner des requêtes qui allaient aboutir. « Charger les prix » réutilise la collection déjà stockée (moins de 12 h) au lieu de relire ~120 pages ; Maj + clic force la relecture complète.
- **09/11/2026 — v4.30.2** — Une requête de collection sans réponse affiche « pas de réponse en 15 s » au lieu du message technique, et elle est retentée après 3 s, 6 s… car un site qui traîne est souvent un site qui freine.
- **09/11/2026 — v4.30.1** — Après un blocage du site, la sonde repart au bout de 1 s puis 2, 3, 5, 8 s… (suite de Fibonacci, 5 min maximum) pour détecter la réouverture presque immédiatement.
- **09/11/2026 — v4.30.0** — Chargement des prix plus rapide face aux blocages du site : une seule requête de sonde après un blocage (au lieu d'une longue pause), rythme déduit de la limite observée et mémorisé 6 h, pause partagée entre les onglets, prix des communes (C, PC) gardés 7 jours, et temps restant estimé sur le bouton.
- **09/11/2026 — v4.29.5** — Quand le site bloque les requêtes de prix, les cartes concernées sont retentées après la pause au lieu d'être perdues ; la pause démarre à 1 min et double à chaque blocage consécutif (5 min maximum).
- **09/11/2026 — v4.29.4** — Le bouton « Charger les prix » affiche « · pause » quand le site limite les requêtes, et le nettoyage du stockage plein ne s'exécute plus qu'une fois par 30 s.
- **09/11/2026 — v4.29.3** — Performances : le stockage du navigateur ne sature plus (cache de collection allégé, purge automatique quand il est plein), chargement des prix et défilement plus fluides, démarrage plus rapide, moins de calculs inutiles sur les familles, et nettoyage du code inutilisé. Correction de l'état « Terminé » affiché à tort quand le site bloque, et de l'offre affichée à « 0 WikiBidous ».
- **09/11/2026 — v4.29.2** — Correction de « Collection page N : HTTP 403 » : pause entre les pages, nouvel essai après un 403/429, pages déjà lues conservées en cas d'erreur (chargement partiel signalé), pause automatique des prix quand le site bloque, et « Uniquement les cartes non chargées » retente les prix en échec. « Mes enchères » ralentit ses requêtes quand le site bloque, la recherche de copies à la mise en vente n'insiste plus indéfiniment, et les permissions inutiles ont été retirées.
- **05/10/2026 — v4.29.1** — Interface des paquets simplifiée : suppression des boutons « Arrêter » et « Revoir le dernier récap » ; compteur discret « 3/5 ouverts » pendant l’ouverture, conservé pendant les attentes.
- **05/10/2026 — v4.29** — Correction des prix sur les exemplaires en double et des moyennes d'une autre rareté ; délais réseau et limitations de requêtes gérés ; ouvertures protégées entre onglets ; bouton « Arrêter » et récapitulatif récupérable après rechargement. L'arrêt de l'ouverture automatique interrompt le lot après le paquet en cours. Les vérifications du site doivent être validées manuellement. Les anciens prix en cache seront rechargés pour éliminer les moyennes incorrectes.
- **05/10/2026** — Ajout de la page « Mes enchères » avec suivi, surenchère en un clic et alerte sonore, désactivable dans les paramètres.
- **30/09/2026** — Ajout de la page « Familles ».
- **28/09/2026** — Nouveaux outils pour les cartes, les échanges et les notifications, avec davantage de réglages pour les paquets.
- **27/09/2026** — Mise à jour du style et des performances des cartes.
- **25/09/2026** — Ajout des paramètres et amélioration des cartes sans image.
- **24/09/2026** — Ajout de l’ouverture automatique et du récapitulatif des paquets.
- **23/09/2026** — Extension disponible sur Firefox, Brave et Opera.
- **21/09/2026** — Ajout des outils de vente, de classement et d’estimation des échanges.
- **18/09/2026** — Ajout des prix moyens dans la collection, les paquets et le Marketplace.
