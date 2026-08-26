(() => {
  function renameMasterFileLabel() {
    const section = document.getElementById('komaxFileSection');
    if (!section) return;
    section.querySelectorAll('div').forEach((el) => {
      if (el.childElementCount === 0 && el.textContent.trim() === 'Komax Job File') {
        el.textContent = 'Master File';
      }
    });
  }

  const path = window.location.pathname || '';
  const isInventoryList =
    path === '/inventory' ||
    path === '/inventory.html' ||
    path === '/inventory-list.html';

  if (isInventoryList) {
    if (!document.querySelector('script[data-inventory-layout-check]')) {
      const script = document.createElement('script');
      script.src = '/inventory-layout-check.js?v=20260826-1';
      script.dataset.inventoryLayoutCheck = '1';
      document.head.appendChild(script);
    }
    return;
  }

  renameMasterFileLabel();
  const observer = new MutationObserver(renameMasterFileLabel);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
