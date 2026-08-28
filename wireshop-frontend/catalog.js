// Keep the catalog synchronous for pages that use it immediately after this script.
// The second script adds admin-only time correction controls without changing page markup.
document.write('<script src="/catalog-data.js"><\/script>');
document.write('<script src="/time-edit-ui.js"><\/script>');
