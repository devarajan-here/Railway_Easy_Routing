import { Router, Request } from 'express';
import crypto from 'crypto';
import db from '../db';

const router = Router();
const SESSION_DAYS = 14;

interface UserRow {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  password_salt: string;
  is_admin: number;
  tour_completed: number;
  created_at: string;
  last_seen_at: string | null;
}

function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

function safeUser(user: UserRow) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    is_admin: Boolean(user.is_admin),
    tour_completed: Boolean(user.tour_completed),
    created_at: user.created_at,
    last_seen_at: user.last_seen_at
  };
}

function parseCookies(req: Request) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header
      .split(';')
      .map(cookie => cookie.trim().split('='))
      .filter(parts => parts.length === 2)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
}

function sessionCookie(token: string) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  return `railway_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function clearSessionCookie() {
  return 'railway_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
}

function getSessionUser(req: Request) {
  const token = parseCookies(req).railway_session;
  if (!token) return null;

  const row = db.prepare(`
    SELECT u.*
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND datetime(s.expires_at) > datetime('now')
  `).get(token) as UserRow | undefined;

  if (!row) return null;
  db.prepare("UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.id);
  return row;
}

function createSession(userId: number) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return token;
}

router.post('/register', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!name || !email || password.length < 6) {
      return res.status(400).json({ error: 'Name, valid email, and 6+ character password are required' });
    }

    const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
    const { salt, hash } = hashPassword(password);
    const info = db.prepare(`
      INSERT INTO users (name, email, password_hash, password_salt, is_admin, last_seen_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(name, email, hash, salt, userCount === 0 ? 1 : 0);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid) as UserRow;
    const token = createSession(user.id);
    res.setHeader('Set-Cookie', sessionCookie(token));
    res.json({ user: safeUser(user) });
  } catch (err: any) {
    if (String(err?.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    console.error('Register failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/login', (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;

    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const { hash } = hashPassword(password, user.password_salt);
    if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.password_hash, 'hex'))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    db.prepare('UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
    const freshUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as UserRow;
    const token = createSession(user.id);
    res.setHeader('Set-Cookie', sessionCookie(token));
    res.json({ user: safeUser(freshUser) });
  } catch (err) {
    console.error('Login failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', (req, res) => {
  const token = parseCookies(req).railway_session;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', clearSessionCookie());
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ user: null });
  res.json({ user: safeUser(user) });
});

router.post('/tour-complete', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  db.prepare('UPDATE users SET tour_completed = 1 WHERE id = ?').run(user.id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as UserRow;
  res.json({ user: safeUser(updated) });
});

router.get('/admin/stats', (req, res) => {
  const user = getSessionUser(req);
  if (!user || !user.is_admin) return res.status(403).json({ error: 'Admin access required' });

  const totalUsers = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
  const completedTours = (db.prepare('SELECT COUNT(*) as count FROM users WHERE tour_completed = 1').get() as { count: number }).count;
  const activeSessions = (db.prepare("SELECT COUNT(*) as count FROM sessions WHERE datetime(expires_at) > datetime('now')").get() as { count: number }).count;
  const recentUsers = db.prepare(`
    SELECT id, name, email, is_admin, tour_completed, created_at, last_seen_at
    FROM users
    ORDER BY datetime(created_at) DESC
    LIMIT 25
  `).all();

  res.json({
    totalUsers,
    completedTours,
    activeSessions,
    recentUsers
  });
});

export default router;
