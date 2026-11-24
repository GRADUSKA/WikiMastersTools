(() => {
  const registry = window.__wmAverageFeatures ||= {};

  registry.core = {
    create() {
      const CACHE_TTL = 24 * 60 * 60 * 1000;
      // Le prix moyen des communes (C, PC) bouge peu : inutile de le redemander chaque jour.
      const LONG_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
      const ERROR_CACHE_TTL = 60 * 1000;
      const CACHE_CLEANUP_INTERVAL = 24 * 60 * 60 * 1000;
      const CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
      const CACHE_CLEANUP_KEY = 'wm_avg_cache_cleanup_v1';
      const CACHE_PREFIX = 'wm_avg_v4_';
      const PRICE_PACE_KEY = 'wm_price_pace_v1';
      const PRICE_BLOCK_KEY = 'wm_price_block_until_v1';
      const MAX_CONCURRENT = 3;
      const BULK_RARITY_LAST_LOAD_KEY = 'wm_bulk_rarity_last_load_v1';
      const ALL_COLLECTION_KEY = 'wm_all_collection_v1';
      const PULL_RECAP_ENABLED_KEY = 'wm_pull_recap_enabled_v1';
      const PULL_STATS_KEY = 'wm_pull_stats_v1';
      const AUTO_OPEN_ENABLED_KEY = 'wm_auto_open_enabled_v1';
      const AUTO_OPEN_NEXT_AT_KEY = 'wm_auto_open_next_at_v1';
      const AUTO_OPEN_SESSION_KEY = 'wm_auto_open_session_v1';
      const AUTO_OPEN_MIN_MINUTES_KEY = 'wm_auto_open_min_minutes_v1';
      const AUTO_OPEN_MAX_MINUTES_KEY = 'wm_auto_open_max_minutes_v1';
      const AUTO_OPEN_DEFAULT_MIN_MINUTES = 20;
      const AUTO_OPEN_DEFAULT_MAX_MINUTES = 100;
      const COMPACT_MODE_KEY = 'wm_compact_mode_v1';
      const MISSING_IMAGE_CACHE_PREFIX = 'wm_missing_img_v2_';
      const MISSING_IMAGE_FOUND_TTL = 30 * 24 * 60 * 60 * 1000;
      const MISSING_IMAGE_MISS_TTL = 7 * 24 * 60 * 60 * 1000;
      const RARITIES = ['L', 'UR', 'SR', 'R', 'PC', 'C'];
      const DEFAULT_RARE_RARITIES = ['L', 'UR', 'SR', 'R'];

      const cardMetaById = new Map();
      const idByTitle = new Map();
      const cacheMemory = new Map();

      function isCollectionPage() {
        return location.pathname === '/collection' || location.pathname.startsWith('/collection/');
      }

      function isMarketplaceDetailPage() {
        return /^\/marketplace\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i.test(location.pathname);
      }

      function isMarketplacePage() {
        return location.pathname === '/marketplace' || location.pathname.startsWith('/marketplace/');
      }

      function isPullsPage() {
        return location.pathname === '/pulls' || location.pathname.startsWith('/pulls/');
      }

      function isTradesPage() {
        return location.pathname === '/trades' || location.pathname.startsWith('/trades/');
      }

      function isGlobalCollectionPage() {
        return location.pathname === '/global-collection' || location.pathname.startsWith('/global-collection/');
      }

      function isGuildPage() {
        return location.pathname === '/guild' || location.pathname.startsWith('/guild/');
      }

      function isLastPullCardVisible() {
        if (!isPullsPage()) return false;

        for (const el of document.querySelectorAll('main div')) {
          const text = String(el.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();

          const match = text.match(/^Carte\s*(\d+)\s*\/\s*(\d+)$/i);
          if (!match) continue;

          const current = Number(match[1]);
          const total = Number(match[2]);
          return total > 0 && current === total;
        }

        return false;
      }

      function normalizeTitle(value) {
        return String(value || '')
          .normalize('NFC')
          .replace(/\s+/g, ' ')
          .trim();
      }

      function cacheKey(id) {
        return CACHE_PREFIX + id;
      }

      function readLocalValue(key) {
        try {
          const raw = localStorage.getItem(key);
          return raw == null ? undefined : JSON.parse(raw);
        } catch (_) {
          return undefined;
        }
      }

      function isMissingImageEntryExpired(entry, now = Date.now()) {
        const fetchedAt = Number(entry?.fetchedAt);
        if (!fetchedAt) return true;
        return now - fetchedAt >= (entry.found ? MISSING_IMAGE_FOUND_TTL : MISSING_IMAGE_MISS_TTL);
      }

      // Quota plein : retire ce qui ne sert plus (échecs de prix, images manquantes expirées).
      // Le scan lit toutes les clés : au plus un passage par 30 s, même si chaque écriture échoue.
      let nextStorageCleanupAt = 0;

      function freeStorageSpace() {
        const now = Date.now();
        if (now < nextStorageCleanupAt) return false;
        nextStorageCleanupAt = now + 30000;

        const doomed = [];

        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (!key) continue;

          if (key.startsWith(CACHE_PREFIX)) {
            const entry = readLocalValue(key);
            if (!entry || entry.ok === false || !Number.isFinite(entry.fetchedAt)) doomed.push(key);
          } else if (key.startsWith(MISSING_IMAGE_CACHE_PREFIX)) {
            if (isMissingImageEntryExpired(readLocalValue(key), now)) doomed.push(key);
          }
        }

        doomed.forEach((key) => localStorage.removeItem(key));
        return doomed.length > 0;
      }

      function writeLocalValue(key, value) {
        try {
          const json = JSON.stringify(value);

          try {
            localStorage.setItem(key, json);
          } catch (error) {
            if (!freeStorageSpace()) throw error;
            localStorage.setItem(key, json);
          }

          return true;
        } catch (error) {
          console.warn('[WM Average] localStorage indisponible', error);
          return false;
        }
      }

      // wikipediaUrl pèse ~90 caractères par carte et n'est jamais relue depuis ce cache.
      function toStoredCard({ wikipediaUrl, ...card }) {
        return card;
      }

      // Ancien format compact de localStorage (v4.32.0) : valeurs par défaut omises, début d'adresse
      // d'image mis en commun. Seulement relu, pour la migration vers IndexedDB.
      function expandCard({ img, ...card }, imagePrefix) {
        const ownedCardIds = Array.isArray(card.ownedCardIds) ? card.ownedCardIds : [];
        return {
          ...card,
          ownedCardId: 'ownedCardId' in card ? card.ownedCardId : (ownedCardIds[0] ?? null),
          ownedCardIds,
          imageUrl: typeof img === 'string' ? imagePrefix + img : (card.imageUrl ?? null),
          starred: card.starred === true,
          tags: Array.isArray(card.tags) ? card.tags : [],
          count: card.count ?? 1
        };
      }

      function expandCollection(entry) {
        if (entry?.v !== 2 || !Array.isArray(entry.cards)) return entry;
        const { v, imagePrefix = '', cards, ...meta } = entry;
        return { ...meta, cards: cards.map((card) => expandCard(card, imagePrefix)) };
      }

      // La collection (~5 Mo pour 10 000 cartes) saturait les ~10 Mo de localStorage partagés avec les
      // prix : elle vit dans IndexedDB, avec une copie en mémoire pour que storageGet reste synchrone.
      let collectionMemory;
      let collectionDb;
      const collectionChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(ALL_COLLECTION_KEY) : null;
      let collectionWrites = 0;
      // Les autres onglets relisent IndexedDB : envoyer les ~5 Mo dans le message en faisait une copie de plus.
      // Une écriture locale faite pendant cette relecture est plus récente : elle n'est pas écrasée.
      if (collectionChannel) collectionChannel.onmessage = () => {
        const writes = collectionWrites;
        collectionStore('readonly', (store) => store.get(ALL_COLLECTION_KEY))
          .then((entry) => { if (writes === collectionWrites) collectionMemory = entry; })
          .catch((error) => console.debug('[WM Average] collection d’un autre onglet illisible', error));
      };

      function collectionStore(mode, run) {
        collectionDb ||= new Promise((resolve, reject) => {
          const open = indexedDB.open('wm_tools', 1);
          open.onupgradeneeded = () => open.result.createObjectStore('kv');
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        return collectionDb.then((db) => new Promise((resolve, reject) => {
          const tx = db.transaction('kv', mode);
          const request = run(tx.objectStore('kv'));
          tx.oncomplete = () => resolve(request.result);
          tx.onerror = tx.onabort = () => reject(tx.error);
        }));
      }

      function saveCollection(entry) {
        collectionMemory = entry;
        collectionWrites += 1;
        const write = entry === undefined
          ? (store) => store.delete(ALL_COLLECTION_KEY)
          : (store) => store.put(entry, ALL_COLLECTION_KEY);
        return collectionStore('readwrite', write).then(() => collectionChannel?.postMessage('changed'));
      }

      // Une écriture faite pendant la lecture initiale est plus récente : elle n'est pas écrasée.
      const collectionReady = (async () => {
        const legacy = readLocalValue(ALL_COLLECTION_KEY);
        try {
          if (legacy === undefined) {
            const stored = await collectionStore('readonly', (store) => store.get(ALL_COLLECTION_KEY));
            collectionMemory ??= stored;
          } else {
            collectionMemory ??= expandCollection(legacy);
            await collectionStore('readwrite', (store) => store.put(collectionMemory, ALL_COLLECTION_KEY));
            localStorage.removeItem(ALL_COLLECTION_KEY);
          }
        } catch (error) {
          console.warn('[WM Average] IndexedDB indisponible, collection gardée en mémoire', error);
        }
      })();

      function storageGet(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        const result = {};

        for (const key of list) {
          // Copie : les appelants modifient l'objet lu avant de le réenregistrer.
          const value = key === ALL_COLLECTION_KEY ? structuredClone(collectionMemory) : readLocalValue(key);
          if (value !== undefined) result[key] = value;
        }

        return result;
      }

      // Sans copie (~40 ms pour 10 000 cartes) : uniquement pour les lecteurs qui ne modifient rien.
      function readCollection() {
        return collectionMemory;
      }

      // L'objet enregistré devient la copie en mémoire : l'appelant ne doit plus le modifier.
      function storageSet(values) {
        for (const [key, value] of Object.entries(values || {})) {
          if (key !== ALL_COLLECTION_KEY) {
            writeLocalValue(key, value);
            continue;
          }
          saveCollection(value)
            .catch((error) => console.warn('[WM Average] collection non enregistrée', error));
        }
      }

      // Un prix obtenu reste affiché quel que soit son âge : il n'est plus redemandé automatiquement.
      function isCacheEntryValid(entry, now = Date.now()) {
        if (!entry || typeof entry.ok !== 'boolean' || !Number.isFinite(entry.fetchedAt)) return false;
        if (!entry.averages || typeof entry.averages !== 'object' || Array.isArray(entry.averages)) return false;
        const age = now - entry.fetchedAt;
        if (age < 0) return false;
        if (entry.ok) return true;
        return age < Math.min(5 * 60 * 1000, Math.max(ERROR_CACHE_TTL, Number(entry.retryAfterMs) || 0));
      }

      function cleanupPriceCacheOnceDaily() {
        const lastCleanup = Number(readLocalValue(CACHE_CLEANUP_KEY)) || 0;
        const now = Date.now();
        if (now - lastCleanup < CACHE_CLEANUP_INTERVAL) return;

        try {
          const keysToRemove = [];

          for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (!key) continue;

            if (/^wm_avg_v[123]_/.test(key)) {
              keysToRemove.push(key);
              continue;
            }

            if (key.startsWith(MISSING_IMAGE_CACHE_PREFIX)) {
              if (isMissingImageEntryExpired(readLocalValue(key), now)) keysToRemove.push(key);
              continue;
            }

            if (!key.startsWith(CACHE_PREFIX)) continue;

            const entry = readLocalValue(key);
            const fetchedAt = Number(entry?.fetchedAt) || 0;

            if (!fetchedAt || (entry?.ok !== true && now - fetchedAt > CACHE_MAX_AGE)) {
              keysToRemove.push(key);
            }
          }

          keysToRemove.forEach((key) => localStorage.removeItem(key));
          writeLocalValue(CACHE_CLEANUP_KEY, now);
        } catch (error) {
          console.debug('[WM Average] nettoyage cache ignoré', error);
        }
      }

      // Efface uniquement ce qui peut être recalculé : jamais les réglages, les familles ni les statistiques.
      function clearCaches() {
        const exactKeys = new Set([
          ALL_COLLECTION_KEY, BULK_RARITY_LAST_LOAD_KEY, CACHE_CLEANUP_KEY, PRICE_PACE_KEY, PRICE_BLOCK_KEY
        ]);
        const doomed = [];
        let characters = 0;

        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (!key) continue;

          if (
            exactKeys.has(key) ||
            key.startsWith(CACHE_PREFIX) ||
            key.startsWith(MISSING_IMAGE_CACHE_PREFIX) ||
            /^wm_avg_v[123]_/.test(key)
          ) {
            doomed.push(key);
            characters += key.length + (localStorage.getItem(key) || '').length;
          }
        }

        doomed.forEach((key) => localStorage.removeItem(key));
        cacheMemory.clear();
        saveCollection(undefined).catch((error) => console.warn('[WM Average] collection non effacée', error));

        // localStorage compte 2 octets par caractère.
        return { removed: doomed.length, kilobytes: Math.round(characters * 2 / 1024) };
      }

      function isContextInvalidatedError(error) {
        return String(error?.message || error).includes('Extension context invalidated');
      }

      function reportError(scope, error) {
        if (isContextInvalidatedError(error)) return;
        console.error(`[WM Average] ${scope}`, error);
      }

      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      async function waitFor(find, timeoutMs) {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
          const found = find();
          if (found) return found;
          await wait(200);
        }
        return null;
      }

      const siteSearchInput = () => [...document.querySelectorAll('input')]
        .find((input) => /Rechercher/.test(input.placeholder || '') && !input.closest('.wm-modal-overlay'));

      // Le champ est contrôlé par React : il faut passer par le setter natif pour qu'il voie la saisie.
      function setSiteSearch(input, value) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // Étiquettes { id, name, color } fusionnées sans doublon (par id, ou par nom à défaut).
      function mergeTags(...lists) {
        const byKey = new Map();

        for (const list of lists) {
          if (!Array.isArray(list)) continue;

          for (const raw of list) {
            const tag = typeof raw === 'string' ? { name: raw } : raw;
            const name = String(tag?.name || '').trim();
            if (!name) continue;

            const id = tag.id ? String(tag.id) : null;
            const merged = { id, name, color: tag.color || null };
            if (Number.isFinite(tag.cardCount)) merged.cardCount = tag.cardCount;
            byKey.set(id || name, merged);
          }
        }

        return [...byKey.values()];
      }

      function registerCards(cards) {
        const seenIds = new Set();

        for (const meta of cards) {
          if (!meta?.id || !meta?.title) continue;

          // Plusieurs exemplaires d'une même carte dans un lot : on cumule nombre, favori et étiquettes.
          const sameBatch = seenIds.has(meta.id) ? cardMetaById.get(meta.id) : null;
          seenIds.add(meta.id);

          const normalized = {
            ...cardMetaById.get(meta.id),
            id: meta.id,
            title: meta.title,
            rarity: meta.rarity || null,
            imageUrl: meta.imageUrl || null,
            wikipediaUrl: meta.wikipediaUrl || cardMetaById.get(meta.id)?.wikipediaUrl || null,
            count: Number(meta.count) || 1,
            ownedCardId: meta.ownedCardId || cardMetaById.get(meta.id)?.ownedCardId || null,
            ownedCardIds: Array.isArray(meta.ownedCardIds)
              ? [...meta.ownedCardIds]
              : (cardMetaById.get(meta.id)?.ownedCardIds || [])
          };

          if (sameBatch) {
            normalized.ownedCardIds = [...new Set([
              ...(sameBatch.ownedCardIds || []),
              ...normalized.ownedCardIds
            ])];
            normalized.ownedCardId = sameBatch.ownedCardId || normalized.ownedCardId;
            normalized.count = Math.max(
              sameBatch.count || 1,
              normalized.count,
              normalized.ownedCardIds.length
            );
          }

          // Seule la collection fournit ces champs : les autres sources ne doivent pas les effacer.
          if (typeof meta.starred === 'boolean') {
            normalized.starred = meta.starred || Boolean(sameBatch?.starred);
          }
          if (Array.isArray(meta.tags)) {
            normalized.tags = mergeTags(sameBatch?.tags, meta.tags);
          }

          cardMetaById.set(normalized.id, normalized);
          idByTitle.set(normalizeTitle(normalized.title), normalized.id);
        }
      }

      // Le Marché dit pour chaque carte si elle est encore possédée : une carte vendue ou échangée
      // sort de la collection mémorisée, donc de « Plus chères ».
      async function forgetUnownedCards(ids) {
        if (!ids.length) return;
        for (const id of ids) {
          const meta = cardMetaById.get(id);
          if (meta) cardMetaById.set(id, { ...meta, ownedCardId: null, ownedCardIds: [] });
        }

        await collectionReady;
        const gone = new Set(ids);
        const entry = readCollection();
        if (!Array.isArray(entry?.cards) || !entry.cards.some((card) => gone.has(card?.id))) return;
        storageSet({ [ALL_COLLECTION_KEY]: { ...entry, cards: entry.cards.filter((card) => !gone.has(card?.id)) } });
      }

      window.addEventListener('wm-average-ownership', (event) => {
        const owned = event.detail?.owned || {};
        forgetUnownedCards(Object.keys(owned).filter((id) => owned[id] === false))
          .catch((error) => reportError('collection', error));
      });

      // Le site enregistre étiquettes et favori sans réponse lisible : chaque page de collection
      // qu'il affiche donne leur état actuel, qui remplace celui du dernier chargement complet.
      // Seulement si la page montre tous les exemplaires connus : sinon on ajoute sans rien retirer.
      async function refreshStoredMarks(cards) {
        const seen = new Map();
        for (const card of cards) {
          const previous = seen.get(card.id);
          const copies = Array.isArray(card.ownedCardIds) ? card.ownedCardIds : [];
          seen.set(card.id, previous
            ? {
                copies: [...previous.copies, ...copies],
                starred: previous.starred || card.starred === true,
                tags: mergeTags(previous.tags, card.tags)
              }
            : { copies, starred: card.starred === true, tags: mergeTags(card.tags) });
        }

        await collectionReady;
        const entry = readCollection();
        if (!Array.isArray(entry?.cards) || !entry.cards.some((card) => seen.has(card?.id))) return;

        let changed = false;
        const next = entry.cards.map((card) => {
          const fresh = seen.get(card?.id);
          if (!fresh) return card;
          const known = Array.isArray(card.ownedCardIds) ? card.ownedCardIds : [];
          const whole = known.every((id) => fresh.copies.includes(id));
          const tags = whole ? fresh.tags : mergeTags(card.tags, fresh.tags);
          const starred = whole ? fresh.starred : Boolean(card.starred || fresh.starred);
          if (starred === Boolean(card.starred) && JSON.stringify(tags) === JSON.stringify(mergeTags(card.tags))) return card;
          changed = true;
          return { ...card, tags, starred };
        });
        if (changed) storageSet({ [ALL_COLLECTION_KEY]: { ...entry, cards: next } });
      }

      window.addEventListener('wm-average-collection', (event) => {
        const cards = event.detail?.cards;
        if (!Array.isArray(cards) || !cards.length) return;
        refreshStoredMarks(cards).catch((error) => reportError('étiquettes', error));
      });

      // Fin du chemin seulement : la vignette PNG d'un fichier « x.gif » n'est pas animée,
      // et une image en data: (pixel transparent de l'extension) n'est pas une illustration.
      function isGifImage(url) {
        if (typeof url !== 'string' || !/^https?:/i.test(url)) return false;
        try {
          return /\.gif$/i.test(new URL(url).pathname);
        } catch (_) {
          return false;
        }
      }

      // Une carte juste vue sur le Marketplace ou dans une enchère (pas forcément possédée) ne doit
      // pas écraser la rareté ou l'image d'une carte déjà possédée : une même carte existe en
      // plusieurs raretés, et "Plus chères" choisit le prix selon la rareté mémorisée.
      function preserveOwnedMeta(card) {
        const existing = cardMetaById.get(card.id);
        const owned = Boolean(existing?.ownedCardId) ||
          (Array.isArray(existing?.ownedCardIds) && existing.ownedCardIds.length > 0);
        if (!owned) return { ...card, count: existing?.count || 1 };
        return { ...card, count: existing.count || 1, rarity: existing.rarity, imageUrl: existing.imageUrl };
      }

      return {
        CACHE_TTL, LONG_CACHE_TTL, ERROR_CACHE_TTL, MAX_CONCURRENT, BULK_RARITY_LAST_LOAD_KEY,
        ALL_COLLECTION_KEY, PULL_RECAP_ENABLED_KEY, PULL_STATS_KEY,
        AUTO_OPEN_ENABLED_KEY, AUTO_OPEN_NEXT_AT_KEY, AUTO_OPEN_SESSION_KEY,
        AUTO_OPEN_MIN_MINUTES_KEY, AUTO_OPEN_MAX_MINUTES_KEY,
        AUTO_OPEN_DEFAULT_MIN_MINUTES, AUTO_OPEN_DEFAULT_MAX_MINUTES,
        COMPACT_MODE_KEY,
        MISSING_IMAGE_CACHE_PREFIX, MISSING_IMAGE_FOUND_TTL, MISSING_IMAGE_MISS_TTL,
        RARITIES, DEFAULT_RARE_RARITIES, cardMetaById, idByTitle, cacheMemory,
        isCollectionPage, isMarketplaceDetailPage, isMarketplacePage, isPullsPage,
        isTradesPage, isGlobalCollectionPage, isGuildPage, isLastPullCardVisible, normalizeTitle,
        cacheKey, readLocalValue, writeLocalValue, toStoredCard, storageGet, storageSet, collectionReady, readCollection,
        isCacheEntryValid, cleanupPriceCacheOnceDaily, clearCaches, PRICE_PACE_KEY, PRICE_BLOCK_KEY,
        isContextInvalidatedError,
        reportError, mergeTags, registerCards, preserveOwnedMeta, isGifImage,
        wait, waitFor, siteSearchInput, setSiteSearch
      };
    }
  };
})();
