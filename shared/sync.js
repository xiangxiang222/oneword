'use strict';

// A three-way merge for validated learning snapshots. The server must persist
// request IDs (or reject stale revisions): applying a daily delta twice would
// otherwise count the same answer twice. This module does not perform I/O.
const COUNTERS = ['known', 'unknown', 'unsure'];
const ID_LISTS = ['newWordIds', 'reviewedWordIds'];
const MAX_ANSWERS = 1000000;
const owns = (object, key) => !!object && Object.prototype.hasOwnProperty.call(object, key);

function ownValue(object, key) {
  return owns(object, key) ? object[key] : undefined;
}

function put(object, key, value) {
  // An own data property prevents special names from invoking prototype setters.
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}

function copy(value) {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(copy);
  const result = {};
  Object.keys(value).forEach(key => put(result, key, copy(value[key])));
  return result;
}

function canonical(value, omitHistory, depth, parentKey) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    // Daily word lists represent sets. Their insertion order has no meaning.
    const entries = ID_LISTS.includes(parentKey) ? value.slice().sort() : value;
    return '[' + entries.map(item => canonical(item, false, depth + 1, '')).join(',') + ']';
  }
  return '{' + Object.keys(value).filter(key => !(omitHistory && depth === 0 && key === 'history')).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key], false, depth + 1, key)).join(',') + '}';
}

function equal(a, b) {
  return canonical(a, false, 0, '') === canonical(b, false, 0, '');
}

function sameState(a, b) {
  return canonical(a, true, 0, '') === canonical(b, true, 0, '');
}

function keysOf() {
  const keys = new Set();
  Array.prototype.forEach.call(arguments, object => {
    if (object) Object.keys(object).forEach(key => keys.add(key));
  });
  return Array.from(keys).sort();
}

function unionIds(a, b) {
  return Array.from(new Set((a || []).concat(b || []))).sort();
}

function latestProgress(local, remote) {
  // A concurrent review survives an undo on another device. A deletion only
  // takes effect when that other device has not changed the base word record.
  if (local === undefined) return remote;
  if (remote === undefined) return local;
  if (local.lastReviewedAt !== remote.lastReviewedAt) {
    return local.lastReviewedAt > remote.lastReviewedAt ? local : remote;
  }
  // Resolve identical timestamps the same way in either merge direction.
  return canonical(local, false, 0, '') >= canonical(remote, false, 0, '') ? local : remote;
}

function mergeWords(base, local, remote, initialImport) {
  const result = {};
  keysOf(base, local, remote).forEach(id => {
    const before = ownValue(base, id);
    const mine = ownValue(local, id);
    const theirs = ownValue(remote, id);
    let chosen;
    if (initialImport) chosen = latestProgress(mine, theirs);
    else if (equal(mine, before)) chosen = theirs;
    else if (equal(theirs, before)) chosen = mine;
    else chosen = latestProgress(mine, theirs);
    if (chosen !== undefined) put(result, id, copy(chosen));
  });
  return result;
}

function mergeDaily(base, local, remote, initialImport) {
  const result = {};
  keysOf(base, local, remote).forEach(date => {
    const before = ownValue(base, date);
    const mine = ownValue(local, date);
    const theirs = ownValue(remote, date);
    if (!initialImport && equal(mine, before)) {
      if (theirs !== undefined) put(result, date, copy(theirs));
      return;
    }
    if (!initialImport && equal(theirs, before)) {
      if (mine !== undefined) put(result, date, copy(mine));
      return;
    }
    const day = {};
    ID_LISTS.forEach(key => put(day, key, unionIds(mine && mine[key], theirs && theirs[key])));
    COUNTERS.forEach(key => {
      const mineCount = mine ? mine[key] : 0;
      const theirCount = theirs ? theirs[key] : 0;
      // A guest snapshot has no common ancestor, so sum would double-count a
      // restored backup. Once signed in, add each device's delta to the base.
      const count = initialImport ? Math.max(mineCount, theirCount)
        : Math.max(0, mineCount + theirCount - (before ? before[key] : 0));
      put(day, key, count);
    });
    day.answerCount = COUNTERS.reduce((sum, key) => sum + day[key], 0);
    if (day.answerCount > MAX_ANSWERS) throw new Error('每日学习记录超过可同步范围，请保留备份并联系维护者');
    if (day.answerCount || day.newWordIds.length || day.reviewedWordIds.length) put(result, date, day);
  });
  return result;
}

function mergeStates(base, local, remote) {
  if (!local || !remote || local.version !== 1 || remote.version !== 1 || (base && base.version !== 1)) {
    throw new Error('请先校验待同步的学习记录');
  }
  const initialImport = base === null || base === undefined;
  const settings = {};
  keysOf(local.settings, remote.settings).forEach(key => {
    // Preserve an existing cloud account's preferences during first import.
    // For a new account the caller should initialize it from the guest state.
    const value = initialImport || equal(ownValue(local.settings, key), ownValue(base.settings, key))
      ? ownValue(remote.settings, key) : ownValue(local.settings, key);
    put(settings, key, copy(value));
  });
  const createdTimes = [local.createdAt, remote.createdAt].concat(base ? [base.createdAt] : [])
    .filter(value => Number.isFinite(value) && value >= 0);
  return {
    version: 1,
    bookId: initialImport || local.bookId === base.bookId ? remote.bookId : local.bookId,
    createdAt: Math.min.apply(null, createdTimes),
    settings,
    words: mergeWords(base && base.words, local.words, remote.words, initialImport),
    daily: mergeDaily(base && base.daily, local.daily, remote.daily, initialImport),
    // Undo is device-local and refers to a specific pre-merge snapshot.
    history: []
  };
}

function mergeBookIds() {
  const result = new Set();
  Array.prototype.forEach.call(arguments, list => {
    if (list === undefined || list === null) return;
    if (!Array.isArray(list) || list.length > 100) throw new Error('同步词书清单无效');
    list.forEach(id => {
      if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(id) || id === 'constructor') throw new Error('同步词书编号无效');
      result.add(id);
    });
  });
  if (result.size > 100) throw new Error('同步词书数量超过限制');
  return Array.from(result).sort();
}

module.exports = { mergeStates, mergeBookIds, sameState };
