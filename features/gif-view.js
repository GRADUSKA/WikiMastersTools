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
          el('p', null, `${cards.length} carte${cards.length > 1 ? 's' : ''} dont l’illustration du site est un GIF`)
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

        const close = () => overlay.remove();
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
