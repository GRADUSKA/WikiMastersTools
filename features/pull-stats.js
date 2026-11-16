(() => {
  const registry = window.__wmAverageFeatures ||= {};

  registry.pullStats = {
    create(deps) {
      const {
        RARITIES, PULL_STATS_KEY, readLocalValue, writeLocalValue, isPullsPage, isFeatureEnabled,
        priceEntry, chooseAverage, formatAverage
      } = deps;
      let nextValuationAt = 0;
      // Paquets dont tous les prix ne sont pas encore connus : comptés dès que le récap les a chargés.
      const MAX_PENDING_PACKS = 200;

      function readPullStats() {
        const raw = readLocalValue(PULL_STATS_KEY) || {};
        const counts = {};

        for (const rarity of RARITIES) {
          counts[rarity] = Math.max(0, Number(raw?.counts?.[rarity]) || 0);
        }

        const amount = (value) => Math.max(0, Number(value) || 0);

        return {
          counts,
          total: RARITIES.reduce((sum, rarity) => sum + counts[rarity], 0),
          value: {
            packs: amount(raw?.value?.packs),
            total: amount(raw?.value?.total),
            best: amount(raw?.value?.best)
          },
          pending: Array.isArray(raw?.pending) ? raw.pending.filter(Array.isArray) : []
        };
      }

      function writePullStats(stats) {
        writeLocalValue(PULL_STATS_KEY, {
          counts: stats.counts,
          value: stats.value,
          pending: stats.pending,
          updatedAt: Date.now()
        });
      }

      // Valeur au prix moyen connu au moment où le dernier prix du paquet arrive.
      function valuePendingPacks(stats) {
        const before = stats.pending.length;

        stats.pending = stats.pending.filter((pack) => {
          const prices = pack.map((card) => {
            const entry = priceEntry(card?.id);
            if (!entry || entry.ok === false) return undefined;
            return chooseAverage(entry, null, card.rarity || null) ?? 0;
          });
          if (prices.includes(undefined)) return true;

          const packValue = prices.reduce((sum, price) => sum + price, 0);
          stats.value.packs += 1;
          stats.value.total += packValue;
          stats.value.best = Math.max(stats.value.best, packValue);
          return false;
        });

        return stats.pending.length !== before;
      }

      function recordPullStats(cards) {
        if (!isFeatureEnabled('pullStats')) return;
        if (!Array.isArray(cards) || !cards.length) return;

        const stats = readPullStats();

        for (const card of cards) {
          if (!RARITIES.includes(card?.rarity)) continue;
          stats.counts[card.rarity] += 1;
          stats.total += 1;
        }

        const pack = cards
          .filter((card) => card?.id)
          .map((card) => ({ id: card.id, rarity: card.rarity || null }));
        if (pack.length) stats.pending = [...stats.pending, pack].slice(-MAX_PENDING_PACKS);
        valuePendingPacks(stats);

        writePullStats(stats);
        renderPullStats();
      }
    
      function renderPullStats() {
        if (!isFeatureEnabled('pullStats')) {
          document.getElementById('wm-pull-stats')?.remove();
          return;
        }
        if (!isPullsPage()) return;
    
        const info = document.getElementById('wm-pulls-info');
        if (!info?.parentElement) return;
    
        const stats = readPullStats();
        // Le rendu suit chaque changement de la page : la relecture des prix attend 5 s entre deux passages.
        if (stats.pending.length && Date.now() >= nextValuationAt) {
          nextValuationAt = Date.now() + 5000;
          if (valuePendingPacks(stats)) writePullStats(stats);
        }
        const key = [
          ...RARITIES.map((rarity) => stats.counts[rarity]),
          stats.value.packs, Math.round(stats.value.total), stats.pending.length
        ].join(':');
    
        let panel = document.getElementById('wm-pull-stats');
        if (panel?.dataset.wmStatsKey === key) return;
    
        if (!panel) {
          panel = document.createElement('section');
          panel.id = 'wm-pull-stats';
          panel.className = 'wm-pull-stats';
          info.insertAdjacentElement('afterend', panel);
        }
    
        panel.dataset.wmStatsKey = key;
    
        const head = document.createElement('div');
        head.className = 'wm-pull-stats-head';
    
        const title = document.createElement('strong');
        title.className = 'wm-pull-stats-title';
        title.textContent = 'Vos statistiques';
    
        const total = document.createElement('span');
        total.className = 'wm-pull-stats-total';
        total.textContent = `${stats.total} carte${stats.total > 1 ? 's' : ''}`;
    
        head.append(title, total);
    
        if (stats.total === 0) {
          const empty = document.createElement('div');
          empty.className = 'wm-pull-stats-note';
          empty.textContent = 'Aucune carte comptée pour le moment. Ouvrez un paquet pour commencer.';
    
          panel.replaceChildren(head, empty);
          return;
        }
    
        const rows = document.createElement('div');
        rows.className = 'wm-pull-stats-rows';
    
        for (const rarity of RARITIES) {
          const count = stats.counts[rarity];
          const percent = stats.total > 0 ? (count / stats.total) * 100 : 0;
    
          const row = document.createElement('div');
          row.className = 'wm-pull-stat-row';
          row.dataset.rarity = rarity.toLowerCase();
    
          const label = document.createElement('span');
          label.className = 'wm-pull-stat-label';
          label.textContent = rarity;
    
          const track = document.createElement('span');
          track.className = 'wm-pull-stat-track';
    
          if (count > 0) {
            const bar = document.createElement('span');
            bar.className = 'wm-pull-stat-bar';
            bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
            track.append(bar);
          }
    
          const share = document.createElement('span');
          share.className = 'wm-pull-stat-percent';
          share.textContent = `${percent.toLocaleString('fr-FR', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 1
          })} %`;
    
          const amount = document.createElement('span');
          amount.className = 'wm-pull-stat-count';
          amount.textContent = String(count);
    
          row.append(label, track, share, amount);
          rows.append(row);
        }
    
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'wm-pull-stats-reset';
        reset.textContent = 'Réinitialiser les statistiques';
        reset.addEventListener('click', () => {
          if (!confirm('Réinitialiser toutes les statistiques de tirage ?')) return;
          localStorage.removeItem(PULL_STATS_KEY);
          panel.dataset.wmStatsKey = '';
          renderPullStats();
        });
    
        const valueNote = document.createElement('div');
        valueNote.className = 'wm-pull-stats-note';
        const parts = [];
        if (stats.value.packs > 0) {
          parts.push(
            `Valeur moyenne par paquet : ${formatAverage(Math.round(stats.value.total / stats.value.packs))} W`,
            `meilleur paquet : ${formatAverage(Math.round(stats.value.best))} W`,
            `total tiré : ${formatAverage(Math.round(stats.value.total))} W (${stats.value.packs} paquet${stats.value.packs > 1 ? 's' : ''})`
          );
        }
        if (stats.pending.length) {
          parts.push(`${stats.pending.length} paquet${stats.pending.length > 1 ? 's' : ''} en attente de prix`);
        }
        valueNote.textContent = parts.join(' · ');

        panel.replaceChildren(head, rows, ...(parts.length ? [valueNote] : []), reset);
      }
    
    
      return { recordPullStats, renderPullStats };
    }
  };
})();
