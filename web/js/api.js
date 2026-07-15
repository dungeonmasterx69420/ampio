/* Subsonic/OpenSubsonic API client for Navidrome.
   Uses token auth: t = md5(password + salt). */
(function (global) {
  'use strict';

  var API_VERSION = '1.16.1';
  var CLIENT_NAME = 'ampio';

  function SubsonicClient(server, username, password) {
    this.server = (server || '').replace(/\/+$/, '');
    this.username = username;
    this.password = password;
  }

  SubsonicClient.prototype.authQuery = function () {
    var salt = Math.random().toString(36).slice(2, 12);
    var token = md5(this.password + salt);
    return 'u=' + encodeURIComponent(this.username) +
      '&t=' + token + '&s=' + salt +
      '&v=' + API_VERSION + '&c=' + CLIENT_NAME + '&f=json';
  };

  SubsonicClient.prototype.url = function (endpoint, params) {
    var qs = this.authQuery();
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
    return this.server + '/rest/' + endpoint + '?' + qs;
  };

  SubsonicClient.prototype.call = function (endpoint, params) {
    var self = this;
    return fetch(this.url(endpoint, params)).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + self.server);
      return res.json();
    }).then(function (json) {
      var r = json['subsonic-response'];
      if (!r) throw new Error('Not a Subsonic server (unexpected response)');
      if (r.status !== 'ok') {
        var err = r.error || {};
        throw new Error(err.message || ('Subsonic error ' + err.code));
      }
      return r;
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
