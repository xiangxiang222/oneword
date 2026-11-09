'use strict';
const core = require('./core');
const { mergeStates, mergeBookIds, sameState } = require('./sync');
const IDENTITY = 'oneword.cloud.identity.v1';
const GUEST = 'oneword.cloud.guest.v1';
const ACCOUNT = 'oneword.cloud.account.v1.';
const META = 'oneword.cloud.meta.v1.';
const TRANSITION = 'oneword.cloud.transition.v1';
function createCloudClient(adapter) {
  const disk = adapter.storage;
  // Main progress and identity cannot be committed atomically by localStorage
  // or wx storage. Complete a durable transition before any networking starts.
  const interrupted = disk.get(TRANSITION);
  if (interrupted) {
    adapter.setState(core.restoreState(JSON.stringify(interrupted.toState)), null);
    if (interrupted.toIdentity) disk.put(IDENTITY, interrupted.toIdentity);
    else disk.remove(IDENTITY);
    (interrupted.removeKeys || []).forEach(key => disk.remove(key));
    disk.remove(TRANSITION);
  }
  let identity = disk.get(IDENTITY) || null;
  let status = { user: identity && identity.user || null, phase: identity ? 'offline' : 'guest', message: identity ? '等待联网同步' : '游客模式 · 记录保存在本机', lastSyncedAt: null };
  let running = null, starting = null, timer = null, stopped = false, switching = false, uncertainIdentity = false;
  let accountOperation = Promise.resolve(), queuedOperations = 0;
  const clone = value => JSON.parse(JSON.stringify(value));
  const emit = patch => {
    status = Object.assign({}, status, patch);
    // Rendering/subscriber failures must not turn a committed cloud write into
    // an apparent network failure and cause the same answer to be submitted twice.
    if (adapter.onChange) { try { adapter.onChange(Object.assign({}, status)); } catch (_) {} }
    return status;
  };
  const metaKey = () => META + identity.user.id;
  const sendPending = pending => call('POST', '/sync', { accountId: identity.user.id, revision: pending.revision, requestId: pending.requestId, state: pending.state, bookIds: pending.bookIds });
  const accountKey = user => ACCOUNT + user.id;
  const requestId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
  function transition(nextIdentity, nextState, removeKeys) {
    const record = { toIdentity: nextIdentity, toState: clone(nextState), removeKeys: removeKeys || [] };
    disk.put(TRANSITION, record);
    try {
      adapter.setState(nextState, null);
      if (nextIdentity) disk.put(IDENTITY, nextIdentity);
      else disk.remove(IDENTITY);
      identity = nextIdentity;
      record.removeKeys.forEach(key => disk.remove(key));
      disk.remove(TRANSITION);
    } catch (error) {
      // Leave the journal for restart recovery. An uncertain local identity
      // must never make an upload with data belonging to a different account.
      uncertainIdentity = true;
      emit({ phase: 'expired', message: '本机账号切换尚未完成，请刷新或重启后继续；进度已保留' });
      throw error;
    }
  }
  async function call(method, path, body, token) {
    let response;
    try { response = await adapter.request(method, path, body, token === undefined ? identity && identity.token : token); }
    catch (_) { const error = new Error('当前离线，学习记录已保存在本机，联网后会继续同步'); error.offline = true; throw error; }
    if (response.status === 409 && /^\/sync(?:\?|$)/.test(path)) return response;
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(response.data && (response.data.message || response.data.error) || '请求未完成，请稍后重试'); error.status = response.status; throw error;
    }
    return response;
  }
  function persistLocal(next, applicationId) {
    const current = adapter.getState();
    if (!sameState(current, next) || applicationId !== undefined && adapter.getAppliedId && adapter.getAppliedId() !== applicationId) {
      // Changing preferences or fetching a dictionary does not invalidate a
      // device's last answer. An actual progress merge does invalidate undo.
      const sameProgress = sameState({ words: current.words, daily: current.daily }, { words: next.words, daily: next.daily });
      adapter.setState(sameProgress ? Object.assign({}, next, { history: current.history || [] }) : next, applicationId);
    }
    disk.put(accountKey(identity.user), clone(adapter.getState()));
  }
  async function prepare(snapshot) { await adapter.prepareBooks(snapshot.bookIds || []); }
  function ownsAccount(owner) {
    if (stopped || uncertainIdentity || !identity || identity.user.id !== owner) return false;
    const durable = disk.get(IDENTITY);
    if (!durable || !durable.user || durable.user.id !== owner) {
      uncertainIdentity = true;
      emit({ phase: 'expired', message: '其他页面已切换账号，请刷新后继续；本机进度仍保留' });
      return false;
    }
    return true;
  }
  function finish(meta, snapshot, submitted) {
    const current = adapter.getState();
    const remote = snapshot.state || core.createState(current.createdAt);
    // A crash may happen after applying the response and before clearing the
    // durable pending request. Do not apply the original daily delta again.
    const application = meta.pending && meta.pending.application;
    const appliedId = adapter.getAppliedId && adapter.getAppliedId();
    const wasApplied = application && (application.id && appliedId === application.id || sameState(current, application.after));
    const baseline = wasApplied ? application.snapshot.state : application && application.baseline || submitted;
    const next = sameState(current, remote) ? current : wasApplied
      ? sameState(remote, application.snapshot.state) ? current : mergeStates(application.snapshot.state, current, remote)
      : mergeStates(baseline, current, remote);
    const applicationId = meta.pending ? requestId() : undefined;
    if (meta.pending) {
      meta.pending.application = { id: applicationId, baseline: clone(baseline), before: clone(current), after: clone(next), snapshot };
      disk.put(metaKey(), meta);
    }
    // The marker and next state must share a single atomic adapter write.
    // A later answer retains that marker, so retry can distinguish descendants
    // of an already-applied merge from descendants of the original submission.
    persistLocal(next, applicationId);
    const updated = { base: snapshot, pending: null };
    disk.put(metaKey(), updated);
    emit({ phase: 'idle', message: '所有学习记录已同步', lastSyncedAt: snapshot.updatedAt || Date.now() });
    return updated;
  }
  async function performSync() {
    if (!identity || stopped || switching || !ownsAccount(identity.user.id)) return false;
    const owner = identity.user.id;
    emit({ phase: 'syncing', message: '正在同步学习记录…' });
    let meta = disk.get(metaKey()) || { base: null, pending: null };
    // Retry the exact durable request first: a lost response must never count
    // the same offline answers twice.
    if (meta.pending) {
      if (meta.pending.applyOnly) {
        await prepare(meta.pending.snapshot);
        if (!ownsAccount(owner)) return false;
        meta = finish(meta, meta.pending.snapshot, meta.pending.state);
      } else {
        const result = await sendPending(meta.pending);
        if (!ownsAccount(owner)) return false;
        if (result.status !== 409) {
          await prepare(result.data);
          if (!ownsAccount(owner)) return false;
          meta = finish(meta, result.data, meta.pending.localState || meta.pending.state);
        } else {
          // The rejected request made no server changes. Keep its original
          // baseline until the next successful compare-and-swap.
          meta.pending = null;
          disk.put(metaKey(), meta);
        }
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (!ownsAccount(owner)) return false;
      const remote = (await call('GET', '/sync?accountId=' + encodeURIComponent(owner))).data;
      await prepare(remote);
      if (!ownsAccount(owner)) return false;
      const local = clone(adapter.getState());
      const merged = remote.state ? sameState(local, remote.state) ? local : mergeStates(meta.base && meta.base.state, local, remote.state) : local;
      merged.history = [];
      const bookIds = mergeBookIds(adapter.getBookIds(), remote.bookIds || [], meta.base && meta.base.bookIds || []);
      if (remote.state && sameState(merged, remote.state) && JSON.stringify(bookIds) === JSON.stringify(mergeBookIds(remote.bookIds))) {
        if (!sameState(local, remote.state)) {
          meta = { base: meta.base, pending: { applyOnly: true, snapshot: remote, state: local } };
          disk.put(metaKey(), meta);
        }
        meta = finish(meta, remote, local);
        break;
      }
      const pending = { revision: remote.revision, requestId: requestId(), state: merged, bookIds, localState: local };
      // Both the local merge and request are durable before contacting server.
      // While awaiting it, the user can continue learning.
      disk.put(metaKey(), { base: meta.base, pending });
      const response = await sendPending(pending);
      if (!ownsAccount(owner)) return false;
      if (response.status === 409) {
        disk.put(metaKey(), { base: meta.base, pending: null });
        if (attempt === 4) throw new Error('其他设备正在同步，请稍后重试');
        continue;
      }
      await prepare(response.data);
      if (!ownsAccount(owner)) return false;
      // Pending was merged against remote; current still descends from local.
      // Include edits made during the request, without reapplying old deltas.
      meta = finish({ base: meta.base, pending }, response.data, local);
      break;
    }
    if (meta.base && !sameState(adapter.getState(), meta.base.state)) schedule();
    return true;
  }
  function sync() {
    if (running) return running;
    // Browser tabs share durable snapshots and must read their base and state
    // under the same origin-wide lock. Different phones still use server CAS.
    const perform = () => adapter.withSyncLock ? adapter.withSyncLock(performSync) : performSync();
    running = Promise.resolve().then(perform).catch(error => {
      emit({ phase: error.offline ? 'offline' : error.status === 401 ? 'expired' : 'error', message: error.status === 401 ? '登录已过期，请重新登录；本机进度仍保留' : error.message });
      return false;
    }).finally(() => { running = null; });
    return running;
  }
  function schedule() {
    if (!identity || stopped || switching || !ownsAccount(identity.user.id)) return;
    clearTimeout(timer);
    emit({ phase: 'pending', message: '本机已保存，等待同步' });
    timer = setTimeout(() => { timer = null; sync(); }, 1200);
  }
  async function activate(nextIdentity, importGuest) {
    if (identity && identity.user.id === nextIdentity.user.id) {
      disk.put(IDENTITY, nextIdentity); identity = nextIdentity; uncertainIdentity = false;
      switching = false; emit({ user: identity.user }); await sync(); return;
    }
    const remote = (await call('GET', '/sync?accountId=' + encodeURIComponent(nextIdentity.user.id), undefined, nextIdentity.token)).data;
    await prepare(remote);
    const previous = clone(adapter.getState());
    let candidate = disk.get(accountKey(nextIdentity.user));
    const priorMeta = disk.get(META + nextIdentity.user.id);
    if (!candidate) candidate = remote.state || core.createState();
    if (!identity && importGuest) {
      candidate = remote.state ? mergeStates(null, previous, candidate) : previous;
    }
    if (identity) disk.put(accountKey(identity.user), previous);
    else disk.put(GUEST, previous);
    candidate = core.restoreState(JSON.stringify(candidate));
    // Save the candidate before switching the durable identity. If storage is
    // full, authentication cannot accidentally relabel another user's data.
    disk.put(accountKey(nextIdentity.user), candidate);
    transition(nextIdentity, candidate);
    uncertainIdentity = false;
    if (!priorMeta) disk.put(metaKey(), { base: remote, pending: null });
    emit({ user: identity.user, phase: 'idle', lastSyncedAt: null });
    // Account operations pause background synchronization until all identity
    // and local-state writes have completed.
    switching = false;
    await sync();
  }
  async function init() {
    if (starting) return starting;
    if (queuedOperations) { await accountOperation; return getStatus(); }
    starting = (async () => {
      try {
        const response = await call('GET', '/auth/session');
        const next = { user: response.data.user, token: identity && identity.token || null };
        await activate(next, false);
      } catch (error) {
        if (identity) emit({ phase: error.offline ? 'offline' : error.status === 401 ? 'expired' : 'error', message: error.status === 401 ? '请登录后继续同步，本机记录仍保留' : error.message });
      }
      return getStatus();
    })().finally(() => { starting = null; });
    return starting;
  }
  function serializeAccount(operation) {
    queuedOperations += 1;
    const next = accountOperation.then(operation, operation).finally(() => { queuedOperations -= 1; });
    accountOperation = next.catch(() => {});
    return next;
  }
  function authenticate(mode, credentials, importGuest) { return serializeAccount(async () => {
    if (!['login', 'register'].includes(mode)) throw new Error('登录方式无效');
    if (starting) await starting;
    if (running) await running;
    clearTimeout(timer); switching = true;
    let authenticated = false;
    try {
      const response = await call('POST', '/auth/' + mode, credentials);
      authenticated = true;
      await activate({ user: response.data.user, token: response.data.token || null }, !!importGuest);
      return getStatus();
    } catch (error) {
      if (authenticated) {
        uncertainIdentity = true;
        emit({ phase: 'expired', message: '登录已完成，但本机账号切换未完成，请重新登录；原进度仍保留' });
      }
      throw error;
    } finally { switching = false; }
  }); }
  function logout() { return serializeAccount(async () => {
    if (starting) await starting;
    clearTimeout(timer);
    if (running) await running;
    if (!identity) return;
    await sync();
    await call('POST', '/auth/logout', { accountId: identity.user.id });
    disk.put(accountKey(identity.user), clone(adapter.getState()));
    const guest = disk.get(GUEST) || core.createState();
    transition(null, core.restoreState(JSON.stringify(guest)));
    uncertainIdentity = false;
    emit({ user: null, phase: 'guest', message: '已退出账号，当前为本机游客记录', lastSyncedAt: null });
  }); }
  function deleteAccount(password) { return serializeAccount(async () => {
    if (starting) await starting;
    clearTimeout(timer); if (running) await running;
    if (!identity) return;
    await call('POST', '/auth/delete', { password, accountId: identity.user.id });
    const id = identity.user.id;
    transition(null, core.restoreState(JSON.stringify(disk.get(GUEST) || core.createState())), [ACCOUNT + id, META + id]);
    uncertainIdentity = false;
    emit({ user: null, phase: 'guest', message: '账号及云端记录已删除', lastSyncedAt: null });
  }); }
  function changePassword(currentPassword, newPassword) { return serializeAccount(async () => {
    if (starting) await starting;
    clearTimeout(timer); if (running) await running;
    await call('POST', '/auth/password', { currentPassword, newPassword, accountId: identity && identity.user.id });
    uncertainIdentity = true;
    emit({ phase: 'expired', message: '密码已更新，请使用新密码重新登录；本机学习进度仍保留' });
  }); }
  function getStatus() { return Object.assign({}, status); }
  function destroy() { stopped = true; clearTimeout(timer); }
  return { init, authenticate, sync, schedule, logout, deleteAccount, changePassword, getStatus, destroy };
}
module.exports = { createCloudClient };
