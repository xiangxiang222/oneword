'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'oneword-cloud-browser-'));
const remote = process.env.TEST_BASE_URL;
const base = (remote || 'http://127.0.0.1:3797/oneword/').replace(/\/?$/, '/');
const server = remote ? null : spawn(process.execPath, ['server/index.js'], {
  cwd: root, env: { ...process.env, PORT: '3797', ONEWORD_DB_PATH: path.join(fixture, 'progress.sqlite') }, stdio: 'pipe'
});
const suffix = crypto.randomBytes(6).toString('hex');
const username = 'e2e_' + suffix;
const secondUsername = 'e2e_other_' + suffix;
const password = crypto.randomBytes(20).toString('base64url');
const checks = [], errors = [];
const accounts = new Set();
let browser;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const panel = page => page.locator('.home-page .account-panel');
const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem('oneword.v1')));

async function check(name, run) { await run(); checks.push(name); console.log('PASS', name); }
async function waitServer() {
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(base + 'api/health')).ok) return; } catch (_) {}
    await delay(100);
  }
  throw new Error('Cloud test server did not start');
}
async function device(width = 390) {
  const context = await browser.newContext({ viewport: { width, height: 844 } });
  await context.addInitScript(() => localStorage.setItem('oneword.tutorial', '1'));
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.waitForSelector('.home-page');
  return { context, page };
}
async function authenticate(page, name, mode = 'login', options = {}) {
  const account = panel(page);
  await account.getByRole('button', { name: '登录 / 注册', exact: true }).click();
  if (mode === 'register') await account.getByRole('button', { name: '创建账号', exact: true }).click();
  await account.getByLabel('账号', { exact: true }).fill(name);
  await account.getByLabel('密码', { exact: true }).fill(options.password || password);
  if (options.importGuest === false) await account.getByRole('checkbox').uncheck();
  if (mode === 'register') accounts.add(name);
  await account.getByRole('button', { name: mode === 'register' ? '创建账号，保存积累' : '登录并同步', exact: true }).click();
  if (options.expectFailure) {
    await account.getByRole('alert').waitFor();
    return;
  }
  await page.waitForFunction(expected => document.querySelector('.home-page .account-heading h3')?.textContent === expected, name);
  await synced(page);
}
async function synced(page) {
  try {
    await page.waitForFunction(() => document.querySelector('.home-page .account-heading p')?.textContent === '已同步', null, { timeout: 20000 });
  } catch (error) {
    const status = await page.evaluate(() => ({
      phase: document.querySelector('.home-page .account-heading p')?.textContent,
      message: document.querySelector('.home-page .account-message')?.textContent,
      error: document.querySelector('.home-page .account-error')?.textContent
    })).catch(() => ({ phase: 'page unavailable' }));
    throw new Error('Cloud sync did not finish: ' + JSON.stringify(status), { cause: error });
  }
}
async function sync(page) {
  const button = panel(page).getByRole('button', { name: '立即同步', exact: true });
  await button.waitFor();
  await button.click();
  await synced(page);
}
async function learn(page, rating = 'known') {
  await page.getByRole('button', { name: /^(开始|继续)今日学习$/ }).click();
  await page.waitForSelector('.study-card');
  const id = (await page.locator('.word-title h1').innerText()).toLowerCase();
  await page.locator('.rating.' + rating).click();
  await page.waitForTimeout(220);
  await page.getByRole('button', { name: '退出学习', exact: true }).click();
  return id;
}
async function snapshot(context) {
  const response = await context.request.get(base + 'api/sync');
  assert.equal(response.status(), 200);
  return response.json();
}
async function cleanup() {
  for (const name of accounts) {
    try {
      const login = await fetch(base + 'api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password, client: 'native' }) });
      if (login.status === 401) continue;
      if (!login.ok) throw Error('Temporary account cleanup login failed: ' + login.status);
      const { token } = await login.json();
      const removed = await fetch(base + 'api/auth/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ password }) });
      assert.equal(removed.status, 204);
    } catch (error) { errors.push(error.message); }
  }
}

(async () => {
  try {
    await waitServer();
    const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await chromium.launch({ headless: true, ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}), args: ['--no-sandbox'] });
    const a = await device();
    let guestWord, aWord, bWord;
    await check('Guest progress and settings migrate to a real account with secure cookie login', async () => {
      guestWord = await learn(a.page);
      await a.page.getByRole('button', { name: '打开学习设置' }).click();
      await a.page.getByRole('combobox', { name: '每日新词数量' }).selectOption('10');
      await a.page.getByRole('radio', { name: /字母顺序/ }).check();
      await a.page.getByRole('button', { name: '关闭设置' }).click();
      await authenticate(a.page, username, 'register');
      const cloud = await snapshot(a.context);
      assert.equal(cloud.state.words[guestWord].status, 'known');
      assert.equal(cloud.state.settings.dailyGoal, 10);
      assert.equal(cloud.state.settings.learningOrder, 'alphabetical');
      assert.equal(Object.values(cloud.state.daily).reduce((sum, day) => sum + day.answerCount, 0), 1);
      assert.equal(await a.page.evaluate(() => document.cookie.includes('oneword_session')), false);
      const cookies = await a.context.cookies();
      const session = cookies.find(cookie => cookie.name === 'oneword_session');
      assert.equal(session.httpOnly, true);
      if (base.startsWith('https:')) assert.equal(session.secure, true);
      assert.equal(await a.page.evaluate(() => JSON.parse(localStorage.getItem('oneword.cloud.identity.v1')).token), null);
    });
    await check('Account screens fit 320 and 390 pixels with no horizontal overflow', async () => {
      for (const width of [320, 390]) {
        await a.page.setViewportSize({ width, height: 844 });
        await panel(a.page).scrollIntoViewIfNeeded();
        assert.equal(await a.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await a.page.screenshot({ path: path.join(output, `cloud-account-${width}.png`), fullPage: true, animations: 'disabled' });
      }
    });
    const b = await device();
    await check('A fresh phone rejects a wrong password then restores words, history, and settings', async () => {
      await authenticate(b.page, username, 'login', { password: 'intentionally-wrong-password', expectFailure: true });
      assert.match(await panel(b.page).getByRole('alert').innerText(), /密码|credentials/);
      await panel(b.page).getByLabel('密码', { exact: true }).fill(password);
      await panel(b.page).getByRole('button', { name: '登录并同步', exact: true }).click();
      await synced(b.page);
      const restored = await saved(b.page);
      assert.equal(restored.words[guestWord].status, 'known');
      assert.equal(restored.settings.dailyGoal, 10);
      assert.equal(restored.settings.learningOrder, 'alphabetical');
      assert.equal(Object.values(restored.daily).reduce((sum, day) => sum + day.answerCount, 0), 1);
    });
    await check('Two offline phones learn independently and converge without lost or duplicated answers', async () => {
      await a.context.setOffline(true);
      await b.context.setOffline(true);
      aWord = await learn(a.page, 'unsure');
      await b.page.locator('.mobile-nav').getByRole('button', { name: '词书', exact: true }).click();
      await b.page.locator('.book-item').filter({ hasText: '小学' }).click();
      bWord = await learn(b.page, 'unknown');
      assert.notEqual(aWord, bWord);
      assert.notEqual(aWord, guestWord);
      assert.notEqual(bWord, guestWord);
      await a.context.setOffline(false);
      await sync(a.page);
      await b.context.setOffline(false);
      await sync(b.page);
      await sync(a.page);
      const first = await saved(a.page), second = await saved(b.page), cloud = await snapshot(a.context);
      for (const state of [first, second, cloud.state]) {
        assert.equal(Object.keys(state.words).length, 3);
        assert.equal(state.words[aWord].status, 'unsure');
        assert.equal(state.words[bWord].status, 'unknown');
        assert.equal(state.words[guestWord].status, 'known');
        assert.equal(state.bookId, 'primary');
        assert.equal(Object.values(state.daily).reduce((sum, day) => sum + day.answerCount, 0), 3);
      }
      await sync(a.page); await sync(b.page);
      assert.equal(Object.values((await snapshot(a.context)).state.daily).reduce((sum, day) => sum + day.answerCount, 0), 3);
      await a.page.reload(); await a.page.waitForSelector('.home-page'); await synced(a.page);
      assert.equal(Object.keys((await saved(a.page)).words).length, 3);
    });
    await check('A new phone downloads cloud book manifests and restores complete-book words offline', async () => {
      await a.page.locator('.mobile-nav').getByRole('button', { name: '词书', exact: true }).click();
      await a.page.locator('.book-item').filter({ hasText: '大学四级' }).getByRole('button', { name: '下载完整词库', exact: true }).click();
      await a.page.locator('.download-dialog').getByRole('button', { name: '下载完整词库', exact: true }).click();
      await a.page.waitForSelector('.home-page');
      const id = await learn(a.page);
      assert.equal(require('../data/vocabulary').wordMap[id], undefined, 'Must exercise a word outside the shipped selection');
      await sync(a.page);
      const cloud = await snapshot(a.context);
      assert.deepEqual(cloud.bookIds, ['cet4']);
      const c = await device();
      await authenticate(c.page, username);
      assert.match(await c.page.locator('.book-summary').innerText(), /3812/);
      assert.equal((await saved(c.page)).words[id].status, 'known');
      assert.equal(Object.values((await saved(c.page)).daily).reduce((sum, day) => sum + day.answerCount, 0), 4);
      await c.page.evaluate(async () => { await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })); });
      await c.context.setOffline(true);
      await c.page.reload();
      await c.page.waitForSelector('.home-page');
      assert.match(await c.page.locator('.book-summary').innerText(), /3812/);
      assert.equal((await saved(c.page)).words[id].status, 'known');
      await c.context.close();
    });
    await check('Two tabs sharing one browser serialize uploads without counting local answers twice', async () => {
      const twin = await a.context.newPage();
      twin.on('pageerror', error => errors.push(error.message));
      await twin.goto(base);
      await twin.waitForSelector('.home-page');
      await synced(twin);
      await sync(a.page);
      await a.context.setOffline(true);
      const firstId = await learn(a.page, 'unsure');
      await twin.waitForFunction(id => !!JSON.parse(localStorage.getItem('oneword.v1')).words[id], firstId);
      const secondId = await learn(twin, 'known');
      assert.notEqual(firstId, secondId);
      // Slow the API enough for both tabs to attempt the same local delta.
      // The browser lock should serialize them even with requests in flight.
      await a.context.route('**/api/sync*', async route => { await delay(100); await route.continue(); });
      await a.context.setOffline(false);
      await Promise.all([sync(a.page), sync(twin)]);
      await sync(a.page); await sync(twin);
      await a.context.unrouteAll({ behavior: 'wait' });
      const cloud = await snapshot(a.context);
      assert.equal(Object.keys(cloud.state.words).length, 6);
      assert.equal(Object.values(cloud.state.daily).reduce((sum, day) => sum + day.answerCount, 0), 6);
      assert.equal(cloud.state.words[firstId].status, 'unsure');
      assert.equal(cloud.state.words[secondId].status, 'known');
      await twin.close();
    });
    await check('Logging out restores the guest record and another account remains isolated', async () => {
      await panel(a.page).getByRole('button', { name: '退出登录', exact: true }).click();
      await panel(a.page).getByRole('button', { name: '登录 / 注册', exact: true }).waitFor();
      const guest = await saved(a.page);
      assert.deepEqual(Object.keys(guest.words), [guestWord]);
      await authenticate(a.page, secondUsername, 'register', { importGuest: false });
      assert.equal(Object.keys((await saved(a.page)).words).length, 0);
      assert.equal(Object.keys((await snapshot(a.context)).state.words).length, 0);
    });
    await check('Account deletion requires a password and removes all its cloud progress', async () => {
      await panel(a.page).getByRole('button', { name: '账号管理', exact: true }).click();
      await panel(a.page).getByRole('button', { name: '删除账号', exact: true }).click();
      await panel(a.page).getByLabel('当前密码', { exact: true }).fill(password);
      a.page.once('dialog', dialog => dialog.accept());
      await panel(a.page).getByRole('button', { name: '永久删除账号与云端记录', exact: true }).click();
      await panel(a.page).getByRole('button', { name: '登录 / 注册', exact: true }).waitFor();
      accounts.delete(secondUsername);
      assert.deepEqual(Object.keys((await saved(a.page)).words), [guestWord]);
      const session = await a.context.request.get(base + 'api/auth/session');
      assert.equal(session.status(), 401);
    });
    await check('Cloud flows produce no JavaScript runtime errors', async () => assert.deepEqual(errors, []));
    console.log(`${checks.length} cloud browser checks passed.`);
  } catch (error) {
    errors.push(error.message);
    throw error;
  } finally {
    await cleanup();
    if (browser) await browser.close();
    server?.kill('SIGTERM');
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.writeFileSync(path.join(output, 'cloud-browser-report.json'), JSON.stringify({ ok: !errors.length && checks.length === 9, checks, errors }, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; server?.kill('SIGTERM'); });
