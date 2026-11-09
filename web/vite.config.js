import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

function offlineShell() {
  let worker = ''
  return {
    name: 'oneword-offline-shell',
    apply: 'build',
    generateBundle(options, bundle) {
      const template = readFileSync(new URL('./public/sw.js', import.meta.url), 'utf8')
      const assets = Object.keys(bundle).filter(name => /\.(?:js|css)$/.test(name)).sort()
      const digest = createHash('sha256').update(template)
      for (const name of Object.keys(bundle).sort()) {
        const asset = bundle[name]
        digest.update(name).update(asset.type === 'chunk' ? asset.code : asset.source)
      }
      worker = template.replace('__SHELL_VERSION__', digest.digest('hex').slice(0, 16)).replace('__SHELL_ASSETS__', JSON.stringify(assets))
    },
    writeBundle(options) { writeFileSync(resolve(options.dir || 'dist', 'sw.js'), worker) }
  }
}
export default defineConfig({
  plugins: [vue(), offlineShell()],
  base: '/oneword/',
  server: { proxy: { '/oneword/api': 'http://127.0.0.1:3795' } },
  build: { sourcemap: false, target: 'es2020' }
})
