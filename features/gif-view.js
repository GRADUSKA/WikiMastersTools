(() => {
  const registry = window.__wmAverageFeatures ||= {};

  registry.gifView = {
    create(runtime) {
      const {
        collectionReady, readCollection, isGifImage, isCollectionPage, RARITIES, cacheMemory, reportError
      } = runtime.core;
      const SETTING_KEY = 'gifView';
      let toolbarButton = null;

      function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
      }

      // Seule l'illustration fournie par le site compte : c'est celle que tous les joueurs voient.
      // Une image retrouvée sur Wikimedia par l'extension n'existe que pour toi.
      function gifCards() {
        const cards = readCollection()?.cards;
        return (Array.isArray(cards) ? cards : [])
          .filter((card) => card?.id && card?.title && isGifImage(card.imageUrl))
          .sort((a, b) => (
            RARITIES.indexOf(a.rarity) - RARITIES.indexOf(b.rarity) ||
            a.title.localeCompare(b.title, 'fr')
          ));
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

      const siteCard = (id) => [...document.querySelectorAll(`[data-wm-card-id="${CSS.escape(id)}"]`)]
        .find((node) => !node.closest('.wm-modal-overlay'));

      // Le champ est contrôlé par React : il faut passer par le setter natif pour qu'il voie la saisie.
      function setSiteSearch(input, value) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // Étiquettes, favori, enchères : tout passe par la fiche du site. On cherche la carte
      // comme si on tapait son titre, on ouvre sa fiche, puis on revient à la liste des GIF.
      // ponytail: seule la 1re page de résultats est regardée, un titre très courant peut échouer.
      async function openSiteCard(card, overlay, search) {
        const input = siteSearchInput();
        if (!input) return;
        if (!siteCard(card.id) && card.title.trim().length < 3) {
          runtime.modalUi.showInfoModal(
            'Recherche impossible',
            `La recherche du site demande au moins 3 caractères : cherche « ${card.title} » à la main dans ta collection.`
          );
          return;
        }

        overlay.style.display = 'none';
        try {
          if (!siteCard(card.id)) {
            search.previous ??= input.value;
            setSiteSearch(input, card.title);
          }

          const target = await waitFor(() => siteCard(card.id), 8000);
          if (!target) {
            runtime.modalUi.showInfoModal('Carte introuvable', `« ${card.title} » n’apparaît pas dans la recherche du site.`);
            return;
          }

          target.click();
          const sheet = await waitFor(() => document.querySelector('body > .sheet-overlay'), 3000);
          if (sheet) await waitFor(() => !sheet.isConnected, 60 * 60 * 1000);
        } finally {
          overlay.style.display = '';
        }
      }

      async function openGifView() {
        if (document.querySelector('.wm-gif-overlay')) return;
        await collectionReady;

        if (!readCollection()?.cards?.length) {
          runtime.modalUi.showInfoModal(
            'Collection non chargée',
            'Utilise d’abord « Charger les prix » : la liste des GIF se construit à partir de ta collection mémorisée.'
          );
          return;
        }

        const cards = gifCards();
        const overlay = el('div', 'wm-modal-overlay wm-gif-overlay');
        const modal = el('div', 'wm-modal wm-ranking-modal wm-gif-modal');

        const header = el('div', 'wm-ranking-header');
        const heading = el('div');
        heading.append(
          el('h2', null, 'Cartes GIF'),
          el('p', null, `${cards.length} carte${cards.length > 1 ? 's' : ''} dont l’illustration du site est un GIF • ` +
            'clique sur une carte pour ouvrir sa fiche (étiquettes, favori…)')
        );

        const closeButton = el('button', 'wm-ranking-close', '×');
        closeButton.type = 'button';
        closeButton.setAttribute('aria-label', 'Fermer');
        header.append(heading, closeButton);

        const grid = el('div', 'wm-gif-grid');
        if (!cards.length) grid.append(el('div', 'wm-gif-empty', 'Aucune carte GIF dans ta collection mémorisée.'));

        runtime.priceUi.hydrateCacheForCards(cards);
        for (const card of cards) {
          const element = runtime.cardExtras.createCardElement(card);
          if (!element) continue;
          grid.append(element);
          if (cacheMemory.has(card.id)) runtime.priceUi.renderCollectionCard(card.id, element);
        }

        modal.append(header, grid);
        overlay.append(modal);
        document.body.append(overlay);

        const search = { previous: null };
        grid.addEventListener('click', (event) => {
          const element = event.target.closest('[data-wm-card-id]');
          const card = element && cards.find(({ id }) => id === element.dataset.wmCardId);
          if (card) openSiteCard(card, overlay, search).catch((error) => reportError('GIFs', error));
        });

        const close = () => {
          overlay.remove();
          const input = siteSearchInput();
          if (search.previous != null && input) setSiteSearch(input, search.previous);
        };
        closeButton.addEventListener('click', close);
        overlay.addEventListener('click', (event) => {
          if (event.target === overlay) close();
        });
      }

      function render() {
        if (!runtime.settings.isEnabled(SETTING_KEY) || !isCollectionPage()) {
          toolbarButton?.remove();
          toolbarButton = null;
          return;
        }

        const bar = document.getElementById('wm-tools-bar');
        if (!bar || toolbarButton?.parentElement === bar) return;

        toolbarButton = el('button', 'wm-tool-button', 'GIFs');
        toolbarButton.type = 'button';
        toolbarButton.title = 'Affiche les cartes de ta collection dont l’illustration est un GIF';
        toolbarButton.addEventListener('click', () => {
          openGifView().catch((error) => reportError('GIFs', error));
        });
        bar.append(toolbarButton);
      }

      return { render };
    }
  };
})();
