/* Build replaces these tokens. Cache only public files; user data stays on device. */
const CACHE = 'oneword-shell-__SHELL_VERSION__';
const BASE = new URL('./', self.location.href).pathname;
const ASSETS = __SHELL_ASSETS__;
self.addEventListener('install', event => event.waitUntil((async () => {
  try {
    const cache = await caches.open(CACHE);
    // addAll commits the entire batch or rejects: an interrupted upgrade never
    // replaces the previous working shell with partially downloaded HTML/assets.
    await cache.addAll([BASE, ...ASSETS.map(asset => new URL(asset, self.location.href).href)]);
    await self.skipWaiting();
  } catch (error) {
    await caches.delete(CACHE);
    throw error;
  }
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const versions = (await caches.keys()).filter(key => key.startsWith('oneword-shell-'));
  // Retain the previous shell for already-open tabs that still use its asset names.
  const keep = new Set([CACHE, ...versions.filter(key => key !== CACHE).slice(-1)]);
  await Promise.all(versions.filter(key => !keep.has(key)).map(key => caches.delete(key)));
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(BASE) || url.pathname.includes('/api/')) return;
  if (event.request.mode === 'navigate') event.respondWith((async () => {
    try { return await fetch(event.request); }
    catch {
      const cache = await caches.open(CACHE);
      return (await cache.match(BASE)) || Response.error();
    }
    // Never overwrite the versioned shell with HTML from a newer deployment.
  })());
  else if (url.pathname.includes('/assets/')) event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      await cache.put(event.request, response.clone());
    }
    return response;
  })());
});
