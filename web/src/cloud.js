import cloudModule from './generated/cloud.js'
import { installedBooks, restoreBookManifest } from './catalog.js'

export function connectCloud({ getState, setState, getAppliedId, onChange, onCatalog }) {
  return cloudModule.createCloudClient({
    storage: {
      get(key) { const value = localStorage.getItem(key); return value ? JSON.parse(value) : null },
      put(key, value) { localStorage.setItem(key, JSON.stringify(value)) },
      remove(key) { localStorage.removeItem(key) }
    },
    getState, setState, getAppliedId, getBookIds: installedBooks,
    withSyncLock(run) {
      if (navigator.locks) return navigator.locks.request('oneword-account-sync',run)
      return run()
    },
    async prepareBooks(ids) { await restoreBookManifest(ids); onCatalog() },
    onChange,
    async request(method, path, body) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 20000)
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}api${path}`, {
          method, credentials: 'same-origin', signal: controller.signal,
          headers: body ? { 'Content-Type': 'application/json' } : {},
          ...(body ? { body: JSON.stringify(body) } : {})
        })
        return { status: response.status, data: response.status === 204 ? null : await response.json() }
      } finally { clearTimeout(timeout) }
    }
  })
}
