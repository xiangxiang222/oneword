'use strict';

// This module deliberately uses only the JavaScript APIs available in WeChat.
// Intervals are an explainable spacing heuristic, not a fitted FSRS model.
const { books, words, wordMap } = require('../data/vocabulary.js');
const MINUTE = 60000;
const DAY = 86400000;
const INTERVALS = [1, 2, 4, 7, 15, 30, 60, 90];
const STATUSES = ['known', 'unknown', 'unsure'];
const LEARNING_ORDERS = [
  { id: 'adaptive', label: '记忆优先', description: '先复习到期词，优先逾期和薄弱词；新词沿用词书编排。' },
  { id: 'alphabetical', label: '字母顺序', description: '按 A–Z 排列新词和到期复习词，仍先复习再学新词。' },
  { id: 'random', label: '随机顺序', description: '每天混排新词和到期复习词，同日顺序稳定，仍先复习。' }
];
const MAX_HISTORY = 20;

function timestamp(value) {
  const n = value === undefined ? Date.now() : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 8640000000000000) throw new Error('学习时间无效');
  return n;
}

function dateKey(now) {
  const date = new Date(timestamp(now));
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

function bookFor(state) {
  return books.find(book => book.id === state.bookId && book.available) || books.find(book => book.id === 'cet4') || books.find(book => book.available);
}

function createState(now) {
  const at = timestamp(now);
  return {
    version: 1,
    bookId: 'cet4',
    createdAt: at,
    settings: { dailyGoal: 20, recallFirst: false, sound: false, tutorialComplete: false, accent: 'us', learningOrder: 'adaptive' },
    words: {},
    daily: {},
    history: []
  };
}

function dailyEntry() {
  return { newWordIds: [], reviewedWordIds: [], answerCount: 0, known: 0, unknown: 0, unsure: 0 };
}

function getCollection(state, status) {
  if (status !== undefined && status !== 'all' && !STATUSES.includes(status)) throw new Error('词库分类无效');
  return words.filter(word => state.words[word.id] && (!status || status === 'all' || state.words[word.id].status === status))
    .map(word => Object.assign({}, word, { progress: state.words[word.id] }))
    .sort((a, b) => (a.progress.dueAt - b.progress.dueAt) || a.word.localeCompare(b.word));
}

function compareWords(a, b) {
  // All dictionary IDs are lowercase English. A lexical comparison is identical
  // across JavaScript runtimes and does not depend on the device's locale.
  return a < b ? -1 : a > b ? 1 : 0;
}

function learningOrder(state, override) {
  const order = override !== undefined ? override : state.settings.learningOrder === undefined ? 'adaptive' : state.settings.learningOrder;
  if (!LEARNING_ORDERS.some(item => item.id === order)) throw new Error('请选择记忆优先、字母顺序或随机顺序');
  return order;
}

function randomRank(value) {
  // A stable keyed rank, rather than reshuffling on every call, preserves the
  // relative order of the remaining words after a rating or a page reload.
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function orderIds(ids, state, now, order, fresh) {
  const ordered = ids.slice();
  if (order === 'alphabetical') return ordered.sort(compareWords);
  if (order === 'random') {
    const seed = String(state.createdAt) + '|' + dateKey(now) + '|' + state.bookId + '|';
    const ranks = Object.create(null);
    ordered.forEach(id => { ranks[id] = randomRank(seed + id); });
    return ordered.sort((a, b) => ranks[a] - ranks[b] || compareWords(a, b));
  }
  if (fresh) return ordered;
  const weakness = { unknown: 0, unsure: 1, known: 2 };
  return ordered.sort((a, b) => {
    const pa = state.words[a];
    const pb = state.words[b];
    const aDue = pa.dueAt <= now;
    const bDue = pb.dueAt <= now;
    if (aDue !== bDue) return aDue ? -1 : 1;
    if (!aDue) return pa.dueAt - pb.dueAt || compareWords(a, b);
    // Relative overdue time is an explainable priority heuristic. It is not an
    // estimated forgetting probability or a fitted memory model.
    const urgencyA = (now - pa.dueAt) / Math.max(pa.interval, 5 * MINUTE);
    const urgencyB = (now - pb.dueAt) / Math.max(pb.interval, 5 * MINUTE);
    return urgencyB - urgencyA || weakness[pa.status] - weakness[pb.status]
      || pb.lapses - pa.lapses || pa.dueAt - pb.dueAt || compareWords(a, b);
  });
}

function makeSession(state, options) {
  const opts = options || {};
  const now = timestamp(opts.now);
  const mode = opts.mode || 'today';
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));
  const order = learningOrder(state, opts.learningOrder);
  if (STATUSES.includes(mode) || mode === 'all') {
    const ids = getCollection(state, mode).map(word => word.id);
    return orderIds(ids, state, now, order, false).slice(0, limit)
      .map(id => Object.assign({}, wordMap[id], { progress: state.words[id] }));
  }
  if (!['today', 'review', 'new'].includes(mode)) throw new Error('学习模式无效');
  const book = bookFor(state);
  const day = state.daily[dateKey(now)] || dailyEntry();
  const due = orderIds(book.wordIds.filter(id => state.words[id] && state.words[id].dueAt <= now), state, now, order, false);
  const room = Math.max(0, state.settings.dailyGoal - day.newWordIds.length);
  // Order the full unseen pool before taking today's quota. Otherwise random
  // mode would merely shuffle the first few words in the original book.
  const fresh = orderIds(book.wordIds.filter(id => !state.words[id]), state, now, order, true).slice(0, room);
  const ids = mode === 'review' ? due : mode === 'new' ? fresh : due.concat(fresh);
  return ids.slice(0, limit).map(id => Object.assign({}, wordMap[id], { progress: state.words[id] || null }));
}

function rateWord(state, wordId, rating, at) {
  const now = timestamp(at);
  if (!wordMap[wordId]) throw new Error('找不到这个单词');
  if (!STATUSES.includes(rating)) throw new Error('请选择认识、不认识或不确定');
  const previous = state.words[wordId];
  // A double tap is not a second retrieval. Ignore stale and near-identical events.
  if (previous && now - previous.lastReviewedAt < 800) return state;
  const key = dateKey(now);
  const priorDay = state.daily[key];
  const day = Object.assign(dailyEntry(), priorDay || {}, {
    newWordIds: (priorDay ? priorDay.newWordIds : []).slice(),
    reviewedWordIds: (priorDay ? priorDay.reviewedWordIds : []).slice()
  });
  if (!previous && !day.newWordIds.includes(wordId)) day.newWordIds.push(wordId);
  if (previous && !day.reviewedWordIds.includes(wordId)) day.reviewedWordIds.push(wordId);
  day.answerCount += 1;
  day[rating] += 1;
  // Early practice can update the collection, but cannot manufacture evidence
  // of long-term recall by advancing through several levels in one session.
  const knownRepetitions = !previous || previous.dueAt <= now ? (previous ? previous.repetitions : 0) + 1 : Math.max(1, previous.repetitions);
  const repetitions = rating === 'known' ? knownRepetitions : rating === 'unsure' ? Math.max(0, (previous ? previous.repetitions : 0) - 1) : 0;
  const interval = rating === 'known' ? INTERVALS[Math.min(repetitions - 1, INTERVALS.length - 1)] * DAY : rating === 'unknown' ? 5 * MINUTE : 15 * MINUTE;
  const progress = {
    status: rating,
    repetitions,
    lapses: (previous ? previous.lapses : 0) + (rating === 'unknown' ? 1 : 0),
    interval,
    dueAt: now + interval,
    lastReviewedAt: now,
    firstReviewedAt: previous ? previous.firstReviewedAt : now,
    totalReviews: (previous ? previous.totalReviews : 0) + 1
  };
  const next = Object.assign({}, state, {
    words: Object.assign({}, state.words, { [wordId]: progress }),
    daily: Object.assign({}, state.daily, { [key]: day }),
    history: (state.history || []).concat([{ wordId, previous: previous || null, date: key, previousDay: priorDay || null }]).slice(-MAX_HISTORY)
  });
  return next;
}

function undo(state) {
  const history = state.history || [];
  if (!history.length) return state;
  const action = history[history.length - 1];
  const nextWords = Object.assign({}, state.words);
  const nextDaily = Object.assign({}, state.daily);
  if (action.previous) nextWords[action.wordId] = action.previous;
  else delete nextWords[action.wordId];
  if (action.previousDay) nextDaily[action.date] = action.previousDay;
  else delete nextDaily[action.date];
  return Object.assign({}, state, { words: nextWords, daily: nextDaily, history: history.slice(0, -1) });
}

function setBook(state, bookId) {
  if (!books.some(book => book.id === bookId && book.available)) throw new Error('这本词书暂不可用');
  return Object.assign({}, state, { bookId });
}

function updateSettings(state, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('学习设置格式无效');
  const settings = Object.assign({}, state.settings);
  Object.keys(patch).forEach(key => {
    if (key === 'dailyGoal') {
      if (!Number.isInteger(patch[key]) || patch[key] < 1 || patch[key] > 200) throw new Error('每日新词数需为 1–200 的整数');
    } else if (key === 'accent') {
      if (!['us', 'uk'].includes(patch[key])) throw new Error('请选择美式或英式朗读');
    } else if (key === 'learningOrder') {
      if (!LEARNING_ORDERS.some(item => item.id === patch[key])) throw new Error('请选择记忆优先、字母顺序或随机顺序');
    } else if (['recallFirst', 'sound', 'tutorialComplete'].includes(key)) {
      if (typeof patch[key] !== 'boolean') throw new Error('学习设置值无效');
    } else throw new Error('未知的学习设置');
    settings[key] = patch[key];
  });
  return Object.assign({}, state, { settings });
}

function getStats(state, at) {
  const now = timestamp(at);
  const key = dateKey(now);
  const day = state.daily[key] || dailyEntry();
  const book = bookFor(state);
  const entries = Object.values(state.words);
  const learnedIds = book.wordIds.filter(id => state.words[id]);
  const due = learnedIds.filter(id => state.words[id].dueAt <= now);
  const remainingNew = Math.min(Math.max(0, state.settings.dailyGoal - day.newWordIds.length), book.wordIds.length - learnedIds.length);
  const base = new Date(now);
  base.setHours(12, 0, 0, 0);
  const last7Days = [];
  const forecast = [];
  for (let i = -6; i <= 6; i += 1) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    const date = dateKey(d.getTime());
    if (i <= 0) {
      const info = state.daily[date] || dailyEntry();
      last7Days.push({ date, label: i === 0 ? '今天' : d.getMonth() + 1 + '/' + d.getDate(), newCount: info.newWordIds.length, reviewCount: info.reviewedWordIds.length, total: info.answerCount });
    }
    if (i >= 0) {
      const count = learnedIds.filter(id => {
        const dueAt = state.words[id].dueAt;
        return i === 0 ? dueAt <= new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1 : dateKey(dueAt) === date;
      }).length;
      forecast.push({ date, label: i === 0 ? '今天' : i === 1 ? '明天' : d.getMonth() + 1 + '/' + d.getDate(), count });
    }
  }
  let streak = 0;
  const cursor = new Date(base);
  if (!day.answerCount) cursor.setDate(cursor.getDate() - 1);
  while (streak < 36600) {
    const entry = state.daily[dateKey(cursor.getTime())];
    if (!entry || !entry.answerCount) break;
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  const nextDueAt = learnedIds.reduce((min, id) => state.words[id].dueAt > now ? Math.min(min, state.words[id].dueAt) : min, Infinity);
  return {
    bookId: book.id,
    bookTitle: book.title,
    bookTotal: book.count,
    learnedCount: learnedIds.length,
    totalLearned: entries.length,
    knownCount: entries.filter(entry => entry.status === 'known').length,
    unknownCount: entries.filter(entry => entry.status === 'unknown').length,
    unsureCount: entries.filter(entry => entry.status === 'unsure').length,
    masteredCount: entries.filter(entry => entry.status === 'known' && entry.repetitions >= 4 && entry.interval >= 7 * DAY).length,
    dueCount: due.length,
    todayNew: day.newWordIds.length,
    todayReviews: day.reviewedWordIds.length,
    todayReviewed: day.reviewedWordIds.length,
    todayAnswers: day.answerCount,
    dailyGoal: state.settings.dailyGoal,
    remainingNew,
    todayRemaining: due.length + remainingNew,
    progress: book.count ? Math.round(learnedIds.length / book.count * 100) : 0,
    streak,
    nextDueAt: Number.isFinite(nextDueAt) ? nextDueAt : null,
    last7Days,
    forecast
  };
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function validProgress(value) {
  if (!plainObject(value) || !STATUSES.includes(value.status)) return false;
  if (!['repetitions', 'lapses', 'totalReviews'].every(key => Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 1000000)) return false;
  return ['interval', 'dueAt', 'lastReviewedAt', 'firstReviewedAt'].every(key => Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 8640000000000000)
    && value.dueAt >= value.lastReviewedAt && value.lastReviewedAt >= value.firstReviewedAt && value.interval <= 365 * DAY
    && value.dueAt - value.lastReviewedAt === value.interval;
}

function validDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parts = value.split('-').map(Number);
  const date = new Date(parts[0], parts[1] - 1, parts[2], 12);
  return date.getFullYear() === parts[0] && date.getMonth() === parts[1] - 1 && date.getDate() === parts[2];
}

function validDaily(value) {
  if (!plainObject(value)) return false;
  if (!['newWordIds', 'reviewedWordIds'].every(key => Array.isArray(value[key]) && value[key].length <= words.length && new Set(value[key]).size === value[key].length && value[key].every(id => typeof id === 'string' && !!wordMap[id]))) return false;
  return ['answerCount', 'known', 'unknown', 'unsure'].every(key => Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 1000000)
    && value.answerCount === value.known + value.unknown + value.unsure;
}

function restoreState(input, now) {
  let raw = input;
  if (typeof input === 'string') {
    if (input.length > 5 * 1024 * 1024) throw new Error('学习记录超过 5 MB，无法恢复');
    try { raw = JSON.parse(input); } catch (_) { throw new Error('学习记录不是有效的 JSON 文件'); }
  }
  if (!plainObject(raw) || raw.version !== 1) throw new Error('学习记录版本无效');
  try {
    if (JSON.stringify(raw).length > 5 * 1024 * 1024) throw new Error('学习记录超过 5 MB，无法恢复');
  } catch (error) {
    throw new Error(error.message.includes('5 MB') ? error.message : '学习记录无法读取');
  }
  if (!books.some(book => book.id === raw.bookId && book.available)) throw new Error('记录中的词书不可用');
  if (!plainObject(raw.words) || Object.keys(raw.words).length > words.length) throw new Error('单词记录格式无效');
  if (!plainObject(raw.daily) || Object.keys(raw.daily).length > 36600) throw new Error('每日记录格式无效');
  const base = createState(now);
  const settings = updateSettings(base, raw.settings).settings;
  Object.keys(raw.words).forEach(id => {
    if (!wordMap[id] || !validProgress(raw.words[id])) throw new Error('单词记录损坏：' + id);
  });
  Object.keys(raw.daily).forEach(date => {
    if (!validDateKey(date) || !validDaily(raw.daily[date])) throw new Error('每日记录损坏：' + date);
  });
  const result = {
    version: 1, bookId: raw.bookId,
    createdAt: Number.isFinite(raw.createdAt) && raw.createdAt >= 0 ? raw.createdAt : base.createdAt,
    settings,
    words: JSON.parse(JSON.stringify(raw.words)),
    daily: JSON.parse(JSON.stringify(raw.daily)),
    // History is ephemeral. Discarding it prevents imported undo entries from
    // bypassing validation of the actual learning records.
    history: []
  };
  return result;
}

function textField(value, max, label, optional) {
  if (optional && (value === undefined || value === null)) return '';
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error('词书' + label + '格式无效');
  return value;
}

// A pure validation pass lets clients persist an entire package before making
// it visible. If storage is full, no newly learned word becomes unrecoverable
// on the next app launch. No mutation occurs until installBook's second phase.
function validateBook(payload) {
  if (!plainObject(payload) || !plainObject(payload.book) || !Array.isArray(payload.words)) throw new Error('词书包格式无效');
  const current = books.find(book => book.id === payload.book.id && book.available);
  if (!current) throw new Error('词书包的词书不可用');
  if (payload.book.edition !== 'full') throw new Error('请选择完整词书包');
  if (payload.words.length < 1 || payload.words.length > 15000 || payload.book.count !== payload.words.length) throw new Error('词书数量无效（最多 15000 词）');
  if (!Array.isArray(payload.book.wordIds) || payload.book.wordIds.length !== payload.words.length) throw new Error('词书目录与单词数量不一致');
  let encoded;
  try { encoded = JSON.stringify(payload); } catch (_) { throw new Error('词书包无法读取'); }
  if (encoded.length > 8 * 1024 * 1024) throw new Error('词书包超过 8 MB');
  const seen = Object.create(null);
  const normalized = payload.words.map((entry, index) => {
    if (!plainObject(entry)) throw new Error('词条格式无效');
    const id = textField(entry.id, 80, '单词');
    if (!/^[a-z]+(?:[-'][a-z]+)?$/.test(id) || id === 'constructor' || seen[id]) throw new Error('单词编号无效或重复：' + id);
    if (payload.book.wordIds[index] !== id || (entry.word !== undefined && entry.word !== id)) throw new Error('词书目录与词条不一致：' + id);
    seen[id] = true;
    const coreMeaning = textField(entry.coreMeaning, 120, '核心义');
    if (!/[\u4e00-\u9fff]/.test(coreMeaning) || /[,，;；\n]/.test(coreMeaning)) throw new Error('词书核心义应只保留一个中文意思');
    const pos = textField(entry.pos, 20, '词性', true);
    const phonetic = textField(entry.phonetic, 160, '音标', true);
    if (!Array.isArray(entry.meanings) || entry.meanings.length < 1 || entry.meanings.length > 12) throw new Error('词书展开义项无效');
    const meanings = entry.meanings.map(item => {
      if (!plainObject(item)) throw new Error('词书展开义项格式无效');
      return { pos: textField(item.pos, 20, '词性', true), meaning: textField(item.meaning, 160, '展开义项') };
    });
    if (meanings[0].meaning !== coreMeaning || meanings[0].pos !== pos) throw new Error('核心义与第一义项不一致');
    let example = null;
    if (entry.example !== undefined && entry.example !== null) {
      if (!plainObject(entry.example)) throw new Error('词书例句格式无效');
      example = { en: textField(entry.example.en, 600, '英文例句'), zh: textField(entry.example.zh, 600, '中文例句') };
    }
    const existing = wordMap[id];
    const source = entry.source === undefined ? existing ? existing.source : 'ECDICT · MIT / 首义提取' : textField(entry.source, 200, '来源');
    const bookIds = existing ? existing.bookIds.slice() : [];
    if (!bookIds.includes(current.id)) bookIds.push(current.id);
    return { id, word: id, phonetic, pos, coreMeaning, meanings, example, source, bookIds };
  });
  const uniqueTotal = words.length + normalized.filter(word => !wordMap[word.id]).length;
  if (uniqueTotal > 50000) throw new Error('已安装单词超过 50000 词');
  const book = Object.assign({}, current, {
    wordIds: normalized.map(word => word.id), count: normalized.length,
    fullCount: normalized.length, edition: 'full', fullAvailable: true,
    subtitle: current.subtitle.replace('精选', '词表'),
    selection: current.id === 'primary' ? '人工基础选词' : 'ECDICT 考试标签全量（非官方大纲）',
    isComplete: false
  });
  const result = { book, words: normalized, source: 'https://github.com/skywind3000/ECDICT' };
  if (payload.license !== undefined) result.license = textField(payload.license, 3000, '许可证');
  if (payload.upstreamBlobSha1 !== undefined) {
    if (typeof payload.upstreamBlobSha1 !== 'string' || !/^[a-f0-9]{40}$/.test(payload.upstreamBlobSha1)) throw new Error('词书来源校验值无效');
    result.upstreamBlobSha1 = payload.upstreamBlobSha1;
  }
  return result;
}

function installBook(payload) {
  const validated = validateBook(payload);
  // All entries have passed before any exported shared reference is modified.
  const indexes = Object.create(null);
  words.forEach((word, index) => { indexes[word.id] = index; });
  validated.words.forEach(word => {
    if (wordMap[word.id]) words[indexes[word.id]] = word;
    else words.push(word);
    wordMap[word.id] = word;
  });
  const book = books.find(item => item.id === validated.book.id);
  Object.assign(book, validated.book);
  return book;
}

module.exports = { createState, makeSession, rateWord, undo, getStats, setBook, getCollection, updateSettings, restoreState, importState: restoreState, validateBook, installBook, dateKey, INTERVALS, LEARNING_ORDERS, DAY, MINUTE };
