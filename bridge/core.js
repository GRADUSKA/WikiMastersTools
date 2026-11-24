(() => {
  const registry = window.__wmBridgeFeatures ||= {};

  // Chrome ralentit les minuteurs d'un onglet masqué (jusqu'à un par minute après 5 min) ; ceux d'un
  // Worker ne le sont pas. Sans Worker (ou s'il échoue), on retombe sur setTimeout.
  registry.timer ||= (() => {
    const WORKER_SOURCE = 'const t=new Map();onmessage=e=>{const{id,ms}=e.data;clearTimeout(t.get(id));t.delete(id);'
      + 'if(ms!=null)t.set(id,setTimeout(()=>{t.delete(id);postMessage(id)},ms))}';
    const pending = new Map();
    let worker;
    let seq = 0;

    function degrade() {
      worker = null;
      for (const { fn, at } of pending.values()) setTimeout(fn, Math.max(0, at - Date.now()));
      pending.clear();
    }

    function getWorker() {
      if (worker !== undefined) return worker;
      try {
        worker = new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' })));
        worker.onmessage = (event) => {
          const entry = pending.get(event.data);
          pending.delete(event.data);
          entry?.fn();
        };
        worker.onerror = degrade;
      } catch (_) {
        worker = null;
      }
      return worker;
    }

    function set(fn, ms) {
      const target = getWorker();
      if (!target) return setTimeout(fn, ms);
      const id = `w${++seq}`;
      pending.set(id, { fn, at: Date.now() + ms });
      target.postMessage({ id, ms });
      return id;
    }

    function clear(id) {
      if (typeof id !== 'string') return clearTimeout(id);
      pending.delete(id);
      worker?.postMessage({ id });
    }

    return { set, clear, sleep: (ms) => new Promise((resolve) => set(resolve, ms)) };
  })();

  registry.bridgeCore = {
    create() {
      const originalFetch = window.fetch.bind(window);
      const MAX_COLLECTION_PAGES = 200;
      const MAX_BULK_PACKS = 100;
      const RARITY_ORDER = ['L', 'UR', 'SR', 'R', 'PC', 'C'];
      const MARKETPLACE_MINE_CACHE_TTL = 15 * 1000;

      // Étiquettes normalisées en { id, name, color }, dédoublonnées par id (ou par nom à défaut).
      function mapTags(...lists) {
        const byKey = new Map();

        for (const list of lists) {
          if (!Array.isArray(list)) continue;

          for (const raw of list) {
            const tag = raw?.tag && typeof raw.tag === 'object' ? raw.tag : raw;
            const isObject = tag && typeof tag === 'object';
            const name = String((isObject ? tag.name : tag) || '').trim();
            if (!name) continue;

            const id = isObject && tag.id ? String(tag.id) : null;
            const color = isObject && typeof tag.color === 'string' ? tag.color : null;
            const mapped = { id, name, color };
            // Présent uniquement dans la liste des étiquettes du joueur.
            if (isObject && Number.isFinite(Number(tag.cardCount))) {
              mapped.cardCount = Number(tag.cardCount);
            }
            byKey.set(id || name, mapped);
          }
        }

        return [...byKey.values()];
      }

      function mapEntry(entry) {
        const card = entry && entry.card;
        const id = (entry && entry.card_id) || (card && card.id);
        const ownedCardId = entry?.id || null;
        const title = card && card.wikipedia_title;
        if (!id || !title) return null;

        return {
          id,
          ownedCardId,
          ownedCardIds: ownedCardId ? [ownedCardId] : [],
          title,
          rarity: card?.rarity || null,
          imageUrl: card?.image_url || null,
          wikipediaUrl: card?.wikipedia_url || null,
          count: Number(entry?.count) || 1,
          starred: entry?.starred === true,
          tags: mapTags(entry?.tags)
        };
      }

      function extractCards(json) {
        if (!json || !Array.isArray(json.collection)) return [];
        return json.collection.map(mapEntry).filter(Boolean);
      }

      function emitCollection(json) {
        const cards = extractCards(json);
        if (!cards.length) return;

        window.dispatchEvent(new CustomEvent('wm-average-collection', {
          detail: { cards }
        }));
      }

      function isMarketplaceDetailApi(url) {
        try {
          const parsed = new URL(url, location.origin);
          return /^\/api\/marketplace\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.pathname);
        } catch (_) {
          return false;
        }
      }

      function isPacksOpenApi(url) {
        try {
          const parsed = new URL(url, location.origin);
          return parsed.origin === location.origin && parsed.pathname === '/api/packs/open';
        } catch (_) {
          return false;
        }
      }

      // Liste des annonces affichée par le site ; « mine=1 » est la requête de « Mes enchères ».
      function isMarketplaceListApi(url) {
        try {
          const parsed = new URL(url, location.origin);
          return parsed.pathname === '/api/marketplace' && !parsed.searchParams.has('mine');
        } catch (_) {
          return false;
        }
      }

      // Toutes les listes du Marché, y compris « mine=1 » (tes ventes, enchères et achats).
      function isMarketplaceFeedApi(url) {
        try {
          return new URL(url, location.origin).pathname === '/api/marketplace';
        } catch (_) {
          return false;
        }
      }

      // Chaque annonce porte « owned » : possèdes-tu encore cette carte ? C'est ce qu'affiche
      // le badge « Possédée » du site, notamment sur l'historique de tes ventes.
      function emitOwnership(json) {
        const lists = Array.isArray(json) ? [json] : Object.values(json || {}).filter(Array.isArray);
        const owned = {};
        for (const auction of lists.flat()) {
          const id = auction?.card_id || auction?.card?.id;
          if (id && typeof auction.owned === 'boolean') owned[id] = auction.owned;
        }
        if (Object.keys(owned).length) {
          window.dispatchEvent(new CustomEvent('wm-average-ownership', { detail: { owned } }));
        }
      }

      function isTradesApi(url) {
        try {
          const parsed = new URL(url, location.origin);
          return parsed.pathname === '/api/trades';
        } catch (_) {
          return false;
        }
      }

      function isGlobalCardsApi(url) {
        try {
          const parsed = new URL(url, location.origin);
          return parsed.hostname === 'cyrxjeppjqsxxjayfrur.supabase.co' &&
            parsed.pathname === '/rest/v1/cards';
        } catch (_) {
          return false;
        }
      }

      function getGlobalCollectionSummaryCardId(url) {
        try {
          const parsed = new URL(url, location.origin);
          if (parsed.hostname !== 'cyrxjeppjqsxxjayfrur.supabase.co') return null;
          if (parsed.pathname !== '/rest/v1/cards') return null;

          const select = parsed.searchParams.get('select') || '';
          if (!select.split(',').map((value) => value.trim()).includes('summary')) return null;

          const rawId = parsed.searchParams.get('id') || '';
          const match = rawId.match(/^eq\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
          return match ? match[1] : null;
        } catch (_) {
          return null;
        }
      }

      function emitGlobalCollectionInspectedCard(url) {
        const id = getGlobalCollectionSummaryCardId(url);
        if (!id) return;

        window.dispatchEvent(new CustomEvent('wm-average-global-card-inspected', {
          detail: { id }
        }));
      }

      function mapPackCards(json) {
        if (!Array.isArray(json?.cards)) return [];

        return json.cards
          .map((card) => {
            if (!card?.id || !card?.wikipedia_title) return null;
            return {
              id: card.id,
              title: card.wikipedia_title,
              rarity: card.rarity || null,
              imageUrl: card.image_url || null,
              wikipediaUrl: card.wikipedia_url || null,
              count: 1
            };
          })
          .filter(Boolean);
      }

      function emitPackOpened(json) {
        const cards = mapPackCards(json);
        if (!cards.length) return;

        window.dispatchEvent(new CustomEvent('wm-average-pack-opened', {
          detail: {
            cards,
            packsRemaining: Number(json?.packs_remaining)
          }
        }));
      }

      function mapTrade(raw) {
        if (!raw?.id || !raw?.initiator_id || !raw?.recipient_id) return null;

        const items = Array.isArray(raw.items)
          ? raw.items.map((item) => {
              const card = item?.card;
              const id = item?.card_id || card?.id;
              const title = card?.wikipedia_title;
              if (!id || !title) return null;

              return {
                id: item?.id || null,
                offeredBy: item?.offered_by || null,
                card: {
                  id,
                  title,
                  rarity: item?.snapshot_rarity || card?.rarity || null,
                  imageUrl: card?.image_url || null,
                  wikipediaUrl: card?.wikipedia_url || null,
                  count: 1
                }
              };
            }).filter(Boolean)
          : [];

        return {
          id: raw.id,
          status: raw.status || null,
          initiatorId: raw.initiator_id,
          recipientId: raw.recipient_id,
          initiatorWikibidous: Number(raw.initiator_wikibidous) || 0,
          recipientWikibidous: Number(raw.recipient_wikibidous) || 0,
          initiator: {
            id: raw.initiator?.id || raw.initiator_id,
            username: raw.initiator?.username || 'Initiateur'
          },
          recipient: {
            id: raw.recipient?.id || raw.recipient_id,
            username: raw.recipient?.username || 'Destinataire'
          },
          items
        };
      }

      function emitTrades(json) {
        const trades = Array.isArray(json?.trades)
          ? json.trades.map(mapTrade).filter(Boolean)
          : [];

        window.dispatchEvent(new CustomEvent('wm-average-trades', {
          detail: { trades }
        }));
      }

      async function fetchTrades() {
        try {
          const response = await originalFetch('/api/trades', {
            method: 'GET',
            credentials: 'include',
            headers: { accept: '*/*' }
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          emitTrades(await response.json());
        } catch (error) {
          window.dispatchEvent(new CustomEvent('wm-average-trades', {
            detail: {
              trades: [],
              error: String(error?.message || error)
            }
          }));
        }
      }

      // La forme exacte de la liste n'est pas documentée : on prend le premier tableau d'annonces trouvé.
      function emitMarketplaceList(json) {
        const isAuction = (item) => item && typeof item === 'object' && (item.card_id || item.card?.id);
        const source = Array.isArray(json)
          ? json
          : Object.values(json || {}).find((value) => Array.isArray(value) && value.some(isAuction));
        if (!Array.isArray(source)) return;

        const auctions = source.filter(isAuction).map((auction) => {
          const price = [auction.effective_bid, auction.current_bid, auction.listing_base_amount, auction.base_amount]
            .map(Number)
            .find((value) => Number.isFinite(value) && value > 0) || 0;
          return {
            id: auction.id || null,
            price,
            card: {
              id: auction.card_id || auction.card?.id,
              title: auction.card?.wikipedia_title || null,
              rarity: auction.snapshot_rarity || auction.card?.rarity || null,
              imageUrl: auction.card?.image_url || null
            }
          };
        }).filter((auction) => auction.id && auction.card.id && auction.card.title);

        if (!auctions.length) return;
        window.dispatchEvent(new CustomEvent('wm-average-marketplace-list', { detail: { auctions } }));
      }

      function emitMarketplaceDetail(json) {
        const auction = json?.auction;
        const card = auction?.card;
        const id = auction?.card_id || card?.id;
        const title = card?.wikipedia_title;
        if (!id || !title) return;

        window.dispatchEvent(new CustomEvent('wm-average-marketplace-detail', {
          detail: {
            auctionId: auction?.id || null,
            card: {
              id,
              title,
              rarity: auction?.snapshot_rarity || card?.rarity || null,
              imageUrl: card?.image_url || null,
              wikipediaUrl: card?.wikipedia_url || null,
              count: 1
            }
          }
        }));
      }

      const { sleep } = registry.timer;

      // 403 et 429 : le site limite les requêtes automatisées. On s'arrête au lieu d'insister.
      const isRetryableStatus = (status) => status === 408 || (status >= 500 && status <= 599);

      async function fetchJsonRetry(url, options = {}, {
        label = 'Requête',
        maxAttempts = 3,
        timeoutMs = 15000
      } = {}) {
        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), timeoutMs);
          let delayMs = Math.min(1800, 300 * (2 ** (attempt - 1)));
          try {
            const response = await originalFetch(url, { ...options, signal: options.signal || controller.signal });

            if (response.ok) {
              return await response.json();
            }

            lastError = new Error(`${label}: HTTP ${response.status}`);
            lastError.status = response.status;

            if (!isRetryableStatus(response.status) || attempt >= maxAttempts) {
              throw lastError;
            }
          } catch (rawError) {
            // Sans réponse dans le délai, le site traîne, souvent parce qu'il nous freine.
            const timedOut = !options.signal && rawError?.name === 'AbortError';
            const error = timedOut
              ? new Error(`${label}: pas de réponse en ${Math.round(timeoutMs / 1000)} s`)
              : rawError;
            lastError = error;
            if (timedOut) delayMs = Math.min(30000, 3000 * attempt);

            const status = Number.isFinite(error?.status) ? error.status : null;
            const retryable = status == null || isRetryableStatus(status);

            if (!retryable || attempt >= maxAttempts) {
              throw error;
            }
          } finally {
            clearTimeout(timeout);
          }

          await sleep(delayMs);
        }

        throw lastError || new Error(`${label}: erreur inconnue`);
      }


      return {
        originalFetch, MAX_COLLECTION_PAGES, MAX_BULK_PACKS, RARITY_ORDER,
        MARKETPLACE_MINE_CACHE_TTL, mapTags, mapEntry, extractCards, emitCollection,
        isMarketplaceDetailApi, isMarketplaceListApi, isMarketplaceFeedApi, emitOwnership, isPacksOpenApi, isTradesApi,
        isGlobalCardsApi, getGlobalCollectionSummaryCardId, emitGlobalCollectionInspectedCard,
        mapPackCards, emitPackOpened, mapTrade, emitTrades, fetchTrades,
        emitMarketplaceDetail, emitMarketplaceList, fetchJsonRetry, sleep
      };
    }
  };
})();
