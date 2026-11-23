(() => {
  const registry = window.__wmAverageFeatures ||= {};

  registry.priceLoader = {
    create(runtime) {
      const {
        CACHE_TTL, ERROR_CACHE_TTL, LONG_CACHE_TTL, PRICE_BLOCK_KEY,
        cardMetaById, idByTitle, cacheMemory,
        normalizeTitle, cacheKey, readLocalValue, writeLocalValue, storageGet, storageSet,
        isCacheEntryValid, registerCards, reportError
      } = runtime.core;

      // Le règlement du site interdit l'automatisation : un prix n'est demandé que sur un clic,
      // une requête à la fois, au rythme d'un humain. Les prix déjà connus restent affichés.
      const MANUAL_GAP_MS = 4000;
      // Sans Retry-After, on laisse le site tranquille un bon moment après un blocage.
      const DEFAULT_BLOCK_MS = 10 * 60 * 1000;
      const MAX_BLOCK_MS = 60 * 60 * 1000;
      const COMMON_RARITIES = new Set(['C', 'PC']);
      const CHEAP_PRICE = 5;

      const queued = [];
      const queuedIds = new Set();
      const pendingByRequestId = new Map();
      let inFlightId = null;
      let lastStartAt = 0;
      let pumpTimer = null;

      function blockedUntil() {
        return Number(readLocalValue(PRICE_BLOCK_KEY)) || 0;
      }

      function isBlocked() {
        return Date.now() < blockedUntil();
      }

      // Seul un clic (manual) envoie une requête ; le reste se contente du cache.
      function loadCacheForCards(cards, { manual = false } = {}) {
        registerCards(cards);
        cards = [...new Map(cards.filter((card) => card?.id && card?.title).map((card) => [card.id, card])).values()];

        const stored = storageGet(cards.map(({ id }) => cacheKey(id)));
        const now = Date.now();

        for (const { id } of cards) {
          const entry = stored[cacheKey(id)] ?? cacheMemory.get(id);
          if (isCacheEntryValid(entry, now)) cacheMemory.set(id, entry);
          if (manual && !isFresh(entry, now)) enqueue(id);
          runtime.priceUi.renderKnownCard(id);
        }

        pumpQueue();
      }

      // Un prix connu s'affiche toujours ; un clic ne le redemande que s'il a plus d'un jour.
      function isFresh(entry, now = Date.now()) {
        if (!isCacheEntryValid(entry, now)) return false;
        if (entry.ok === false) return true;
        // Un prix chargé avant le comptage des ventes peut être actualisé d'un clic.
        if (!entry.sales) return false;
        const ttl = Number(entry.ttlMs) > 0 ? Math.min(Number(entry.ttlMs), LONG_CACHE_TTL) : CACHE_TTL;
        return now - entry.fetchedAt < ttl;
      }

      function enqueue(id) {
        if (inFlightId === id || queuedIds.has(id)) return;
        queued.push(id);
        queuedIds.add(id);
      }

      function pumpQueue() {
        if (inFlightId || !queued.length) return;

        if (isBlocked()) {
          dropQueue();
          return;
        }

        const wait = lastStartAt + MANUAL_GAP_MS - Date.now();
        if (wait > 0) {
          if (!pumpTimer) pumpTimer = setTimeout(() => { pumpTimer = null; pumpQueue(); }, wait);
          return;
        }

        const id = queued.shift();
        queuedIds.delete(id);
        requestAverage(id);
      }

      // Bloqué : on abandonne les clics en attente au lieu de les rejouer plus tard.
      function dropQueue() {
        const ids = queued.splice(0);
        queuedIds.clear();
        for (const id of ids) runtime.priceUi.renderKnownCard(id);
      }

      function requestAverage(id) {
        inFlightId = id;
        lastStartAt = Date.now();

        const requestId = `${id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        const timer = setTimeout(() => finishRequest({
          requestId, id, ok: false, error: 'Délai de chargement des prix dépassé'
        }), 80000);
        pendingByRequestId.set(requestId, { id, timer });
        runtime.priceUi.renderKnownCard(id);

        window.dispatchEvent(new CustomEvent('wm-average-request', {
          detail: { id, requestId }
        }));
      }

      function finishRequest(detail) {
        const pending = pendingByRequestId.get(detail.requestId);
        // Une réponse tardive ou inconnue ne doit pas libérer un autre emplacement.
        if (!pending) return;
        const { id, timer } = pending;
        clearTimeout(timer);
        pendingByRequestId.delete(detail.requestId);
        inFlightId = null;

        if (detail.rateLimited) {
          const hint = Number(detail.retryAfterHintMs) || 0;
          writeLocalValue(PRICE_BLOCK_KEY, Date.now() + Math.min(MAX_BLOCK_MS, Math.max(hint, DEFAULT_BLOCK_MS)));
          dropQueue();
          runtime.priceUi.renderKnownCard(id);
          return;
        }

        const entry = {
          fetchedAt: Date.now(),
          averages: detail.ok ? (detail.averages || {}) : {},
          ok: Boolean(detail.ok)
        };
        if (detail.ok) entry.sales = detail.sales || {};
        else entry.retryAfterMs = Number(detail.retryAfterMs) || ERROR_CACHE_TTL;

        // Une carte à quelques W ne mérite pas d'être redemandée chaque jour, quelle que soit sa rareté.
        const rarity = cardMetaById.get(id)?.rarity;
        const rawAverage = rarity ? entry.averages[rarity] : null;
        const average = rawAverage == null || rawAverage === '' ? Number.NaN : Number(rawAverage);
        if (detail.ok && (COMMON_RARITIES.has(rarity) || (average > 0 && average < CHEAP_PRICE))) {
          entry.ttlMs = LONG_CACHE_TTL;
        }

        if (detail.title) {
          cardMetaById.set(id, { ...(cardMetaById.get(id) || { id }), title: detail.title });
          idByTitle.set(normalizeTitle(detail.title), id);
        }

        // Un échec ne remplace pas un ancien prix valable.
        const previous = cacheMemory.get(id);
        if (detail.ok || !previous?.ok) {
          cacheMemory.set(id, entry);
          storageSet({ [cacheKey(id)]: entry });
        }

        try {
          runtime.priceUi.renderKnownCard(id);
        } catch (error) {
          reportError('rendu prix', error);
        }

        pumpQueue();
      }

      window.addEventListener('wm-average-response', (event) => {
        try {
          finishRequest(event.detail || {});
        } catch (error) {
          reportError('réponse', error);
        }
      });

      function isPending(id) {
        return queuedIds.has(id) || inFlightId === id;
      }

      return { loadCacheForCards, isPending, isFresh, isBlocked, blockedUntil };
    }
  };
})();
