/* Subsonic/OpenSubsonic API client for Navidrome.

   Auth hardening:
   - The password is only ever seen by SubsonicClient.credentials(), which
     derives a reusable {salt, token} pair (t = md5(password + salt), salt
     from crypto.getRandomValues). The client itself never holds the password.
   - JSON API calls send auth in a POST body, keeping tokens out of URLs and
     server access logs. Stream/cover-art URLs must embed them (the Subsonic
     protocol streams via GET), which is unavoidable for <audio>/<img>.
   - If a server rejects POST (older Subsonic implementations, strict CORS),
     the client falls back to GET once and remembers. */
(function (global) {
  'use strict';

  var API_VERSION = '1.16.1';
  var CLIENT_NAME = 'ampio';

  function randomSalt() {
    if (global.crypto && global.crypto.getRandomValues) {
      var buf = new Uint8Array(16);
      global.crypto.getRandomValues(buf);
      return Array.prototype.map.call(buf, function (b) {
        return b.toString(16).padStart(2, '0');
      }).join('');
    }
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }

  function SubsonicClient(server, username, auth) {
    this.server = (server || '').replace(/\/+$/, '');
    this.username = username;
    this.auth = auth; // { salt, token } — no password
    this._post = true;
  }

  // Derive a reusable token pair from a password. Call once, then forget the password.
  SubsonicClient.credentials = function (password) {
    var salt = randomSalt();
    return { salt: salt, token: md5(password + salt) };
  };

  SubsonicClient.prototype.authQuery = function () {
    return 'u=' + encodeURIComponent(this.username) +
      '&t=' + this.auth.token + '&s=' + this.auth.salt +
      '&v=' + API_VERSION + '&c=' + CLIENT_NAME + '&f=json';
  };

  function buildParams(base, params) {
    var qs = base;
    if (params) {
      for (var k in params) {
        if (params[k] === undefined || params[k] === null) continue;
        if (Array.isArray(params[k])) {
          params[k].forEach(function (v) { qs += '&' + k + '=' + encodeURIComponent(v); });
        } else {
          qs += '&' + k + '=' + encodeURIComponent(params[k]);
        }
      }
    }
    return qs;
  }

  SubsonicClient.prototype.url = function (endpoint, params) {
    return this.server + '/rest/' + endpoint + '?' + buildParams(this.authQuery(), params);
  };

  SubsonicClient.prototype.call = function (endpoint, params) {
    var self = this;
    var body = buildParams(this.authQuery(), params);

    function parse(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + self.server);
      return res.json().then(function (json) {
        var r = json['subsonic-response'];
        if (!r) throw new Error('Not a Subsonic server (unexpected response)');
        if (r.status !== 'ok') {
          var err = r.error || {};
          throw new Error(err.message || ('Subsonic error ' + err.code));
        }
        return r;
      });
    }

    function viaGet() {
      return fetch(self.server + '/rest/' + endpoint + '?' + body).then(parse);
    }

    if (!this._post) return viaGet();

    return fetch(this.server + '/rest/' + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body
    }).then(function (res) {
      if (res.status === 405 || res.status === 501) {
        self._post = false;
        return viaGet();
      }
      return parse(res);
    }).catch(function (e) {
      // Network/CORS-level rejection of POST: retry once over GET
      if (e instanceof TypeError && self._post) {
        self._post = false;
        return viaGet();
      }
      throw e;
    });
  };

  // --- Endpoints ---
  SubsonicClient.prototype.ping = function () { return this.call('ping'); };

  SubsonicClient.prototype.getArtists = function () {
    return this.call('getArtists').then(function (r) {
      var idx = (r.artists && r.artists.index) || [];
      var out = [];
      idx.forEach(function (ix) { (ix.artist || []).forEach(function (a) { out.push(a); }); });
      return out;
    });
  };

  SubsonicClient.prototype.getArtist = function (id) {
    return this.call('getArtist', { id: id }).then(function (r) {
      return (r.artist && r.artist.album) || [];
    });
  };

  SubsonicClient.prototype.getAlbum = function (id) {
    return this.call('getAlbum', { id: id }).then(function (r) {
      return r.album || { song: [] };
    });
  };

  SubsonicClient.prototype.getAlbumList = function (type, offset, size) {
    return this.call('getAlbumList2', { type: type || 'newest', offset: offset || 0, size: size || 50 })
      .then(function (r) { return (r.albumList2 && r.albumList2.album) || []; });
  };

  SubsonicClient.prototype.getPlaylists = function () {
    return this.call('getPlaylists').then(function (r) {
      return (r.playlists && r.playlists.playlist) || [];
    });
  };

  SubsonicClient.prototype.getPlaylist = function (id) {
    return this.call('getPlaylist', { id: id }).then(function (r) {
      return (r.playlist && r.playlist.entry) || [];
    });
  };

  SubsonicClient.prototype.getRandomSongs = function (size) {
    return this.call('getRandomSongs', { size: size || 50 }).then(function (r) {
      return (r.randomSongs && r.randomSongs.song) || [];
    });
  };

  SubsonicClient.prototype.search = function (query) {
    return this.call('search3', { query: query, artistCount: 20, albumCount: 20, songCount: 50 })
      .then(function (r) { return r.searchResult3 || {}; });
  };

  SubsonicClient.prototype.scrobble = function (id, submission) {
    return this.call('scrobble', { id: id, submission: !!submission }).catch(function () { /* non-fatal */ });
  };

  SubsonicClient.prototype.streamUrl = function (id) {
    return this.url('stream', { id: id });
  };

  SubsonicClient.prototype.coverArtUrl = function (id, size) {
    return this.url('getCoverArt', { id: id, size: size || 200 });
  };

  global.SubsonicClient = SubsonicClient;
})(typeof window !== 'undefined' ? window : this);
