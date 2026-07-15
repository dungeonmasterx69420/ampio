#!/usr/bin/env node
/* Ampio dev server + CORS proxy (zero dependencies, Node 18+).

   Usage:
     node serve.js                              serve the app on :8420
     node serve.js https://music.example.com    also proxy /rest/* to that
                                                Navidrome server (avoids CORS;
                                                log in with server = this origin)
     PORT=9000 node serve.js ...                custom port
*/
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8420', 10);
const TARGET = (process.argv[2] || '').replace(/\/+$/, '');
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json'
};

async function proxy(req, res) {
  const url = TARGET + req.url;
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: { 'accept': req.headers['accept'] || '*/*', 'range': req.headers['range'] || '' },
      redirect: 'follow'
    });
    const headers = {};
    for (const h of ['content-type', 'content-length', 'accept-ranges', 'content-range', 'cache-control']) {
      const v = upstream.headers.get(h);
      if (v) headers[h] = v;
    }
    res.writeHead(upstream.status, headers);
    if (upstream.body) {
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }
    res.end();
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('proxy error: ' + e.message);
  }
}

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  if (TARGET && req.url.startsWith('/rest/')) return proxy(req, res);
  return serveStatic(req, res);
}).listen(PORT, () => {
  console.log('ampio serving on http://localhost:' + PORT +
    (TARGET ? ('  (proxying /rest -> ' + TARGET + ')') : '  (no proxy target; direct-connect mode)'));
});
