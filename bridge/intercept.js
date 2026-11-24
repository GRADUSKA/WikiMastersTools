(() => {
  const registry = window.__wmBridgeFeatures ||= {};

  registry.bridgeIntercept = {
    create(runtime) {
      const {
        originalFetch, emitCollection, isMarketplaceDetailApi, isMarketplaceListApi, isPacksOpenApi,
        isMarketplaceFeedApi, emitOwnership,
        isTradesApi, isGlobalCardsApi,
        getGlobalCollectionSummaryCardId, emitGlobalCollectionInspectedCard,
        emitTrades, fetchTrades,
        emitMarketplaceDetail, emitMarketplaceList, emitPackOpened
      } = runtime.core;

      window.fetch = (...args) => {
        const input = args[0];
        const url = typeof input === 'string' ? input : input?.url;
        const method = args[1]?.method || input?.method || 'GET';
        // Lecture seule : les requêtes du site partent telles quelles, l'extension n'en ajoute aucune.
        const fetchPromise = originalFetch(...args);

        fetchPromise.then((response) => {
          try {
            if (!response.ok) return;
            const input = args[0];
            const url = typeof input === 'string' ? input : input?.url;
            if (url && isGlobalCardsApi(url)) {
              if (getGlobalCollectionSummaryCardId(url)) emitGlobalCollectionInspectedCard(url);
            } else if (url && url.includes('/api/my-collection')) {
              response.clone().json().then(emitCollection).catch(() => {});
            } else if (url && isTradesApi(url)) {
              response.clone().json().then(emitTrades).catch(() => {});
            } else if (url && isMarketplaceDetailApi(url)) {
              response.clone().json().then(emitMarketplaceDetail).catch(() => {});
            } else if (url && isMarketplaceFeedApi(url) && method.toUpperCase() === 'GET') {
              response.clone().json().then((json) => {
                emitOwnership(json);
                if (isMarketplaceListApi(url)) emitMarketplaceList(json);
              }).catch(() => {});
            } else if (url && isPacksOpenApi(url)) {
              response.clone().json().then(emitPackOpened).catch(() => {});
            }
          } catch (_) {}
        }).catch(() => {
          // Ne pas transformer une erreur réseau du site en erreur de l'extension.
        });

        return fetchPromise;
      };

      const OriginalXHR = window.XMLHttpRequest;
      if (OriginalXHR) {
        const origOpen = OriginalXHR.prototype.open;
        const origSend = OriginalXHR.prototype.send;

        OriginalXHR.prototype.open = function(method, url, ...rest) {
          this.__wmUrl = typeof url === 'string' ? url : String(url || '');
          return origOpen.call(this, method, url, ...rest);
        };

        OriginalXHR.prototype.send = function(...args) {
          if (
            this.__wmUrl &&
            (
              this.__wmUrl.includes('/api/my-collection') ||
              isGlobalCardsApi(this.__wmUrl) ||
              isTradesApi(this.__wmUrl) ||
              isMarketplaceDetailApi(this.__wmUrl) ||
              isMarketplaceFeedApi(this.__wmUrl) ||
              isPacksOpenApi(this.__wmUrl)
            )
          ) {
            this.addEventListener('load', () => {
              if (this.status < 200 || this.status >= 300) return;

              if (isGlobalCardsApi(this.__wmUrl)) {
                if (getGlobalCollectionSummaryCardId(this.__wmUrl)) {
                  emitGlobalCollectionInspectedCard(this.__wmUrl);
                }
                return;
              }

              try {
                const json = JSON.parse(this.responseText);
                if (this.__wmUrl.includes('/api/my-collection')) {
                  emitCollection(json);
                } else if (isTradesApi(this.__wmUrl)) {
                  emitTrades(json);
                } else if (isMarketplaceDetailApi(this.__wmUrl)) {
                  emitMarketplaceDetail(json);
                } else if (isMarketplaceFeedApi(this.__wmUrl)) {
                  emitOwnership(json);
                  if (isMarketplaceListApi(this.__wmUrl)) emitMarketplaceList(json);
                } else if (isPacksOpenApi(this.__wmUrl)) {
                  emitPackOpened(json);
                }
              } catch (_) {}
            }, { once: true });
          }
          return origSend.apply(this, args);
        };
      }

      // Ni « Tout ouvrir » ni chargement complet de la collection : retirés, interdits par le règlement du site.
      window.addEventListener('wm-average-load-tag-cards', (event) => {
        const { requestId, tagId } = event.detail || {};
        if (!requestId || !tagId) return;
        runtime.collection.fetchTagCards(requestId, String(tagId));
      });

      window.addEventListener('wm-average-load-starred-cards', (event) => {
        const requestId = event.detail?.requestId;
        if (!requestId) return;
        runtime.collection.fetchStarredCards(requestId);
      });

      window.addEventListener('wm-average-load-tag-options', (event) => {
        const requestId = event.detail?.requestId;
        if (!requestId) return;
        runtime.collection.fetchTagOptions(requestId);
      });

      window.addEventListener('wm-average-load-trades', () => {
        fetchTrades();
      });


      return {};
    }
  };
})();
