(() => {
  const registry = window.__wmAverageFeatures ||= {};

  registry.priceLoader = {
    create(runtime) {
      const {
        MAX_CONCURRENT, ERROR_CACHE_TTL, LONG_CACHE_TTL, PRICE_PACE_KEY, PRICE_BLOCK_KEY,
        cardMetaById, idByTitle, cacheMemory,
        normalizeTitle, cacheKey, readLocalValue, writeLocalValue, storageGet, storageSet,
        isCacheEntryValid, registerCards, reportError
      } = runtime.core;

      // Le site accepte une série de requêtes puis bloque (403/429) un moment. Plutôt qu'attendre à
      // l'aveugle, on sonde avec une seule requête, puis on règle l'espacement juste sous sa limite.
      const PACE_KEY = PRICE_PACE_KEY;
      const BLOCK_KEY = PRICE_BLOCK_KEY;
      const PACE_TTL = 6 * 60 * 60 * 1000;
      // Attente avant chaque sonde successive (Fibonacci), en secondes : on détecte vite la réouverture.
      const PROBE_STEPS_S = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 300];
      const MAX_COOLDOWN_MS = 5 * 60 * 1000;
      // Mesuré le 09/11/2026 : ~2 s par carte passe sans blocage pendant des minutes, ~1,4 s est bloqué.
      const MIN_GAP_MS = 1800;
      const MAX_GAP_MS = 15000;
      const PACE_MARGIN = 1.15;
      const MIN_BURST_TO_LEARN = 5;
      const SPEEDUP_EVERY = 15;
      const SHORT_BURST_GAP_MS = 2000;
      const PACE_VERSION = 4;
      const BURST_IDLE_MS = 60000;
      const MAX_RATE_LIMIT_RETRIES = 3;
      const COMMON_RARITIES = new Set(['C', 'PC']);
      const CHEAP_PRICE = 5;

      const queued = [];
      const queuedIds = new Set();
      const inFlightIds = new Set();
      const pendingByRequestId = new Map();
      const bulkPendingIds = new Set();
      const rateLimitRetries = new Map();
      let activeRequests = 0;
      let bulkBatchActive = false;
      let bulkTotal = 0;

      let cooldownUntil = 0;
      let pumpTimer = null;
      let pumpAt = 0;
      let lastStartAt = 0;
      let probing = false;
      let probeFails = 0;
      // Série de requêtes réussies en cours, et celle qui a précédé le dernier blocage.
      let burstOk = 0;
      let burstStartAt = 0;
      let lastOkAt = 0;
      let episodeBurst = 0;
      let episodeStart = 0;
      let calmStreak = 0;

      const savedPace = readLocalValue(PACE_KEY);
      let paceGapMs = savedPace?.v === PACE_VERSION && Date.now() - Number(savedPace.savedAt) < PACE_TTL
        ? Number(savedPace.gapMs) || 0
        : 0;

      function savePace() {
        writeLocalValue(PACE_KEY, { gapMs: paceGapMs, savedAt: Date.now(), v: PACE_VERSION });
      }

      // Autre onglet bloqué : inutile d'insister depuis celui-ci.
      function sharedBlockedUntil() {
        return Number(readLocalValue(BLOCK_KEY)) || 0;
      }

      function estimateRemainingMs() {
        if (!paceGapMs) return 0;
        return bulkPendingIds.size * paceGapMs + Math.max(0, cooldownUntil - Date.now());
      }

      function notifyBulkProgress() {
        runtime.collectionBulk?.updateBulkProgress(
          bulkTotal, bulkPendingIds.size, Date.now() < cooldownUntil, estimateRemainingMs()
        );
      }

      // priority : quelques cartes affichées à l'instant (enchères, annonces) passent devant un
      // chargement complet qui peut durer des heures.
      function loadCacheForCards(cards, { forceRarities = null, markBulk = false, priority = false } = {}) {
        registerCards(cards);
        cards = [...new Map(cards.filter((card) => card?.id && card?.title).map((card) => [card.id, card])).values()];

        for (const card of cards) {
          const forceCard = Boolean(forceRarities?.has(card.rarity));
          if (forceCard) cacheMemory.delete(card.id);
          runtime.priceUi.renderKnownCard(card.id);
        }

        const keys = cards.map(({ id }) => cacheKey(id));
        const stored = storageGet(keys);
        const now = Date.now();
        const toQueue = [];

        if (markBulk) {
          bulkBatchActive = true;
          bulkPendingIds.clear();
          bulkTotal = cards.length;
        }

        for (const card of cards) {
          const { id } = card;
          const forceCard = Boolean(forceRarities?.has(card.rarity));
          const entry = stored[cacheKey(id)];
          const valid = !forceCard && isCacheEntryValid(entry, now);

          if (valid) {
            cacheMemory.set(id, entry);
            runtime.priceUi.renderKnownCard(id);
          } else {
            cacheMemory.delete(id);
            if (markBulk) bulkPendingIds.add(id);
            toQueue.push(id);
          }
        }

        // En tête de file, une par une : à l'envers pour garder l'ordre demandé.
        for (const id of priority ? toQueue.reverse() : toQueue) enqueue(id, priority);

        if (markBulk) notifyBulkProgress();
        pumpQueue();

        if (markBulk && bulkBatchActive && bulkPendingIds.size === 0) {
          bulkBatchActive = false;
          runtime.collectionBulk.finishBulkLoad();
        }
      }

      function enqueue(id, front = false) {
        const memoryEntry = cacheMemory.get(id);

        if (memoryEntry && isCacheEntryValid(memoryEntry)) return;
        if (memoryEntry) cacheMemory.delete(id);

        if (inFlightIds.has(id)) return;
        if (queuedIds.has(id)) {
          if (!front) return;
          queued.splice(queued.indexOf(id), 1);
        }
        if (front) queued.unshift(id);
        else queued.push(id);
        queuedIds.add(id);
      }

      // Minuteur du pont (Worker) : celui de la page est ralenti par Chrome quand l'onglet est masqué.
      const bridgeTimer = () => window.__wmBridgeFeatures?.timer;
      const setPumpTimer = (fn, ms) => bridgeTimer() ? bridgeTimer().set(fn, ms) : setTimeout(fn, ms);
      const clearPumpTimer = (id) => bridgeTimer() ? bridgeTimer().clear(id) : clearTimeout(id);

      function schedulePump(ms) {
        const at = Date.now() + ms;
        if (pumpTimer && at >= pumpAt) return;

        clearPumpTimer(pumpTimer);
        pumpAt = at;
        pumpTimer = setPumpTimer(() => {
          pumpTimer = null;
          pumpQueue();
        }, ms);
      }

      function pumpQueue() {
        const now = Date.now();
        const shared = sharedBlockedUntil();
        const blockedUntil = Math.max(cooldownUntil, shared);

        if (now < blockedUntil) {
          if (shared > now) probing = true;
          schedulePump(blockedUntil - now);
          return;
        }

        if (paceGapMs > 0 && now < lastStartAt + paceGapMs) {
          schedulePump(lastStartAt + paceGapMs - now);
          return;
        }

        // Après un blocage, une seule requête de sonde tant qu'aucune ne passe.
        const limit = probing ? 1 : MAX_CONCURRENT;

        while (activeRequests < limit && queued.length > 0) {
          const id = queued.shift();
          queuedIds.delete(id);

          const memoryEntry = cacheMemory.get(id);
          if (memoryEntry && isCacheEntryValid(memoryEntry)) continue;
          if (memoryEntry) cacheMemory.delete(id);

          if (inFlightIds.has(id)) continue;
          requestAverage(id);
          lastStartAt = Date.now();

          if (paceGapMs > 0) {
            if (queued.length > 0) schedulePump(paceGapMs);
            break;
          }
        }
      }

      function requestAverage(id) {
        activeRequests += 1;
        inFlightIds.add(id);

        const requestId = `${id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        const timer = setTimeout(() => finishRequest({
          requestId, id, ok: false, error: 'Délai de chargement des prix dépassé'
        }), 80000);
        pendingByRequestId.set(requestId, { id, timer, probe: probing });

        window.dispatchEvent(new CustomEvent('wm-average-request', {
          detail: { id, requestId }
        }));
      }

      // Premier succès après un blocage : on en déduit combien de requêtes le site tolère par durée.
      function learnPace() {
        if (episodeBurst >= MIN_BURST_TO_LEARN) {
          const windowMs = Date.now() - episodeStart;
          const learned = Math.min(
            MAX_GAP_MS,
            Math.max(MIN_GAP_MS, Math.round(PACE_MARGIN * windowMs / episodeBurst))
          );
          // Bloqué malgré l'espacement actuel : on ne l'accélère jamais.
          paceGapMs = paceGapMs > 0 ? Math.max(learned, Math.round(paceGapMs * 1.1)) : learned;
        } else if (!paceGapMs) {
          // Série trop courte pour en déduire une limite : on ne ralentit pas davantage.
          paceGapMs = SHORT_BURST_GAP_MS;
        }

        savePace();
        episodeBurst = 0;
        episodeStart = 0;
      }

      function handleRateLimit(detail, probe) {
        const now = Date.now();

        if (!probing) {
          // Nouveau blocage : on retient la série réussie qui l'a précédé.
          episodeBurst = burstOk;
          episodeStart = burstStartAt || now;
          probing = true;
          probeFails = 0;
        } else if (probe) {
          probeFails += 1;
        }

        burstOk = 0;
        burstStartAt = 0;
        calmStreak = 0;

        const hint = Number(detail.retryAfterHintMs) || 0;
        const wait = hint > 0
          ? Math.min(MAX_COOLDOWN_MS, hint)
          : PROBE_STEPS_S[Math.min(probeFails, PROBE_STEPS_S.length - 1)] * 1000;

        cooldownUntil = Math.max(cooldownUntil, now + wait);
        writeLocalValue(BLOCK_KEY, cooldownUntil);
      }

      function finishRequest(detail) {
        const pending = pendingByRequestId.get(detail.requestId);
        // Une réponse tardive ou inconnue ne doit pas libérer un autre emplacement.
        if (!pending) return;
        const { id, timer, probe } = pending;
        clearTimeout(timer);

        pendingByRequestId.delete(detail.requestId);
        inFlightIds.delete(id);
        activeRequests = Math.max(0, activeRequests - 1);

        if (detail.rateLimited) {
          handleRateLimit(detail, probe);

          // La carte n'est pas en cause : on la retente après la pause plutôt que de la perdre.
          // Un échec de sonde ne compte pas contre la carte.
          const tries = (rateLimitRetries.get(id) || 0) + (probe ? 0 : 1);
          if (tries <= MAX_RATE_LIMIT_RETRIES) {
            rateLimitRetries.set(id, tries);
            enqueue(id);
            notifyBulkProgress();
            pumpQueue();
            return;
          }
        }

        rateLimitRetries.delete(id);

        if (detail.ok) {
          if (probing) {
            learnPace();
            probing = false;
            probeFails = 0;
            burstOk = 0;
            burstStartAt = 0;
          }

          // Un long silence entre deux prix n'est pas de la capacité du site : la série repart de zéro.
          const okAt = Date.now();
          if (!burstOk || okAt - lastOkAt > BURST_IDLE_MS) {
            burstOk = 0;
            burstStartAt = okAt;
          }
          burstOk += 1;
          lastOkAt = okAt;

          // Tout passe : on resserre doucement l'espacement pour retrouver la limite.
          if (paceGapMs > 0 && (calmStreak += 1) >= SPEEDUP_EVERY) {
            calmStreak = 0;
            paceGapMs = Math.max(MIN_GAP_MS, Math.round(paceGapMs * 0.9));
            savePace();
          }
        }

        const entry = {
          fetchedAt: Date.now(),
          averages: detail.ok ? (detail.averages || {}) : {},
          ok: Boolean(detail.ok)
        };
        // Inutile sur un succès : ~20 caractères de moins par prix, sur des milliers d'entrées.
        if (!detail.ok) entry.retryAfterMs = Number(detail.retryAfterMs) || ERROR_CACHE_TTL;

        // Une carte à quelques W ne mérite pas une requête par jour, quelle que soit sa rareté.
        const rarity = cardMetaById.get(id)?.rarity;
        const rawAverage = rarity ? entry.averages[rarity] : null;
        const average = rawAverage == null || rawAverage === '' ? Number.NaN : Number(rawAverage);
        if (detail.ok && (COMMON_RARITIES.has(rarity) || (average > 0 && average < CHEAP_PRICE))) {
          entry.ttlMs = LONG_CACHE_TTL;
        }

        if (detail.title) {
          const oldMeta = cardMetaById.get(id) || { id };
          const updatedMeta = { ...oldMeta, title: detail.title };
          cardMetaById.set(id, updatedMeta);
          idByTitle.set(normalizeTitle(detail.title), id);
        }

        cacheMemory.set(id, entry);
        storageSet({ [cacheKey(id)]: entry });
        try {
          runtime.priceUi.renderKnownCard(id);
        } catch (error) {
          reportError('rendu prix', error);
        }

        if (bulkPendingIds.delete(id)) {
          notifyBulkProgress();
          if (bulkBatchActive && bulkPendingIds.size === 0) {
            bulkBatchActive = false;
            runtime.collectionBulk.finishBulkLoad();
          }
        }

        if (!detail.ok) {
          console.debug('[WM Average] échec temporaire mis en cache 60 s', id, detail.error);
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
        return queuedIds.has(id) || inFlightIds.has(id);
      }

      return { loadCacheForCards, isPending };
    }
  };
})();
