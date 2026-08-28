// Build History print-name fallback.
// Completion events do not always store printName, so fill blanks from the live
// Inventory database first, with catalog-data.js as an additional fallback.
(() => {
  if (window.__historyNameFallbackLoaded) return;
  window.__historyNameFallbackLoaded = true;

  const path = String(location.pathname || '').toLowerCase();
  const onHistory = path.endsWith('/build-history.html') || path === '/build-history';
  if (!onHistory) return;

  const session = (() => {
    try { return JSON.parse(localStorage.getItem('user') || '{}'); }
    catch { return {}; }
  })();
  if (!session.username) return;

  const API_ROOT = (localStorage.getItem('API_BASE') || 'https://wireshop-backend.onrender.com').replace(/\/+$/, '');
  const nativeFetch = window.fetch.bind(window);
  let nameMapPromise = null;

  function partKey(v) {
    return String(v || '').trim();
  }

  function getNameMap() {
    if (nameMapPromise) return nameMapPromise;

    nameMapPromise = (async () => {
      const map = new Map();

      // Catalog fallback for normal catalog parts.
      (Array.isArray(window.catalog) ? window.catalog : []).forEach(row => {
        const pn = partKey(row?.partNumber);
        const name = String(row?.printName || '').trim();
        if (pn && name) map.set(pn, name);
      });

      // Inventory is the live source and also contains DB-only parts.
      try {
        const res = await nativeFetch(API_ROOT + '/api/inventory-all', {
          headers: {
            'x-user': session.username,
            'x-role': session.role || ''
          }
        });
        if (res.ok) {
          const inventory = await res.json();
          (Array.isArray(inventory) ? inventory : []).forEach(row => {
            const pn = partKey(row?.partNumber);
            const name = String(row?.description || row?.printName || '').trim();
            if (pn && name) map.set(pn, name);
          });
        }
      } catch (err) {
        console.warn('[BUILD HISTORY] inventory print-name fallback unavailable', err);
      }

      return map;
    })();

    return nameMapPromise;
  }

  window.fetch = async (...args) => {
    const res = await nativeFetch(...args);

    try {
      const input = args[0];
      const url = typeof input === 'string' ? input : (input?.url || '');
      const isHistoryFeed =
        url.includes('/api/build-task-events') &&
        /(?:\?|&)type=complete(?:&|$)/.test(url) &&
        /(?:\?|&)includeHidden=1(?:&|$)/.test(url);

      if (!isHistoryFeed || !res.ok) return res;

      const events = await res.clone().json();
      if (!Array.isArray(events)) return res;

      const names = await getNameMap();
      const filled = events.map(row => {
        if (String(row?.printName || '').trim()) return row;
        const name = names.get(partKey(row?.partNumber)) || '';
        return name ? { ...row, printName: name } : row;
      });

      return new Response(JSON.stringify(filled), {
        status: res.status,
        statusText: res.statusText,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (err) {
      console.warn('[BUILD HISTORY] print-name fallback failed', err);
      return res;
    }
  };
})();
