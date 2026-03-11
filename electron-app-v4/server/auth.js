'use strict';

/**
 * auth.js — Session-based authentication.
 *
 * Sessions stored in-memory (Map<token, {username, role, userId, expires}>).
 * Tokens are random UUIDs in cookies.
 *
 * Users are stored in the SQLite `users` table (if it exists).
 * If no users table exists, a default admin/admin account is used.
 */

const crypto = require('crypto');
const { getDb } = require('./db');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;  // 24 h
const _sessions = new Map();  // token → { username, role, userId, expires }

// ── Password helpers ──────────────────────────────────────────────────────────

function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100_000, 32, 'sha256').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, storedHash, salt) {
  const { hash } = hashPassword(password, salt);
  return hash === storedHash;
}

// ── Session management ────────────────────────────────────────────────────────

function createSession(username, role, userId) {
  const token   = crypto.randomUUID();
  const expires = Date.now() + SESSION_TTL_MS;
  _sessions.set(token, { username, role, userId, expires });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = _sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { _sessions.delete(token); return null; }
  return s;
}

function deleteSession(token) {
  _sessions.delete(token);
}

// ── User lookup ───────────────────────────────────────────────────────────────

function lookupUser(username, password) {
  let db;
  try { db = getDb(); } catch { /* no DB yet */ }

  if (db) {
    try {
      // Add password_salt column if this is a fresh v4 DB (v2 DBs won't have it)
      try {
        db.prepare('ALTER TABLE users ADD COLUMN password_salt TEXT').run();
      } catch { /* column already exists */ }

      const user = db.prepare(
        'SELECT id, username, password_hash, password_salt, role FROM users WHERE username = ?'
      ).get(username);

      if (user) {
        if (!user.password_salt) {
          // v2 Werkzeug-format hash (pbkdf2:sha256:N$salt$hash) — can't verify with our
          // PBKDF2 implementation. Fall through to the env-var default below so the user
          // can log in with DEFAULT_ADMIN_USER / DEFAULT_ADMIN_PASS (admin/admin by default).
        } else {
          const ok = verifyPassword(password, user.password_hash, user.password_salt);
          if (!ok) return null;
          return { username: user.username, role: user.role || 'user', userId: user.id };
        }
      }
    } catch {
      // users table may not exist — fall through to default
    }
  }

  // Fallback: default admin account (dev / first-run)
  const defaultAdmin = process.env.DEFAULT_ADMIN_USER || 'admin';
  const defaultPass  = process.env.DEFAULT_ADMIN_PASS || 'admin';
  if (username === defaultAdmin && password === defaultPass) {
    return { username, role: 'admin', userId: null };
  }

  return null;
}

// ── Express middleware ────────────────────────────────────────────────────────

/** Attach req.user if a valid session cookie is present. */
function sessionMiddleware(req, _res, next) {
  const token = req.cookies?.session;
  req.user = getSession(token) || null;
  next();
}

/** Returns true if the request originates from the local machine. */
function isLocalhost(req) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/** Require authentication; respond 401 if missing.
 *  Localhost requests are auto-authenticated as local admin (same-machine bypass). */
function requireAuth(req, res, next) {
  if (!req.user) {
    if (isLocalhost(req)) {
      req.user = { username: 'local', role: 'admin', userId: null };
      return next();
    }
    return res.status(401).json({ detail: 'Not authenticated' });
  }
  next();
}

/** Require admin role; respond 403 if not admin. */
function requireAdmin(req, res, next) {
  if (!req.user) {
    if (isLocalhost(req)) {
      req.user = { username: 'local', role: 'admin', userId: null };
      return next();
    }
    return res.status(401).json({ detail: 'Not authenticated' });
  }
  if (req.user.role !== 'admin') return res.status(403).json({ detail: 'Admin only' });
  next();
}

// ── Auth router factory ───────────────────────────────────────────────────────

const express = require('express');

function makeAuthRouter() {
  const router = express.Router();

  router.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ detail: 'username and password required' });
    }
    const user = lookupUser(username, password);
    if (!user) return res.status(401).json({ detail: 'Invalid credentials' });

    const token = createSession(user.username, user.role, user.userId);
    res.cookie('session', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge:   SESSION_TTL_MS,
    });
    res.json({ username: user.username, role: user.role, ok: true });
  });

  router.post('/logout', (req, res) => {
    const token = req.cookies?.session;
    if (token) deleteSession(token);
    res.clearCookie('session');
    res.json({ ok: true });
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({ username: req.user.username, role: req.user.role });
  });

  router.post('/change-password', requireAuth, (req, res) => {
    const { current_password, new_password } = req.body || {};
    const user = lookupUser(req.user.username, current_password);
    if (!user) return res.status(400).json({ detail: 'Wrong current password' });

    let db;
    try { db = getDb(); } catch { return res.status(500).json({ detail: 'DB unavailable' }); }

    const { hash, salt } = hashPassword(new_password);
    try {
      db.prepare('UPDATE users SET password_hash=?, password_salt=? WHERE username=?')
        .run(hash, salt, req.user.username);
    } catch {
      return res.status(500).json({ detail: 'Could not update password' });
    }
    res.json({ ok: true });
  });

  return router;
}

module.exports = { sessionMiddleware, requireAuth, requireAdmin, makeAuthRouter, getSession };
