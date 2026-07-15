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

## Running it

It's a static page. Any web server works:

```sh
cd web
node serve.js            # http://localhost:8420
# or: python3 -m http.server 8420
```

Then log in with your Navidrome URL, username, and password. Auth uses the standard Subsonic salted-token scheme (`t = md5(password + salt)`), so the password itself is never sent.

### CORS

Navidrome sends CORS headers on its `/rest` endpoints, so connecting directly from the browser normally just works, including the EQ and analyzer.

If your server sits behind a proxy that strips CORS headers, two options:

1. **Bundled proxy**: `node serve.js https://music.example.com` — then log in with `http://localhost:8420` as the server URL. Everything is same-origin and all features work.
2. **Direct anyway**: Ampio detects the CORS failure and falls back to plain `<audio>` playback — music still plays, but the EQ and real analyzer data are disabled (the visualizer switches to simulated bars).

### "Remember me"

Stores the server URL, username, and password (base64-obfuscated, not encrypted) in `localStorage` so you land straight in the player. Skip it on shared machines; the ✕ button on the main window logs out and clears it.

## Files

```
web/
├── index.html      # all four windows: login, main, EQ, playlist, library
├── css/style.css   # the skin — pure CSS, no sprite images
├── js/md5.js       # minimal RFC 1321 MD5 for Subsonic token auth
├── js/api.js       # Subsonic/OpenSubsonic API client
├── js/app.js       # audio engine, EQ, visualizer, playlist, library, window manager
└── serve.js        # optional zero-dep static server + /rest CORS proxy (Node 18+)
```
