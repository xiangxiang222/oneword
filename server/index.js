'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const VERSION = require('./package.json').version;
const SPA_ROUTES = new Set(['/', '/today', '/study', '/review', '/library', '/books', '/words', '/bag', '/profile', '/settings', '/progress']);

function normalizeBasePath(value) {
  if (value === '' || value === '/') return '';
  if (typeof value !== 'string' || !/^\/[a-zA-Z0-9/_-]+$/.test(value) || value.includes('//')) {
    throw new TypeError('BASE_PATH must be an absolute URL path such as /oneword');
  }
  return value.replace(/\/+$/, '');
}

function publicBook(book) {
  const { wordIds, ...metadata } = book;
  return { ...metadata, count: wordIds ? wordIds.length : Number(book.count || 0) };
}

function createApp(options = {}) {
  const basePath = normalizeBasePath(options.basePath ?? process.env.BASE_PATH ?? '/oneword');
  const distDir = path.resolve(options.distDir || path.join(ROOT, 'web/dist'));
  const fullBooksDir = path.resolve(options.fullBooksDir || path.join(ROOT, 'data/full-books'));
  const catalog = options.catalog || require(path.join(ROOT, 'data/vocabulary.js'));
  const books = catalog.books || [];
  const wordMap = catalog.wordMap || Object.fromEntries((catalog.words || []).map(word => [word.id, word]));
  const fullCache = new Map();

  function fullBook(book) {
    // IDs come from the shipped catalog and must remain a single file basename.
    if (!book || book.available === false || !/^[a-zA-Z0-9_-]+$/.test(book.id)) return null;
    const filename = path.join(fullBooksDir, `${book.id}.json`);
    let stat;
    try { stat = fs.statSync(filename); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
    if (!stat.isFile()) return null;
    const cached = fullCache.get(book.id);
    if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return cached.payload;
    const payload = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!payload || !payload.book || payload.book.id !== book.id || !Array.isArray(payload.words)
      || payload.words.length === 0 || payload.words.length > 100000
      || payload.words.some(word => !word || typeof word.id !== 'string' || !word.id)
      || new Set(payload.words.map(word => word.id)).size !== payload.words.length) {
      throw new Error('Invalid complete book package');
    }
    const result = {
      ...payload,
      book: {
        ...publicBook(book), ...payload.book,
        wordIds: payload.words.map(word => word.id),
        count: payload.words.length,
        selectedCount: (book.wordIds || []).length,
        fullCount: payload.words.length,
        fullAvailable: true,
        edition: 'full'
      }
    };
    fullCache.set(book.id, { mtime: stat.mtimeMs, size: stat.size, payload: result });
    return result;
  }

  function bookMetadata(book) {
    let complete = null;
    try { complete = fullBook(book); } catch { /* Invalid packages are never advertised as available. */ }
    return {
      ...publicBook(book),
      selectedCount: (book.wordIds || []).length,
      fullCount: complete ? complete.words.length : Number(book.fullCount || 0),
      fullAvailable: !!complete
    };
  }

  function sendFullBook(req, res) {
    const book = books.find(item => item.id === req.params.id);
    if (!book) return res.status(404).json({ error: 'book_not_found', message: '没有找到这本词书' });
    try {
      const payload = fullBook(book);
      if (!payload) return res.status(404).json({ error: 'full_book_unavailable', message: '这本词书尚未提供完整词表，请先使用精选版' });
      return res.set('Cache-Control', 'public, max-age=300').json(payload);
    } catch {
      return res.status(500).json({ error: 'full_book_invalid', message: '完整词表暂时无法读取，请稍后重试' });
    }
  }
  const app = express();
  app.disable('x-powered-by');
  app.enable('strict routing');
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    let pathname;
    try { pathname = decodeURIComponent(req.path); }
    catch { return res.status(400).json({ error: 'invalid_path', message: '请求路径无效' }); }
    if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.'))) {
      return res.status(404).json({ error: 'not_found' });
    }
    next();
  });

  const router = express.Router();
  router.get('/api/health', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true, service: 'oneword', version: VERSION, releaseId: process.env.ONEWORD_RELEASE_ID || 'development', storage: 'local', basePath });
  });
  router.get('/api/meta', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json({
      name: '一词', version: VERSION, storage: 'local', cloudSync: false,
      bookCount: books.filter(book => book.available !== false).length,
      wordCount: Object.keys(wordMap).length,
      note: '学习记录仅保存在当前设备；精选词书可离线使用，完整标签词表可按需下载，均不冒充官方考试大纲。'
    });
  });
  router.get('/api/books', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json({ books: books.map(bookMetadata) });
  });
  router.get('/api/books/:id/words', (req, res) => {
    const edition = req.query.edition ?? 'selected';
    if (edition !== 'selected' && edition !== 'full') return res.status(400).json({ error: 'invalid_edition', message: '词书版本仅支持 selected 或 full' });
    if (edition === 'full') return sendFullBook(req, res);
    const book = books.find(item => item.id === req.params.id);
    if (!book) return res.status(404).json({ error: 'book_not_found', message: '没有找到这本词书' });
    if (book.available === false) return res.status(409).json({ error: 'book_unavailable', message: '这本词书尚未提供可用词表' });
    const words = (book.wordIds || []).map(id => wordMap[id]).filter(Boolean);
    res.set('Cache-Control', 'public, max-age=300').json({ book: { ...bookMetadata(book), edition: 'selected' }, words });
  });
  router.get('/api/books/:id/full', sendFullBook);
  router.use('/api', (req, res) => {
    res.status(404).json({ error: 'api_not_found', message: '接口不存在' });
  });

  router.use(express.static(distDir, {
    index: false,
    dotfiles: 'deny',
    fallthrough: true,
    redirect: false,
    setHeaders(res, filePath) {
      res.set('Cache-Control', /[/\\]assets[/\\]/.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache');
    }
  }));
  router.use((req, res, next) => {
    const pathname = req.path.replace(/\/$/, '') || '/';
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !SPA_ROUTES.has(pathname) || !req.accepts('html')) return next();
    const entry = path.join(distDir, 'index.html');
    if (!fs.existsSync(entry)) return res.status(503).json({ error: 'web_not_built', message: '请先执行 npm run build' });
    res.set('Cache-Control', 'no-cache').sendFile(entry);
  });

  if (basePath) {
    app.get(basePath, (req, res) => res.redirect(308, `${basePath}/`));
    app.use(basePath, router);
  } else {
    app.use(router);
  }
  app.use((req, res) => res.status(404).json({ error: 'not_found', message: '页面或文件不存在' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status === 404 ? 404 : error instanceof URIError || error.status === 400 ? 400 : 500;
    res.status(status).json({ error: status === 500 ? 'internal_error' : status === 400 ? 'invalid_path' : 'not_found' });
  });
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3795);
  const host = process.env.BIND_HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('PORT must be between 1 and 65535');
  const app = createApp();
  const server = app.listen(port, host, () => console.log(`oneword listening on http://${host}:${port}${normalizeBasePath(process.env.BASE_PATH ?? '/oneword')}/`));
  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createApp, normalizeBasePath };
