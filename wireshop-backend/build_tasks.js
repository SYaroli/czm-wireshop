// Compatibility wrapper: keep the existing Build Next implementation intact,
// then add admin-only timer/history correction and safe part-number transition endpoints.
const attachBuildTasksCore = require('./build_tasks-core');
const attachAdminTime = require('./admin-time');
const attachPartNumberTransition = require('./part-number-transition');

module.exports = function attachBuildTasks(app, opts = {}) {
  attachBuildTasksCore(app, opts);
  attachAdminTime(app, opts);
  attachPartNumberTransition(app, opts);
};
