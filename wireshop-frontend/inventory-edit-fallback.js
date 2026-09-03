(() => {
  // Some legacy/catalog-only parts can appear on Inventory even though they do not
  // yet have a row in the live inventory DB. The normal Edit flow uses PUT, which
  // correctly returns 404 for those rows. If that happens, create the missing DB
  // row with the exact values the admin just entered, then let the page continue
  // as if the save succeeded.
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async function inventoryEditFallback(input, init = {}) {
    const method = String(
      init.method || (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
    ).toUpperCase();

    let url;
    try {
      url = new URL(typeof input === 'string' ? input : input.url, window.location.href);
    } catch {
      return nativeFetch(input, init);
    }

    const isSingleInventoryEdit = /^\/api\/inventory\/[^/]+$/.test(url.pathname);
    if (method !== 'PUT' || !isSingleInventoryEdit) {
      return nativeFetch(input, init);
    }

    const response = await nativeFetch(input, init);
    if (response.status !== 404 || typeof init.body !== 'string') {
      return response;
    }

    let payload;
    try {
      payload = JSON.parse(init.body || '{}');
    } catch {
      return response;
    }

    const partFromUrl = decodeURIComponent(url.pathname.replace('/api/inventory/', ''));
    if (!payload.partNumber) payload.partNumber = partFromUrl;

    const createUrl = `${url.origin}/api/inventory`;
    const createResponse = await nativeFetch(createUrl, {
      method: 'POST',
      headers: init.headers,
      body: JSON.stringify(payload)
    });

    // If another request created it between the failed PUT and our POST, just
    // retry the original edit once rather than surfacing a false "exists" error.
    if (createResponse.status === 409) {
      return nativeFetch(input, init);
    }

    return createResponse;
  };
})();
