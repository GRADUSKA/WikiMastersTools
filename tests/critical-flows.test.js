const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function harness(files, extras = {}) {
  const timers = new Map();
  let now = Date.parse('2026-10-05T12:00:00Z');
  let seq = 0;
  const window = new EventTarget();
  const context = vm.createContext({
    window, console: { debug() {}, warn() {}, error() {} }, CustomEvent,
    AbortController, Response, URL, Headers, structuredClone, navigator: {}, CSS: { escape: v => v },
    location: { origin: 'https://www.wiki-masters.com', pathname: '/collection' },
    document: {}, localStorage: { getItem() { return null; }, setItem() {} },
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, delay) { const id = ++seq; timers.set(id, {fn, at:now + delay}); return id; },
    clearTimeout(id) { timers.delete(id); }, ...extras
  });
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  return {
    window, context, timers,
    send(type, detail) { window.dispatchEvent(new CustomEvent(type, { detail })); },
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers].filter(([,timer]) => timer.at <= target).sort((a,b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = target; await flush();
    }
  };
}
function priceHarness(extras) {
  const h = harness(['features/core.js','features/price-ui.js','features/price-loader.js'], extras);
  const registry = h.window.__wmAverageFeatures;
  const core = registry.core.create();
  const runtime = { core, settings: { isEnabled: () => true } };
  runtime.priceUi = registry.priceUi.create(runtime);
  runtime.priceLoader = registry.priceLoader.create(runtime);
  return { ...h, core, runtime };
}
function packHarness(fetch, navigator) {
  const h = harness(['bridge/packs.js'], { navigator: navigator || {
    locks: { request: (_name, _options, callback) => Promise.resolve().then(() => callback({})) }
  }});
  const packs = h.window.__wmBridgeFeatures.bridgePacks.create({core:{
    originalFetch: fetch, MAX_BULK_PACKS: 100,
    mapPackCards: json => Array.isArray(json?.cards) ? json.cards : []
  }});
  const results = [], progress = [];
  h.window.addEventListener('wm-average-open-all-packs-result', e => results.push(e.detail));
  h.window.addEventListener('wm-average-open-all-packs-progress', e => progress.push(e.detail));
  return { ...h, packs, results, progress };
}
const response = (body, status = 200) => new Response(JSON.stringify(body), {status});
const card = {id:'a', title:'Carte A', rarity:'C'};

test('un prix manquant ne reprend jamais la moyenne d’une autre rareté', () => {
  const {runtime} = priceHarness();
  const choose = runtime.priceUi.chooseAverage;
  assert.equal(choose({ok:true, averages:{UR:200}}, null, 'C'), null);
  assert.equal(choose({ok:true, averages:{UR:200}}, null), 200);
  assert.equal(choose({ok:true, averages:{C:3,UR:200}}, null), null);
  assert.equal(choose({ok:false, averages:{C:3}}, null, 'C'), null);
});

test('null, valeurs vides, booléens et prix négatifs ne deviennent pas des prix', () => {
  const {runtime} = priceHarness();
  for (const value of [null, undefined, '', ' ', false, true, -1, Infinity, NaN, 'invalide']) {
    assert.equal(runtime.priceUi.chooseAverage({ok:true, averages:{C:value}}, null, 'C'), null);
  }
  for (const value of [0, '0', 2.5, '2.5']) {
    assert.equal(runtime.priceUi.chooseAverage({ok:true, averages:{C:value}}, null, 'C'), Number(value));
  }
});

test('cache : un prix obtenu ne périme jamais, Retry-After borné et horodatages futurs rejetés', () => {
  const {core} = priceHarness();
  const now = 100000000;
  const entry = {ok:true, fetchedAt:now, averages:{C:3}};
  assert.equal(core.isCacheEntryValid(entry, now), true);
  assert.equal(core.isCacheEntryValid(entry, now + 365 * core.CACHE_TTL), true);
  assert.equal(core.isCacheEntryValid(entry, now - 1), false);
  assert.equal(core.isCacheEntryValid({...entry,ok:false,retryAfterMs:120000}, now + 90000), true);
  assert.equal(core.isCacheEntryValid({...entry,ok:false,retryAfterMs:Infinity}, now + 300000), false);
  assert.equal(core.isCacheEntryValid({fetchedAt:now}, now), false);
});

test('la réponse met à jour tous les exemplaires et respecte leur rareté affichée', () => {
  const badges = [];
  const cards = ['C','UR','UR'].map(rarity => {
    const badge = {className:'wm-average-badge', classList:{contains:() => false}, parentElement:{}, textContent:'Prix…', dataset:{}};
    badges.push(badge);
    return {dataset:{wmCardId:'a'}, querySelector:selector => selector === '.wm-average-badge' ? badge : null,
      querySelectorAll:() => [{textContent:rarity}]};
  });
  const {core, runtime} = priceHarness({document:{querySelectorAll:() => cards}});
  core.cardMetaById.set('a', {id:'a', title:'A', rarity:'UR'});
  core.cacheMemory.set('a', {ok:true, averages:{C:2,UR:200}});
  runtime.priceUi.renderKnownCard('a');
  assert.deepEqual(badges.map(b => b.textContent), ['Moy. 2 W','Moy. 200 W','Moy. 200 W']);
});

test('des milliers de prix rendus dans la même tâche ne parcourent la page qu’une fois', async () => {
  let scans = 0;
  const badge = {classList:{contains:() => true}, parentElement:{}, textContent:'Prix…', dataset:{}};
  const cards = ['a','b'].map(id => ({dataset:{wmCardId:id}, querySelector:selector => selector === '.wm-average-badge' ? badge : null, querySelectorAll:() => []}));
  const document = {querySelectorAll:selector => { if (selector === '[data-wm-card-id]') scans++; return selector === '[data-wm-card-id]' ? cards : []; }};
  const {runtime} = priceHarness({document});
  for (let n = 0; n < 1000; n++) runtime.priceUi.renderKnownCard(n % 2 ? 'a' : 'b');
  assert.equal(scans,1);
  await flush();
  runtime.priceUi.renderKnownCard('a');
  assert.equal(scans,2);
});

test('un paquet tiré est valorisé dès que tous ses prix sont connus', () => {
  const h = harness(['features/pull-stats.js']);
  const prices = new Map([['a',{ok:true,averages:{C:2}}]]);
  const store = new Map();
  const stats = h.window.__wmAverageFeatures.pullStats.create({
    RARITIES:['L','UR','SR','R','PC','C'], PULL_STATS_KEY:'s',
    readLocalValue: key => store.get(key), writeLocalValue: (key, value) => store.set(key, structuredClone(value)),
    isPullsPage: () => false, isFeatureEnabled: () => true,
    priceEntry: id => prices.get(id), chooseAverage: (entry, _el, rarity) => entry.averages[rarity] ?? null, formatAverage: String
  });

  stats.recordPullStats([{id:'a',rarity:'C'},{id:'b',rarity:'UR'}]);
  assert.equal(store.get('s').value.packs,0);
  assert.equal(store.get('s').pending.length,1);

  prices.set('b',{ok:true,averages:{UR:100}});
  stats.recordPullStats([{id:'a',rarity:'C'}]);
  assert.deepEqual(store.get('s').value,{packs:2,total:104,best:102});
  assert.equal(store.get('s').pending.length,0);
  assert.equal(store.get('s').counts.C,2);
});

function loaderHarness(extras) {
  const h = priceHarness(extras);
  const requests = [], rendered = [];
  h.runtime.priceUi = {renderKnownCard:id => rendered.push(id)};
  const progress = [];
  let finished = 0;
  h.runtime.collectionBulk = {updateBulkProgress:(...args) => progress.push(args), finishBulkLoad:() => finished++};
  h.window.addEventListener('wm-average-request', e => requests.push(e.detail));
  const loader = h.window.__wmAverageFeatures.priceLoader.create(h.runtime);
  return {...h, loader, requests, rendered, progress, finished:() => finished};
}

const cards = ids => ids.map(id => ({...card,id}));
const answer = (h, request, averages = {C:1}) => h.send('wm-average-response',{...request,ok:true,averages});

test('sans clic, aucun prix n’est demandé au site', () => {
  const h = loaderHarness();
  h.loader.loadCacheForCards(cards(['a','b','c']));
  h.loader.loadCacheForCards(cards(['d']), {priority:true, markBulk:true});
  assert.equal(h.requests.length, 0);
  assert.equal(h.loader.isPending('a'), false);
});

test('un prix connu reste affiché quel que soit son âge, sans être redemandé', async () => {
  const store = new Map([['wm_avg_v4_a', JSON.stringify({ok:true,fetchedAt:Date.parse('2026-01-01T00:00:00Z'),averages:{C:7}})]]);
  const h = loaderHarness({ localStorage: {
    getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => store.set(key, value)
  }});
  h.loader.loadCacheForCards([card]);
  assert.equal(h.core.cacheMemory.get('a').averages.C, 7);
  assert.equal(h.requests.length, 0);
  // Un clic sur un prix ancien le redemande.
  h.loader.loadCacheForCards([card], {manual:true});
  assert.equal(h.requests.length, 1);
});

test('les clics partent une carte à la fois, espacées de 4 s, sans doublon', async () => {
  const h = loaderHarness();
  h.loader.loadCacheForCards(cards(['a','a','b']), {manual:true});
  h.loader.loadCacheForCards(cards(['b']), {manual:true});
  assert.deepEqual(h.requests.map(r => r.id), ['a']);
  answer(h, h.requests[0]);
  assert.equal(h.requests.length, 1);
  await h.advance(3999); assert.equal(h.requests.length, 1);
  await h.advance(1); assert.deepEqual(h.requests.map(r => r.id), ['a','b']);
  answer(h, h.requests[1]);
  await h.advance(60000); assert.equal(h.requests.length, 2);
});

test('un clic sur un prix de moins d’un jour n’envoie rien ; les communes restent fraîches 7 jours', async () => {
  const h = loaderHarness();
  h.loader.loadCacheForCards([{...card,id:'c1',rarity:'C'}], {manual:true});
  answer(h, h.requests[0]);
  await h.advance(4000);
  h.loader.loadCacheForCards([{...card,id:'r1',rarity:'R'}], {manual:true});
  answer(h, h.requests[1], {R:100});
  await h.advance(60000);
  h.loader.loadCacheForCards([{...card,id:'c1',rarity:'C'},{...card,id:'r1',rarity:'R'}], {manual:true});
  assert.equal(h.requests.length, 2);

  const start = Date.parse('2026-10-05T12:00:00Z'), day = 24 * 60 * 60 * 1000;
  assert.equal(h.loader.isFresh(h.core.cacheMemory.get('c1'), start + 3 * day), true);
  assert.equal(h.loader.isFresh(h.core.cacheMemory.get('r1'), start + day + 5000), false);
});

test('les réponses inconnues et dupliquées ne libèrent aucun emplacement', async () => {
  const h = loaderHarness();
  h.loader.loadCacheForCards(cards(['a','b']), {manual:true});
  h.send('wm-average-response',{requestId:'inconnu',id:'b',ok:true});
  await h.advance(5000);
  assert.equal(h.requests.length, 1);
  answer(h, h.requests[0]);
  answer(h, h.requests[0], {C:999});
  assert.equal(h.core.cacheMemory.get('a').averages.C, 1);
});

test('une requête sans réponse expire et la file reprend', async () => {
  const h = loaderHarness();
  h.loader.loadCacheForCards(cards(['a','b']), {manual:true});
  await h.advance(80000);
  assert.equal(h.requests.length, 2);
  assert.equal(h.core.cacheMemory.get('a').ok, false);
  answer(h, h.requests[0], {C:999});
  assert.equal(h.core.cacheMemory.get('a').ok, false);
});

test('un échec ne remplace pas un ancien prix, une erreur de rendu ne bloque pas la file', async () => {
  const h = loaderHarness();
  h.loader.loadCacheForCards(cards(['a','b']), {manual:true});
  answer(h, h.requests[0]);
  await h.advance(4000);
  h.runtime.priceUi.renderKnownCard = () => { throw new Error('DOM retiré'); };
  answer(h, h.requests[1]);
  h.core.cacheMemory.set('a', {...h.core.cacheMemory.get('a'), fetchedAt: Date.now() - 2 * 24 * 60 * 60 * 1000});
  h.runtime.priceUi.renderKnownCard = () => {};
  await h.advance(4000);
  h.loader.loadCacheForCards(cards(['a']), {manual:true});
  h.send('wm-average-response',{...h.requests.at(-1),ok:false});
  assert.equal(h.core.cacheMemory.get('a').ok, true);
});

test('un blocage du site arrête tout : clics en attente abandonnés, pause d’au moins 10 min', async () => {
  const h = loaderHarness();
  h.loader.loadCacheForCards(cards(['a','b','c']), {manual:true});
  h.send('wm-average-response',{...h.requests[0],ok:false,rateLimited:true,retryAfterHintMs:5000});
  assert.equal(h.loader.isPending('b'), false);
  assert.equal(h.core.cacheMemory.has('a'), false);
  await h.advance(60 * 60 * 1000);
  assert.equal(h.requests.length, 1);
});

test('pendant la pause d’un autre onglet, un clic n’envoie rien et n’est pas rejoué', async () => {
  const store = new Map([['wm_price_block_until_v1', String(Date.parse('2026-10-05T12:00:00Z') + 30000)]]);
  const h = loaderHarness({ localStorage: {
    getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => store.set(key, value)
  }});
  assert.equal(h.loader.isBlocked(), true);
  h.loader.loadCacheForCards([card], {manual:true});
  await h.advance(60000);
  assert.equal(h.requests.length,0);
  h.loader.loadCacheForCards([card], {manual:true});
  assert.equal(h.requests.length,1);
});

test('Tout ouvrir conserve les cartes et s’arrête quand le serveur annonce zéro', async () => {
  let calls = 0;
  const h = packHarness(async () => response({cards:[card],packs_remaining:++calls === 1 ? 1 : 0}));
  const run = h.packs.openAllPacks('x');
  await flush(); await h.advance(2000); await run;
  assert.equal(calls,2);
  assert.equal(h.results[0].openedPacks,2);
  assert.equal(h.results[0].cards.length,2);
  assert.equal(h.results[0].ok,true);
});

test('un compteur null ne signifie pas zéro paquet restant', async () => {
  let calls = 0;
  const h = packHarness(async () => response({cards:[card],packs_remaining:++calls === 1 ? null : 0}));
  const run = h.packs.openAllPacks('x');
  await flush(); await h.advance(2000); await run;
  assert.equal(calls,2);
});

test('Arrêter interrompt l’attente sans perdre le paquet déjà ouvert', async () => {
  let calls = 0;
  const h = packHarness(async () => { calls++; return response({cards:[card],packs_remaining:8}); });
  const run = h.packs.openAllPacks('x');
  await flush(); h.send('wm-average-cancel-open-all-packs',{requestId:'x'}); await run;
  assert.equal(calls,1);
  assert.equal(h.results[0].cancelled,true);
  assert.equal(h.results[0].cards.length,1);
});

test('Arrêter pendant le POST attend la réponse et conserve ses cartes', async () => {
  let resolve;
  const h = packHarness(() => new Promise(r => {resolve=r;}));
  const run = h.packs.openAllPacks('x'); await flush();
  h.packs.cancelOpenAllPacks('x');
  resolve(response({cards:[card],packs_remaining:8})); await run;
  assert.equal(h.results[0].openedPacks,1);
  assert.equal(h.results[0].cards.length,1);
  assert.equal(h.results[0].cancelled,true);
});

test('une erreur réseau sur POST ne déclenche jamais de nouvel essai', async () => {
  let calls = 0;
  const h = packHarness(async () => { calls++; throw new Error('network'); });
  await h.packs.openAllPacks('x');
  assert.equal(calls,1);
  assert.equal(h.results[0].ok,false);
  assert.match(h.results[0].error,/peut avoir été consommé/);
});

test('une erreur après un paquet conserve le résultat partiel', async () => {
  let calls = 0;
  const h = packHarness(async () => ++calls === 1 ? response({cards:[card],packs_remaining:2}) : response({error:'Maintenance'},503));
  const run = h.packs.openAllPacks('x'); await flush(); await h.advance(2000); await run;
  assert.equal(calls,2);
  assert.equal(h.results[0].ok,false);
  assert.equal(h.results[0].cards.length,1);
});

test('une limite quotidienne termine immédiatement le lot', async () => {
  let calls = 0;
  const h = packHarness(async () => { calls++; return response({rate_limited:true,rate_limit_daily:true,retry_after:new Date(Date.now()+5000).toISOString()},429); });
  await h.packs.openAllPacks('x');
  assert.equal(calls,1);
  assert.equal(h.results[0].ok,false);
});

test('une limitation temporaire attend la date serveur puis reprend', async () => {
  let calls = 0;
  const h = packHarness(async () => ++calls === 1 ? response({rate_limited:true,retry_after:'2026-10-05T12:00:01Z',packs_remaining:1},429) : response({cards:[card],packs_remaining:0}));
  const run = h.packs.openAllPacks('x'); await flush();
  assert.equal(calls,1); await h.advance(1199); assert.equal(calls,1);
  await h.advance(1); await run;
  assert.equal(calls,2);
  assert.equal(h.results[0].ok,true);
});

test('une attente excessive et des limitations répétées sont bornées', async () => {
  const excessive = packHarness(async () => response({rate_limited:true,retry_after:'2026-10-05T12:10:00Z'},429));
  await excessive.packs.openAllPacks('x');
  assert.equal(excessive.results[0].ok,false);
  let calls = 0;
  const repeated = packHarness(async () => { calls++; return response({rate_limited:true,retry_after:'2026-10-05T12:00:00Z'},429); });
  const run = repeated.packs.openAllPacks('x'); await flush(); await repeated.advance(1500); await run;
  assert.equal(calls,6);
  assert.equal(repeated.results[0].ok,false);
});

test('le verrou empêche les lots concurrents entre onglets', async () => {
  let locked = false, calls = 0;
  const navigator = {locks:{async request(_name,_options,callback) {
    if (locked) return callback(null);
    locked=true;
    try { return await callback({}); } finally { locked=false; }
  }}};
  const first = packHarness(async () => {calls++; return response({cards:[card],packs_remaining:8});},navigator);
  const second = packHarness(async () => {calls++; return response({cards:[card],packs_remaining:8});},navigator);
  const run = first.packs.openAllPacks('a'); await flush();
  await second.packs.openAllPacks('b');
  assert.equal(calls,1);
  assert.match(second.results[0].error,/autre onglet/);
  assert.equal(second.results[0].lockBusy,true);
  first.packs.cancelOpenAllPacks('a'); await run;
  assert.equal(first.results[0].lockBusy,false);
});

test('un blocage 403 sans JSON attend puis reprend au lieu d’annoncer un paquet perdu', async () => {
  let calls = 0;
  const h = packHarness(async () => ++calls === 1 ? new Response('<html>Forbidden</html>', {status:403}) : response({cards:[card],packs_remaining:0}));
  const run = h.packs.openAllPacks('x'); await flush();
  assert.equal(calls,1); await h.advance(60199); assert.equal(calls,1);
  await h.advance(1); await run;
  assert.equal(calls,2);
  assert.equal(h.results[0].ok,true);
  assert.equal(h.progress[0].waiting,true);
});

test('deux mises en vente simultanées de la même carte n’envoient qu’une annonce', async () => {
  const h = harness(['bridge/marketplace.js']);
  let posts = 0, release;
  h.window.__wmBridgeFeatures.bridgeMarketplace.create({core:{
    originalFetch: async () => { posts++; await new Promise(resolve => { release = resolve; }); return response({id:'l1'}); },
    fetchJsonRetry: async () => ({}), extractCards: () => [], sleep: async () => {},
    emitMarketplaceDetail() {}, MAX_COLLECTION_PAGES: 1, MARKETPLACE_MINE_CACHE_TTL: 60000
  }});
  const results = [];
  h.window.addEventListener('wm-average-create-listing-result', e => results.push(e.detail));
  const sell = requestId => h.send('wm-average-create-listing', {requestId, ownedCardId:'o1', catalogueCardId:'a', title:'A', baseAmount:10, durationMinutes:10});

  sell('r1'); await flush(); sell('r2'); await flush();
  assert.equal(posts,1);
  assert.equal(results.length,1);
  assert.equal(results[0].requestId,'r2');
  assert.match(results[0].error,/déjà en cours/);

  release(); await flush();
  assert.equal(results[1].requestId,'r1');
  assert.equal(results[1].ok,true);

  sell('r3'); await flush();
  assert.doesNotMatch(results[2].error || '',/déjà en cours/);
});

test('« Plus chères » peut demander à l’avance les ventes en cours', async () => {
  const h = harness(['bridge/marketplace.js']);
  h.window.__wmBridgeFeatures.bridgeMarketplace.create({core:{
    originalFetch: async () => response({}),
    fetchJsonRetry: async () => ({listings:[{owned_card_id:'o1'}]}),
    extractCards: () => [], sleep: async () => {}, emitMarketplaceDetail() {},
    MAX_COLLECTION_PAGES: 1, MARKETPLACE_MINE_CACHE_TTL: 60000
  }});
  const responses = [];
  h.window.addEventListener('wm-average-my-listings', e => responses.push(e.detail));
  h.send('wm-average-load-my-listings', {requestId:'r1'});
  await flush();

  assert.equal(responses[0].ok,true);
  assert.match(responses[0].text,/o1/);
  assert.doesNotMatch(responses[0].text,/o2/);
});

test('un événement dupliqué ne lance pas un nouveau lot', async () => {
  let calls=0;
  const h = packHarness(async () => {calls++; return response({cards:[card],packs_remaining:8});});
  const run=h.packs.openAllPacks('a'); await flush();
  await h.packs.openAllPacks('a');
  assert.equal(h.results.length,0);
  assert.equal(calls,1);
  h.packs.cancelOpenAllPacks('a'); await run;
  assert.equal(h.results.length,1);
});

test('un serveur sans paquets est une fin normale', async () => {
  const h = packHarness(async () => response({packs_remaining:0,error:'Aucun paquet'},400));
  await h.packs.openAllPacks('x');
  assert.equal(h.results[0].ok,true);
  assert.equal(h.results[0].openedPacks,0);
});

test('un POST bloqué expire sans être relancé', async () => {
  let calls=0;
  const h = packHarness((_url,{signal}) => new Promise((_resolve,reject) => {
    calls++; signal.addEventListener('abort',() => reject(new Error('aborted')));
  }));
  const run = h.packs.openAllPacks('x'); await flush(); await h.advance(30000); await run;
  assert.equal(calls,1);
  assert.equal(h.results[0].ok,false);
});

function salesHarness(fetch) {
  const h = harness(['bridge/prices.js']);
  h.window.__wmBridgeFeatures.bridgePrices.create({core:{originalFetch:fetch}});
  const results=[];
  h.window.addEventListener('wm-average-response', e => results.push(e.detail));
  h.send('wm-average-request',{id:'a',requestId:'sales'});
  return {...h,results};
}

test('le prix est la moyenne de la dernière semaine avec des ventes, comme l’onglet Marché du site', async () => {
  let url = null;
  const h = salesHarness(async (requested) => { url = requested; return response({by_rarity:{
    UR:{weekly:[{start:'2026-11-23',avg:300,count:1},{start:'2026-11-09',avg:243,count:48},{start:'2026-11-16',avg:312,count:51}],monthly:[]},
    L:{weekly:[{start:'2026-11-02',avg:0,count:2},{start:'2026-11-09',avg:null,count:3},{start:'2026-11-16',avg:900,count:0}]},
    SR:{weekly:[{start:'2026-11-16',avg:-2,count:1}]},
    X:{weekly:[{start:'2026-11-16',avg:10,count:1}]}
  }}); });
  await flush();
  assert.match(url,/\/cards\/a\/price-history$/);
  assert.equal(h.results[0].ok,true);
  assert.equal(JSON.stringify(h.results[0].averages),JSON.stringify({UR:300,L:0}));
  assert.equal(h.timers.size,0);
});

test('le nombre de ventes sur 30 jours accompagne le prix, pour repérer une vente isolée', async () => {
  const h = salesHarness(async () => response({by_rarity:{
    C:{weekly:[{start:'2026-07-06',avg:130000,count:1}]},
    R:{weekly:[{start:'2026-08-31',avg:50,count:9},{start:'2026-09-07',avg:60,count:4},{start:'2026-09-28',avg:70,count:3}]}
  }}));
  await flush();
  assert.equal(JSON.stringify(h.results[0].averages),JSON.stringify({C:130000,R:70}));
  assert.equal(JSON.stringify(h.results[0].sales),JSON.stringify({
    C:{recent:0,last:'2026-07-06'},
    R:{recent:7,last:'2026-09-28'}
  }));
});

test('une réponse de format inconnu échoue en une seule requête au lieu de cacher une réponse vide', async () => {
  let calls=0;
  const h = salesHarness(async () => {calls++; return response({});});
  await flush(); await h.advance(1000);
  assert.equal(calls,1);
  assert.equal(h.results[0].ok,false);
  assert.equal(h.timers.size,0);
});

test('aucune vente : prix connu mais vide, pas une erreur', async () => {
  const h = salesHarness(async () => response({computed_at:'2026-11-23',by_rarity:{}}));
  await flush();
  assert.equal(h.results[0].ok,true);
  assert.equal(JSON.stringify(h.results[0].averages),'{}');
});

test('HTTP 429 respecte Retry-After sans relancer immédiatement', async () => {
  let calls=0;
  const h = salesHarness(async () => {calls++; return new Response('{}',{status:429,headers:{'Retry-After':'120'}});});
  await flush();
  assert.equal(calls,1);
  assert.equal(h.results[0].rateLimited,true);
  assert.equal(h.results[0].retryAfterMs,120000);
});

test('la collection abandonne après trois erreurs réseau et rend le contrôle à l’interface', async () => {
  let calls=0;
  const h = harness(['bridge/core.js','bridge/collection.js']);
  h.window.fetch=async () => { calls++; throw new Error('offline'); };
  const core=h.window.__wmBridgeFeatures.bridgeCore.create();
  const collection=h.window.__wmBridgeFeatures.bridgeCollection.create({core});
  const results=[];
  h.window.addEventListener('wm-average-tag-cards',e => results.push(e.detail));
  const run=collection.fetchTagCards('x','tag');
  await flush(); await h.advance(1000); await run;
  assert.equal(calls,3);
  assert.equal(results[0].ok,false);
});

test('une requête sans réponse est abandonnée avec un message clair, puis retentée plus tard', async () => {
  const h = harness(['bridge/core.js']);
  let calls = 0;
  h.window.fetch = (_url,{signal}) => ++calls === 1
    ? new Promise((_resolve,reject) => signal.addEventListener('abort',() => reject(Object.assign(new Error('signal is aborted without reason'),{name:'AbortError'}))))
    : Promise.resolve(response({ok:true}));
  const core = h.window.__wmBridgeFeatures.bridgeCore.create();
  const run = core.fetchJsonRetry('/api/my-collection',{}, {label:'Collection page 3',timeoutMs:15000});
  await flush(); await h.advance(15000);
  assert.equal(calls,1);
  await h.advance(2999); assert.equal(calls,1);
  await h.advance(1);
  assert.deepEqual(await run,{ok:true});
  assert.equal(calls,2);
});

test('trois requêtes sans réponse donnent « pas de réponse en 15 s », pas le message technique', async () => {
  const h = harness(['bridge/core.js']);
  h.window.fetch = (_url,{signal}) => new Promise((_resolve,reject) => signal.addEventListener('abort',() => reject(Object.assign(new Error('signal is aborted without reason'),{name:'AbortError'}))));
  const core = h.window.__wmBridgeFeatures.bridgeCore.create();
  const run = core.fetchJsonRetry('/api/my-collection',{}, {label:'Collection page 3'});
  const rejected = assert.rejects(run,/Collection page 3: pas de réponse en 15 s/);
  await flush(); await h.advance(120000); await rejected;
});

test('le chargement collection expire aussi si fetch ne répond pas', async () => {
  const h=harness(['bridge/core.js']);
  h.window.fetch=(_url,{signal}) => new Promise((_resolve,reject) => signal.addEventListener('abort',() => reject(new Error('timeout'))));
  const core=h.window.__wmBridgeFeatures.bridgeCore.create();
  const run=core.fetchJsonRetry('/api/my-collection',{}, {maxAttempts:1,timeoutMs:15000});
  const rejected=assert.rejects(run,/timeout/);
  await flush(); await h.advance(15000); await rejected;
});

// DOM minimal pour tester les interactions du module, sans navigateur ni dépendance.
function documentFixture() {
  class Element extends EventTarget {
    constructor(tag) { super(); this.tagName=tag.toUpperCase(); this.children=[]; this.dataset={}; this.className=''; this.hidden=false; this.disabled=false; this._text=''; }
    get childElementCount() {return this.children.length;}
    get textContent() {return this._text+this.children.map(c => c.textContent).join('');}
    set textContent(v) {this._text=String(v); this.children=[];}
    get classList() {return {
      contains:name => this.className.split(' ').includes(name),
      add:(...names) => {this.className=[...new Set([...this.className.split(' '),...names])].join(' ');},
      toggle:(name,enabled) => {const names=new Set(this.className.split(' ')); enabled ? names.add(name) : names.delete(name); this.className=[...names].join(' ');}
    };}
    get isConnected() {return this.tagName==='BODY' || Boolean(this.parentElement?.isConnected);}
    append(...nodes) {for(const node of nodes) {node.remove(); node.parentElement=this; this.children.push(node);}}
    appendChild(node) {this.append(node); return node;}
    replaceChildren(...nodes) {for(const child of this.children) child.parentElement=null; this.children=[]; this._text=''; this.append(...nodes);}
    remove() {if(this.parentElement) {this.parentElement.children=this.parentElement.children.filter(child => child!==this); this.parentElement=null;}}
    insertAdjacentElement(position,node) {
      if(position==='afterend') {node.remove(); const parent=this.parentElement; node.parentElement=parent; parent.children.splice(parent.children.indexOf(this)+1,0,node);}
    }
    setAttribute(name,value) {this[name]=value;}
    click() {if(!this.disabled) this.dispatchEvent(new Event('click'));}
    querySelectorAll(selector) {
      const match=node => selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1))
        : selector.startsWith('[data-role=') ? node.dataset.role===selector.match(/"(.*?)"/)[1]
        : node.tagName===selector.toUpperCase();
      return this.children.flatMap(child => [...(match(child)?[child]:[]),...child.querySelectorAll(selector)]);
    }
    querySelector(selector) {return this.querySelectorAll(selector)[0] || null;}
  }
  const document=new EventTarget();
  document.body=new Element('body');
  document.createElement=tag => new Element(tag);
  document.createTextNode=text => {const node=new Element('#text'); node.textContent=text; return node;};
  document.createDocumentFragment=() => new Element('#fragment');
  document.querySelectorAll=selector => document.body.querySelectorAll(selector);
  document.getElementById=id => {
    const visit=node => node.id===id ? node : node.children.map(visit).find(Boolean);
    return visit(document.body) || null;
  };
  const header=new Element('header'), h1=new Element('h1'), subtitle=new Element('p');
  h1.textContent='Ouvrir un paquet'; subtitle.textContent='Découvrez 5 cartes';
  header.append(h1,subtitle); document.body.append(header);
  return document;
}
function storageFixture() {
  const data=new Map();
  return {getItem:key => data.get(key) ?? null, setItem:(key,value) => data.set(key,String(value)), removeItem:key => data.delete(key)};
}
function packsUiHarness({ savedRecap = null } = {}) {
  const document=documentFixture(), localStorage=storageFixture(), sessionStorage=storageFixture();
  if (savedRecap) sessionStorage.setItem('wm_pack_batch_recap_v1', JSON.stringify(savedRecap));
  const h=harness(['features/core.js','features/price-ui.js','features/packs.js'], {
    document, localStorage, sessionStorage, location:{pathname:'/pulls',reload() {}}
  });
  const registry=h.window.__wmAverageFeatures;
  const core=registry.core.create(); core.isLastPullCardVisible=() => false;
  const recorded=[], requests=[], cancellations=[];
  const runtime={core,settings:{isEnabled:() => true},pullStats:{recordPullStats:cards => recorded.push(cards)},priceLoader:{loadCacheForCards() {},isPending:() => false},modalUi:{showInfoModal() {}}};
  runtime.priceUi=registry.priceUi.create(runtime);
  runtime.packs=registry.packs.create(runtime);
  runtime.packs.ensurePullsToolbar();
  h.window.addEventListener('wm-average-open-all-packs',e => requests.push(e.detail));
  h.window.addEventListener('wm-average-cancel-open-all-packs',e => cancellations.push(e.detail));
  return {...h, document, localStorage, sessionStorage, runtime, recorded, requests, cancellations,
    button:text => document.querySelectorAll('button').find(button => button.textContent===text)};
}

test('double clic sur Tout ouvrir : une seule confirmation, puis une seule requête', async () => {
  const h=packsUiHarness();
  h.button('Tout ouvrir').click(); h.button('Tout ouvrir').click();
  assert.equal(h.document.querySelectorAll('.wm-confirm-modal').length,1);
  assert.equal(h.requests.length,0);
  h.document.querySelectorAll('.wm-confirm-modal')[0].querySelectorAll('button').find(button => button.textContent==='Tout ouvrir').click();
  await flush();
  assert.equal(h.requests.length,1);
});

test('la progression du lot garde le total pendant les attentes et ne double ni stats ni exemplaires', async () => {
  const h=packsUiHarness();
  h.runtime.core.storageSet({[h.runtime.core.ALL_COLLECTION_KEY]:{fetchedAt:123,cards:[{...card,count:4}]}});
  h.button('Tout ouvrir').click();
  h.document.querySelectorAll('.wm-confirm-modal')[0].querySelectorAll('button').find(button => button.textContent==='Tout ouvrir').click(); await flush();
  const requestId=h.requests[0].requestId;
  const detail={requestId,openedPacks:1,cards:[card],packsRemaining:4};
  h.send('wm-average-open-all-packs-progress',detail);
  h.send('wm-average-open-all-packs-progress',detail);
  assert.equal(h.recorded.length,1);
  const stored=h.runtime.core.storageGet(h.runtime.core.ALL_COLLECTION_KEY)[h.runtime.core.ALL_COLLECTION_KEY];
  assert.equal(stored.cards[0].count,5);
  assert.equal(stored.fetchedAt,123);
  const counter=h.document.querySelectorAll('.wm-open-all-progress')[0];
  assert.equal(counter.textContent,'1/5 ouverts');
  assert.equal(counter.hidden,false);
  h.send('wm-average-open-all-packs-progress',{requestId,openedPacks:3,packsRemaining:2,waiting:true,waitMs:1500});
  assert.equal(counter.textContent,'3/5 ouverts');
  h.send('wm-average-open-all-packs-progress',{requestId,openedPacks:3,packsRemaining:null,waiting:true,waitMs:1500});
  assert.equal(counter.textContent,'3/5 ouverts');
  assert.equal(h.button('Ouverture…').disabled,true);
  assert.equal(h.cancellations.length,0);
  h.send('wm-average-open-all-packs-result',{...detail,ok:true});
  assert.equal(counter.hidden,true);
  assert.equal(h.button('Tout ouvrir').disabled,false);
  assert.ok(h.document.getElementById('wm-open-all-overlay'));
});

test('la désactivation automatique arrête le lot et garde son récap sans doubler les cartes', async () => {
  const h=packsUiHarness();
  h.runtime.core.writeLocalValue(h.runtime.core.AUTO_OPEN_MIN_MINUTES_KEY,1);
  h.runtime.core.writeLocalValue(h.runtime.core.AUTO_OPEN_MAX_MINUTES_KEY,1);
  const toggle=h.document.querySelectorAll('input')[1];
  toggle.checked=true; toggle.dispatchEvent(new Event('change'));
  await h.advance(60000);
  assert.equal(h.requests.length,1);
  const detail={requestId:h.requests[0].requestId,openedPacks:1,cards:[card],packsRemaining:8};
  h.send('wm-average-open-all-packs-progress',detail);
  toggle.checked=false; toggle.dispatchEvent(new Event('change'));
  assert.equal(h.cancellations.length,1);
  h.send('wm-average-open-all-packs-result',{...detail,ok:true,cancelled:true});
  const session=JSON.parse(h.localStorage.getItem(h.runtime.core.AUTO_OPEN_SESSION_KEY));
  assert.equal(session.cards.length,1);
  assert.equal(session.openedPacks,1);
  assert.equal(session.runs,1);
  assert.match(h.document.getElementById('wm-open-all-overlay').textContent,/Récap ouverture automatique/);
  await h.advance(60000);
  assert.equal(h.requests.length,1);
});

test('le récap natif évite de recréer le DOM quand les prix n’ont pas changé', () => {
  const document=documentFixture();
  const fresh=harness(['features/core.js','features/price-ui.js','features/packs.js'], {document,localStorage:storageFixture(),sessionStorage:storageFixture(),location:{pathname:'/pulls'}});
  const registry=fresh.window.__wmAverageFeatures, core=registry.core.create();
  core.isLastPullCardVisible=() => true;
  const runtime={core,settings:{isEnabled:() => true},pullStats:{recordPullStats() {}},priceLoader:{loadCacheForCards() {},isPending:() => false}};
  runtime.priceUi=registry.priceUi.create(runtime); runtime.packs=registry.packs.create(runtime);
  fresh.send('wm-average-pack-opened',{cards:[card]});
  const panel=document.getElementById('wm-pack-recap'), children=panel.children;
  runtime.packs.renderPackRecap();
  assert.equal(panel.children,children);
});

test('la navigation entre annonces n’envoie aucune requête et ignore une ancienne réponse', () => {
  const a='00000000-0000-0000-0000-000000000001', b='00000000-0000-0000-0000-000000000002';
  const h=priceHarness({document:{querySelectorAll:() => [],getElementById:() => null},location:{pathname:'/marketplace/'+a}});
  const loaded=[], requested=[];
  h.runtime.priceLoader={loadCacheForCards:cards => loaded.push(cards[0].id)};
  h.window.addEventListener('wm-average-load-marketplace-detail',e => requested.push(e.detail.auctionId));
  h.send('wm-average-marketplace-detail',{auctionId:a,card:{...card,id:'card-a'}});
  h.context.location.pathname='/marketplace/'+b;
  h.runtime.priceUi.renderMarketplaceCurrent();
  assert.deepEqual(requested,[]);
  h.send('wm-average-marketplace-detail',{auctionId:a,card:{...card,id:'card-a'}});
  assert.deepEqual(loaded,['card-a']);
  h.send('wm-average-marketplace-detail',{auctionId:b,card:{...card,id:'card-b'}});
  assert.deepEqual(loaded,['card-a','card-b']);
});

test('une ouverture de paquet du site passe telle quelle, une seule requête, lue par l’extension', async () => {
  let calls=0;
  const h=harness(['bridge/core.js','bridge/packs.js','bridge/intercept.js'], {
    navigator:{locks:{request:(_name,_opts,callback) => Promise.resolve().then(() => callback(null))}}
  });
  h.window.fetch=async () => {calls++; return response({cards:[]});};
  const registry=h.window.__wmBridgeFeatures, core=registry.bridgeCore.create();
  const runtime={core}; runtime.packs=registry.bridgePacks.create(runtime);
  registry.bridgeIntercept.create(runtime);
  await h.window.fetch('/api/packs/open',{method:'POST'});
  assert.equal(calls,1);
});


test('la barre des paquets masque le compteur au repos et n’offre ni arrêt ni ancien récap', () => {
  const h=packsUiHarness({savedRecap:{cards:[card],openedPacks:1}});
  assert.equal(h.button('Arrêter'),undefined);
  assert.equal(h.button('Revoir le dernier récap'),undefined);
  assert.equal(h.document.querySelectorAll('.wm-open-all-progress')[0].hidden,true);
});

// Chargement de collection : le fetch simulé répond par URL, aucune requête réelle.
function collectionHarness(handler) {
  const h = harness(['bridge/core.js','bridge/collection.js']);
  const pages = [];
  h.window.fetch = async (url) => {
    const { pathname, searchParams } = new URL(url, 'https://www.wiki-masters.com');
    if (pathname.endsWith('/stats')) return handler({ stats: true });
    const page = Number(searchParams.get('page'));
    pages.push(page);
    return handler({ page });
  };
  const core = h.window.__wmBridgeFeatures.bridgeCore.create();
  const collection = h.window.__wmBridgeFeatures.bridgeCollection.create({core});
  const results = [];
  h.window.addEventListener('wm-average-all-collection', e => results.push(e.detail));
  return { ...h, core, collection, pages, results };
}
async function settle(h, run) {
  let done = false;
  run.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 200 && !done; i++) {
    await new Promise(resolve => setImmediate(resolve));
    await h.advance(1000);
  }
}
const entry = (id, title = id) => ({id:`o-${id}`, card_id:id, card:{id, wikipedia_title:title, rarity:'C'}, count:1});
const untitled = {id:'o-x', card_id:'x', card:{id:'x', rarity:'C'}, count:1};

test('les minuteurs passent par un Worker et retombent sur setTimeout s’il échoue', async () => {
  const workers = [];
  class FakeWorker { constructor() { this.sent = []; workers.push(this); } postMessage(message) { this.sent.push(message); } }
  const h = harness(['bridge/core.js'], { Worker: FakeWorker, Blob: class {}, URL: { createObjectURL: () => 'blob:x' } });
  const { timer } = h.window.__wmBridgeFeatures;
  let fired = 0;

  const id = timer.set(() => fired++, 5000);
  assert.equal(workers.length, 1);
  assert.equal(JSON.stringify(workers[0].sent), JSON.stringify([{ id, ms: 5000 }]));
  workers[0].onmessage({ data: id });
  assert.equal(fired, 1);

  const cancelled = timer.set(() => fired++, 1000);
  timer.clear(cancelled);
  workers[0].onmessage({ data: cancelled });
  assert.equal(fired, 1);

  timer.set(() => fired++, 3000);
  workers[0].onerror();
  await h.advance(2999); assert.equal(fired, 1);
  await h.advance(1); assert.equal(fired, 2);
});

test('un 403 ou 429 du site arrête la requête sans nouvel essai, avec le statut sur l’erreur', async () => {
  for (const status of [403, 429]) {
    const h = harness(['bridge/core.js']);
    let calls = 0;
    h.window.fetch = async () => { calls++; return new Response('blocked',{status}); };
    const core = h.window.__wmBridgeFeatures.bridgeCore.create();
    const run = core.fetchJsonRetry('/api/my-collection',{}, {label:'Collection page 117'});
    const rejected = assert.rejects(run, error => error.status === status && /Collection page 117: HTTP/.test(error.message));
    await flush(); await h.advance(60000); await rejected;
    assert.equal(calls,1);
  }
});

test('HTTP 403 sur les prix suspend la file comme une limitation', async () => {
  let calls=0;
  const h = salesHarness(async () => {calls++; return new Response('blocked',{status:403});});
  await flush();
  assert.equal(calls,1);
  assert.equal(h.results[0].rateLimited,true);
  assert.equal(h.results[0].retryAfterMs,60000);
});

test('la liste du Marketplace est lue, mais pas la requête « mine=1 » de Mes enchères', () => {
  const h = harness(['bridge/core.js']);
  h.window.fetch = async () => response({});
  const core = h.window.__wmBridgeFeatures.bridgeCore.create();
  const lists = [];
  h.window.addEventListener('wm-average-marketplace-list', e => lists.push(e.detail.auctions));

  assert.equal(core.isMarketplaceListApi('/api/marketplace?page=1&limit=24'),true);
  assert.equal(core.isMarketplaceListApi('/api/marketplace?page=1&limit=1&mine=1'),false);
  assert.equal(core.isMarketplaceListApi('/api/marketplace/00000000-0000-4000-8000-000000000000'),false);

  core.emitMarketplaceList({total:2, auctions:[
    {id:'l1', card_id:'a', current_bid:12, snapshot_rarity:'UR', card:{wikipedia_title:'A'}},
    {id:'l2', base_amount:30, card:{id:'b', wikipedia_title:'B', rarity:'L'}},
    {id:'l3', card_id:'c', card:{}}
  ]});
  assert.equal(JSON.stringify(lists), JSON.stringify([[
    {id:'l1', price:12, card:{id:'a', title:'A', rarity:'UR', imageUrl:null}},
    {id:'l2', price:30, card:{id:'b', title:'B', rarity:'L', imageUrl:null}}
  ]]));
});

test('les listes du Marché, « mine=1 » comprise, disent quelles cartes sont encore possédées', () => {
  const h = harness(['bridge/core.js']);
  h.window.fetch = async () => response({});
  const core = h.window.__wmBridgeFeatures.bridgeCore.create();
  const events = [];
  h.window.addEventListener('wm-average-ownership', e => events.push(e.detail.owned));

  assert.equal(core.isMarketplaceFeedApi('/api/marketplace?page=1&limit=50&sort=recent&mine=1'),true);
  assert.equal(core.isMarketplaceFeedApi('/api/marketplace/00000000-0000-4000-8000-000000000000'),false);

  core.emitOwnership({page:1, history:[
    {id:'v1', card_id:'sold', owned:false, status:'settled_sold'},
    {id:'v2', card:{id:'kept'}, owned:true, status:'cancelled'},
    {id:'v3', card_id:'unknown'}
  ], selling:[]});
  core.emitOwnership({history:[]});
  assert.equal(JSON.stringify(events), JSON.stringify([{sold:false, kept:true}]));
});

test('une carte que le Marché dit non possédée sort de la collection mémorisée', async () => {
  const h = priceHarness();
  const {core} = h;
  await core.collectionReady;
  core.storageSet({[core.ALL_COLLECTION_KEY]:{fetchedAt:123, complete:true, cards:[
    {...card, id:'sold'}, {...card, id:'kept'}
  ]}});
  core.registerCards([{...card, id:'sold', ownedCardId:'o1', ownedCardIds:['o1']}]);

  h.send('wm-average-ownership', {owned:{sold:false, kept:true}});
  await flush();

  const stored = core.readCollection();
  assert.deepEqual(stored.cards.map(c => c.id), ['kept']);
  assert.equal(stored.complete, true);
  assert.equal(stored.fetchedAt, 123);
  assert.equal(core.cardMetaById.get('sold').ownedCardIds.length, 0);
  assert.equal(core.cardMetaById.get('sold').ownedCardId, null);
});

test('une moyenne de 0 n’est pas traitée comme une carte bon marché', () => {
  const h = loaderHarness();
  h.loader.loadCacheForCards([{...card,id:'r0',rarity:'R'}], {manual:true});
  h.requests.forEach(request => h.send('wm-average-response',{...request,ok:true,averages:{R:0}}));

  const now = Date.parse('2026-10-05T12:00:00Z');
  assert.equal(h.loader.isFresh(h.core.cacheMemory.get('r0'), now + 25 * 60 * 60 * 1000),false);
});

test('une carte vue au Marketplace ou en enchère ne garde ni rareté ni compte si elle est possédée', () => {
  const h = priceHarness();
  h.core.registerCards([{id:'a', title:'A', rarity:'C', ownedCardId:'o1', ownedCardIds:['o1','o2'], count:2}]);

  const unowned = h.core.preserveOwnedMeta({id:'b', title:'B', rarity:'UR', imageUrl:'https://x/b.webp'});
  assert.equal(unowned.rarity,'UR');
  assert.equal(unowned.count,1);

  const owned = h.core.preserveOwnedMeta({id:'a', title:'A', rarity:'UR', imageUrl:'https://x/a-foil.webp'});
  assert.equal(owned.rarity,'C');
  assert.equal(owned.imageUrl,null);
  assert.equal(owned.count,2);
});

test('une image introuvable à cause d’une erreur réseau n’est pas mémorisée comme absente', async () => {
  const store = new Map();
  let failing = true;
  const h = harness(['features/image-resolver.js'], {
    URLSearchParams,
    fetch: async () => {
      if (failing) throw new Error('HTTP 429');
      return new Response(JSON.stringify({search:[], query:{pages:{}}}), {status:200});
    }
  });
  const resolver = h.window.__wmAverageFeatures.imageResolver.create({
    normalizeTitle: value => String(value || '').trim(),
    readLocalValue: key => store.get(key), writeLocalValue: (key, value) => store.set(key, value),
    MISSING_IMAGE_CACHE_PREFIX: 'img_', MISSING_IMAGE_FOUND_TTL: 1e9, MISSING_IMAGE_MISS_TTL: 1e9
  });

  const failed = await resolver.resolveMissingImage('Chat');
  assert.equal(failed.error,true);
  assert.equal(store.size,0);

  failing = false;
  const missing = await resolver.resolveMissingImage('Chat');
  assert.equal(missing.found,false);
  assert.equal(store.size,1);
});

test('une illustration est un GIF seulement si l’adresse finit par .gif', () => {
  const {core} = priceHarness();
  assert.equal(core.isGifImage('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Chat.gif/330px-Chat.gif'),true);
  assert.equal(core.isGifImage('https://cdn.example.com/cards/a.GIF?v=2'),true);
  assert.equal(core.isGifImage('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Chat.gif/330px-Chat.gif.png'),false);
  assert.equal(core.isGifImage('https://cdn.example.com/cards/a.webp'),false);
  assert.equal(core.isGifImage('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP'),false);
  assert.equal(core.isGifImage(null),false);
});

test('la liste du Marketplace n’est traitée que sur la page Marketplace, pas masquée par Mes enchères', () => {
  const elsewhere = priceHarness({location:{origin:'https://www.wiki-masters.com', pathname:'/pulls'}});
  elsewhere.send('wm-average-marketplace-list', {auctions:[{id:'l1', price:10, card:{id:'a', title:'A', rarity:'C'}}]});
  assert.equal(elsewhere.core.cardMetaById.has('a'), false);

  const h = priceHarness({location:{origin:'https://www.wiki-masters.com', pathname:'/marketplace'}});
  h.send('wm-average-marketplace-list', {auctions:[{id:'l1', price:10, card:{id:'a', title:'A', rarity:'C'}}]});
  assert.equal(h.core.cardMetaById.has('a'), true);

  h.runtime.myBids = {isBidsPage:() => true};
  h.send('wm-average-marketplace-list', {auctions:[{id:'l2', price:10, card:{id:'b', title:'B', rarity:'C'}}]});
  assert.equal(h.core.cardMetaById.has('b'), false);
});

test('une carte sans titre en page 0 ne crée pas de page hors bornes', async () => {
  const h = collectionHarness(({stats,page}) => response(stats ? {} : {
    total:6, collection: page === 0 ? [entry('a'),entry('b'),untitled] : [entry('c'),entry('d'),entry('e')]
  }));
  const run = h.collection.fetchAllCollection('r',[]);
  await settle(h,run);
  assert.deepEqual(h.pages,[0,1]);
  assert.equal(h.results[0].ok,true);
  assert.equal(h.results[0].complete,true);
  assert.equal(h.results[0].cards.length,5);
});

test('avec la rareté C cochée, les stats de rareté ne raccourcissent pas le chargement', async () => {
  const h = collectionHarness(({stats,page}) => response(stats ? {rarityCounts:{C:1}} : {
    total:6, collection: page === 0 ? [entry('a'),entry('b'),entry('c')] : [entry('d'),entry('e'),entry('f')]
  }));
  const run = h.collection.fetchAllCollection('r',['C']);
  await settle(h,run);
  assert.deepEqual(h.pages,[0,1]);
  assert.equal(h.results[0].complete,true);
});

test('un quota plein libère les prix en échec et les images expirées, garde les prix valides', () => {
  const store = new Map([
    ['wm_avg_v4_bad', JSON.stringify({ok:false,fetchedAt:1,averages:{}})],
    ['wm_avg_v4_good', JSON.stringify({ok:true,fetchedAt:Date.parse('2026-10-05T12:00:00Z'),averages:{}})],
    ['wm_missing_img_v2_old', JSON.stringify({found:false,fetchedAt:1})]
  ]);
  const localStorage = {
    get length() { return store.size; },
    key: index => [...store.keys()][index] ?? null,
    getItem: key => store.has(key) ? store.get(key) : null,
    removeItem: key => store.delete(key),
    setItem(key, value) {
      if (!store.has(key) && store.size >= 3) throw new Error('QuotaExceededError');
      store.set(key, value);
    }
  };
  const h = priceHarness({ localStorage });

  assert.equal(h.core.writeLocalValue('wm_new', {a:1}), true);
  assert.deepEqual([...store.keys()].sort(), ['wm_avg_v4_good','wm_new']);
});

test('vider le cache efface le recalculable et garde réglages, familles et statistiques', () => {
  const keep = ['wm_feature_settings_v1','wm_families_v1','wm_pull_stats_v1','wm_auto_open_min_minutes_v1','wm_my_bids_sound_v1','autre_cle_du_site'];
  const clear = ['wm_avg_v4_a','wm_avg_v3_old','wm_missing_img_v2_x','wm_all_collection_v1','wm_price_pace_v1','wm_price_block_until_v1','wm_bulk_rarity_last_load_v1','wm_avg_cache_cleanup_v1'];
  const store = new Map([...keep, ...clear].map(key => [key, JSON.stringify({key})]));
  const localStorage = {
    get length() { return store.size; },
    key: index => [...store.keys()][index] ?? null,
    getItem: key => store.has(key) ? store.get(key) : null,
    removeItem: key => store.delete(key),
    setItem: (key, value) => store.set(key, value)
  };
  const h = priceHarness({ localStorage });
  h.core.cacheMemory.set('a',{ok:true});

  const result = h.core.clearCaches();
  assert.equal(result.removed,clear.length);
  assert.deepEqual([...store.keys()].sort(), [...keep].sort());
  assert.equal(h.core.cacheMemory.size,0);
});

function memoryStorage(entries = []) {
  const store = new Map(entries);
  return { store, localStorage: {
    get length() { return store.size; },
    key: index => [...store.keys()][index] ?? null,
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key)
  }};
}
const img = name => `https://cdn.example.com/storage/v1/object/public/cards/${name}.webp`;
const fullCards = [
  {id:'a', ownedCardId:'o1', ownedCardIds:['o1'], title:'A', rarity:'C', imageUrl:img('a'), count:1, starred:false, tags:[]},
  {id:'b', ownedCardId:'o3', ownedCardIds:['o2','o3'], title:'B', rarity:'R', imageUrl:img('b'), count:2, starred:true, tags:[{id:'t',name:'T',color:null}]},
  {id:'c', ownedCardId:null, ownedCardIds:['o4'], title:'C', rarity:'SR', imageUrl:'https://autre.example.org/c.png', count:1, starred:false, tags:[]},
  {id:'d', ownedCardId:null, ownedCardIds:[], title:'D', rarity:'UR', imageUrl:null, count:3, starred:false, tags:[]}
];

// L'ordre des clés d'une carte peut changer après compactage : seul le contenu compte.
const sameCards = (actual, expected) => assert.equal(
  JSON.stringify(actual.map(card => Object.fromEntries(Object.entries(card).sort()))),
  JSON.stringify(expected.map(card => Object.fromEntries(Object.entries(card).sort())))
);

// Juste ce que core.js utilise d'IndexedDB : open, transaction, get, put, delete.
function fakeIndexedDB(entries = []) {
  const data = new Map(entries);
  const later = fn => Promise.resolve().then(fn);
  const db = { transaction() {
    const tx = {};
    const done = request => { later(() => tx.oncomplete()); return request; };
    tx.objectStore = () => ({
      get: key => done({ result: structuredClone(data.get(key)) }),
      put: (value, key) => done(data.set(key, structuredClone(value)) && {}),
      delete: key => done(data.delete(key) && {})
    });
    return tx;
  }};
  return { data, indexedDB: { open() { const request = { result: db }; later(() => request.onsuccess()); return request; } } };
}

test('la collection est enregistrée dans IndexedDB, plus dans localStorage, et relue au rechargement', async () => {
  const { store, localStorage } = memoryStorage();
  const { data, indexedDB } = fakeIndexedDB();
  const h = priceHarness({ localStorage, indexedDB });
  const key = h.core.ALL_COLLECTION_KEY;
  h.core.storageSet({[key]:{fetchedAt:1, complete:true, cards:fullCards}});
  await flush();

  assert.equal(store.has(key), false);
  sameCards(data.get(key).cards, fullCards);

  const reloaded = priceHarness({ localStorage, indexedDB });
  await reloaded.core.collectionReady;
  const read = reloaded.core.storageGet(key)[key];
  assert.equal(read.fetchedAt, 1);
  assert.equal(read.complete, true);
  sameCards(read.cards, fullCards);
});

test('modifier la collection lue ne change pas la copie gardée tant qu’elle n’est pas réenregistrée', () => {
  const h = priceHarness();
  const key = h.core.ALL_COLLECTION_KEY;
  h.core.storageSet({[key]:{fetchedAt:1, cards:[{id:'a', count:1}]}});
  h.core.storageGet(key)[key].cards[0].count = 9;
  assert.equal(h.core.storageGet(key)[key].cards[0].count, 1);
});

test('une collection de localStorage, compacte ou non, passe dans IndexedDB au démarrage', async () => {
  const compact = {v:2, fetchedAt:1, complete:true, imagePrefix:img('').slice(0, -5), cards:[
    {id:'a', ownedCardIds:['o1'], title:'A', rarity:'C', img:'a.webp'},
    {id:'b', ownedCardId:'o3', ownedCardIds:['o2','o3'], title:'B', rarity:'R', img:'b.webp', count:2, starred:true, tags:[{id:'t',name:'T',color:null}]},
    {id:'c', ownedCardId:null, ownedCardIds:['o4'], title:'C', rarity:'SR', imageUrl:'https://autre.example.org/c.png'},
    {id:'d', title:'D', rarity:'UR', count:3}
  ]};
  for (const legacy of [{fetchedAt:1, complete:true, cards:fullCards}, compact]) {
    const { store, localStorage } = memoryStorage([['wm_all_collection_v1', JSON.stringify(legacy)]]);
    const { data, indexedDB } = fakeIndexedDB();
    const h = priceHarness({ localStorage, indexedDB });
    await h.core.collectionReady;

    assert.equal(store.has('wm_all_collection_v1'), false);
    sameCards(data.get('wm_all_collection_v1').cards, fullCards);
    sameCards(h.core.storageGet('wm_all_collection_v1').wm_all_collection_v1.cards, fullCards);
  }
});

test('sans IndexedDB, la collection reste utilisable et sa copie localStorage n’est pas effacée', async () => {
  const { store, localStorage } = memoryStorage([['wm_all_collection_v1', JSON.stringify({fetchedAt:1, cards:fullCards})]]);
  const h = priceHarness({ localStorage });
  await h.core.collectionReady;

  assert.equal(store.has('wm_all_collection_v1'), true);
  sameCards(h.core.storageGet('wm_all_collection_v1').wm_all_collection_v1.cards, fullCards);
});

test('vider le cache efface aussi la collection d’IndexedDB', async () => {
  const { localStorage } = memoryStorage();
  const { data, indexedDB } = fakeIndexedDB([['wm_all_collection_v1', {fetchedAt:1, cards:fullCards}]]);
  const h = priceHarness({ localStorage, indexedDB });
  await h.core.collectionReady;

  h.core.clearCaches();
  await flush();
  assert.equal(data.has('wm_all_collection_v1'), false);
  assert.equal(h.core.storageGet('wm_all_collection_v1').wm_all_collection_v1, undefined);
});

test('les cartes persistées perdent wikipediaUrl, jamais relue depuis ce cache', () => {
  const h = priceHarness();
  assert.equal(
    JSON.stringify(h.core.toStoredCard({id:'a', title:'A', wikipediaUrl:'https://fr.wikipedia.org/wiki/A', count:2})),
    JSON.stringify({id:'a', title:'A', count:2})
  );
});

test('une erreur tardive garde les pages déjà lues et les signale comme partielles', async () => {
  const h = collectionHarness(({stats,page}) => {
    if (stats) return response({});
    if (page === 2) return new Response('blocked',{status:403});
    return response({total:9, collection:[1,2,3].map(n => entry(`p${page}-${n}`))});
  });
  const run = h.collection.fetchAllCollection('r',[]);
  await settle(h,run);
  assert.equal(h.results[0].ok,true);
  assert.equal(h.results[0].complete,false);
  assert.match(h.results[0].partialError,/Collection page 2: HTTP 403/);
  assert.equal(h.results[0].cards.length,6);
  assert.deepEqual(h.pages,[0,1,2]);
});
