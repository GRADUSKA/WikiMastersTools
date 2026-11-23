(() => {
  const registry = window.__wmAverageFeatures ||= {};

  registry.priceUi = {
    create(runtime) {
      const {
        isCollectionPage, isMarketplaceDetailPage, isMarketplacePage, isGlobalCollectionPage,
        normalizeTitle, cacheKey, storageGet, isCacheEntryValid, reportError,
        registerCards, preserveOwnedMeta, cardMetaById, idByTitle, cacheMemory
      } = runtime.core;

      let collectionPriceObserver = null;
      let marketplaceCardId = null;
      let marketplaceRequestedPath = null;
      let globalCollectionCardId = null;
      let globalCollectionInitializedId = null;

      function getRarityFromCard(cardEl) {
        if (!cardEl) return null;
        const candidates = cardEl.querySelectorAll('div, span');
        for (const el of candidates) {
          const text = (el.textContent || '').trim();
          if (/^(L|UR|SR|R|PC|C)$/.test(text)) return text;
        }
        return null;
      }

      // Créer un formateur coûte ~40 fois plus que s'en servir : on les garde.
      const wholeFormat = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
      const decimalFormat = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });

      function formatAverage(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '—';
        return (Number.isInteger(n) ? wholeFormat : decimalFormat).format(n);
      }

      // Le chargement en masse appelle findCardByTitle des milliers de fois dans la même tâche :
      // l'index des titres affichés n'est construit qu'une fois, puis jeté à la fin de la tâche.
      let h3ByTitle = null;

      function indexH3ByTitle() {
        if (h3ByTitle) return h3ByTitle;

        h3ByTitle = new Map();
        for (const h3 of document.querySelectorAll('h3')) {
          const key = normalizeTitle(h3.textContent);
          const list = h3ByTitle.get(key);
          if (list) list.push(h3);
          else h3ByTitle.set(key, [h3]);
        }

        Promise.resolve().then(() => { h3ByTitle = null; });
        return h3ByTitle;
      }

      // Même principe pour les cartes déjà reliées à un id : une recherche dans toute la page
      // par carte coûtait ~21 000 requêtes DOM au lancement d'un chargement complet.
      let cardsById = null;

      function indexCardsById() {
        if (cardsById) return cardsById;

        cardsById = new Map();
        for (const card of document.querySelectorAll('[data-wm-card-id]')) {
          const list = cardsById.get(card.dataset.wmCardId);
          if (list) list.push(card);
          else cardsById.set(card.dataset.wmCardId, [card]);
        }

        Promise.resolve().then(() => { cardsById = null; });
        return cardsById;
      }

      function findCardByTitle(title) {
        if (!isCollectionPage()) return null;

        for (const h3 of indexH3ByTitle().get(normalizeTitle(title)) || []) {
          const card = h3.closest('div[class*="rounded-2xl"][class*="overflow-hidden"][class*="cursor-pointer"]');
          if (card) return card;
        }
        return null;
      }

      function getOrCreateBadge(card) {
        let badge = card.querySelector('.wm-average-badge');
        if (!badge) {
          badge = document.createElement('div');
          badge.className = 'wm-average-badge';
        }

        const title = card.querySelector('h3');
        const textArea = title?.parentElement;

        if (title && textArea) {
          if (badge.parentElement !== textArea || title.nextElementSibling !== badge) {
            title.insertAdjacentElement('afterend', badge);
          }
        } else if (!badge.parentElement) {
          card.appendChild(badge);
        }

        return badge;
      }

      function renderLoadingBadge(badge) {
        if (
          badge.classList.contains('wm-average-loading') &&
          normalizeTitle(badge.textContent) === 'Prix…'
        ) {
          return;
        }

        badge.className = 'wm-average-badge wm-average-loading';
        badge.title = 'Chargement du prix moyen…';
        badge.replaceChildren();

        const spinner = document.createElement('span');
        spinner.className = 'wm-average-spinner';
        spinner.setAttribute('aria-hidden', 'true');

        const label = document.createElement('span');
        label.textContent = 'Prix…';

        badge.append(spinner, label);
      }

      const dateFormat = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit' });
      const timeFormat = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });

      function renderAskBadge(badge, id) {
        const blocked = runtime.priceLoader.isBlocked();
        const text = blocked ? 'Prix en pause' : 'Voir le prix';
        badge.className = 'wm-average-badge wm-average-ask';
        badge.title = blocked
          ? `Le site a limité les requêtes : réessaie après ${timeFormat.format(runtime.priceLoader.blockedUntil())}`
          : 'Charger le prix moyen de cette carte';
        if (badge.textContent !== text) badge.textContent = text;
        if (!blocked) badge.dataset.wmAskId = id;
      }

      // Un clic sur le badge demande le prix de cette seule carte, sans ouvrir la carte du site.
      window.addEventListener('click', (event) => {
        const badge = event.target instanceof Element ? event.target.closest('[data-wm-ask-id]') : null;
        if (!badge) return;
        event.preventDefault();
        event.stopPropagation();
        const meta = cardMetaById.get(badge.dataset.wmAskId);
        if (meta) runtime.priceLoader.loadCacheForCards([meta], { manual: true });
      }, true);

      function chooseAverage(cacheEntry, cardEl, explicitRarity = null) {
        if (cacheEntry?.ok === false) return null;
        const rarity = explicitRarity || getRarityFromCard(cardEl);
        const averages = cacheEntry?.averages || {};
        const validPrice = (value) => (
          (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
          Number.isFinite(Number(value)) && Number(value) >= 0
        );
        // Une rareté connue doit toujours utiliser sa propre moyenne.
        if (rarity) return validPrice(averages[rarity]) ? Number(averages[rarity]) : null;
        const values = Object.values(averages).filter(validPrice).map(Number);
        return values.length === 1 ? values[0] : null;
      }

      function renderCollectionCard(id, card, { force = false } = {}) {
        if (!force && !runtime.settings.isEnabled('collectionPrices')) {
          card?.querySelector('.wm-average-badge')?.remove();
          return;
        }
        const badge = getOrCreateBadge(card);
        const cacheEntry = cacheMemory.get(id);
        delete badge.dataset.wmAskId;

        if (runtime.priceLoader.isPending(id)) {
          renderLoadingBadge(badge);
          return;
        }

        if (!cacheEntry) {
          renderAskBadge(badge, id);
          return;
        }

        if (cacheEntry.ok === false) {
          if (badge.className !== 'wm-average-badge wm-average-empty') {
            badge.className = 'wm-average-badge wm-average-empty';
          }
          badge.title = 'Erreur temporaire lors du chargement du prix';
          if (badge.textContent !== 'Prix indispo.') badge.textContent = 'Prix indispo.';
          return;
        }

        const stale = !runtime.priceLoader.isFresh(cacheEntry);
        const priceTitle = stale
          ? `Prix moyen de la semaine au ${dateFormat.format(cacheEntry.fetchedAt)} : clic pour l'actualiser`
          : 'Prix moyen de la semaine, comme l’onglet « Marché » du site';
        if (badge.title !== priceTitle) badge.title = priceTitle;
        if (stale) badge.dataset.wmAskId = id;
        const average = chooseAverage(cacheEntry, card, getRarityFromCard(card) || cardMetaById.get(id)?.rarity || null);

        if (average == null) {
          if (badge.className !== 'wm-average-badge wm-average-empty') {
            badge.className = 'wm-average-badge wm-average-empty';
          }
          if (badge.textContent !== 'Moy. —') badge.textContent = 'Moy. —';
        } else {
          if (badge.className !== 'wm-average-badge') {
            badge.className = 'wm-average-badge';
          }
          const text = `Moy. ${formatAverage(average)} W`;
          if (badge.textContent !== text) badge.textContent = text;
        }
      }

      function ensureCollectionPriceObserver() {
        if (collectionPriceObserver) return collectionPriceObserver;

        collectionPriceObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;

            const cardEl = entry.target;
            const id = cardEl.dataset.wmCardId;
            if (!id) {
              collectionPriceObserver.unobserve(cardEl);
              continue;
            }

            const meta = cardMetaById.get(id);
            if (meta) {
              try {
                runtime.priceLoader.loadCacheForCards([meta]);
              } catch (error) {
                reportError('prix visible', error);
              }
            }

            collectionPriceObserver.unobserve(cardEl);
          }
        }, {
          root: null,
          rootMargin: '320px 0px',
          threshold: 0
        });

        return collectionPriceObserver;
      }

      function hydrateCacheForCards(cards) {
        const now = Date.now();
        const stored = storageGet(cards.map((card) => cacheKey(card.id)));

        for (const card of cards) {
          const entry = stored[cacheKey(card.id)];

          if (isCacheEntryValid(entry, now)) {
            cacheMemory.set(card.id, entry);
          } else {
            cacheMemory.delete(card.id);
          }
        }
      }

      function bindCollectionCardElement(id, h3, card) {
        if (!id || !card) return;

        if (card.dataset.wmCardId !== id) {
          card.dataset.wmCardId = id;
          if (cardsById) cardsById.set(id, [...(cardsById.get(id) || []), card]);
        }
        if (h3) h3.dataset.wmCardBound = '1';

        renderCollectionCard(id, card);

        if (!isCacheEntryValid(cacheMemory.get(id))) {
          ensureCollectionPriceObserver().observe(card);
        }
      }

      function renderOne(id) {
        if (!isCollectionPage()) return;

        const direct = (indexCardsById().get(id) || []).filter((card) => card.dataset.wmCardId === id);
        if (direct.length) {
          for (const card of direct) renderCollectionCard(id, card);
          return;
        }

        const meta = cardMetaById.get(id);
        if (!meta?.title) return;

        const card = findCardByTitle(meta.title);
        if (card) {
          const h3 = card.querySelector('h3');
          bindCollectionCardElement(id, h3, card);
        }
      }

      function renderVisibleCollectionCards() {
        if (!runtime.settings.isEnabled('collectionPrices')) {
          document.querySelectorAll('.wm-average-badge').forEach((badge) => badge.remove());
          return;
        }
        if (!isCollectionPage()) return;

        for (const card of document.querySelectorAll('[data-wm-card-id]')) {
          const id = card.dataset.wmCardId;
          if (!id) continue;

          renderCollectionCard(id, card);

          if (
            !isCacheEntryValid(cacheMemory.get(id)) &&
            !runtime.priceLoader.isPending(id)
          ) {
            ensureCollectionPriceObserver().observe(card);
          }
        }

        for (const h3 of document.querySelectorAll('h3:not([data-wm-card-bound])')) {
          const id = idByTitle.get(normalizeTitle(h3.textContent));
          if (!id) continue;

          const card = h3.closest('div[class*="rounded-2xl"][class*="overflow-hidden"][class*="cursor-pointer"]');
          if (card) bindCollectionCardElement(id, h3, card);
        }
      }

      function renderMarketplaceAverage(id) {
        if (!runtime.settings.isEnabled('marketplacePrice')) {
          document.getElementById('wm-marketplace-average')?.remove();
          return;
        }
        if (!isMarketplaceDetailPage() || marketplaceCardId !== id) return;

        const meta = cardMetaById.get(id);
        if (!meta?.title) return;

        const h1 = [...document.querySelectorAll('h1')]
          .find((el) => normalizeTitle(el.textContent) === normalizeTitle(meta.title));
        if (!h1) return;

        const headingRow = h1.parentElement;
        const titleBlock = headingRow?.parentElement;
        if (!titleBlock) return;

        let wrap = document.getElementById('wm-marketplace-average');
        if (!wrap) {
          wrap = document.createElement('div');
          wrap.id = 'wm-marketplace-average';
          wrap.className = 'wm-marketplace-average-wrap';

          const priceCard = document.createElement('div');
          priceCard.className = 'wm-marketplace-average-card';

          const labelWrap = document.createElement('div');
          labelWrap.className = 'wm-marketplace-average-label-wrap';

          const label = document.createElement('span');
          label.className = 'wm-marketplace-average-label';
          label.textContent = 'Prix moyen';

          const rarity = document.createElement('span');
          rarity.className = 'wm-marketplace-average-rarity';
          rarity.dataset.role = 'rarity';

          labelWrap.append(label, rarity);

          const value = document.createElement('span');
          value.className = 'wm-marketplace-average-value';
          value.dataset.role = 'value';

          priceCard.append(labelWrap, value);
          wrap.append(priceCard);
          titleBlock.insertAdjacentElement('afterend', wrap);
        }

        const rarityEl = wrap.querySelector('[data-role="rarity"]');
        if (rarityEl) {
          rarityEl.textContent = meta.rarity ? `Rareté ${meta.rarity}` : '';
        }

        const valueEl = wrap.querySelector('[data-role="value"]');
        if (!valueEl) return;

        const cacheEntry = cacheMemory.get(id);
        delete valueEl.dataset.wmAskId;
        valueEl.removeAttribute('title');

        if (runtime.priceLoader.isPending(id)) {
          valueEl.className = 'wm-marketplace-average-value wm-marketplace-average-loading';
          valueEl.replaceChildren();

          const spinner = document.createElement('span');
          spinner.className = 'wm-average-spinner';
          spinner.setAttribute('aria-hidden', 'true');

          const loadingText = document.createElement('span');
          loadingText.textContent = 'Chargement…';

          valueEl.append(spinner, loadingText);
          return;
        }

        // Prix inconnu : chargé seulement sur un clic, comme dans la collection.
        if (!cacheEntry) {
          const blocked = runtime.priceLoader.isBlocked();
          valueEl.className = 'wm-marketplace-average-value wm-marketplace-average-ask';
          valueEl.textContent = blocked ? 'Prix en pause' : 'Voir le prix';
          valueEl.title = blocked
            ? `Le site a limité les requêtes : réessaie après ${timeFormat.format(runtime.priceLoader.blockedUntil())}`
            : 'Charger le prix moyen de la semaine pour cette carte';
          if (!blocked) valueEl.dataset.wmAskId = id;
          return;
        }

        const average = chooseAverage(cacheEntry, null, meta.rarity || null);
        valueEl.className = 'wm-marketplace-average-value';
        valueEl.textContent = average == null ? '—' : `${formatAverage(average)} W`;
        if (!runtime.priceLoader.isFresh(cacheEntry)) {
          valueEl.dataset.wmAskId = id;
          valueEl.title = `Prix moyen de la semaine au ${dateFormat.format(cacheEntry.fetchedAt)} : clic pour l'actualiser`;
        }
      }

      // Annonces vues dans la liste du Marketplace, par id d'enchère.
      const marketplaceListings = new Map();
      const marketplaceCardIds = new Set();
      const MARKET_RARE_RARITIES = new Set(['L', 'UR', 'SR']);
      const MARKET_MAX_LOADS = 20;
      const AUCTION_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

      function marketplaceDealsVisible() {
        // « Mes enchères » masque la page Marketplace en CSS sur cette même URL, mais le site
        // continue d'en charger la liste en arrière-plan : elle ne doit pas être traitée ici.
        return runtime.settings.isEnabled('marketplaceDeals') && isMarketplacePage() && !isMarketplaceDetailPage() &&
          !runtime.myBids?.isBidsPage();
      }

      // Plusieurs annonces peuvent porter le même titre : l'écart n'est affiché que si l'annonce
      // est identifiée (lien vers l'enchère, rareté affichée unique parmi elles, ou titre unique).
      function renderMarketplaceDeals() {
        if (!marketplaceDealsVisible()) {
          document.querySelectorAll('.wm-market-deal').forEach((badge) => badge.remove());
          return;
        }
        if (!marketplaceListings.size) return;

        const byTitle = new Map();
        for (const listing of marketplaceListings.values()) {
          const key = normalizeTitle(listing.card.title);
          byTitle.set(key, [...(byTitle.get(key) || []), listing]);
        }

        for (const cardEl of document.querySelectorAll('div[class*="glow-"]')) {
          const h3 = cardEl.querySelector('h3');
          const listings = h3 ? byTitle.get(normalizeTitle(h3.textContent)) : null;
          if (!listings) continue;

          const linkedId = cardEl.closest('a[href*="/marketplace/"]')?.getAttribute('href')?.match(AUCTION_ID_PATTERN)?.[0];
          const byRarity = listings.filter((item) => item.card.rarity === getRarityFromCard(cardEl));
          const listing = listings.find((item) => item.id === linkedId) ||
            (byRarity.length === 1 ? byRarity[0] : null) ||
            (listings.length === 1 ? listings[0] : null);
          let badge = cardEl.querySelector('.wm-market-deal');
          if (!listing) {
            badge?.remove();
            continue;
          }
          const { card } = listing;
          const entry = cacheMemory.get(card.id);
          const average = entry ? chooseAverage(entry, null, card.rarity) : null;

          if (!Number.isFinite(average) || average <= 0) {
            badge?.remove();
            continue;
          }

          let text = `Moy. ${formatAverage(Math.round(average))} W`;
          let state = '';
          if (listing?.price > 0) {
            const diff = Math.round((listing.price - average) / average * 100);
            text += ` · ${diff > 0 ? '+' : diff < 0 ? '−' : ''}${Math.abs(diff)} %`;
            state = diff <= -20 ? 'is-deal' : diff >= 20 ? 'is-expensive' : '';
          }

          if (!badge) {
            badge = document.createElement('div');
            h3.insertAdjacentElement('afterend', badge);
          }
          const className = `wm-market-deal ${state}`.trim();
          if (badge.className !== className) badge.className = className;
          if (badge.textContent !== text) badge.textContent = text;
          badge.title = 'Prix moyen des ventes et écart avec le prix actuel de l’annonce';
        }
      }

      window.addEventListener('wm-average-marketplace-list', (event) => {
        // Autrement, une recherche de carte par Familles ou tout autre appel à /api/marketplace
        // déclencherait aussi des requêtes de prix prioritaires, hors de la page Marketplace.
        if (!marketplaceDealsVisible()) return;
        const auctions = Array.isArray(event.detail?.auctions) ? event.detail.auctions : [];
        if (!auctions.length) return;

        for (const auction of auctions) {
          marketplaceListings.set(auction.id, auction);
          marketplaceCardIds.add(auction.card.id);
        }

        const cards = [...new Map(auctions.map(({ card }) => [card.id, preserveOwnedMeta(card)])).values()];

        try {
          registerCards(cards);
          hydrateCacheForCards(cards);
          const missing = cards
            .filter((card) => !cacheMemory.has(card.id) && MARKET_RARE_RARITIES.has(card.rarity))
            .slice(0, MARKET_MAX_LOADS);
          if (missing.length) runtime.priceLoader.loadCacheForCards(missing, { priority: true });
          renderMarketplaceDeals();
        } catch (error) {
          reportError('bonnes affaires', error);
        }
      });

      function renderKnownCard(id) {
        renderOne(id);
        renderMarketplaceAverage(id);
        if (marketplaceCardIds.has(id) && marketplaceDealsVisible()) renderMarketplaceDeals();

        runtime.packs?.onPriceUpdated(id);
        runtime.myBids?.onPriceUpdated(id);
        runtime.trades?.renderTradeDetailCard(id);

        if (id === globalCollectionCardId) {
          renderGlobalCollectionInspectedCard();
        }

        runtime.trades?.renderTradeValuesForCard(id);
      }

      function getGlobalCollectionInspection() {
        if (!isGlobalCollectionPage()) return null;

        for (const closeButton of document.querySelectorAll('button[aria-label="Fermer"]')) {
          const modal = closeButton.closest('.card-frame');
          if (!modal) continue;

          const h3 = modal.querySelector('h3');
          if (!h3) continue;

          const card = h3.closest('div[class*="rounded-2xl"][class*="overflow-hidden"][class*="cursor-pointer"]');
          if (card) {
            return { modal, card, h3 };
          }
        }

        return null;
      }

      function renderGlobalCollectionInspectedCard() {
        if (!runtime.settings.isEnabled('globalCollectionPrice')) return;
        if (!isGlobalCollectionPage() || !globalCollectionCardId) return;

        const inspection = getGlobalCollectionInspection();
        if (!inspection) return;

        const meta = cardMetaById.get(globalCollectionCardId);
        if (!meta?.title) return;

        if (normalizeTitle(inspection.h3.textContent) !== normalizeTitle(meta.title)) {
          return;
        }

        renderCollectionCard(meta.id, inspection.card, { force: true });
      }

      function ensureGlobalCollectionInspectedCard() {
        if (!runtime.settings.isEnabled('globalCollectionPrice')) return;
        if (!isGlobalCollectionPage() || !globalCollectionCardId) return;

        const inspection = getGlobalCollectionInspection();
        if (!inspection) return;

        const title = normalizeTitle(inspection.h3.textContent);
        if (!title) return;

        const existingMeta = cardMetaById.get(globalCollectionCardId);
        if (
          existingMeta?.title &&
          normalizeTitle(existingMeta.title) !== title
        ) {
          return;
        }

        const meta = {
          id: globalCollectionCardId,
          title,
          rarity: getRarityFromCard(inspection.card),
          imageUrl: inspection.card.querySelector('img[alt]')?.src || null,
          count: 1
        };

        registerCards([meta]);
        renderCollectionCard(meta.id, inspection.card, { force: true });

        if (globalCollectionInitializedId === meta.id) return;

        // Important: mark as initialized BEFORE runtime.priceLoader.loadCacheForCards().
        // runtime.priceLoader.loadCacheForCards() calls renderKnownCard(), which can render this card again.
        globalCollectionInitializedId = meta.id;

        try {
          runtime.priceLoader.loadCacheForCards([meta]);
        } catch (error) {
          globalCollectionInitializedId = null;
          reportError('collection globale', error);
        }
      }


      window.addEventListener('wm-average-global-card-inspected', (event) => {
        if (!runtime.settings.isEnabled('globalCollectionPrice')) return;
        const id = event.detail?.id;
        if (!isGlobalCollectionPage() || !id) return;

        if (globalCollectionCardId !== id) {
          globalCollectionInitializedId = null;
        }

        globalCollectionCardId = id;
        ensureGlobalCollectionInspectedCard();
        renderGlobalCollectionInspectedCard();
      });

      window.addEventListener('wm-average-marketplace-detail', (event) => {
        if (!runtime.settings.isEnabled('marketplacePrice')) return;
        const card = event.detail?.card;
        if (!card?.id || !card?.title) return;

        if (!isMarketplaceDetailPage() || event.detail?.auctionId !== location.pathname.split('/')[2]) return;
        marketplaceCardId = card.id;
        marketplaceRequestedPath = location.pathname;
        registerCards([card]);
        renderMarketplaceAverage(card.id);

        try {
          runtime.priceLoader.loadCacheForCards([card], { priority: true });
        } catch (error) {
          reportError('marketplace', error);
        }
      });

      window.addEventListener('wm-average-collection', (event) => {
        const cards = event.detail?.cards;
        if (!Array.isArray(cards) || !cards.length) return;

        try {
          registerCards(cards);
          hydrateCacheForCards(cards);
          renderVisibleCollectionCards();
        } catch (error) {
          reportError('cache', error);
        }
      });


      function renderMarketplaceCurrent() {
        if (!runtime.settings.isEnabled('marketplacePrice')) {
          document.getElementById('wm-marketplace-average')?.remove();
          return;
        }

        if (!isMarketplaceDetailPage()) return;

        if (marketplaceRequestedPath !== location.pathname) {
          marketplaceRequestedPath = location.pathname;
          marketplaceCardId = null;
          document.getElementById('wm-marketplace-average')?.remove();
        }
        // L'annonce arrive par la requête du site, lue au passage : l'extension n'en envoie pas.
        if (marketplaceCardId) renderMarketplaceAverage(marketplaceCardId);
      }

      return {
        getRarityFromCard, formatAverage, chooseAverage, renderCollectionCard,
        hydrateCacheForCards, renderVisibleCollectionCards, renderMarketplaceAverage,
        renderMarketplaceCurrent, renderMarketplaceDeals, renderKnownCard, renderGlobalCollectionInspectedCard,
        ensureGlobalCollectionInspectedCard
      };
    }
  };
})();
