// Compatibility wrapper: keep the existing Build Next implementation intact,
// then add admin-only timer/history correction endpoints.
const attachBuildTasksCore = require('./build_tasks-core');
const attachAdminTime = require('./admin-time');

module.exports = function attachBuildTasks(app, opts = {}) {
  attachBuildTasksCore(app, opts);
  attachAdminTime(app, opts);
};
