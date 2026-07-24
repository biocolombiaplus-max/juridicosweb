var CACHE_NAME = 'jw-shell-v2';
var SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', function(e){
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_NAME).then(function(c){ return c.addAll(SHELL); }));
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k!==CACHE_NAME; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

// App-shell: network-first para el HTML (siempre fresco), cache-first para el resto del shell.
self.addEventListener('fetch', function(e){
  if(e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if(url.origin !== location.origin) return; // no interceptar CDNs externos (fonts, GTM, etc.)

  if(e.request.mode === 'navigate'){
    // cache:'no-store' evita que el navegador reutilice una respuesta HTTP
    // vieja (de GitHub Pages/CDN) para el HTML — sin esto, "network-first"
    // podía seguir devolviendo una versión desactualizada de la página
    // aunque ya hubiera una nueva publicada.
    e.respondWith(
      fetch(e.request, { cache: 'no-store' }).then(function(res){
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function(c){ c.put('/index.html', copy); });
        return res;
      }).catch(function(){ return caches.match('/index.html'); })
    );
    return;
  }

  if(SHELL.indexOf(url.pathname) !== -1){
    e.respondWith(
      caches.match(e.request).then(function(cached){
        return cached || fetch(e.request);
      })
    );
  }
});
