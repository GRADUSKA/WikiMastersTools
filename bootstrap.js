function getExtensionRuntime() {
  return (typeof browser !== 'undefined' && browser?.runtime)
    ? browser.runtime
    : (typeof chrome !== 'undefined' && chrome?.runtime)
      ? chrome.runtime
      : null;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  (() => {
    if (window.__wmAverageBootstrapInjected) return;
    window.__wmAverageBootstrapInjected = true;

    // Pont page -> contexte extension : écriture d'une image PNG dans le presse-papiers.
    window.addEventListener('message', async (event) => {
      if (event.source !== window) return;

      const message = event.data;
      if (
        !message ||
        message.source !== 'wm-average-page' ||
        typeof message.requestId !== 'string'
      ) {
        return;
      }

      if (
        message.type !== 'copy-card-image' ||
        typeof message.dataUrl !== 'string'
      ) {
        return;
      }

      const reply = (ok, error = null) => {
        window.postMessage({
          source: 'wm-average-extension',
          type: 'copy-card-image-result',
          requestId: message.requestId,
          ok,
          error
        }, '*');
      };

      try {
        const response = await fetch(message.dataUrl);
        const blob = await response.blob();

        if (
          typeof ClipboardItem === 'function' &&
          typeof navigator.clipboard?.write === 'function'
        ) {
          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blob })
          ]);
          reply(true);
          return;
        }

        throw new Error('API de copie d’image indisponible');
      } catch (error) {
        console.error('[WM Average] copie image extension impossible', error);
        reply(false, String(error?.message || error));
      }
    });

    // Posé dès document_start : le CSS peut masquer le design WikiMasters
    // avant le premier paint, sauf si l'utilisateur a désactivé les cartes premium.
    let premiumCardsEnabled = true;
    try {
      const saved = JSON.parse(localStorage.getItem('wm_feature_settings_v1') || 'null');
      premiumCardsEnabled = saved?.premiumCards !== false;
    } catch (_) {}

    if (premiumCardsEnabled) {
      document.documentElement?.classList.add('wm-premium-cards-enabled');
    }

    const extensionRuntime = getExtensionRuntime();
    if (!extensionRuntime?.getURL) return;
    document.documentElement.dataset.wmExtensionVersion = extensionRuntime.getManifest?.().version || 'unknown';

    const paths = [
      'bridge/core.js',
      'bridge/collection.js',
      'bridge/packs.js',
      'bridge/intercept.js',
      'bridge/marketplace.js',
      'bridge/prices.js',
      'page-bridge.js',
      'features/core.js',
      'features/settings.js',
      'features/image-resolver.js',
      'features/price-ui.js',
      'features/price-loader.js',
      'features/card-extras.js',
      'features/pull-stats.js',
      'features/compact-mode.js',
      'features/trades.js',
      'features/modal-ui.js',
      'features/packs.js',
      'features/ranking.js',
      'features/collection-bulk.js',
      'features/gif-view.js',
      'features/extra-tools.js',
      'features/theme-tracker.js',
      'features/my-bids-logic.js',
      'features/my-bids.js',
      'features/app.js',
      'content.js'
    ];

    const parent = document.head || document.documentElement;

    const injectScript = (path) => new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = extensionRuntime.getURL(path);
      script.async = false;
      script.dataset.wmAverageInjected = '1';

      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener('error', () => {
        reject(new Error(`Impossible de charger ${path}`));
      }, { once: true });

      parent.appendChild(script);
    });

    // async = false : les scripts se téléchargent en parallèle mais s'exécutent dans l'ordre.
    Promise.all(paths.map(injectScript)).catch((error) => {
      // Évite de laisser les cartes masquées si l'initialisation de l'extension échoue.
      document.documentElement?.classList.remove('wm-premium-cards-enabled');
      console.error('[WM Average] chargement interrompu', error);
    });
  })();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getExtensionRuntime };
}