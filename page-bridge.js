(() => {
  if (window.__wmAveragePriceBridgeInstalled) return;
  window.__wmAveragePriceBridgeInstalled = true;

  const registry = window.__wmBridgeFeatures || {};
  const runtime = {};
  window.__wmAverageBridgeRuntime = runtime;

  runtime.core = registry.bridgeCore.create();
  runtime.collection = registry.bridgeCollection.create(runtime);
  runtime.packs = registry.bridgePacks.create(runtime);
  runtime.intercept = registry.bridgeIntercept.create(runtime);
  runtime.marketplace = registry.bridgeMarketplace.create(runtime);
  runtime.prices = registry.bridgePrices.create(runtime);

})();
