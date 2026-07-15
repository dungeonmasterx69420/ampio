/* Ampio service worker.
   - App shell: cache-first (bump VERSION on any shell file change to push updates)
   - /rest/getCoverArt: stale-while-revalidate runtime cache, capped
   - Everything else under /rest (ping, browse, stream): untouched — goes
     straight to the network so auth tokens stay fresh and range requests
     on audio streams keep native handling. */
'use strict';

var VERSION = 'ampio-shell-v1';
var ART_CACHE = 'ampio-art-v1';
var ART_MAX_ENTRIES = 150;

var SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/md5.js',
  'js/api.js',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION)
      .then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== VERSION && k !== ART_CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function trimArtCache() {
  return caches.open(ART_CACHE).then(function (c) {
    return c.keys().then(function (keys) {
      if (keys.length <= ART_MAX_ENTRIES) return;
      return Promise.all(keys.slice(0, keys.length - ART_MAX_ENTRIES)
        .map(function (k) { return c.delete(k); }));
    });
  });
}

// Cover art URLs vary only by auth salt; cache key = server + art id + size
// so re-auth doesn't miss the cache.
function artKey(url) {
  var u = new URL(url);
  return u.origin + '/__art__?id=' + (u.searchParams.get('id') || '') +
    '&size=' + (u.searchParams.get('size') || '');
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  if (url.pathname.indexOf('/rest/') !== -1) {
    if (url.pathname.indexOf('getCoverArt') !== -1) {
      var key = artKey(req.url);
      e.respondWith(
        caches.open(ART_CACHE).then(function (c) {
          return c.match(key).then(function (hit) {
            var refetch = fetch(req).then(function (res) {
              if (res && (res.ok || res.type === 'opaque')) {
                c.put(key, res.clone());
                trimArtCache();
              }
              return res;
            });
            return hit || refetch;
          });
        }).catch(function () { return fetch(req); })
      );
    }
    return; // ping/browse/stream: native network handling
  }

  if (url.origin !== self.location.origin) return;

  // App shell: cache-first, network fallback; offline navigations get index.html
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).catch(function () {
        if (req.mode === 'navigate') return caches.match('index.html');
        throw new Error('offline');
      });
    })
  );
});
