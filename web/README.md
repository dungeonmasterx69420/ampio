# Ampio

A Winamp-classic-inspired web client for [Navidrome](https://www.navidrome.org/) (or any Subsonic-compatible server). It really whips the llama's... library.

Pure static HTML/CSS/JS — no build step, no framework, no dependencies. The look is a from-scratch CSS homage to the Winamp 2.x base skin: beveled steel chrome, green LCD, gold titlebars.

## Features

- **Main window** — transport (prev/play/pause/stop/next/eject), seek bar, volume + balance sliders, scrolling track marquee, kbps/khz readout, mono/stereo indicators, elapsed/remaining LCD clock (click to toggle), shuffle and repeat
- **Spectrum analyzer** — real 19-band analyzer with falling peak caps, driven by the Web Audio API; click it to cycle analyzer → oscilloscope → off
- **Equalizer** — real 10-band EQ (60 Hz–16 kHz, classic Winamp bands) + preamp, with the classic presets (rock, pop, jazz, full bass, ...), applied via BiquadFilter nodes
- **Playlist** — green-on-black double-click-to-play list, multi-select (ctrl/shift), drag to reorder, REM/CROP/CLEAR, running time totals
- **Media library** — browse recent albums, artists → albums → tracks, server playlists, search (artists/albums/songs), random-50; PLAY replaces the queue, ENQUEUE appends
- **Draggable windows** with saved positions, z-ordering, and toggle buttons (EQ / PL / ML), just like the old days
- **Winamp keybindings** — `Z X C V B` transport, `S` shuffle, `R` repeat, `L` library, arrows for seek/volume, `Del` removes from playlist
- Scrobbles to the server (now-playing + submission at 50%), media-key support via the MediaSession API
- **Installable PWA** — add it to your home screen / dock and it runs standalone (no browser chrome), with the app shell cached for instant offline loads

## Running it

It's a static page. Any web server works:

```sh
cd web
node serve.js            # http://localhost:8420
# or: python3 -m http.server 8420
```

Then log in with your Navidrome URL, username, and password. Auth uses the standard Subsonic salted-token scheme (`t = md5(password + salt)`), so the password itself is never sent.

## Security model

- **The password is never stored — anywhere.** At login it is converted once into a Subsonic `{salt, token}` pair (salt from `crypto.getRandomValues`), used for the session, and discarded; the form field is cleared immediately.
- **"Remember me" stores only the derived token**, AES-GCM-encrypted with a non-extractable WebCrypto key held in IndexedDB, so a casual localStorage dump yields ciphertext. (On plain-HTTP hosts WebCrypto is unavailable; the token pair is then stored unencrypted — but still never the password. Host over HTTPS.) The token is server-revocable: change the account password and it dies.
- **Auth stays out of URLs where the protocol allows**: JSON API calls send credentials in POST bodies, keeping tokens out of server/proxy access logs. Audio streams and cover art are fetched by `<audio>`/`<img>` tags, which the Subsonic protocol only serves via GET query params — that part is inherent to the protocol.
- **Content-Security-Policy** (`script-src 'self'`, no inline scripts, `object-src 'none'`) plus a `no-referrer` policy; `serve.js` adds `nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy` headers.
- **The service worker never caches authenticated API responses** — only the static app shell and cover art images, and the art cache is keyed by art id (not by token-bearing URL) and wiped on logout, along with the vault and its key.
- Logging out (the ✕ button) destroys the vault, the encryption key, and the cover-art cache.
- Upgrading from an earlier Ampio: any old-format stored credential is migrated to a derived token on first load and the original record is deleted.

### CORS

Navidrome sends CORS headers on its `/rest` endpoints, so connecting directly from the browser normally just works, including the EQ and analyzer.

If your server sits behind a proxy that strips CORS headers, two options:

1. **Bundled proxy**: `node serve.js https://music.example.com` — then log in with `http://localhost:8420` as the server URL. Everything is same-origin and all features work.
2. **Direct anyway**: Ampio detects the CORS failure and falls back to plain `<audio>` playback — music still plays, but the EQ and real analyzer data are disabled (the visualizer switches to simulated bars).

### PWA / installing

Serve Ampio over **HTTPS** (or localhost) and the browser will offer to install it — Chrome/Edge show an install icon in the address bar, iOS Safari uses Share → "Add to Home Screen". Installed, it opens as a standalone window with the Winamp-bolt icon.

What the service worker does:

- **App shell** (HTML/CSS/JS/icons) is cached cache-first, so the player opens instantly and even fully offline (you still need the network to reach your Navidrome server, of course)
- **Cover art** is cached stale-while-revalidate, capped at 150 entries
- **Everything else under `/rest`** (auth, browsing, audio streams) goes straight to the network — tokens stay fresh and seeking/range requests keep native behavior

Shipping an update? Bump `VERSION` in `sw.js` — old caches are purged on activation.

## Files

```
web/
├── index.html            # all four windows: login, main, EQ, playlist, library
├── css/style.css         # the skin — pure CSS, no sprite images
├── js/md5.js             # minimal RFC 1321 MD5 for Subsonic token auth
├── js/api.js             # Subsonic/OpenSubsonic API client
├── js/app.js             # audio engine, EQ, visualizer, playlist, library, window manager
├── sw.js                 # service worker: offline app shell + cover art cache
├── manifest.webmanifest  # PWA manifest
├── icons/                # bolt icon (SVG sources + generated PNGs)
└── serve.js              # optional zero-dep static server + /rest CORS proxy (Node 18+)
```
