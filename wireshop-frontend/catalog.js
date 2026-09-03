// Keep the catalog synchronous for pages that use it immediately after this script.
// The next scripts add admin time correction, role-aware row actions, compact UI polish,
// Build History print-name fallback, safe current-part-number transitions, tech note editing,
// and a save fallback for catalog-only inventory parts that are missing a live DB row.
document.write('<script src="/catalog-data.js"><\/script>');
document.write('<script src="/inventory-edit-fallback.js"><\/script>');
document.write('<script src="/time-edit-ui.js"><\/script>');
document.write('<script src="/context-actions.js"><\/script>');
document.write('<script src="/ui-polish.js"><\/script>');
document.write('<script src="/history-name-fallback.js"><\/script>');
document.write('<script src="/part-number-transition-ui.js"><\/script>');
document.write('<script src="/movement-note-edit.js"><\/script>');
