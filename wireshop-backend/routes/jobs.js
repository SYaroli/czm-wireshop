// routes/jobs.js
import express from 'express';
import { getDB } from '../db.js';

/*
  Expected existing endpoints (kept):
  POST   /api/jobs/log
  PUT    /api/jobs/log/:id
  GET    /api/jobs/logs/:username
  DELETE /api/jobs/delete-logs/:username
  GET    /api/jobs/logs        (admin)
  DELETE /api/jobs/admin/clear-logs  (admin)
*/

export default function jobsRouterFactory({ adminRequired, authRequired }) {
  const router = express.Router();

  // Helper: resolve acting username (JWT preferred, fallback to legacy x-user)
  function actingUsername(req) {
    if (req.user?.username) return req.user.username;
    const legacy = String(req.headers['x-user'] || '').toLowerCase().trim();
    return legacy || 'unknown';
  }

  // ---- Create log
  router.post('/log', authRequired, async (req, res) => {
    try {
      const db = getDB();
      const username = actingUsername(req);
      const { partNumber, action, startTime, note } = req.body;

      await new Promise((resolve, reject) =>
        db.run(
          `INSERT INTO logs (username, partNumber, action, startTime, note) VALUES (?, ?, ?, ?, ?)`,
          [username, partNumber || '', action || 'Start', startTime || Date.now(), note || ''],
          (err) => (err ? reject(err) : resolve())
        )
      );
      db.close();
      res.status(201).json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to create log' });
    }
  });

  // ---- Update log
  router.put('/log/:id', authRequired, async (req, res) => {
    const id = Number(req.params.id);
    const { action, endTime, note } = req.body;
    const db = getDB();

    try {
      // Update allowed fields; keep your existing pause/continue fields if you have them
      await new Promise((resolve, reject) =>
        db.run(
          `UPDATE logs SET action = COALESCE(?, action),
                           endTime = COALESCE(?, endTime),
                           note = COALESCE(?, note)
           WHERE id = ?`,
          [action || null, endTime || null, note || null, id],
          (err) => (err ? reject(err) : resolve())
        )
      );
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to update log' });
    } finally {
      db.close();
    }
  });

  // ---- List logs for a user (tech view)
  router.get('/logs/:username', authRequired, async (req, res) => {
    const username = String(req.params.username || '').toLowerCase();
    const db = getDB();
    try {
      const rows = await new Promise((resolve) =>
        db.all(
          `SELECT id, username, partNumber, action, startTime, endTime, note, pauseStart, pauseTotal
           FROM logs WHERE username = ? ORDER BY startTime DESC`,
          [username],
          (_e, r) => resolve(r || [])
        )
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load logs' });
    } finally {
      db.close();
    }
  });

  // ---- Delete all logs for a user
  router.delete('/delete-logs/:username', authRequired, async (req, res) => {
    const username = String(req.params.username || '').toLowerCase();
    const db = getDB();
    await new Promise((resolve, reject) =>
      db.run(`DELETE FROM logs WHERE username = ?`, [username], (err) => (err ? reject(err) : resolve()))
    );
    db.close();
    res.json({ ok: true });
  });

  // ---- Admin: list all logs
  router.get('/logs', adminRequired, async (_req, res) => {
    const db = getDB();
    try {
      const rows = await new Promise((resolve) =>
        db.all(
          `SELECT id, username, partNumber, action, startTime, endTime, note, pauseStart, pauseTotal
           FROM logs ORDER BY startTime DESC`,
          (_e, r) => resolve(r || [])
        )
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load admin logs' });
    } finally {
      db.close();
    }
  });

  // ---- Admin: clear all logs
  router.delete('/admin/clear-logs', adminRequired, async (_req, res) => {
    const db = getDB();
    await new Promise((resolve, reject) =>
      db.run(`DELETE FROM logs`, (err) => (err ? reject(err) : resolve()))
    );
    db.close();
    res.json({ ok: true });
  });

  return router;
}
