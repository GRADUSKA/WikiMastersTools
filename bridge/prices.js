(() => {
  const registry = window.__wmBridgeFeatures ||= {};

  registry.bridgePrices = {
    create(runtime) {
      const { originalFetch } = runtime.core;
      const RARITIES = ['L', 'UR', 'SR', 'R', 'PC', 'C'];

      const isPrice = (value) =>
        (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
        Number.isFinite(Number(value)) && Number(value) >= 0;

      const RECENT_SALES_MS = 30 * 24 * 60 * 60 * 1000;

      // Même prix que l'onglet « Marché » du site : la moyenne de la semaine en cours,
      // ou de la dernière semaine qui a eu des ventes, pour chaque rareté.
      // Le nombre de ventes sur 30 jours dit si ce prix repose sur une vente isolée.
      function pricesFrom(json) {
        if (!json?.by_rarity || typeof json.by_rarity !== 'object' || Array.isArray(json.by_rarity)) return null;

        const averages = {};
        const sales = {};
        const since = new Date(Date.now() - RECENT_SALES_MS).toISOString().slice(0, 10);
        for (const [rarity, history] of Object.entries(json.by_rarity)) {
          if (!RARITIES.includes(rarity) || !Array.isArray(history?.weekly)) continue;
          const weeks = history.weekly
            .filter((week) => isPrice(week?.avg) && Number(week?.count) > 0 && typeof week?.start === 'string')
            .sort((a, b) => a.start.localeCompare(b.start));
          const last = weeks.at(-1);
          if (!last) continue;
          averages[rarity] = Number(last.avg);
          sales[rarity] = {
            recent: weeks
              .filter((week) => week.start.slice(0, 10) >= since)
              .reduce((sum, week) => sum + Number(week.count), 0),
            last: last.start.slice(0, 10)
          };
        }
        return { averages, sales };
      }

      function respond(detail) {
        window.dispatchEvent(new CustomEvent('wm-average-response', { detail }));
      }

      // Une seule requête par demande, sans nouvel essai automatique : c'est la personne qui reclique.
      window.addEventListener('wm-average-request', async (event) => {
        const { id, requestId } = event.detail || {};
        if (!id || !requestId) return;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 25000);

        try {
          const response = await originalFetch(
            `/api/marketplace/cards/${encodeURIComponent(id)}/price-history`,
            { signal: controller.signal, method: 'GET', credentials: 'include', headers: { accept: '*/*' } }
          );

          if (!response.ok) {
            const header = response.headers.get('Retry-After');
            const seconds = Number(header);
            const delay = header == null ? 0 : (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now());
            respond({
              requestId,
              id,
              ok: false,
              retryAfterMs: Math.max(60000, Math.min(300000, delay || 0)),
              retryAfterHintMs: Math.max(0, Math.min(300000, delay || 0)),
              rateLimited: response.status === 403 || response.status === 429,
              error: `HTTP ${response.status}`
            });
            return;
          }

          const json = await response.json();
          const prices = pricesFrom(json);
          if (!prices) throw new Error('Historique des prix inconnu');

          respond({ requestId, id, ok: true, title: json?.wikipedia_title || null, ...prices });
        } catch (error) {
          respond({ requestId, id, ok: false, retryAfterMs: 60000, error: String(error?.message || error || 'Erreur réseau') });
        } finally {
          clearTimeout(timeout);
        }
      });

      return {};
    }
  };
})();
