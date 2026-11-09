'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const express = require('express');
const Database = require('better-sqlite3');

const scrypt = promisify(crypto.scrypt);
const SESSION_AGE = 30 * 86400000;
const COOKIE_NAME = 'oneword_session';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function createAccountApi(options = {}) {
  const dbPath = options.dbPath || ':memory:';
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath);
  if (dbPath !== ':memory:') fs.chmodSync(dbPath, 0o600);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS progress (
      user_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, state TEXT NOT NULL, book_ids TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_receipts (
      user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, request_id)
    );
  `);
  const router = express.Router();
  const cookiePath = (options.basePath || '') + '/api';
  const attempts = new Map();
  let deriving = 0;
  let lastSessionCleanup = 0;

  function reply(res, status, error, message, extra) {
    return res.status(status).json({ error, message, ...extra });
  }
  function limited(key, maximum, duration) {
    const now = Date.now();
    if (attempts.size >= 5000) {
      for (const [name, entry] of attempts) if (entry.until <= now) attempts.delete(name);
      if (attempts.size >= 5000) return true;
    }
    let entry = attempts.get(key);
    if (!entry || entry.until <= now) { entry = { count: 0, until: now + duration }; attempts.set(key, entry); }
    entry.count += 1;
    return entry.count > maximum;
  }
  function authLimit(req, res, next) {
    const username = typeof req.body?.username === 'string' ? req.body.username.toLowerCase().slice(0, 32) : '';
    const accountKey = req.account ? 'account:' + req.account.id : 'username:' + username;
    if (limited('auth-ip:' + req.ip, options.authIpLimit || 60, 15 * 60000)
      || limited('auth-user:' + accountKey, options.authUserLimit || 15, 15 * 60000)) {
      res.set('Retry-After', '900');
      return reply(res, 429, 'too_many_attempts', '尝试次数过多，请 15 分钟后再试');
    }
    next();
  }
  function usernameOf(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9_.-]{3,32}$/.test(value) ? value.toLowerCase() : null;
  }
  function validPassword(value) { return typeof value === 'string' && value.length >= 8 && value.length <= 128; }
  async function derive(password, salt) {
    // Bound parallel scrypt work independently of the per-address limiter.
    if (deriving >= 4) { const error = new Error('busy'); error.status = 503; throw error; }
    deriving += 1;
    try { return await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }); }
    finally { deriving -= 1; }
  }
  async function verify(account, password) {
    const result = await derive(password, account ? account.salt : 'oneword-nonexistent-account');
    const expected = account ? Buffer.from(account.password_hash, 'hex') : Buffer.alloc(64);
    return crypto.timingSafeEqual(result, expected) && !!account;
  }
  function tokenOf(req) {
    if (req.headers.authorization !== undefined) {
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization);
      return match ? match[1] : '';
    }
    const cookies = (req.headers.cookie || '').split(';');
    for (const item of cookies) {
      const position = item.indexOf('=');
      if (item.slice(0, position).trim() === COOKIE_NAME) {
        const token = item.slice(position + 1).trim();
        return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : '';
      }
    }
    return '';
  }
  function clearCookie(req, res) {
    res.clearCookie(COOKIE_NAME, { path: cookiePath, httpOnly: true, sameSite: 'lax', secure: req.secure });
  }
  function beginSession(req, res, account) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    if (now - lastSessionCleanup > 3600000) {
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
      lastSessionCleanup = now;
    }
    // A new login replaces this browser's previous session without affecting
    // other devices. The database contains only hashes of bearer credentials.
    const old = tokenOf(req);
    if (old) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(old));
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash(token), account.id, now + SESSION_AGE);
    const result = { user: { id: account.id, username: account.username } };
    if (req.body.client === 'native') result.token = token;
    else res.cookie(COOKIE_NAME, token, { path: cookiePath, httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_AGE });
    return result;
  }
  function authenticated(req, res, next) {
    const token = tokenOf(req);
    const account = token && db.prepare(`SELECT accounts.id,accounts.username FROM sessions JOIN accounts ON accounts.id=sessions.user_id
      WHERE sessions.token_hash=? AND sessions.expires_at>?`).get(hash(token), Date.now());
    if (!account) return reply(res, 401, 'login_required', '请登录后同步学习记录');
    req.account = account;
    req.sessionToken = token;
    if (req.body?.accountId !== undefined && req.body.accountId !== account.id) {
      return reply(res, 403, 'account_changed', '登录账号已变化，请刷新登录状态后重试');
    }
    next();
  }
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      let matches = false;
      if (origin) {
        try { matches = new URL(origin).origin === `${req.protocol}://${req.get('host')}`; } catch (_) {}
      }
      if ((origin && !matches) || req.get('sec-fetch-site') === 'cross-site') return reply(res, 403, 'origin_rejected', '请求来源无效');
      if (!req.is('application/json')) return reply(res, 415, 'json_required', '请使用 JSON 请求');
    }
    next();
  });
  router.use(express.json({ limit: '5mb', strict: true }));

  router.post('/auth/register', authLimit, async (req, res) => {
    const username = usernameOf(req.body?.username);
    if (!username || !validPassword(req.body?.password)) return reply(res, 400, 'invalid_credentials', '用户名需 3–32 位字母、数字、点、下划线或短横线；密码需 8–128 位');
    if (db.prepare('SELECT id FROM accounts WHERE username=?').get(username)) return reply(res, 409, 'username_taken', '这个用户名已被使用，请换一个');
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = (await derive(req.body.password, salt)).toString('hex');
    const account = { id: crypto.randomUUID(), username };
    try { db.prepare('INSERT INTO accounts(id,username,salt,password_hash,created_at) VALUES(?,?,?,?,?)').run(account.id, username, salt, passwordHash, Date.now()); }
    catch (error) { if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return reply(res, 409, 'username_taken', '这个用户名已被使用，请换一个'); throw error; }
    res.status(201).json(beginSession(req, res, account));
  });
  router.post('/auth/login', authLimit, async (req, res) => {
    const username = usernameOf(req.body?.username);
    if (!username || !validPassword(req.body?.password)) return reply(res, 401, 'invalid_credentials', '用户名或密码不正确');
    const account = db.prepare('SELECT * FROM accounts WHERE username=?').get(username);
    if (!await verify(account, req.body.password)) return reply(res, 401, 'invalid_credentials', '用户名或密码不正确');
    res.json(beginSession(req, res, account));
  });
  router.get('/auth/session', authenticated, (req, res) => res.json({ user: req.account }));
  router.post('/auth/logout', (req, res) => {
    const token = tokenOf(req);
    if (req.body?.accountId !== undefined) {
      const session = token && db.prepare('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(token), Date.now());
      if (session && session.user_id !== req.body.accountId) return reply(res, 403, 'account_changed', '登录账号已变化，请刷新登录状态后重试');
    }
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
    clearCookie(req, res);
    res.status(204).end();
  });
  router.post('/auth/password', authenticated, authLimit, async (req, res) => {
    if (!validPassword(req.body?.currentPassword) || !validPassword(req.body?.newPassword)) return reply(res, 400, 'invalid_password', '密码需为 8–128 位');
    const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(req.account.id);
    if (!await verify(account, req.body.currentPassword)) return reply(res, 401, 'invalid_credentials', '当前密码不正确');
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = (await derive(req.body.newPassword, salt)).toString('hex');
    db.transaction(() => {
      db.prepare('UPDATE accounts SET salt=?,password_hash=? WHERE id=?').run(salt, passwordHash, account.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(account.id);
    })();
    res.json(beginSession(req, res, account));
  });
  router.post('/auth/delete', authenticated, authLimit, async (req, res) => {
    if (!validPassword(req.body?.password)) return reply(res, 400, 'invalid_password', '请输入账号密码');
    const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(req.account.id);
    if (!await verify(account, req.body.password)) return reply(res, 401, 'invalid_credentials', '密码不正确，账号未删除');
    db.prepare('DELETE FROM accounts WHERE id=?').run(account.id);
    clearCookie(req, res);
    res.status(204).end();
  });

  function snapshot(userId) {
    const row = db.prepare('SELECT * FROM progress WHERE user_id=?').get(userId);
    return row ? { revision: row.revision, state: JSON.parse(row.state), bookIds: JSON.parse(row.book_ids), updatedAt: row.updated_at }
      : { revision: 0, state: null, bookIds: [], updatedAt: null };
  }
  const commit = db.transaction((userId, request, payloadHash, state, bookIds) => {
    const receipt = db.prepare('SELECT * FROM sync_receipts WHERE user_id=? AND request_id=?').get(userId, request.requestId);
    if (receipt) return receipt.payload_hash === payloadHash ? { status: 200, data: receipt.response ? JSON.parse(receipt.response) : snapshot(userId) }
      : { status: 409, data: { error: 'request_id_reused', message: '同步请求编号重复，请重新同步', ...snapshot(userId) } };
    const previous = snapshot(userId);
    if (request.revision !== previous.revision) return { status: 409, data: { error: 'sync_conflict', message: '另一台设备已有更新，请合并后重试', ...previous } };
    const next = { revision: previous.revision + 1, state, bookIds, updatedAt: Date.now() };
    db.prepare(`INSERT INTO progress(user_id,revision,state,book_ids,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,book_ids=excluded.book_ids,updated_at=excluded.updated_at`)
      .run(userId, next.revision, JSON.stringify(state), JSON.stringify(bookIds), next.updatedAt);
    db.prepare('INSERT INTO sync_receipts(user_id,request_id,payload_hash,response,created_at) VALUES(?,?,?,?,?)')
      .run(userId, request.requestId, payloadHash, JSON.stringify(next), Date.now());
    // Keep compact operation markers so a long-offline device can safely retry
    // an acknowledged upload without applying its answer delta twice. Only the
    // eight most recent operations retain their full response snapshot.
    db.prepare(`UPDATE sync_receipts SET response='' WHERE user_id=? AND response<>'' AND request_id NOT IN
      (SELECT request_id FROM sync_receipts WHERE user_id=? ORDER BY rowid DESC LIMIT 8)`).run(userId, userId);
    return { status: 200, data: next };
  });
  router.get('/sync', authenticated, (req, res) => {
    if (req.query.accountId !== undefined && req.query.accountId !== req.account.id) {
      return reply(res, 403, 'account_changed', '登录账号已变化，请刷新登录状态后再同步');
    }
    res.json(snapshot(req.account.id));
  });
  router.post('/sync', authenticated, (req, res) => {
    if (limited('sync:' + req.account.id, 120, 60000)) return reply(res, 429, 'sync_rate_limit', '同步过于频繁，请稍后重试');
    const raw = req.body;
    if (raw?.accountId !== undefined && raw.accountId !== req.account.id) {
      return reply(res, 403, 'account_changed', '登录账号已变化，请刷新登录状态后再同步');
    }
    if (!raw || !Number.isSafeInteger(raw.revision) || raw.revision < 0 || typeof raw.requestId !== 'string' || !/^[A-Za-z0-9_.-]{8,100}$/.test(raw.requestId)) {
      return reply(res, 400, 'invalid_sync', '同步版本或请求编号无效');
    }
    let normalized;
    try { normalized = options.validateState(raw.state, raw.bookIds); }
    catch (error) { return reply(res, 400, 'invalid_progress', error.message || '学习记录格式无效'); }
    const payloadHash = hash(JSON.stringify({ revision: raw.revision, state: normalized.state, bookIds: normalized.bookIds }));
    const result = commit(req.account.id, raw, payloadHash, normalized.state, normalized.bookIds);
    res.status(result.status).json(result.data);
  });
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.too.large') return reply(res, 413, 'payload_too_large', '学习记录不能超过 5 MB');
    if (error.type === 'entity.parse.failed') return reply(res, 400, 'invalid_json', '请求不是有效的 JSON');
    if (error.status === 503) return reply(res, 503, 'server_busy', '登录请求较多，请稍后重试');
    next(error);
  });
  return { router, close: () => { if (db.open) db.close(); } };
}

module.exports = { createAccountApi };
