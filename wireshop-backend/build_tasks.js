// Compatibility wrapper: keep the existing Build Next implementation intact,
// then add timer/history correction, safe part-number transitions, and note-only inventory edits.
const attachBuildTasksCore = require('./build_tasks-core');
const attachAdminTime = require('./admin-time');
const attachPartNumberTransition = require('./part-number-transition');
const attachInventoryNoteEdit = require('./inventory-note-edit');

module.exports = function attachBuildTasks(app, opts = {}) {
  attachBuildTasksCore(app, opts);
  attachAdminTime(app, opts);
  attachPartNumberTransition(app, opts);
  attachInventoryNoteEdit(app, opts);
};
