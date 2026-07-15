/* ================================================================
   AMPIO — Winamp-style Navidrome client
   Single-file app logic: auth, audio engine, EQ, visualizer,
   playlist, media library, window manager.
   ================================================================ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var LS = {
    get: function (k, d) {
      try { var v = localStorage.getItem('ampio.' + k); return v === null ? d : JSON.parse(v); }
      catch (e) { return d; }
    },
    set: function (k, v) {
      try { localStorage.setItem('ampio.' + k, JSON.stringify(v)); } catch (e) { /* full/blocked */ }
    },
    del: function (k) { try { localStorage.removeItem('ampio.' + k); } catch (e) {} }
  };

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  var api = null;

  var state = {
    playlist: [],        // array of subsonic song objects
    current: -1,         // index into playlist
    playing: false,
    paused: false,
    shuffle: LS.get('shuffle', false),
    repeat: LS.get('repeat', false),
    history: [],         // indices played (for prev in shuffle mode)
    timeRemaining: false,
    seeking: false,
    scrobbled: false
  };

  var EQ_FREQS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
  var EQ_LABELS = ['60', '170', '310', '600', '1k', '3k', '6k', '12k', '14k', '16k'];
  var EQ_PRESETS = {
    flat:       [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    rock:       [4.8, 2.9, -3.4, -4.8, -2.0, 2.4, 5.3, 6.7, 6.7, 6.7],
    pop:        [-1.0, 2.9, 4.3, 4.8, 3.4, -1.0, -1.4, -1.4, -1.0, -1.0],
    jazz:       [2.4, 1.4, 0.0, 1.4, 2.4, 2.4, 0.0, 1.0, 2.0, 2.4],
    classical:  [0, 0, 0, 0, 0, 0, -4.3, -4.3, -4.3, -5.8],
    dance:      [5.8, 4.3, 1.4, 0, 0, -3.4, -4.3, -4.3, 0, 0],
    metal:      [6.2, 3.4, 0, -2.4, -1.4, 2.4, 5.3, 6.2, 6.7, 6.2],
    bass:       [5.8, 5.8, 5.8, 3.4, 1.0, -2.4, -4.8, -6.2, -6.7, -6.7],
    treble:     [-5.8, -5.8, -5.8, -2.4, 1.4, 6.7, 9.6, 9.6, 9.6, 10.1],
    headphones: [2.9, 6.7, 3.4, -2.0, -1.4, 1.0, 2.9, 5.8, 7.7, 8.7]
  };

  var eqState = LS.get('eq', { on: true, preamp: 0, bands: EQ_PRESETS.flat.slice() });

  // ---------------------------------------------------------------
  // Audio engine
  // ---------------------------------------------------------------
  var audio = $('audio');
  var ctx = null;                 // AudioContext
  var graph = null;               // { source, preamp, filters[], panner, analyser }
  var webAudioOk = true;          // false => plain <audio> fallback (no EQ/vis data)
  var corsRetried = false;        // one fallback retry per track

  function ensureContext() {
    if (!webAudioOk || ctx) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      audio.crossOrigin = 'anonymous';
      var source = ctx.createMediaElementSource(audio);
      var preamp = ctx.createGain();
      var filters = EQ_FREQS.map(function (f, i) {
        var biq = ctx.createBiquadFilter();
        if (i === 0) { biq.type = 'lowshelf'; }
        else if (i === EQ_FREQS.length - 1) { biq.type = 'highshelf'; }
        else { biq.type = 'peaking'; biq.Q.value = 1.1; }
        biq.frequency.value = f;
        biq.gain.value = 0;
        return biq;
      });
      var panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.75;

      var node = source;
      node.connect(preamp); node = preamp;
      filters.forEach(function (f) { node.connect(f); node = f; });
      if (panner) { node.connect(panner); node = panner; }
      node.connect(analyser);
      analyser.connect(ctx.destination);

      graph = { source: source, preamp: preamp, filters: filters, panner: panner, analyser: analyser };
      applyEq();
      applyBalance();
    } catch (e) {
      webAudioOk = false;
      ctx = null; graph = null;
      audio.removeAttribute('crossorigin');
    }
  }

  // If the server sends no CORS headers, a crossOrigin='anonymous' fetch fails
  // outright. Rebuild with a plain <audio> element (no EQ / real visualizer)
  // and retry the current track once.
  function fallbackToPlainAudio() {
    webAudioOk = false;
    if (ctx) { try { ctx.close(); } catch (e) {} }
    ctx = null; graph = null;

    var old = audio;
    old.pause();
    old.removeAttribute('src');
    var fresh = document.createElement('audio');
    fresh.id = 'audio';
    fresh.preload = 'auto';
    old.replaceWith(fresh);
    audio = fresh;
    bindAudioEvents();
    audio.volume = parseInt($('volume').value, 10) / 100;
  }

  function applyEq() {
    if (!graph) return;
    var on = eqState.on;
    graph.preamp.gain.value = on ? Math.pow(10, eqState.preamp / 20) : 1;
    graph.filters.forEach(function (f, i) {
      f.gain.value = on ? eqState.bands[i] : 0;
    });
    $('eq-on').classList.toggle('lit', on);
    LS.set('eq', eqState);
  }

  function applyBalance() {
    if (graph && graph.panner) {
      graph.panner.pan.value = parseInt($('balance').value, 10) / 100;
    }
  }

  // ---------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.round(s);
    var m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  function trackLabel(t) {
    return (t.artist ? t.artist + ' - ' : '') + (t.title || 'Unknown');
  }

  // ---------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------
  function playIndex(i) {
    if (i < 0 || i >= state.playlist.length) { stop(); return; }
    var t = state.playlist[i];
    state.current = i;
    state.scrobbled = false;
    corsRetried = false;

    ensureContext();
    if (ctx && ctx.state === 'suspended') ctx.resume();

    audio.src = api.streamUrl(t.id);
    var p = audio.play();
    if (p && p.catch) p.catch(function () { /* handled via error event / user gesture */ });

    state.playing = true;
    state.paused = false;
    api.scrobble(t.id, false);
    renderPlaylist();
    updateNowPlaying();
    updateMediaSession(t);
  }

  function playPause() {
    if (state.current === -1) {
      if (state.playlist.length) playIndex(state.shuffle ? randIndex() : 0);
      return;
    }
    if (state.paused || !state.playing) {
      if (ctx && ctx.state === 'suspended') ctx.resume();
      audio.play();
      state.playing = true; state.paused = false;
    }
    updateNowPlaying();
  }

  function pause() {
    if (!state.playing) return;
    if (state.paused) { audio.play(); state.paused = false; }
    else { audio.pause(); state.paused = true; }
    updateNowPlaying();
  }

  function stop() {
    audio.pause();
    if (audio.src) { try { audio.currentTime = 0; } catch (e) {} }
    state.playing = false; state.paused = false;
    updateNowPlaying();
  }

  function randIndex() {
    if (state.playlist.length <= 1) return 0;
    var i;
    do { i = Math.floor(Math.random() * state.playlist.length); } while (i === state.current);
    return i;
  }

  function next(fromEnded) {
    if (!state.playlist.length) return;
    if (state.shuffle) {
      if (state.current !== -1) state.history.push(state.current);
      if (state.history.length > 200) state.history.shift();
      playIndex(randIndex());
      return;
    }
    var n = state.current + 1;
    if (n >= state.playlist.length) {
      if (state.repeat) n = 0;
      else { if (fromEnded) stop(); return; }
    }
    playIndex(n);
  }

  function prev() {
    if (!state.playlist.length) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (state.shuffle && state.history.length) { playIndex(state.history.pop()); return; }
    var p = state.current - 1;
    if (p < 0) p = state.repeat ? state.playlist.length - 1 : 0;
    playIndex(p);
  }

  // ---------------------------------------------------------------
  // Audio element events
  // ---------------------------------------------------------------
  function bindAudioEvents() {
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('ended', function () { next(true); });
    audio.addEventListener('error', onAudioError);
    audio.addEventListener('loadedmetadata', function () {
      $('seek').disabled = false;
      $('seek').max = Math.max(1, Math.floor(audio.duration || 0));
    });
  }

  function onAudioError() {
    if (!audio.src) return;
    if (webAudioOk && !corsRetried) {
      // Likely a CORS rejection of the crossOrigin fetch — retry without WebAudio.
      corsRetried = true;
      var t = state.playlist[state.current];
      if (!t) return;
      fallbackToPlainAudio();
      audio.src = api.streamUrl(t.id);
      audio.play().catch(function () {});
      setMarquee('EQ/VISUALIZER DISABLED (SERVER SENT NO CORS HEADERS - SEE README) *** ' + marqueeBase);
      return;
    }
    setStatusMarquee('ERROR PLAYING TRACK - SKIPPING');
    setTimeout(function () { if (state.playing) next(true); }, 800);
  }

  function onTimeUpdate() {
    if (!state.seeking) {
      var el = $('seek');
      if (!el.disabled) el.value = Math.floor(audio.currentTime);
    }
    renderTime();
    // Scrobble submission at 50% or 4 minutes, whichever comes first
    if (!state.scrobbled && state.current !== -1 && audio.duration > 30 &&
        (audio.currentTime > audio.duration / 2 || audio.currentTime > 240)) {
      state.scrobbled = true;
      api.scrobble(state.playlist[state.current].id, true);
    }
  }

  function renderTime() {
    var el = $('time');
    if (state.current === -1 || (!state.playing && !audio.src)) { el.textContent = ' --:--'; return; }
    var t = state.timeRemaining && isFinite(audio.duration)
      ? -(audio.duration - audio.currentTime)
      : audio.currentTime;
    var neg = t < 0;
    var str = fmtTime(Math.abs(t));
    el.textContent = (neg ? '-' : ' ') + (str.length < 5 ? ' ' + str : str);
  }

  // ---------------------------------------------------------------
  // Now playing display
  // ---------------------------------------------------------------
  var marqueeBase = 'AMPIO 1.0 - WINAMP-STYLE NAVIDROME CLIENT';

  function setMarquee(text) {
    var el = $('marquee-text');
    el.textContent = text + '  ***  ';
    el.style.transform = 'translateX(0)';
    marqueePos = 0;
  }

  function setStatusMarquee(text) { setMarquee(text); }

  function updateNowPlaying() {
    var ps = $('playstate');
    var timeEl = $('time');
    timeEl.classList.toggle('blink', state.paused);
    if (!state.playing) { ps.innerHTML = '&#9632;'; }
    else if (state.paused) { ps.innerHTML = '&#10073;&#10073;'; }
    else { ps.innerHTML = '&#9654;'; }

    var t = state.playlist[state.current];
    if (t && state.playing) {
      marqueeBase = (state.current + 1) + '. ' + trackLabel(t) +
        (t.duration ? ' (' + fmtTime(t.duration) + ')' : '');
      setMarquee(marqueeBase);
      $('kbps').textContent = t.bitRate ? String(t.bitRate).padStart(3, ' ') : ' --';
      $('khz').textContent = t.samplingRate ? Math.round(t.samplingRate / 1000) : 44;
      var chans = t.channelCount || 2;
      $('ind-stereo').classList.toggle('on', chans >= 2);
      $('ind-mono').classList.toggle('on', chans === 1);
    } else if (!state.playing) {
      $('ind-stereo').classList.remove('on');
      $('ind-mono').classList.remove('on');
    }
    renderTime();
    renderPlaylist();
  }

  function updateMediaSession(t) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title || 'Unknown',
        artist: t.artist || '',
        album: t.album || '',
        artwork: t.coverArt ? [{ src: api.coverArtUrl(t.coverArt, 300), sizes: '300x300' }] : []
      });
      navigator.mediaSession.setActionHandler('play', playPause);
      navigator.mediaSession.setActionHandler('pause', pause);
      navigator.mediaSession.setActionHandler('previoustrack', prev);
      navigator.mediaSession.setActionHandler('nexttrack', function () { next(false); });
    } catch (e) { /* optional */ }
  }

  // Marquee scroll loop
  var marqueePos = 0;
  setInterval(function () {
    var el = $('marquee-text');
    var wrap = el.parentElement;
    if (el.scrollWidth <= wrap.clientWidth) { el.style.transform = 'translateX(0)'; return; }
    marqueePos += 1;
    if (marqueePos > el.scrollWidth) marqueePos = -wrap.clientWidth;
    el.style.transform = 'translateX(' + (-marqueePos) + 'px)';
  }, 40);

  // ---------------------------------------------------------------
  // Visualizer: analyzer bars / oscilloscope / off (click to cycle)
  // ---------------------------------------------------------------
  var visMode = LS.get('vismode', 0); // 0=bars 1=scope 2=off
  var BAR_COUNT = 19;
  var barPeaks = new Array(BAR_COUNT).fill(0);
  var fakeBars = new Array(BAR_COUNT).fill(0);
  var freqData = null, timeData = null;

  function drawVis() {
    requestAnimationFrame(drawVis);
    var cv = $('vis');
    if (!cv) return;
    var g = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    g.fillStyle = '#000006';
    g.fillRect(0, 0, W, H);
    if (visMode === 2) return;

    var active = state.playing && !state.paused;

    if (visMode === 1 && graph && webAudioOk) {
      // Oscilloscope
      if (!timeData) timeData = new Uint8Array(graph.analyser.fftSize);
      graph.analyser.getByteTimeDomainData(timeData);
      g.strokeStyle = '#00e800';
      g.lineWidth = 1;
      g.beginPath();
      for (var x = 0; x < W; x++) {
        var v = timeData[Math.floor(x / W * timeData.length)] / 255;
        var y = v * H;
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      return;
    }

    // Analyzer bars
    var levels;
    if (graph && webAudioOk) {
      if (!freqData) freqData = new Uint8Array(graph.analyser.frequencyBinCount);
      graph.analyser.getByteFrequencyData(freqData);
      levels = [];
      var n = freqData.length;
      for (var b = 0; b < BAR_COUNT; b++) {
        // log-spaced bins
        var lo = Math.floor(Math.pow(n, b / BAR_COUNT)) - 1;
        var hi = Math.floor(Math.pow(n, (b + 1) / BAR_COUNT));
        if (hi <= lo) hi = lo + 1;
        var sum = 0;
        for (var k = Math.max(0, lo); k < Math.min(n, hi); k++) sum += freqData[k];
        levels.push(sum / (hi - lo) / 255);
      }
    } else {
      // Fallback: simulated bars while playing
      levels = fakeBars.map(function (v, i) {
        var target = active ? Math.random() * (0.9 - i * 0.02) : 0;
        return fakeBars[i] = v + (target - v) * 0.3;
      });
    }

    var bw = W / BAR_COUNT;
    for (var i = 0; i < BAR_COUNT; i++) {
      var lvl = active || (graph && webAudioOk) ? levels[i] : 0;
      var bh = Math.round(lvl * (H - 2));
      // classic green->yellow->red vertical gradient per bar
      var grad = g.createLinearGradient(0, H, 0, 0);
      grad.addColorStop(0, '#00c000');
      grad.addColorStop(0.6, '#c8c800');
      grad.addColorStop(1, '#d00000');
      g.fillStyle = grad;
      g.fillRect(Math.floor(i * bw) + 1, H - bh, Math.max(2, Math.floor(bw) - 2), bh);
      // falling peak caps
      if (bh / H > barPeaks[i]) barPeaks[i] = bh / H;
      else barPeaks[i] = Math.max(0, barPeaks[i] - 0.008);
      if (barPeaks[i] > 0.01) {
        g.fillStyle = '#a8a8c8';
        g.fillRect(Math.floor(i * bw) + 1, H - Math.round(barPeaks[i] * H) - 1, Math.max(2, Math.floor(bw) - 2), 1);
      }
    }
  }
  requestAnimationFrame(drawVis);

  $('vis').addEventListener('click', function () {
    visMode = (visMode + 1) % 3;
    LS.set('vismode', visMode);
  });

  // ---------------------------------------------------------------
  // Playlist window
  // ---------------------------------------------------------------
  var plSelection = new Set();
  var plAnchor = -1;

  function totalDuration(list) {
    return list.reduce(function (s, t) { return s + (t.duration || 0); }, 0);
  }

  function renderPlaylist() {
    var ol = $('pl-list');
    ol.innerHTML = '';
    if (!state.playlist.length) {
      var li = document.createElement('li');
      li.className = 'pl-empty';
      li.textContent = 'playlist empty - hit + ADD or the eject button to browse your library';
      ol.appendChild(li);
    }
    state.playlist.forEach(function (t, i) {
      var li = document.createElement('li');
      li.draggable = true;
      li.dataset.idx = i;
      if (i === state.current) li.classList.add('current');
      if (plSelection.has(i)) li.classList.add('selected');
      var title = document.createElement('span');
      title.className = 'pl-title';
      title.textContent = (i + 1) + '. ' + trackLabel(t);
      var dur = document.createElement('span');
      dur.className = 'pl-dur';
      dur.textContent = t.duration ? fmtTime(t.duration) : '';
      li.appendChild(title); li.appendChild(dur);
      ol.appendChild(li);
    });
    var cur = state.current >= 0 && state.playlist[state.current]
      ? state.playlist.slice(0, state.current + 1) : [];
    $('pl-total').textContent =
      fmtTime(totalDuration(cur)) + '/' + fmtTime(totalDuration(state.playlist));
  }

  $('pl-list').addEventListener('click', function (e) {
    var li = e.target.closest('li[data-idx]');
    if (!li) return;
    var i = parseInt(li.dataset.idx, 10);
    if (e.shiftKey && plAnchor !== -1) {
      plSelection.clear();
      var a = Math.min(plAnchor, i), b = Math.max(plAnchor, i);
      for (var k = a; k <= b; k++) plSelection.add(k);
    } else if (e.ctrlKey || e.metaKey) {
      if (plSelection.has(i)) plSelection.delete(i); else plSelection.add(i);
      plAnchor = i;
    } else {
      plSelection.clear(); plSelection.add(i); plAnchor = i;
    }
    renderPlaylist();
  });

  $('pl-list').addEventListener('dblclick', function (e) {
    var li = e.target.closest('li[data-idx]');
    if (li) playIndex(parseInt(li.dataset.idx, 10));
  });

  // Drag-reorder (single item)
  var dragIdx = -1;
  $('pl-list').addEventListener('dragstart', function (e) {
    var li = e.target.closest('li[data-idx]');
    if (!li) return;
    dragIdx = parseInt(li.dataset.idx, 10);
    e.dataTransfer.effectAllowed = 'move';
  });
  $('pl-list').addEventListener('dragover', function (e) {
    e.preventDefault();
    var li = e.target.closest('li[data-idx]');
    Array.prototype.forEach.call($('pl-list').children, function (c) { c.classList.remove('drag-over'); });
    if (li) li.classList.add('drag-over');
  });
  $('pl-list').addEventListener('drop', function (e) {
    e.preventDefault();
    var li = e.target.closest('li[data-idx]');
    if (!li || dragIdx === -1) return;
    var to = parseInt(li.dataset.idx, 10);
    if (to === dragIdx) return;
    var item = state.playlist.splice(dragIdx, 1)[0];
    state.playlist.splice(to, 0, item);
    if (state.current === dragIdx) state.current = to;
    else if (dragIdx < state.current && to >= state.current) state.current--;
    else if (dragIdx > state.current && to <= state.current) state.current++;
    dragIdx = -1;
    plSelection.clear();
    renderPlaylist();
  });

  function removeIndices(keepSelected) {
    if (!plSelection.size) return;
    var keep = [];
    var newCurrent = -1;
    state.playlist.forEach(function (t, i) {
      var selected = plSelection.has(i);
      var stays = keepSelected ? selected : !selected;
      if (stays) {
        if (i === state.current) newCurrent = keep.length;
        keep.push(t);
      }
    });
    var removedCurrent = state.current !== -1 && newCurrent === -1;
    state.playlist = keep;
    state.current = newCurrent;
    plSelection.clear(); plAnchor = -1;
    state.history = [];
    if (removedCurrent) stop();
    renderPlaylist();
  }

  $('pl-rem').addEventListener('click', function () { removeIndices(false); });
  $('pl-crop').addEventListener('click', function () { removeIndices(true); });
  $('pl-clear').addEventListener('click', function () {
    state.playlist = []; state.current = -1; state.history = [];
    plSelection.clear();
    stop();
    renderPlaylist();
  });
  $('pl-add').addEventListener('click', function () { showWin('lib-win', true); });

  function enqueue(tracks, replace, andPlay) {
    if (replace) {
      state.playlist = []; state.current = -1; state.history = []; plSelection.clear();
    }
    var startAt = state.playlist.length;
    state.playlist = state.playlist.concat(tracks);
    renderPlaylist();
    if (andPlay && tracks.length) {
      playIndex(state.shuffle && replace ? randIndex() : startAt);
    }
  }

  // ---------------------------------------------------------------
  // Equalizer window
  // ---------------------------------------------------------------
  (function buildEqBands() {
    var wrap = $('eq-bands');
    EQ_LABELS.forEach(function (label, i) {
      var div = document.createElement('div');
      div.className = 'eq-band';
      var input = document.createElement('input');
      input.type = 'range';
      input.className = 'vslider';
      input.min = -12; input.max = 12; input.step = 0.5;
      input.setAttribute('orient', 'vertical');
      input.value = eqState.bands[i];
      input.dataset.band = i;
      input.addEventListener('input', function () {
        eqState.bands[i] = parseFloat(input.value);
        $('eq-preset').value = 'custom';
        applyEq();
      });
      var span = document.createElement('span');
      span.textContent = label;
      div.appendChild(input); div.appendChild(span);
      wrap.appendChild(div);
    });
    var custom = document.createElement('option');
    custom.value = 'custom'; custom.textContent = 'custom';
    $('eq-preset').appendChild(custom);
  })();

  $('eq-preamp').value = eqState.preamp;
  $('eq-preamp').addEventListener('input', function () {
    eqState.preamp = parseFloat(this.value);
    applyEq();
  });

  $('eq-on').addEventListener('click', function () {
    eqState.on = !eqState.on;
    applyEq();
  });

  $('eq-preset').addEventListener('change', function () {
    var p = EQ_PRESETS[this.value];
    if (!p) return;
    eqState.bands = p.slice();
    document.querySelectorAll('#eq-bands .vslider').forEach(function (el, i) { el.value = p[i]; });
    applyEq();
  });

  // ---------------------------------------------------------------
  // Media library window
  // ---------------------------------------------------------------
  var lib = {
    tab: 'albums',
    leftItems: [],       // items in left pane
    rightTracks: [],     // song objects currently listed in right pane
    rightSelection: new Set(),
    rightAnchor: -1,
    artistAlbums: null   // when drilled into an artist: {artist, albums}
  };

  function libStatus(msg) { $('lib-status').textContent = msg || ''; }

  function clearRightPane() {
    lib.rightTracks = [];
    lib.rightSelection.clear();
    lib.rightAnchor = -1;
    $('lib-right-list').innerHTML = '';
    $('lib-album-header').hidden = true;
  }

  function renderLeft(items, render) {
    lib.leftItems = items;
    var ul = $('lib-left-list');
    ul.innerHTML = '';
    items.forEach(function (item, i) {
      var li = document.createElement('li');
      render(li, item);
      li.dataset.idx = i;
      ul.appendChild(li);
    });
  }

  function renderRightTracks(tracks, headerAlbum) {
    lib.rightTracks = tracks;
    lib.rightSelection.clear();
    lib.rightAnchor = -1;
    var hdr = $('lib-album-header');
    if (headerAlbum) {
      hdr.hidden = false;
      $('lib-cover').src = headerAlbum.coverArt ? api.coverArtUrl(headerAlbum.coverArt, 128) : '';
      $('lib-album-title').textContent = headerAlbum.name || headerAlbum.album || '';
      $('lib-album-sub').textContent =
        (headerAlbum.artist || '') +
        (headerAlbum.year ? ' · ' + headerAlbum.year : '') +
        (headerAlbum.songCount ? ' · ' + headerAlbum.songCount + ' tracks' : '');
    } else {
      hdr.hidden = true;
    }
    var ul = $('lib-right-list');
    ul.innerHTML = '';
    tracks.forEach(function (t, i) {
      var li = document.createElement('li');
      li.dataset.tidx = i;
      var num = t.track ? String(t.track).padStart(2, '0') + '. ' : '';
      li.innerHTML = '';
      li.textContent = num + trackLabel(t);
      var dur = document.createElement('span');
      dur.className = 'dim';
      dur.textContent = t.duration ? '  [' + fmtTime(t.duration) + ']' : '';
      li.appendChild(dur);
      ul.appendChild(li);
    });
    libStatus(tracks.length + ' tracks');
  }

  function renderRightAlbums(albums, ownerName) {
    clearRightPane();
    var ul = $('lib-right-list');
    if (ownerName) {
      var h = document.createElement('li');
      h.className = 'heading';
      h.textContent = ownerName;
      ul.appendChild(h);
    }
    albums.forEach(function (al) {
      var li = document.createElement('li');
      li.textContent = (al.year ? '(' + al.year + ') ' : '') + (al.name || al.album || 'Unknown album');
      li.addEventListener('click', function () {
        loadAlbumTracks(al.id);
      });
      ul.appendChild(li);
    });
    libStatus(albums.length + ' albums');
  }

  function loadAlbumTracks(albumId) {
    libStatus('loading...');
    api.getAlbum(albumId).then(function (album) {
      renderRightTracks(album.song || [], album);
    }).catch(function (e) { libStatus(String(e.message || e)); });
  }

  function loadTab(tab) {
    lib.tab = tab;
    document.querySelectorAll('.lib-tab').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    clearRightPane();
    $('lib-left-list').innerHTML = '';
    libStatus('loading...');

    if (tab === 'albums') {
      api.getAlbumList('newest', 0, 100).then(function (albums) {
        renderLeft(albums, function (li, al) {
          li.textContent = (al.artist ? al.artist + ' - ' : '') + (al.name || 'Unknown');
        });
        libStatus(albums.length + ' recent albums');
      }).catch(function (e) { libStatus(String(e.message || e)); });
    } else if (tab === 'artists') {
      api.getArtists().then(function (artists) {
        renderLeft(artists, function (li, a) {
          li.textContent = a.name;
          var c = document.createElement('span');
          c.className = 'dim';
          c.textContent = a.albumCount ? '  [' + a.albumCount + ']' : '';
          li.appendChild(c);
        });
        libStatus(artists.length + ' artists');
      }).catch(function (e) { libStatus(String(e.message || e)); });
    } else if (tab === 'playlists') {
      api.getPlaylists().then(function (pls) {
        renderLeft(pls, function (li, p) {
          li.textContent = p.name;
          var c = document.createElement('span');
          c.className = 'dim';
          c.textContent = '  [' + (p.songCount || 0) + ']';
          li.appendChild(c);
        });
        libStatus(pls.length + ' playlists');
      }).catch(function (e) { libStatus(String(e.message || e)); });
    }
  }

  $('lib-left-list').addEventListener('click', function (e) {
    var li = e.target.closest('li[data-idx]');
    if (!li) return;
    document.querySelectorAll('#lib-left-list li').forEach(function (x) { x.classList.remove('selected'); });
    li.classList.add('selected');
    var item = lib.leftItems[parseInt(li.dataset.idx, 10)];
    if (!item) return;
    if (lib.tab === 'albums') {
      loadAlbumTracks(item.id);
    } else if (lib.tab === 'artists') {
      libStatus('loading...');
      api.getArtist(item.id).then(function (albums) {
        renderRightAlbums(albums, item.name);
      }).catch(function (err) { libStatus(String(err.message || err)); });
    } else if (lib.tab === 'playlists') {
      libStatus('loading...');
      api.getPlaylist(item.id).then(function (entries) {
        renderRightTracks(entries, null);
      }).catch(function (err) { libStatus(String(err.message || err)); });
    }
  });

  // Right pane track selection
  $('lib-right-list').addEventListener('click', function (e) {
    var li = e.target.closest('li[data-tidx]');
    if (!li) return;
    var i = parseInt(li.dataset.tidx, 10);
    if (e.shiftKey && lib.rightAnchor !== -1) {
      lib.rightSelection.clear();
      var a = Math.min(lib.rightAnchor, i), b = Math.max(lib.rightAnchor, i);
      for (var k = a; k <= b; k++) lib.rightSelection.add(k);
    } else if (e.ctrlKey || e.metaKey) {
      if (lib.rightSelection.has(i)) lib.rightSelection.delete(i); else lib.rightSelection.add(i);
      lib.rightAnchor = i;
    } else {
      lib.rightSelection.clear(); lib.rightSelection.add(i); lib.rightAnchor = i;
    }
    document.querySelectorAll('#lib-right-list li[data-tidx]').forEach(function (x) {
      x.classList.toggle('selected', lib.rightSelection.has(parseInt(x.dataset.tidx, 10)));
    });
  });

  $('lib-right-list').addEventListener('dblclick', function (e) {
    var li = e.target.closest('li[data-tidx]');
    if (!li) return;
    var t = lib.rightTracks[parseInt(li.dataset.tidx, 10)];
    if (t) { enqueue([t], false, true); showWin('pl-win', true); }
  });

  function selectedRightTracks() {
    if (!lib.rightTracks.length) return [];
    if (!lib.rightSelection.size) return lib.rightTracks.slice();
    return Array.from(lib.rightSelection).sort(function (a, b) { return a - b; })
      .map(function (i) { return lib.rightTracks[i]; });
  }

  $('lib-play').addEventListener('click', function () {
    var tracks = selectedRightTracks();
    if (!tracks.length) { libStatus('nothing to play - pick an album first'); return; }
    enqueue(tracks, true, true);
    showWin('pl-win', true);
  });

  $('lib-enqueue').addEventListener('click', function () {
    var tracks = selectedRightTracks();
    if (!tracks.length) { libStatus('nothing selected'); return; }
    enqueue(tracks, false, false);
    libStatus('queued ' + tracks.length + ' tracks');
  });

  $('lib-random').addEventListener('click', function () {
    libStatus('rolling the dice...');
    api.getRandomSongs(50).then(function (songs) {
      renderRightTracks(songs, null);
      libStatus(songs.length + ' random songs - hit PLAY or ENQUEUE');
    }).catch(function (e) { libStatus(String(e.message || e)); });
  });

  document.querySelectorAll('.lib-tab').forEach(function (b) {
    b.addEventListener('click', function () { loadTab(b.dataset.tab); });
  });

  $('lib-search-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var q = $('lib-search').value.trim();
    if (!q) { loadTab(lib.tab); return; }
    libStatus('searching...');
    clearRightPane();
    api.search(q).then(function (res) {
      var items = [];
      (res.artist || []).forEach(function (a) { items.push({ kind: 'artist', data: a }); });
      (res.album || []).forEach(function (a) { items.push({ kind: 'album', data: a }); });
      (res.song || []).forEach(function (s) { items.push({ kind: 'song', data: s }); });
      var ul = $('lib-left-list');
      ul.innerHTML = '';
      lib.leftItems = [];
      var lastKind = null;
      items.forEach(function (item) {
        if (item.kind !== lastKind) {
          lastKind = item.kind;
          var h = document.createElement('li');
          h.className = 'heading';
          h.textContent = '-- ' + item.kind.toUpperCase() + 'S --';
          ul.appendChild(h);
        }
        var li = document.createElement('li');
        var d = item.data;
        li.textContent = item.kind === 'artist' ? d.name
          : item.kind === 'album' ? (d.artist ? d.artist + ' - ' : '') + d.name
          : trackLabel(d);
        li.addEventListener('click', function () {
          document.querySelectorAll('#lib-left-list li').forEach(function (x) { x.classList.remove('selected'); });
          li.classList.add('selected');
          if (item.kind === 'artist') {
            api.getArtist(d.id).then(function (albums) { renderRightAlbums(albums, d.name); });
          } else if (item.kind === 'album') {
            loadAlbumTracks(d.id);
          } else {
            renderRightTracks([d], null);
          }
        });
        ul.appendChild(li);
      });
      libStatus(items.length + ' results for "' + q + '"');
    }).catch(function (e2) { libStatus(String(e2.message || e2)); });
  });

  // ---------------------------------------------------------------
  // Window manager: dragging, show/hide, z-order, saved positions
  // ---------------------------------------------------------------
  var WIN_IDS = ['main-win', 'eq-win', 'pl-win', 'lib-win'];
  var zTop = 30;

  function bringToFront(el) {
    zTop += 1;
    el.style.zIndex = zTop;
    document.querySelectorAll('.win').forEach(function (w) { w.classList.add('inactive'); });
    el.classList.remove('inactive');
  }

  function showWin(id, show) {
    var el = $(id);
    var vis = LS.get('winvis', { 'eq-win': true, 'pl-win': true, 'lib-win': false });
    if (show === undefined) show = el.hidden;
    el.hidden = !show;
    if (id !== 'main-win') { vis[id] = show; LS.set('winvis', vis); }
    if (show) {
      bringToFront(el);
      if (id === 'lib-win' && !$('lib-left-list').children.length) loadTab(lib.tab);
    }
    $('btn-eq-toggle').classList.toggle('lit', !$('eq-win').hidden);
    $('btn-pl-toggle').classList.toggle('lit', !$('pl-win').hidden);
    $('btn-lib-toggle').classList.toggle('lit', !$('lib-win').hidden);
  }

  // Dragging
  var drag = null;
  document.addEventListener('mousedown', function (e) {
    var win = e.target.closest('.win');
    if (win) bringToFront(win);
    var tb = e.target.closest('.titlebar[data-drag]');
    if (!tb || e.target.closest('.tb-btn')) return;
    var el = $(tb.dataset.drag);
    var r = el.getBoundingClientRect();
    drag = { el: el, dx: e.clientX - r.left, dy: e.clientY - r.top };
    el.style.transform = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', function (e) {
    if (!drag) return;
    var x = Math.max(-drag.el.offsetWidth + 60, Math.min(window.innerWidth - 60, e.clientX - drag.dx));
    var y = Math.max(0, Math.min(window.innerHeight - 20, e.clientY - drag.dy));
    drag.el.style.left = x + 'px';
    drag.el.style.top = y + 'px';
  });
  document.addEventListener('mouseup', function () {
    if (!drag) return;
    var pos = LS.get('winpos', {});
    pos[drag.el.id] = { left: drag.el.style.left, top: drag.el.style.top };
    LS.set('winpos', pos);
    drag = null;
  });

  document.querySelectorAll('[data-close]').forEach(function (b) {
    b.addEventListener('click', function () { showWin(b.dataset.close, false); });
  });

  function layoutWindows() {
    var pos = LS.get('winpos', {});
    var main = $('main-win'), eq = $('eq-win'), pl = $('pl-win'), libw = $('lib-win');
    var x = Math.max(10, Math.floor((window.innerWidth - 550 - 740) / 2));
    main.style.left = x + 'px'; main.style.top = '18px';
    eq.style.left = x + 'px';
    pl.style.left = x + 'px';
    libw.style.left = (x + 562) + 'px'; libw.style.top = '18px';
    // Stack after render so heights are known
    requestAnimationFrame(function () {
      eq.style.top = (18 + main.offsetHeight + 2) + 'px';
      pl.style.top = (18 + main.offsetHeight + 2 + (eq.hidden ? 0 : eq.offsetHeight + 2)) + 'px';
      WIN_IDS.forEach(function (id) {
        if (pos[id] && pos[id].left) {
          $(id).style.left = pos[id].left;
          $(id).style.top = pos[id].top;
        }
      });
    });
  }

  // ---------------------------------------------------------------
  // Main window controls
  // ---------------------------------------------------------------
  $('btn-play').addEventListener('click', playPause);
  $('btn-pause').addEventListener('click', pause);
  $('btn-stop').addEventListener('click', stop);
  $('btn-prev').addEventListener('click', prev);
  $('btn-next').addEventListener('click', function () { next(false); });
  $('btn-eject').addEventListener('click', function () { showWin('lib-win', true); });

  $('btn-shuffle').addEventListener('click', function () {
    state.shuffle = !state.shuffle;
    LS.set('shuffle', state.shuffle);
    this.classList.toggle('lit', state.shuffle);
  });
  $('btn-repeat').addEventListener('click', function () {
    state.repeat = !state.repeat;
    LS.set('repeat', state.repeat);
    this.classList.toggle('lit', state.repeat);
  });

  $('btn-eq-toggle').addEventListener('click', function () { showWin('eq-win'); });
  $('btn-pl-toggle').addEventListener('click', function () { showWin('pl-win'); });
  $('btn-lib-toggle').addEventListener('click', function () { showWin('lib-win'); });

  $('time').parentElement.addEventListener('click', function () {
    state.timeRemaining = !state.timeRemaining;
    renderTime();
  });

  $('volume').addEventListener('input', function () {
    audio.volume = parseInt(this.value, 10) / 100;
    LS.set('volume', parseInt(this.value, 10));
  });
  $('balance').addEventListener('input', applyBalance);
  $('balance').addEventListener('dblclick', function () { this.value = 0; applyBalance(); });

  var seekEl = $('seek');
  seekEl.addEventListener('input', function () { state.seeking = true; });
  seekEl.addEventListener('change', function () {
    state.seeking = false;
    if (isFinite(audio.duration)) audio.currentTime = parseInt(this.value, 10);
  });

  // Keyboard shortcuts (classic winamp keys)
  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    switch (e.key.toLowerCase()) {
      case 'x': playPause(); break;
      case 'c': pause(); break;
      case 'v': stop(); break;
      case 'z': prev(); break;
      case 'b': next(false); break;
      case 's': $('btn-shuffle').click(); break;
      case 'r': $('btn-repeat').click(); break;
      case 'l': showWin('lib-win'); break;
      case 'delete': removeIndices(false); break;
      case 'arrowleft': audio.currentTime = Math.max(0, audio.currentTime - 5); break;
      case 'arrowright':
        if (isFinite(audio.duration)) audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
        break;
      case 'arrowup':
        $('volume').value = Math.min(100, parseInt($('volume').value, 10) + 5);
        $('volume').dispatchEvent(new Event('input'));
        e.preventDefault();
        break;
      case 'arrowdown':
        $('volume').value = Math.max(0, parseInt($('volume').value, 10) - 5);
        $('volume').dispatchEvent(new Event('input'));
        e.preventDefault();
        break;
    }
  });

  // ---------------------------------------------------------------
  // Login / session
  // ---------------------------------------------------------------
  function showApp() {
    $('login-win').hidden = true;
    showWin('main-win', true);
    var vis = LS.get('winvis', { 'eq-win': true, 'pl-win': true, 'lib-win': false });
    showWin('eq-win', vis['eq-win'] !== false);
    showWin('pl-win', vis['pl-win'] !== false);
    showWin('lib-win', !!vis['lib-win']);
    layoutWindows();
    renderPlaylist();
    $('btn-shuffle').classList.toggle('lit', state.shuffle);
    $('btn-repeat').classList.toggle('lit', state.repeat);
    var vol = LS.get('volume', 80);
    $('volume').value = vol;
    audio.volume = vol / 100;
  }

  function tryLogin(server, user, pass, remember, fromSaved) {
    var client = new SubsonicClient(server, user, pass);
    $('login-error').hidden = true;
    return client.ping().then(function () {
      api = client;
      if (remember) {
        LS.set('creds', { server: server, user: user, pass: btoa(unescape(encodeURIComponent(pass))) });
      }
      showApp();
    }).catch(function (e) {
      if (fromSaved) {
        $('login-win').hidden = false;
        $('login-server').value = server;
        $('login-user').value = user;
      }
      var el = $('login-error');
      el.textContent = 'connection failed: ' + (e.message || e);
      el.hidden = false;
      throw e;
    });
  }

  $('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = document.querySelector('.login-btn');
    btn.disabled = true; btn.textContent = 'CONNECTING...';
    tryLogin(
      $('login-server').value.trim(),
      $('login-user').value.trim(),
      $('login-pass').value,
      $('login-remember').checked
    ).catch(function () {}).then(function () {
      btn.disabled = false; btn.textContent = 'CONNECT';
    });
  });

  $('btn-logout').addEventListener('click', function () {
    stop();
    LS.del('creds');
    state.playlist = []; state.current = -1;
    WIN_IDS.forEach(function (id) { $(id).hidden = true; });
    $('login-win').hidden = false;
    $('login-pass').value = '';
  });

  // ---------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------
  bindAudioEvents();

  // PWA service worker (needs a secure context: https or localhost)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* http or unsupported */ });
  }

  var saved = LS.get('creds', null);
  if (saved && saved.server && saved.user) {
    $('login-win').hidden = true;
    var pass = '';
    try { pass = decodeURIComponent(escape(atob(saved.pass || ''))); } catch (e) {}
    tryLogin(saved.server, saved.user, pass, false, true).catch(function () {});
  } else {
    // Prefill server with same-origin when served via the bundled proxy
    if (location.protocol.indexOf('http') === 0) $('login-server').value = location.origin;
  }
})();
