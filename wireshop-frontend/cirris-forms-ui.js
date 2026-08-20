(() => {
  // Cirris setup UI is intentionally disabled for now.
  // Keep this lightweight helper loaded so the inventory detail page
  // uses the new workbook name without touching the existing backend.
  const OLD_LABEL = 'Komax Job File';
  const NEW_LABEL = 'Master File';

  function renameMasterFileLabel() {
    const section = document.getElementById('komaxFileSection');
    if (!section) return;

    section.querySelectorAll('div').forEach((el) => {
      if (el.childElementCount === 0 && el.textContent.trim() === OLD_LABEL) {
        el.textContent = NEW_LABEL;
      }
    });
  }

  renameMasterFileLabel();

  const observer = new MutationObserver(renameMasterFileLabel);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
