'use strict'
// Diagnostic rendering of the actual WXML/WXSS in Chromium. This is a source
// mirror with synthetic, isolated storage, not a WeChat simulator/device test.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { chromium } = require('playwright-core')
const root = path.resolve(__dirname, '..')
const mini = path.join(root, 'miniprogram')
const output = process.env.NATIVE_PREVIEW_DIR || '/tmp/oneword-native-previews'
fs.mkdirSync(output, { recursive: true })
const data = new Map()
global.wx = { getStorageSync: key => data.get(key), setStorageSync: (key, value) => data.set(key, value), removeStorageSync: key => data.delete(key), showToast() {}, setNavigationBarTitle() {}, navigateTo() {}, switchTab() {} }
const store = require('../miniprogram/utils/store')
function fixture(name) {
  store.write(store.core.createState())
  const route = name === 'onboarding' ? 'index' : name === 'expanded' ? 'study' : name === 'populated' ? 'collections' : ['login', 'account', 'account-delete'].includes(name) ? 'profile' : name
  if (['populated', 'profile'].includes(name)) {
    store.core.makeSession(store.read(), { mode: 'today' }).slice(0, 6).forEach((word, index) => store.write(store.core.rateWord(store.read(), word.id, ['unknown', 'known', 'unsure'][index % 3], Date.now() - 30000 + index * 1000)))
  }
  const file = path.join(mini, 'pages', route, route + '.js')
  let definition
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: createRequire(file), Page: page => { definition = page }, wx: global.wx, Date, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} }, { filename: file })
  definition.data = JSON.parse(JSON.stringify(definition.data))
  definition.setData = patch => Object.assign(definition.data, patch)
  if (definition.onLoad) definition.onLoad({ mode: 'today' })
  if (definition.onShow) definition.onShow()
  if (name === 'index') definition.data.tutorial = false
  if (name === 'expanded') definition.expand()
  if (name === 'login') definition.openAccount()
  if (name === 'account' || name === 'account-delete') Object.assign(definition.data, { panel: 'account', account: { user: { id: 'visual-only', username: 'learner_2026' }, phase: 'offline', message: '待联网同步，学习记录已保留' }, accountInitial: 'L', syncLabel: '待联网同步，本机记录已保留', syncTime: '2026/11/9 16:30:00', authMode: name === 'account-delete' ? 'delete' : 'login' })
  return { route, data: definition.data }
}
function css(route, width) {
  let value = fs.readFileSync(path.join(mini, 'app.wxss'), 'utf8') + '\n' + fs.readFileSync(path.join(mini, 'pages', route, route + '.wxss'), 'utf8')
  value = value.replace(/(-?[\d.]+)rpx/g, (_, size) => Number(size) * width / 750 + 'px').replace(/(^|[},\s])page(?=[\s,{.:>])/g, '$1body')
  for (const [source, target] of Object.entries({ view: 'div', text: 'span', picker: 'div', 'scroll-view': 'div', image: 'img' })) value = value.replace(new RegExp('(?<![.#\\w-])' + source + '(?![\\w-])', 'g'), target)
  return value
}
;(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
  const report = []
  try {
    for (const width of [320, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, deviceScaleFactor: 1 })
      for (const name of ['index', 'study', 'expanded', 'books', 'collections', 'populated', 'profile', 'onboarding', 'login', 'account', 'account-delete']) {
        const { route, data } = fixture(name)
        const source = fs.readFileSync(path.join(mini, 'pages', route, route + '.wxml'), 'utf8')
        await page.setContent('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>html,body{margin:0;padding:0}body{padding-bottom:62px}button{display:block;font-family:inherit;cursor:pointer}input,textarea{font-family:inherit;outline:0;border:0}.preview-label{font:9px system-ui;text-align:center;color:#9aa58f;padding:4px}.preview-nav{padding:11px 18px;text-align:center;font:14px system-ui;color:#244d3d}.preview-tabs{position:fixed;bottom:0;left:0;right:0;background:#f6f5ef;display:flex;justify-content:space-around;padding:10px 0;border-top:1px solid #e3e7db;font:10px system-ui;z-index:9}.preview-tabs>div{text-align:center}.preview-tabs img{width:22px;height:22px;display:block;margin:0 auto 3px}</style><style>' + css(route, width) + '</style><body><div class="preview-label">WXML / WXSS 源码镜像 · 非微信真机</div><div class="preview-nav">' + ({ index: '一词 OneWord', study: '今日学习', books: '词书', collections: '词集', profile: '我的' }[route] || '') + '</div></body></html>')
        const expressionErrors = await page.evaluate(({ source, scope }) => {
          const template = document.createElement('template')
          template.innerHTML = source.replace(/<([\w-]+)([^<>]*?)\s*\/>/g, '<$1$2></$1>')
          const errors = []
          function evaluate(expression, data) {
            try { return Function('scope', 'with(scope){return (' + expression + ')}')(new Proxy(data, { has: () => true, get: (object, key) => key === Symbol.unscopables ? undefined : object[key] })) }
            catch (error) { errors.push(expression + ': ' + error.message); return undefined }
          }
          function interpolate(value, data) { return value.replace(/{{([\s\S]*?)}}/g, (_, expression) => { const result = evaluate(expression, data); return result == null ? '' : String(result) }) }
          function children(parent, data) {
            const result = document.createDocumentFragment()
            let matched = false
            for (const child of parent.childNodes) {
              if (child.nodeType === 3) { result.append(document.createTextNode(interpolate(child.textContent, data))); continue }
              if (child.nodeType !== 1) continue
              const condition = child.getAttribute('wx:if'), elseif = child.getAttribute('wx:elif'), otherwise = child.hasAttribute('wx:else')
              let show = true
              if (condition !== null) { show = !!evaluate(condition.replace(/^{{|}}$/g, ''), data); matched = show }
              else if (elseif !== null) { show = !matched && !!evaluate(elseif.replace(/^{{|}}$/g, ''), data); matched = matched || show }
              else if (otherwise) { show = !matched; matched = true }
              else matched = false
              if (show) result.append(render(child, data))
            }
            return result
          }
          function render(node, data) {
            const loop = node.getAttribute('wx:for')
            if (loop !== null) {
              const fragment = document.createDocumentFragment()
              const items = evaluate(loop.replace(/^{{|}}$/g, ''), data) || []
              items.forEach((item, index) => { const copy = node.cloneNode(true); copy.removeAttribute('wx:for'); fragment.append(render(copy, { ...data, [node.getAttribute('wx:for-item') || 'item']: item, [node.getAttribute('wx:for-index') || 'index']: index })) })
              return fragment
            }
            const tag = node.tagName.toLowerCase()
            if (tag === 'block') return children(node, data)
            const el = document.createElement(({ view: 'div', text: 'span', picker: 'div', 'scroll-view': 'div', image: 'img', switch: 'input' })[tag] || tag)
            if (tag === 'switch') el.type = 'checkbox'
            for (const attr of node.attributes) {
              if (/^(wx:|bind|catch|data-)/.test(attr.name)) continue
              const value = interpolate(attr.value, data)
              if (['disabled', 'checked', 'loading'].includes(attr.name) && value === 'false') continue
              if (attr.name === 'value' && ['input', 'textarea'].includes(tag)) { el.value = value; continue }
              try { el.setAttribute(attr.name, value) } catch (_) {}
            }
            if (!['image', 'input', 'switch'].includes(tag)) el.append(children(node, data))
            return el
          }
          document.body.append(children(template.content, scope))
          return Array.from(new Set(errors))
        }, { source, scope: data })
        if (!['study', 'expanded'].includes(name)) {
          const nav = ['index', 'books', 'collections', 'profile'].map((key, index) => {
            const icon = ['study', 'books', 'collection', 'profile'][index] + (route === key ? '-on' : '') + '.png'
            return '<div><img src="data:image/png;base64,' + fs.readFileSync(path.join(mini, 'images', icon)).toString('base64') + '">' + ['学习', '词书', '词集', '我的'][index] + '</div>'
          }).join('')
          await page.locator('body').evaluate((body, nav) => body.insertAdjacentHTML('beforeend', '<div class="preview-tabs">' + nav + '</div>'), nav)
        }
        const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, overflow: Array.from(document.querySelectorAll('body *')).filter(el => { const r = el.getBoundingClientRect(); return r.width && r.right > innerWidth + 2 }).map(el => ({ tag: el.tagName, class: el.className, text: el.textContent.slice(0, 30) })).slice(0, 8) }))
        await page.screenshot({ path: path.join(output, name + '-' + width + '.png'), fullPage: true })
        report.push({ name, ...layout, expressionErrors })
      }
      await page.close()
    }
  } finally { await browser.close() }
  const result = { kind: 'Native WXML/WXSS source mirror; synthetic isolated data; not device testing', passed: report.every(item => item.scrollWidth <= item.width && !item.expressionErrors.length), report }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  if (!result.passed) process.exitCode = 1
})().catch(error => { console.error(error); process.exitCode = 1 })
