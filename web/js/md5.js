/* Minimal MD5 (RFC 1321) — used for Subsonic API token auth (t = md5(password + salt)).
   Not for security-critical hashing. */
(function (global) {
  'use strict';

  var S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];

  var K = (function () {
    var k = new Array(64);
    for (var i = 0; i < 64; i++) {
      k[i] = (Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)) >>> 0;
    }
    return k;
  })();

  function rotl(x, c) { return ((x << c) | (x >>> (32 - c))) >>> 0; }

  function toBytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    // Fallback UTF-8 encoder
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.codePointAt(i);
      if (c > 0xffff) i++;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function md5(str) {
    var msg = toBytes(str);
    var origLenBits = msg.length * 8;

    // Padding: append 0x80, then zeros until length ≡ 56 (mod 64), then 64-bit LE length
    var padded = new Uint8Array((((msg.length + 8) >> 6) + 1) << 6);
    padded.set(msg);
    padded[msg.length] = 0x80;
    var dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, origLenBits >>> 0, true);
    dv.setUint32(padded.length - 4, Math.floor(origLenBits / 4294967296), true);

    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    var M = new Array(16);

    for (var off = 0; off < padded.length; off += 64) {
      for (var j = 0; j < 16; j++) M[j] = dv.getUint32(off + j * 4, true);
      var A = a0, B = b0, C = c0, D = d0;
      for (var i = 0; i < 64; i++) {
        var F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + rotl(F, S[i])) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }

    function hexLE(n) {
      var s = '';
      for (var i = 0; i < 4; i++) s += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
      return s;
    }
    return hexLE(a0) + hexLE(b0) + hexLE(c0) + hexLE(d0);
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = md5;
  else global.md5 = md5;
})(typeof window !== 'undefined' ? window : this);
