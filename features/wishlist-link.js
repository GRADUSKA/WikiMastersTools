(() => {
  const registry = window.__wmAverageFeatures ||= {};

  // Le site n'ajoute une carte à la liste de souhaits que depuis sa fiche dans « Toutes les cartes ».
  // Depuis le profil d'un joueur, on ouvre cette fiche dans un nouvel onglet : le clic d'ajout reste le tien.
  registry.wishlistLink = {
    create(runtime) {
      const {
        isGlobalCollectionPage, normalizeTitle, reportError, wait, waitFor, siteSearchInput, setSiteSearch
      } = runtime.core;
      const SETTING_KEY = 'wishlistLink';
      const HASH_PREFIX = '#wm-wish=';

      const isPlayerProfilePage = () => /^\/profile\/[^/]+/.test(location.pathname);

      function wishUrl(title) {
        return `/global-collection${HASH_PREFIX}${encodeURIComponent(title)}`;
      }

      function renderProfileButtons() {
        for (const card of document.querySelectorAll('main div[class*="glow-"][class*="cursor-pointer"]')) {
          const title = normalizeTitle(card.querySelector('h3')?.textContent);
          if (!title || card.querySelector(':scope > .wm-wish-button')) continue;

          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'wm-wish-button';
          button.textContent = '♡ Souhait';
          button.title = 'Ouvre cette carte dans « Toutes les cartes » pour l’ajouter à ta liste de souhaits';
          button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            window.open(wishUrl(title), '_blank', 'noopener');
          });
          card.append(button);
        }
      }

      const searchButton = () => [...document.querySelectorAll('main button')]
        .find((button) => button.textContent.trim() === 'Rechercher' && !button.closest('.wm-modal-overlay'));

      const findCard = (title) => [...document.querySelectorAll('main h3')]
        .find((h3) => normalizeTitle(h3.textContent) === title)
        ?.closest('div[class*="cursor-pointer"]');

      // Même recherche que si tu tapais le titre et cliquais sur « Rechercher », puis ouverture de la fiche.
      async function openWishedCard(title) {
        // Les cartes affichées prouvent que React a pris la main : une saisie plus tôt serait effacée.
        const ready = await waitFor(() => document.querySelector('main h3'), 15000);
        const input = ready && siteSearchInput();
        const button = input && searchButton();
        if (!button) {
          runtime.modalUi.showInfoModal('Recherche impossible', `Cherche « ${title} » à la main dans « Toutes les cartes ».`);
          return;
        }

        setSiteSearch(input, title);
        await wait(100);
        button.click();

        const card = await waitFor(() => findCard(title), 10000);
        if (card) card.click();
        else runtime.modalUi.showInfoModal('Carte introuvable', `« ${title} » n’apparaît pas dans la recherche du site.`);
      }

      function render() {
        if (!runtime.settings.isEnabled(SETTING_KEY)) return;

        if (isPlayerProfilePage()) renderProfileButtons();

        if (isGlobalCollectionPage() && location.hash.startsWith(HASH_PREFIX)) {
          let title = '';
          try {
            title = normalizeTitle(decodeURIComponent(location.hash.slice(HASH_PREFIX.length)));
          } catch (_) {}
          history.replaceState(history.state, '', location.pathname + location.search);
          if (title) openWishedCard(title).catch((error) => reportError('liste de souhaits', error));
        }
      }

      return { render, wishUrl };
    }
  };
})();
