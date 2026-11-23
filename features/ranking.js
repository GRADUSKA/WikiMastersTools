(() => {
  const registry = window.__wmAverageFeatures ||= {};

  registry.ranking = {
    create(runtime) {
      const {
        ALL_COLLECTION_KEY, cardMetaById, cacheMemory, cacheKey,
        storageGet, storageSet, collectionReady, readCollection, mergeTags,
        readLocalValue, writeLocalValue, RARITIES, isGifImage
      } = runtime.core;
      // Illustration du site uniquement : celle que tous les joueurs voient.
      const isGifCard = (card) => isGifImage(card.imageUrl);
      const SALE_SETTINGS_KEY = 'wm_ranking_sale_v1';
      const COLLECTION_VALUE_KEY = 'wm_collection_value_v1';
      const { formatAverage, chooseAverage } = runtime.priceUi;
      const pendingMarketplaceListings = new Map();
      const pendingBridgeRequests = new Map();
      // Cases de prix affichées dans le classement ouvert, redessinées quand un prix arrive.
      const priceCells = new Map();

      function onPriceUpdated(id) {
        for (const paint of priceCells.get(id) || []) paint();
      }

      // Requête au bridge résolue par l'événement de réponse portant le même requestId.
      function requestBridge(eventName, detail = {}, timeoutMs = 12000) {
        return new Promise((resolve) => {
          const requestId = `${eventName}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

          const timeout = setTimeout(() => {
            const pending = pendingBridgeRequests.get(requestId);
            if (!pending) return;

            pendingBridgeRequests.delete(requestId);
            resolve({
              requestId,
              ok: false,
              timeout: true,
              error: 'La requête a expiré.'
            });
          }, timeoutMs);

          pendingBridgeRequests.set(requestId, { resolve, timeout });
          window.dispatchEvent(new CustomEvent(eventName, {
            detail: { ...detail, requestId }
          }));
        });
      }

      function resolveBridgeRequest(event) {
        const detail = event.detail || {};
        const pending = pendingBridgeRequests.get(detail.requestId);
        if (!pending) return;

        clearTimeout(pending.timeout);
        pendingBridgeRequests.delete(detail.requestId);
        pending.resolve(detail);
      }

      window.addEventListener('wm-average-tag-cards', resolveBridgeRequest);
      window.addEventListener('wm-average-starred-cards', resolveBridgeRequest);
      window.addEventListener('wm-average-tag-options', resolveBridgeRequest);
      window.addEventListener('wm-average-my-listings', resolveBridgeRequest);

      function humanElapsed(timestamp) {
        const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60000));
        if (minutes < 60) return `${minutes} min`;
        const hours = Math.floor(minutes / 60);
        const remaining = minutes % 60;
        return remaining ? `${hours} h ${remaining} min` : `${hours} h`;
      }

      // L'état d'une vente suit la carte, pas le bouton : un filtre peut redessiner la ligne
      // pendant la requête, et le nouveau bouton doit rester bloqué.
      function paintSale(button, sale) {
        if (sale) button.dataset.state = sale.state;
        else delete button.dataset.state;
        button.disabled = Boolean(sale) && sale.state !== 'error';
        button.textContent = sale?.text || button.dataset.idleText || 'Mettre en vente';
        button.title = sale?.title || '';
        button.closest('.wm-ranking-row')?.classList.toggle('wm-ranking-row-unowned', Boolean(sale?.unowned));
      }

      function setSale(row, sale) {
        row.sale = sale;
        if (row.sellButton?.isConnected) paintSale(row.sellButton, sale);
      }

      function requestListing({ row, amount, duration, ownedCardId, allowStarred = false }) {
        const requestId = `listing:${row.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

        setSale(row, { state: 'pending', text: ownedCardId ? 'Mise en vente…' : 'Recherche ID…' });

        pendingMarketplaceListings.set(requestId, { row, amount, duration });

        window.dispatchEvent(new CustomEvent('wm-average-create-listing', {
          detail: {
            requestId,
            ownedCardId,
            catalogueCardId: row.id,
            title: row.title,
            baseAmount: amount,
            durationMinutes: duration,
            allowStarred
          }
        }));
      }

      // Les cartes vues pendant la session ne décrivent parfois qu'un seul exemplaire d'un doublon :
      // elles ne doivent pas faire perdre ce que le chargement complet connaît des autres copies.
      function mergeKnownCard(stored, seen) {
        const merged = { ...stored, ...seen };
        const storedCopies = Array.isArray(stored.ownedCardIds) ? stored.ownedCardIds : [];
        if (storedCopies.length <= 1) return merged;

        merged.ownedCardIds = [...new Set([
          ...storedCopies,
          ...(Array.isArray(seen.ownedCardIds) ? seen.ownedCardIds : [])
        ])];
        merged.count = Math.max(stored.count || 1, seen.count || 1, merged.ownedCardIds.length);
        merged.starred = Boolean(stored.starred || seen.starred);
        merged.tags = mergeTags(stored.tags, seen.tags);

        return merged;
      }

      // Un double clic ne doit pas empiler deux classements : on pourrait vendre deux fois la même carte.
      let rankingOpening = null;

      function openRankingModal() {
        if (document.querySelector('.wm-ranking-overlay')) return Promise.resolve();
        rankingOpening ||= buildRankingModal().finally(() => { rankingOpening = null; });
        return rankingOpening;
      }

      async function buildRankingModal() {
        await collectionReady;
        const collectionEntry = readCollection();
        const storedCards = Array.isArray(collectionEntry?.cards) ? collectionEntry.cards : [];

        // Merge persisted metadata with cards already discovered during this page session.
        // This lets the ranking work even before a full bulk collection load.
        const knownCards = new Map();

        for (const card of storedCards) {
          if (card?.id && card?.title) knownCards.set(card.id, { ...card });
        }

        for (const card of cardMetaById.values()) {
          if (!card?.id || !card?.title) continue;

          const previous = knownCards.get(card.id);
          const hasOwnershipEvidence =
            Boolean(card.ownedCardId) ||
            (Array.isArray(card.ownedCardIds) && card.ownedCardIds.length > 0);

          // cardMetaById is shared by several features (collection, marketplace,
          // packs, trades...). A marketplace card viewed during the session must
          // never become a collection candidate just because its price was cached.
          // Existing persisted collection cards are still allowed to absorb fresher
          // metadata, while new session-only cards need proof that they are owned.
          if (!previous && !hasOwnershipEvidence) continue;

          knownCards.set(card.id, previous ? mergeKnownCard(previous, card) : { ...card });
        }

        const candidates = [...knownCards.values()];

        if (!candidates.length) {
          runtime.modalUi.showInfoModal(
            'Aucun prix chargé',
            'Aucune carte de ta collection n’est encore connue. Parcours ta collection, puis réessaie.'
          );
          return;
        }

        const priceKeys = candidates.map((card) => cacheKey(card.id));
        const prices = storageGet(priceKeys);

        const rows = candidates
          .map((card) => {
            const entry = prices[cacheKey(card.id)];

            // Errors are not useful in a "most expensive" ranking.
            if (!entry || entry.ok === false) return null;

            const average = chooseAverage(entry, null, card.rarity || null);

            return {
              ...card,
              average,
              fetchedAt: Number(entry?.fetchedAt) || 0
            };
          })
          .filter(Boolean)
          .sort((a, b) => {
            const aPrice = Number.isFinite(a.average) ? a.average : -Infinity;
            const bPrice = Number.isFinite(b.average) ? b.average : -Infinity;
            if (bPrice !== aPrice) return bPrice - aPrice;
            return a.title.localeCompare(b.title, 'fr');
          });

        // Cartes connues sans prix en cache : hors classement, mais utiles aux filtres
        // favoris / étiquettes pour ne pas donner un résultat incomplet.
        const rankedIds = new Set(rows.map((row) => row.id));
        const unpricedRows = candidates
          .filter((card) => (
            !rankedIds.has(card.id) &&
            (card.starred || (Array.isArray(card.tags) && card.tags.length > 0) || isGifCard(card))
          ))
          .map((card) => ({ ...card, average: Number.NaN, fetchedAt: 0 }))
          .sort((a, b) => a.title.localeCompare(b.title, 'fr'));

        // Toutes les cartes jamais chargées, pour l'étiquette « Sans prix ».
        const allUnpricedRows = candidates
          .filter((card) => !rankedIds.has(card.id))
          .map((card) => ({ ...card, average: Number.NaN, fetchedAt: 0 }));

        const isComplete =
          collectionEntry?.complete === true &&
          rows.length >= candidates.length;

        renderRankingModal(
          rows,
          collectionEntry?.fetchedAt || 0,
          {
            incomplete: !isComplete,
            unpricedRows,
            allUnpricedRows,
            knownCards: candidates.length,
            cachedCards: rows.length
          }
        );
      }

      // Une valeur par jour, gardée 60 jours, pour comparer avec la semaine précédente.
      // Seuls les classements complets sont enregistrés : un chargement partiel fausserait l'écart.
      function collectionValueHistory() {
        const history = readLocalValue(COLLECTION_VALUE_KEY);
        return history && typeof history === 'object' ? history : {};
      }

      function recordCollectionValue(total) {
        const history = collectionValueHistory();
        history[new Date(Date.now()).toISOString().slice(0, 10)] = Math.round(total);
        const days = Object.keys(history).sort().slice(-60);
        writeLocalValue(COLLECTION_VALUE_KEY, Object.fromEntries(days.map((day) => [day, history[day]])));
      }

      // Entre 7 et 10 jours avant aujourd'hui : au-delà, l'écart ne serait plus « sur 7 jours ».
      function collectionValueWeekAgo() {
        const history = collectionValueHistory();
        const oldest = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const newest = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const day = Object.keys(history).filter((key) => key >= oldest && key <= newest).sort().pop();
        return day ? Number(history[day]) : null;
      }

      function createCollectionValue(rows, status) {
        let total = 0;
        let priced = 0;
        const byRarity = new Map();

        for (const row of rows) {
          if (!Number.isFinite(row.average)) continue;
          const value = row.average * (Number(row.count) || 1);
          total += value;
          priced += 1;
          byRarity.set(row.rarity, (byRarity.get(row.rarity) || 0) + value);
        }

        const weekAgo = collectionValueWeekAgo();
        const allPriced = !status.incomplete && priced === (Number(status.knownCards) || 0);
        if (allPriced) recordCollectionValue(total);

        const box = document.createElement('div');
        box.className = 'wm-ranking-value';
        box.title = 'Prix moyen des ventes × exemplaires possédés, pour les cartes dont le prix est chargé';

        const totalEl = document.createElement('strong');
        totalEl.textContent = `Valeur estimée : ${formatAverage(Math.round(total))} W`;
        box.append(totalEl);

        const addPart = (text, className = '') => {
          const part = document.createElement('span');
          part.textContent = text;
          if (className) part.className = className;
          box.append(part);
        };

        const rarityParts = RARITIES
          .filter((rarity) => byRarity.has(rarity))
          .map((rarity) => `${rarity} ${formatAverage(Math.round(byRarity.get(rarity)))}`);
        if (rarityParts.length) addPart(rarityParts.join(' · '));

        const unpriced = Math.max(0, (Number(status.knownCards) || 0) - priced);
        if (unpriced) addPart(`${formatAverage(unpriced)} carte${unpriced > 1 ? 's' : ''} sans prix`);

        if (weekAgo > 0 && allPriced) {
          const change = (total - weekAgo) / weekAgo * 100;
          const sign = change > 0 ? '+' : '';
          addPart(`${sign}${change.toFixed(1).replace('.', ',')} % sur 7 jours`, change >= 0 ? 'is-up' : 'is-down');
        }

        return box;
      }

      function renderRankingModal(rows, collectionFetchedAt, status = {}) {
        const salesEnabled = runtime.settings.isEnabled('rankingSales');
        const overlay = document.createElement('div');
        overlay.className = 'wm-modal-overlay wm-ranking-overlay';

        const modal = document.createElement('div');
        modal.className = `wm-modal wm-ranking-modal ${salesEnabled ? 'wm-ranking-sales-enabled' : 'wm-ranking-sales-disabled'}`;

        const header = document.createElement('div');
        header.className = 'wm-ranking-header';

        const headingWrap = document.createElement('div');
        const title = document.createElement('h2');
        title.textContent = 'Cartes les plus chères';

        const subtitle = document.createElement('p');
        const pricedCount = rows.filter((row) => Number.isFinite(row.average)).length;
        subtitle.textContent = `${rows.length} cartes du cache • ${pricedCount} avec un prix moyen${collectionFetchedAt ? ` • données collection il y a ${humanElapsed(collectionFetchedAt)}` : ''}`;

        headingWrap.append(title, subtitle);

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'wm-ranking-close';
        closeButton.setAttribute('aria-label', 'Fermer');
        closeButton.textContent = '×';

        header.append(headingWrap, closeButton);

        let cacheNotice = null;
        if (status.incomplete) {
          cacheNotice = document.createElement('div');
          cacheNotice.className = 'wm-ranking-cache-notice';

          const noticeTitle = document.createElement('strong');
          noticeTitle.textContent = 'Classement partiel';

          const noticeText = document.createElement('span');
          noticeText.textContent =
            'Vous n’avez pas chargé tous les prix : seules les cartes actuellement disponibles dans votre cache sont affichées ici.';

          cacheNotice.append(noticeTitle, noticeText);
        }

        const saleControls = document.createElement('div');
        saleControls.className = 'wm-ranking-sale-controls';

        const priceField = document.createElement('label');
        priceField.className = 'wm-ranking-sale-field';

        const priceLabel = document.createElement('span');
        priceLabel.textContent = 'Prix de mise en vente';

        // Par défaut, un pourcentage de la moyenne : un prix fixe unique vendait aussi bien
        // une carte à 3 W qu'une carte à 2 000 W au même montant.
        const savedSale = readLocalValue(SALE_SETTINGS_KEY) || {};

        const priceInputs = document.createElement('div');
        priceInputs.className = 'wm-ranking-price-inputs';

        const priceInput = document.createElement('input');
        priceInput.type = 'number';
        priceInput.min = '1';
        priceInput.step = '1';
        priceInput.inputMode = 'decimal';

        const unitInput = document.createElement('select');
        unitInput.setAttribute('aria-label', 'Unité du prix');
        for (const [value, label] of [['percent', '% de la moyenne'], ['fixed', 'W (prix fixe)']]) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = label;
          unitInput.append(option);
        }
        unitInput.value = savedSale.unit === 'fixed' ? 'fixed' : 'percent';
        priceInput.value = Number(savedSale.value) > 0 ? String(savedSale.value) : '100';

        priceInputs.append(priceInput, unitInput);
        priceField.append(priceLabel, priceInputs);

        const durationField = document.createElement('label');
        durationField.className = 'wm-ranking-sale-field';

        const durationLabel = document.createElement('span');
        durationLabel.textContent = 'Durée';

        const durationInput = document.createElement('select');

        const durationOptions = [
          [10, '10 min'],
          [30, '30 min'],
          [60, '1 h'],
          [180, '3 h'],
          [360, '6 h'],
          [720, '12 h']
        ];

        for (const [value, label] of durationOptions) {
          const option = document.createElement('option');
          option.value = String(value);
          option.textContent = label;
          durationInput.append(option);
        }

        durationInput.value = durationOptions.some(([value]) => value === Number(savedSale.duration))
          ? String(savedSale.duration)
          : '10';

        durationField.append(durationLabel, durationInput);

        const hint = document.createElement('div');
        hint.className = 'wm-ranking-sale-hint';
        hint.textContent = 'Chaque bouton affiche le montant de sa carte. Sans prix moyen, seul un prix fixe permet de la vendre.';

        const amountFor = (row) => {
          const value = Number(priceInput.value);
          if (!Number.isFinite(value) || value <= 0) return null;
          if (unitInput.value === 'fixed') return Math.max(1, Math.round(value));
          return Number.isFinite(row.average) && row.average > 0
            ? Math.max(1, Math.round(row.average * value / 100))
            : null;
        };

        saleControls.append(priceField, durationField, hint);

        const tagKey = (tag) => tag.id || tag.name;
        const rowTags = (row) => mergeTags(row.tags);

        // Le rang affiché reste celui du classement complet, même une fois filtré.
        const rankedRows = rows.map((row, index) => ({ row, index }));
        const rankedById = new Map(rankedRows.map((entry) => [entry.row.id, entry]));
        // Sans prix chargé : pas de rang, affichées seulement quand un filtre est actif.
        const unrankedRows = (Array.isArray(status.unpricedRows) ? status.unpricedRows : [])
          .map((row) => ({ row, index: null }));
        const filterableRows = [...rankedRows, ...unrankedRows];
        let visibleRows = rankedRows;
        let closed = false;

        const knownTags = new Map();
        const addKnownTags = (tags) => {
          for (const tag of mergeTags(tags)) {
            // Une même étiquette ne doit apparaître qu'une fois, qu'on connaisse son id ou non.
            const sameName = [...knownTags.values()].find((known) => known.name === tag.name);
            if (sameName && sameName.id && !tag.id) continue;
            if (sameName) knownTags.delete(tagKey(sameName));
            knownTags.set(tagKey(tag), {
              ...tag,
              cardCount: tag.cardCount ?? sameName?.cardCount
            });
          }
        };
        filterableRows.forEach(({ row }) => addKnownTags(row.tags));

        // Cartes d'un filtre telles que renvoyées par le site : clé -> { state, rows }.
        const fetchedResults = new Map();
        const STARRED_KEY = '__starred__';
        const UNTAGGED_KEY = '__untagged__';
        // Pseudo-étiquette calculée par l'extension : rien n'est écrit sur le compte du joueur.
        const GIF_KEY = '__gif__';
        const UNPRICED_KEY = '__unpriced__';
        const isLocalFilter = (key) => key === UNTAGGED_KEY || key === GIF_KEY || key === UNPRICED_KEY;
        // Sans prix : jamais chargées, ou chargées sans moyenne pour leur rareté (« — »). Plus rares d'abord.
        const allUnpricedRows = [
          ...rankedRows.filter(({ row }) => !Number.isFinite(row.average)),
          ...(Array.isArray(status.allUnpricedRows) ? status.allUnpricedRows : []).map((row) => ({ row, index: null }))
        ].sort((a, b) => (
          RARITIES.indexOf(a.row.rarity) - RARITIES.indexOf(b.row.rarity) || a.row.title.localeCompare(b.row.title, 'fr')
        ));

        const filters = document.createElement('div');
        filters.className = 'wm-ranking-filters';

        const starredFilter = document.createElement('label');
        starredFilter.className = 'wm-ranking-filter-starred';

        const starredInput = document.createElement('input');
        starredInput.type = 'checkbox';

        const starredText = document.createElement('span');
        starredText.textContent = '★ Favoris uniquement';

        starredFilter.append(starredInput, starredText);

        const tagSelect = document.createElement('select');
        tagSelect.className = 'wm-ranking-filter-tag';
        tagSelect.setAttribute('aria-label', 'Filtrer par étiquette');

        const allTagsOption = document.createElement('option');
        allTagsOption.value = '';
        allTagsOption.textContent = 'Toutes les étiquettes';

        const untaggedOption = document.createElement('option');
        untaggedOption.value = UNTAGGED_KEY;
        untaggedOption.textContent = 'Sans étiquette';

        const gifCount = filterableRows.filter(({ row }) => isGifCard(row)).length;
        const gifOption = document.createElement('option');
        gifOption.value = GIF_KEY;
        gifOption.textContent = `GIFs (${gifCount})`;

        const unpricedOption = document.createElement('option');
        unpricedOption.value = UNPRICED_KEY;
        unpricedOption.textContent = `Sans prix (${allUnpricedRows.length})`;

        const fillTagOptions = () => {
          const selected = tagSelect.value;
          const options = [...knownTags.values()]
            .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
            .map((tag) => {
              const option = document.createElement('option');
              option.value = tagKey(tag);
              option.textContent = Number.isFinite(tag.cardCount)
                ? `${tag.name} (${tag.cardCount})`
                : tag.name;
              return option;
            });

          tagSelect.replaceChildren(allTagsOption, untaggedOption, gifOption, unpricedOption, ...options);
          tagSelect.value = knownTags.has(selected) || isLocalFilter(selected) ? selected : '';
        };

        fillTagOptions();
        tagSelect.value = UNTAGGED_KEY;

        const raritySelect = document.createElement('select');
        raritySelect.className = 'wm-ranking-filter-tag';
        raritySelect.setAttribute('aria-label', 'Filtrer par rareté');
        for (const value of ['', ...RARITIES]) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = value || 'Toutes les raretés';
          raritySelect.append(option);
        }

        const duplicatesFilter = document.createElement('label');
        duplicatesFilter.className = 'wm-ranking-filter-starred';

        const duplicatesInput = document.createElement('input');
        duplicatesInput.type = 'checkbox';

        const duplicatesText = document.createElement('span');
        duplicatesText.textContent = 'Doublons uniquement';

        duplicatesFilter.append(duplicatesInput, duplicatesText);

        const filterCount = document.createElement('span');
        filterCount.className = 'wm-ranking-filter-count';

        filters.append(starredFilter, duplicatesFilter, tagSelect, raritySelect, filterCount);

        const list = document.createElement('div');
        list.className = 'wm-ranking-list';

        const PAGE_SIZE = 50;
        let renderedCount = 0;

        const rowByButton = new WeakMap();

        const refreshSaleButton = (button) => {
          const row = rowByButton.get(button);
          if (!row) return;
          const amount = Number(durationInput.value) > 0 ? amountFor(row) : null;
          button.dataset.idleText = amount ? `Vendre ${formatAverage(amount)} W` : 'Pas de prix';
          if (button.dataset.state === 'pending' || button.dataset.state === 'success') return;
          button.disabled = !amount;
          if (button.dataset.state !== 'error') button.textContent = button.dataset.idleText;
        };

        const refreshSaleButtons = () => {
          for (const button of list.querySelectorAll('.wm-ranking-sell-button')) refreshSaleButton(button);
        };

        const onSaleSettingsChange = () => {
          writeLocalValue(SALE_SETTINGS_KEY, {
            value: Number(priceInput.value) || null,
            unit: unitInput.value,
            duration: Number(durationInput.value)
          });
          refreshSaleButtons();
        };

        const createRankingRow = (row, index) => {
          const item = document.createElement('div');
          item.className = 'wm-ranking-row';

          const rank = document.createElement('div');
          rank.className = 'wm-ranking-rank';
          rank.textContent = index == null ? '—' : String(index + 1);
          if (index == null) rank.title = 'Carte absente du classement en cache';

          const thumb = document.createElement('div');
          thumb.className = 'wm-ranking-thumb';
          if (row.imageUrl) {
            const img = document.createElement('img');
            img.src = row.imageUrl;
            img.alt = '';
            img.loading = 'lazy';
            thumb.append(img);
          }

          const info = document.createElement('div');
          info.className = 'wm-ranking-info';

          const name = document.createElement('div');
          name.className = 'wm-ranking-title';
          name.textContent = row.title;

          if (row.starred) {
            const star = document.createElement('span');
            star.className = 'wm-ranking-star';
            star.textContent = '★';
            star.title = 'Carte en favori';
            name.prepend(star);
          }

          const meta = document.createElement('div');
          meta.className = 'wm-ranking-meta';
          meta.textContent = row.rarity || '—';

          if (row.count > 1) {
            const count = document.createElement('span');
            count.className = 'wm-ranking-count';
            count.textContent = `×${row.count}`;
            count.title = `${row.count} exemplaires possédés`;
            meta.append(count);
          }

          for (const tag of rowTags(row)) {
            const chip = document.createElement('span');
            chip.className = 'wm-ranking-tag';

            if (/^#[0-9a-f]{3,8}$/i.test(tag.color || '')) {
              const dot = document.createElement('span');
              dot.className = 'wm-ranking-tag-dot';
              dot.style.background = tag.color;
              chip.append(dot);
            }

            chip.append(document.createTextNode(tag.name));
            meta.append(chip);
          }

          info.append(name, meta);

          const price = document.createElement('div');
          const paintPrice = () => {
            const entry = cacheMemory.get(row.id) || storageGet([cacheKey(row.id)])[cacheKey(row.id)];
            if (entry?.ok) {
              const average = chooseAverage(entry, null, row.rarity || null);
              row.average = average == null ? Number.NaN : average;
            }
            const pending = runtime.priceLoader.isPending(row.id);
            // Un « — » de moins d'un jour vient du site lui-même (aucune vente) : rien à redemander.
            const ask = !pending && !runtime.priceLoader.isFresh(entry) &&
              (!entry?.ok || !Number.isFinite(row.average));

            price.className = 'wm-ranking-price';
            price.title = ask
              ? 'Charger le prix moyen de la semaine pour cette carte'
              : (entry?.ok && !Number.isFinite(row.average) ? 'Le site ne connaît aucune vente de cette carte dans cette rareté' : '');
            price.classList.toggle('wm-ranking-price-ask', ask);
            price.classList.toggle('wm-ranking-price-empty', !ask && !Number.isFinite(row.average));
            price.textContent = Number.isFinite(row.average)
              ? `${formatAverage(row.average)} W`
              : (pending ? 'Chargement…' : (ask ? 'Voir le prix' : '—'));
            if (row.sellButton) refreshSaleButton(row.sellButton);
          };
          // Un clic : une requête pour cette carte seulement, au rythme du chargeur de prix.
          price.addEventListener('click', () => {
            if (price.classList.contains('wm-ranking-price-ask')) {
              runtime.priceLoader.loadCacheForCards([row], { manual: true });
            }
          });
          const paints = priceCells.get(row.id) || new Set();
          paints.add(paintPrice);
          priceCells.set(row.id, paints);
          paintPrice();

          const sellButton = document.createElement('button');
          sellButton.type = 'button';
          sellButton.className = 'wm-tool-button wm-ranking-sell-button';
          sellButton.dataset.cardId = row.id;
          rowByButton.set(sellButton, row);
          refreshSaleButton(sellButton);
          row.sellButton = sellButton;
          if (row.sale) {
            paintSale(sellButton, row.sale);
            if (row.sale.unowned) item.classList.add('wm-ranking-row-unowned');
          }

          sellButton.addEventListener('click', () => {
            if (row.sale && row.sale.state !== 'error') return;
            const amount = amountFor(row);
            const duration = Number(durationInput.value);

            if (!amount) {
              priceInput.focus();
              return;
            }

            if (!Number.isFinite(duration) || duration <= 0) {
              durationInput.focus();
              return;
            }

            // Le favori est connu par carte, pas par exemplaire : pour une carte en favori,
            // on laisse le bridge choisir un exemplaire non favori s'il en existe un.
            const ownedCardId = row.starred
              ? null
              : (row.ownedCardId || row.ownedCardIds?.[0] || null);

            requestListing({ row, amount, duration, ownedCardId });
          });

          item.append(rank, thumb, info, price);
          if (salesEnabled) item.append(sellButton);
          return item;
        };

        const sentinel = document.createElement('div');
        sentinel.className = 'wm-ranking-sentinel';

        const renderNextChunk = () => {
          if (renderedCount >= visibleRows.length) {
            sentinel.remove();
            return;
          }

          const fragment = document.createDocumentFragment();
          const end = Math.min(renderedCount + PAGE_SIZE, visibleRows.length);

          for (let position = renderedCount; position < end; position += 1) {
            const { row, index } = visibleRows[position];
            fragment.append(createRankingRow(row, index));
          }

          renderedCount = end;
          sentinel.remove();
          list.append(fragment);

          if (renderedCount < visibleRows.length) {
            list.append(sentinel);
          }

          refreshSaleButtons();
        };

        const byPriceThenTitle = (a, b) => {
          const aPrice = Number.isFinite(a.row.average) ? a.row.average : -Infinity;
          const bPrice = Number.isFinite(b.row.average) ? b.row.average : -Infinity;
          if (bPrice !== aPrice) return bPrice - aPrice;
          return a.row.title.localeCompare(b.row.title, 'fr');
        };

        // Le site renvoie toutes les cartes du filtre, y compris celles absentes du classement.
        // Il ne renvoie que les exemplaires concernés : on complète ce qu'on sait déjà de la carte
        // sans réduire son nombre d'exemplaires.
        const buildFetchedRows = (cards) => {
          const outside = cards.filter((card) => !rankedById.has(card.id));
          const prices = storageGet(outside.map((card) => cacheKey(card.id)));

          return cards.map((card) => {
            const ranked = rankedById.get(card.id);

            if (ranked) {
              const ownedCardIds = [...new Set([
                ...(Array.isArray(ranked.row.ownedCardIds) ? ranked.row.ownedCardIds : []),
                ...(Array.isArray(card.ownedCardIds) ? card.ownedCardIds : [])
              ])];

              Object.assign(ranked.row, {
                starred: Boolean(ranked.row.starred || card.starred),
                tags: mergeTags(ranked.row.tags, card.tags),
                count: Math.max(ranked.row.count || 1, card.count || 1, ownedCardIds.length),
                ownedCardId: ranked.row.ownedCardId || card.ownedCardId,
                ownedCardIds
              });
              return ranked;
            }

            const entry = prices[cacheKey(card.id)];
            const average = entry && entry.ok !== false
              ? chooseAverage(entry, null, card.rarity || null)
              : Number.NaN;

            return { row: { ...card, average }, index: null };
          }).sort(byPriceThenTitle);
        };

        const loadFetchedRows = (key, eventName, detail = {}) => {
          if (fetchedResults.has(key)) return;
          fetchedResults.set(key, { state: 'loading' });

          // Ces chargements paginés (250 ms entre pages) dépassent largement 12 s.
          requestBridge(eventName, detail, 180000).then((response) => {
            if (closed) return;

            fetchedResults.set(key, response.ok
              ? {
                  state: 'ready',
                  rows: buildFetchedRows(Array.isArray(response.cards) ? response.cards : [])
                }
              : { state: 'error' });

            // Ne redessine que si ce filtre est toujours celui affiché.
            const tagged = !isLocalFilter(tagSelect.value) && tagSelect.value;
            const currentKey = tagged || (starredInput.checked ? STARRED_KEY : '');
            if (currentKey === key) applyFilters();
          });
        };

        const applyFilters = () => {
          const starredOnly = starredInput.checked;
          const key = tagSelect.value;
          const untaggedOnly = key === UNTAGGED_KEY;
          const gifOnly = key === GIF_KEY;
          const unpricedOnly = key === UNPRICED_KEY;
          const tag = key && !isLocalFilter(key) ? knownTags.get(key) : null;
          const rarity = raritySelect.value;
          const duplicatesOnly = duplicatesInput.checked;
          const filterActive = starredOnly || untaggedOnly || gifOnly || unpricedOnly || Boolean(tag) || Boolean(rarity) || duplicatesOnly;

          let pool = filterActive ? filterableRows : rankedRows;
          let result = null;

          if (unpricedOnly) {
            pool = allUnpricedRows;
          } else if (tag) {
            if (tag.id) loadFetchedRows(key, 'wm-average-load-tag-cards', { tagId: tag.id });
            result = fetchedResults.get(key) || null;

            // En attendant (ou en cas d'échec) : les cartes déjà connues de l'extension.
            pool = result?.state === 'ready'
              ? result.rows
              : filterableRows.filter(({ row }) => (
                  rowTags(row).some((rowTag) => tagKey(rowTag) === key)
                ));
          } else if (starredOnly) {
            loadFetchedRows(STARRED_KEY, 'wm-average-load-starred-cards');
            result = fetchedResults.get(STARRED_KEY) || null;

            if (result?.state === 'ready') {
              const fetchedIds = new Set(result.rows.map(({ row }) => row.id));
              pool = [
                ...result.rows,
                ...filterableRows.filter(({ row }) => row.starred && !fetchedIds.has(row.id))
              ].sort(byPriceThenTitle);
            }
          }

          let note = '';
          if (result?.state === 'loading') note = ' • chargement…';
          if (result?.state === 'error') note = ' • liste peut-être incomplète';

          visibleRows = pool.filter(({ row }) => (
            (!starredOnly || row.starred) &&
            (!untaggedOnly || rowTags(row).length === 0) &&
            (!gifOnly || isGifCard(row)) &&
            (!rarity || row.rarity === rarity) &&
            (!duplicatesOnly || (Number(row.count) || 1) > 1)
          ));

          const unpricedCount = visibleRows
            .filter(({ row }) => !Number.isFinite(row.average)).length;
          const plural = visibleRows.length > 1 ? 's' : '';

          filterCount.textContent = filterActive
            ? `${visibleRows.length} carte${plural}${unpricedCount ? ` • ${unpricedCount} sans prix chargé` : ''}${note}`
            : '';

          renderedCount = 0;
          priceCells.clear();
          list.replaceChildren();
          list.scrollTop = 0;

          if (!visibleRows.length) {
            const empty = document.createElement('div');
            empty.className = 'wm-ranking-empty';
            empty.textContent = result?.state === 'loading'
              ? 'Chargement des cartes…'
              : 'Aucune carte ne correspond à ces filtres.';
            list.append(empty);
            return;
          }

          renderNextChunk();
        };

        starredInput.addEventListener('change', applyFilters);
        tagSelect.addEventListener('change', applyFilters);
        raritySelect.addEventListener('change', applyFilters);
        duplicatesInput.addEventListener('change', applyFilters);

        const observer = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            renderNextChunk();
          }
        }, {
          root: list,
          rootMargin: '250px 0px',
          threshold: 0
        });

        priceInput.addEventListener('input', onSaleSettingsChange);
        unitInput.addEventListener('change', onSaleSettingsChange);
        durationInput.addEventListener('change', onSaleSettingsChange);

        applyFilters();
        observer.observe(sentinel);

        const close = () => {
          closed = true;
          priceCells.clear();
          observer.disconnect();
          overlay.remove();
        };

        closeButton.addEventListener('click', close);
        overlay.addEventListener('click', (event) => {
          if (event.target === overlay) close();
        });

        modal.append(header, createCollectionValue(rows, status));
        if (cacheNotice) modal.append(cacheNotice);
        if (salesEnabled) modal.append(saleControls);
        modal.append(filters, list);
        overlay.append(modal);
        document.body.append(overlay);

        // Le menu propose toutes les étiquettes du joueur, pas seulement celles des cartes en cache.
        requestBridge('wm-average-load-tag-options').then((detail) => {
          if (closed || !detail.ok) return;
          addKnownTags(detail.tags);
          fillTagOptions();
        });

        // Marque les cartes déjà en vente au lieu de l'apprendre seulement après un clic qui échoue.
        if (salesEnabled) {
          requestBridge('wm-average-load-my-listings').then((mine) => {
            if (closed || !mine.ok || !mine.text) return;

            for (const { row } of filterableRows) {
              if (row.sale) continue;
              const ownedCardIds = Array.isArray(row.ownedCardIds) ? row.ownedCardIds : [];
              if (ownedCardIds.length && ownedCardIds.every((id) => mine.text.includes(id))) {
                setSale(row, {
                  state: 'success',
                  text: 'Déjà en vente',
                  title: 'Toutes tes copies disponibles sont déjà en vente.'
                });
              }
            }
          });
        }
      }


      window.addEventListener('wm-average-create-listing-progress', (event) => {
        const detail = event.detail || {};
        const pending = pendingMarketplaceListings.get(detail.requestId);
        if (!pending) return;

        if (detail.state === 'refreshing-id') {
          setSale(pending.row, { state: 'pending', text: 'ID expiré • recherche…' });
        } else if (detail.state === 'resolving-id') {
          setSale(pending.row, { state: 'pending', text: 'Recherche ID…' });
        }
      });

      window.addEventListener('wm-average-create-listing-result', (event) => {
        const detail = event.detail || {};
        const pending = pendingMarketplaceListings.get(detail.requestId);
        if (!pending) return;

        pendingMarketplaceListings.delete(detail.requestId);

        const { row, amount, duration } = pending;

        if (detail.needsStarredConfirmation) {
          // Classement fermé entre-temps : pas de question surprise, la vente est abandonnée.
          if (!row.sellButton?.isConnected) {
            setSale(row, null);
            return;
          }

          setSale(row, { state: 'pending', text: 'Confirmation…' });

          runtime.modalUi.showConfirmModal(
            'Vendre ton exemplaire favori ?',
            `« ${row.title} » : le seul exemplaire disponible est en favori. Le mettre en vente quand même ?`,
            { confirmLabel: 'Vendre le favori', cancelLabel: 'Garder la carte' }
          ).then((confirmed) => {
            if (!confirmed || !row.sellButton?.isConnected) {
              setSale(row, null);
              return;
            }

            requestListing({
              row,
              amount,
              duration,
              ownedCardId: detail.ownedCardId,
              allowStarred: true
            });
          });
          return;
        }

        if (detail.ok) {
          if (detail.ownedCardId) {
            const staleId = detail.staleOwnedCardId || null;

            row.ownedCardId = detail.ownedCardId;
            row.ownedCardIds = [
              ...new Set([
                ...(Array.isArray(row.ownedCardIds) ? row.ownedCardIds : [])
                  .filter((id) => id && id !== staleId),
                detail.ownedCardId
              ])
            ];

            const stored = storageGet(ALL_COLLECTION_KEY)[ALL_COLLECTION_KEY];
            if (Array.isArray(stored?.cards)) {
              const target = stored.cards.find((card) => card?.id === row.id);
              if (target) {
                target.ownedCardId = detail.ownedCardId;
                target.ownedCardIds = [
                  ...new Set([
                    ...(Array.isArray(target.ownedCardIds) ? target.ownedCardIds : [])
                      .filter((id) => id && id !== staleId),
                    detail.ownedCardId
                  ])
                ];
                storageSet({ [ALL_COLLECTION_KEY]: stored });
              }
            }
          }

          setSale(row, {
            state: 'success',
            text: 'En vente ✓',
            title: `${formatAverage(amount)} W pendant ${formatAverage(duration)} min`
          });
          return;
        }

        if (detail.notOwned) {
          const stored = storageGet(ALL_COLLECTION_KEY)[ALL_COLLECTION_KEY];

          if (Array.isArray(stored?.cards)) {
            stored.cards = stored.cards.filter((card) => card?.id !== row.id);
            storageSet({ [ALL_COLLECTION_KEY]: stored });
          }

          row.ownedCardId = null;
          row.ownedCardIds = [];

          setSale(row, {
            state: 'success',
            text: 'Plus possédée',
            title: 'Cette carte n’est plus dans ta collection.',
            unowned: true
          });
          return;
        }

        if (detail.alreadyListed) {
          setSale(row, {
            state: 'success',
            text: 'Déjà en vente',
            title: detail.error || 'Toutes tes copies disponibles sont déjà en vente.'
          });
          return;
        }

        const staleId = detail.staleOwnedCardId || (detail.ownershipError ? detail.ownedCardId : null);

        if (staleId) {
          if (row.ownedCardId === staleId) {
            row.ownedCardId = null;
          }
          row.ownedCardIds = (Array.isArray(row.ownedCardIds) ? row.ownedCardIds : [])
            .filter((id) => id && id !== staleId);

          const stored = storageGet(ALL_COLLECTION_KEY)[ALL_COLLECTION_KEY];
          if (Array.isArray(stored?.cards)) {
            const target = stored.cards.find((card) => card?.id === row.id);
            if (target) {
              if (target.ownedCardId === staleId) {
                target.ownedCardId = null;
              }
              target.ownedCardIds = (Array.isArray(target.ownedCardIds) ? target.ownedCardIds : [])
                .filter((id) => id && id !== staleId);
              storageSet({ [ALL_COLLECTION_KEY]: stored });
            }
          }
        }

        setSale(row, {
          state: 'error',
          text: detail.ownershipError ? 'ID invalide — réessayer' : 'Erreur — réessayer',
          title: detail.error || 'Impossible de mettre cette carte en vente.'
        });
      });


      return { openRankingModal, onPriceUpdated };
    }
  };
})();
