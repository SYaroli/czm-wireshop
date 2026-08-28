// Admin-only corrections for Build Next timers and completed build history.
const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

module.exports = function attachAdminTime(app, opts = {}) {
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'wireshop.db');
  const db = opts.db || new sqlite3.Database(DB_PATH);
  const router = express.Router();

  const now = () => Date.now();
  const username = req => String(req.headers['x-user'] || '').trim();

  function isAdmin(req) {
    if (String(req.headers['x-role'] || '').toLowerCase() === 'admin') return true;
    const u = username(req).toLowerCase();
    const list = String(process.env.ADMIN_USERS || '')
      .toLowerCase()
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    return list.includes(u);
  }

  function requireAdmin(req, res) {
    const u = username(req);
    if (!u) {
      res.status(401).json({ error: 'missing x-user header' });
      return null;
    }
    if (!isAdmin(req)) {
      res.status(403).json({ error: 'admin only' });
      return null;
    }
    return u;
  }

  const run = (sql, args = []) => new Promise((resolve, reject) => {
    db.run(sql, args, function (err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });

  const get = (sql, args = []) => new Promise((resolve, reject) => {
    db.get(sql, args, (err, row) => err ? reject(err) : resolve(row || null));
  });

  function requestedSeconds(req) {
    const n = Number(req.body?.elapsedSeconds);
    if (!Number.isFinite(n)) return null;
    const s = Math.round(n);
    return s >= 0 ? s : null;
  }

  function elapsedForTask(row, atTs = now()) {
    const startedAt = Number(row?.startedAt || 0);
    if (!startedAt) return 0;
    const totalPaused = Math.max(0, Number(row?.totalPausedSeconds || 0));
    const isPaused = Number(row?.isPaused || 0) === 1;
    const pausedAt = Number(row?.pausedAt || 0);
    const extraPaused = isPaused && pausedAt
      ? Math.max(0, Math.floor((atTs - pausedAt) / 1000))
      : 0;
    return Math.max(0, Math.floor((atTs - startedAt) / 1000) - totalPaused - extraPaused);
  }

  // Correct the displayed/recorded active time for a job that is still in progress.
  // Preserve its running/paused state and accumulated pause time; only shift startedAt.
  router.patch('/api/build-tasks/:id/admin-time', async (req, res) => {
    const actor = requireAdmin(req, res);
    if (!actor) return;

    const id = Number(req.params.id || 0);
    const desired = requestedSeconds(req);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
    if (desired === null) return res.status(400).json({ error: 'elapsedSeconds must be zero or greater' });

    try {
      const task = await get(`SELECT * FROM build_tasks WHERE id=?`, [id]);
      if (!task) return res.status(404).json({ error: 'not found' });
      if (task.status !== 'claimed') return res.status(409).json({ error: 'task is not in progress', current: task });

      const t = now();
      const oldElapsed = elapsedForTask(task, t);
      const totalPaused = Math.max(0, Number(task.totalPausedSeconds || 0));
      const pausedAt = Number(task.pausedAt || 0);
      const isPaused = Number(task.isPaused || 0) === 1;
      const anchor = isPaused && pausedAt ? pausedAt : t;
      const newStartedAt = Math.round(anchor - ((desired + totalPaused) * 1000));

      await run(`UPDATE build_tasks SET startedAt=? WHERE id=? AND status='claimed'`, [newStartedAt, id]);
      await run(
        `INSERT INTO build_task_events (taskId, type, qty, user, ts, reason, elapsedSeconds)
         VALUES (?, 'time_edit', 0, ?, ?, ?, ?)`,
        [id, actor, t, `in_progress:${oldElapsed}->${desired}`, desired]
      );

      const updated = await get(`SELECT * FROM build_tasks WHERE id=?`, [id]);
      res.json({
        ok: true,
        task: updated,
        previousElapsedSeconds: oldElapsed,
        elapsedSeconds: elapsedForTask(updated, t)
      });
    } catch (err) {
      console.error('[ADMIN TIME] in-progress correction failed:', err);
      res.status(500).json({ error: 'db', detail: String(err.message || err) });
    }
  });

  // Positive IDs are live completion events; negative IDs are imported history rows.
  router.patch('/api/build-history/:id/admin-time', async (req, res) => {
    const actor = requireAdmin(req, res);
    if (!actor) return;

    const id = Number(req.params.id || 0);
    const desired = requestedSeconds(req);
    if (!Number.isInteger(id) || id === 0) return res.status(400).json({ error: 'bad id' });
    if (desired === null) return res.status(400).json({ error: 'elapsedSeconds must be zero or greater' });

    try {
      const t = now();

      if (id < 0) {
        const importId = Math.abs(id);
        const row = await get(`SELECT * FROM build_history_imports WHERE id=?`, [importId]);
        if (!row) return res.status(404).json({ error: 'imported history record not found' });

        const previous = Math.max(0, Number(row.elapsedSeconds || 0));
        await run(`UPDATE build_history_imports SET elapsedSeconds=? WHERE id=?`, [desired, importId]);
        return res.json({
          ok: true,
          id,
          imported: true,
          previousElapsedSeconds: previous,
          elapsedSeconds: desired,
          editedBy: actor,
          editedAt: t
        });
      }

      const event = await get(`SELECT * FROM build_task_events WHERE id=? AND type='complete'`, [id]);
      if (!event) return res.status(404).json({ error: 'completion record not found' });

      const previous = Math.max(0, Number(event.elapsedSeconds || 0));
      await run(`UPDATE build_task_events SET elapsedSeconds=? WHERE id=? AND type='complete'`, [desired, id]);
      await run(
        `INSERT INTO build_task_events (taskId, type, qty, user, ts, reason, elapsedSeconds)
         VALUES (?, 'time_edit', 0, ?, ?, ?, ?)`,
        [event.taskId, actor, t, `completion_event:${id}:${previous}->${desired}`, desired]
      );

      res.json({
        ok: true,
        id,
        imported: false,
        previousElapsedSeconds: previous,
        elapsedSeconds: desired,
        editedBy: actor,
        editedAt: t
      });
    } catch (err) {
      console.error('[ADMIN TIME] completion correction failed:', err);
      res.status(500).json({ error: 'db', detail: String(err.message || err) });
    }
  });

  app.use(router);
};
