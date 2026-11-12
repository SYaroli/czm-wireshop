(() => {
  const path = window.location.pathname;
  const pages = {
    '/bench-stock.html': '/#bench-stock',
    '/build-history.html': '/#history',
    '/my-build-history.html': '/#history',
    '/inventory': '/#inventory',
    '/inventory.html': '/#inventory',
    '/inventory-list.html': '/#inventory',
    '/inventory-movement.html': '/#inventory',
    '/shop-inventory.html': '/#inventory',
    '/komax-files.html': '/#files',
  };
  const target = /^\/(inv|scan)\/[^/]+\/?$/.test(path) ? path : pages[path] || '/';
  window.location.replace(new URL(target, 'https://czm-electrical.onrender.com').href);
})();
