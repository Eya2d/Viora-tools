/* =========================================================
   QRCode — مرمّز رموز QR كامل، بلا أي مكتبة خارجية
   ---------------------------------------------------------
   يدعم الإصدارات 1..40 ومستويات التصحيح L/M/Q/H، بترميز
   البايتات (UTF-8)، مع Reed–Solomon واختيار قناع الإخفاء
   الأمثل حسب قواعد العقوبة الأربع في المواصفة.
   ========================================================= */
(function (root) {
  "use strict";

  /* ---------- حقل جالوا GF(256) بكثير الحدود 0x11D ---------- */
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1, i;
    for (i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
    for (i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  /* كثير حدود التوليد = ∏ (x − α^i) */
  function rsGenerator(deg) {
    var result = [1], i, j;
    for (i = 0; i < deg; i++) {
      var tmp = new Array(result.length + 1);
      for (j = 0; j < tmp.length; j++) tmp[j] = 0;
      for (j = 0; j < result.length; j++) {
        tmp[j] ^= result[j];
        tmp[j + 1] ^= gmul(result[j], EXP[i]);
      }
      result = tmp;
    }
    return result;
  }

  function rsEncode(data, ecLen) {
    var gen = rsGenerator(ecLen);
    var res = new Uint8Array(ecLen);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ res[0];
      for (var s = 0; s < ecLen - 1; s++) res[s] = res[s + 1];
      res[ecLen - 1] = 0;
      for (var j = 0; j < ecLen; j++) res[j] ^= gmul(gen[j + 1], factor);
    }
    return res;
  }

  /* ---------- جداول المواصفة ----------
     لكل إصدار: عدد كلمات التصحيح لكل كتلة، وعدد الكتل.
     كل ما عداهما يُشتقّ حسابياً (انظر totalCodewords).      */
  var EC_PER_BLOCK = [
    /* L,  M,  Q,  H */
    [7, 10, 13, 17], [10, 16, 22, 28], [15, 26, 18, 22], [20, 18, 26, 16],
    [26, 24, 18, 22], [18, 16, 24, 28], [20, 18, 18, 26], [24, 22, 22, 26],
    [30, 22, 20, 24], [18, 26, 24, 28], [20, 30, 28, 24], [24, 22, 26, 28],
    [26, 22, 24, 22], [30, 24, 20, 24], [22, 24, 30, 24], [24, 28, 24, 30],
    [28, 28, 28, 28], [30, 26, 28, 28], [28, 26, 26, 26], [28, 26, 30, 28],
    [28, 26, 28, 30], [28, 28, 30, 24], [30, 28, 30, 30], [30, 28, 30, 30],
    [26, 28, 30, 30], [28, 28, 28, 30], [30, 28, 30, 30], [30, 28, 30, 30],
    [30, 28, 30, 30], [30, 28, 30, 30], [30, 28, 30, 30], [30, 28, 30, 30],
    [30, 28, 30, 30], [30, 28, 30, 30], [30, 28, 30, 30], [30, 28, 30, 30],
    [30, 28, 30, 30], [30, 28, 30, 30], [30, 28, 30, 30], [30, 28, 30, 30]
  ];

  var NUM_BLOCKS = [
    [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 2, 2], [1, 2, 2, 4],
    [1, 2, 4, 4], [2, 4, 4, 4], [2, 4, 6, 5], [2, 4, 6, 6],
    [2, 5, 8, 8], [4, 5, 8, 8], [4, 5, 8, 11], [4, 8, 10, 11],
    [4, 9, 12, 16], [4, 9, 16, 16], [6, 10, 12, 18], [6, 10, 17, 16],
    [6, 11, 16, 19], [6, 13, 18, 21], [7, 14, 21, 25], [8, 16, 20, 25],
    [8, 17, 23, 25], [9, 17, 23, 34], [9, 18, 25, 30], [10, 20, 27, 32],
    [12, 21, 29, 35], [12, 23, 34, 37], [12, 25, 34, 40], [13, 26, 35, 42],
    [14, 28, 38, 45], [15, 29, 40, 48], [16, 31, 43, 51], [17, 33, 45, 54],
    [18, 35, 48, 57], [19, 37, 51, 60], [19, 38, 53, 63], [20, 40, 56, 66],
    [21, 43, 59, 70], [22, 45, 62, 74], [24, 47, 65, 77], [25, 49, 68, 81]
  ];

  var ECL = { L: 0, M: 1, Q: 2, H: 3 };
  var ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };   // ترميز المستوى في معلومات الصيغة

  /* مجموع بتات البيانات + التصحيح لإصدار معيّن (صيغة المواصفة) */
  function totalDataBits(v) {
    var bits = (16 * v + 128) * v + 64;
    if (v >= 2) { var a = Math.floor(v / 7) + 2; bits -= (25 * a - 10) * a - 55; }
    if (v >= 7) bits -= 36;
    return bits;
  }
  function totalCodewords(v) { return Math.floor(totalDataBits(v) / 8); }
  function remainderBits(v) { return totalDataBits(v) % 8; }

  function dataCodewords(v, ecl) {
    return totalCodewords(v) - EC_PER_BLOCK[v - 1][ECL[ecl]] * NUM_BLOCKS[v - 1][ECL[ecl]];
  }

  /* مواضع أنماط المحاذاة */
  function alignPositions(v) {
    if (v === 1) return [];
    var num = Math.floor(v / 7) + 2;
    var size = 17 + 4 * v;
    var step = (v === 32) ? 26 : Math.ceil((v * 4 + 4) / (num * 2 - 2)) * 2;
    var res = [6];
    for (var pos = size - 7; res.length < num; pos -= step) res.splice(1, 0, pos);
    return res;
  }

  /* ---------- ترميز النص إلى بايتات UTF-8 ---------- */
  function toBytes(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
    var out = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  /* ---------- بنية البتات ---------- */
  function BitBuffer() { this.bits = []; }
  BitBuffer.prototype.put = function (val, len) {
    for (var i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  };

  /* ---------- بناء كلمات البيانات النهائية ---------- */
  function buildCodewords(bytes, v, ecl) {
    var cap = dataCodewords(v, ecl);
    var bb = new BitBuffer();
    bb.put(4, 4);                                  // نمط البايتات
    bb.put(bytes.length, v <= 9 ? 8 : 16);
    for (var i = 0; i < bytes.length; i++) bb.put(bytes[i], 8);

    var capBits = cap * 8;
    if (bb.bits.length > capBits) return null;     // لا يتّسع

    var term = Math.min(4, capBits - bb.bits.length);
    bb.put(0, term);
    while (bb.bits.length % 8 !== 0) bb.bits.push(0);

    var cw = new Uint8Array(cap);
    for (i = 0; i < bb.bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bb.bits[i + j];
      cw[i / 8] = b;
    }
    var pad = [0xEC, 0x11], p = 0;
    for (i = bb.bits.length / 8; i < cap; i++) cw[i] = pad[p++ % 2];
    return cw;
  }

  /* تقسيم إلى كتل، حساب التصحيح، ثم التشبيك */
  function interleave(cw, v, ecl) {
    var nBlocks = NUM_BLOCKS[v - 1][ECL[ecl]];
    var ecLen = EC_PER_BLOCK[v - 1][ECL[ecl]];
    var total = totalCodewords(v);
    var dataLen = cw.length;

    var shortLen = Math.floor(dataLen / nBlocks);
    var nLong = dataLen % nBlocks;                 // كتل أطول بكلمة واحدة

    var dataBlocks = [], ecBlocks = [], off = 0, i, j;
    for (i = 0; i < nBlocks; i++) {
      var len = shortLen + (i >= nBlocks - nLong ? 1 : 0);
      var blk = cw.subarray(off, off + len); off += len;
      dataBlocks.push(blk);
      ecBlocks.push(rsEncode(blk, ecLen));
    }

    var out = new Uint8Array(total), k = 0;
    var maxData = shortLen + (nLong ? 1 : 0);
    for (i = 0; i < maxData; i++)
      for (j = 0; j < nBlocks; j++)
        if (i < dataBlocks[j].length) out[k++] = dataBlocks[j][i];
    for (i = 0; i < ecLen; i++)
      for (j = 0; j < nBlocks; j++) out[k++] = ecBlocks[j][i];
    return out;
  }

  /* ---------- المصفوفة ---------- */
  function Matrix(size) {
    this.size = size;
    this.m = new Int8Array(size * size).fill(-1);   // -1 = غير محجوز
    this.fn = new Uint8Array(size * size);          // 1 = نمط وظيفي
  }
  Matrix.prototype.get = function (x, y) { return this.m[y * this.size + x]; };
  Matrix.prototype.set = function (x, y, v, isFn) {
    this.m[y * this.size + x] = v;
    if (isFn) this.fn[y * this.size + x] = 1;
  };

  function placeFunctionPatterns(mx, v) {
    var size = mx.size, i, j;

    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        var d = Math.max(Math.abs(dx), Math.abs(dy));
        mx.set(x, y, (d === 2 || d === 4) ? 0 : 1, true);
      }
    }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

    /* التوقيت */
    for (i = 8; i < size - 8; i++) {
      mx.set(i, 6, i % 2 === 0 ? 1 : 0, true);
      mx.set(6, i, i % 2 === 0 ? 1 : 0, true);
    }

    /* المحاذاة */
    var ap = alignPositions(v);
    for (i = 0; i < ap.length; i++) for (j = 0; j < ap.length; j++) {
      var cx = ap[i], cy = ap[j];
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) ||
          (cx === size - 7 && cy === 6)) continue;
      for (var dy2 = -2; dy2 <= 2; dy2++) for (var dx2 = -2; dx2 <= 2; dx2++) {
        var d2 = Math.max(Math.abs(dx2), Math.abs(dy2));
        mx.set(cx + dx2, cy + dy2, d2 === 1 ? 0 : 1, true);
      }
    }

    /* حجز مواضع معلومات الصيغة */
    for (i = 0; i <= 8; i++) { if (i !== 6) mx.set(i, 8, 0, true); }
    for (i = 0; i <= 8; i++) { if (i !== 6) mx.set(8, i, 0, true); }
    for (i = 0; i < 8; i++) mx.set(size - 1 - i, 8, 0, true);
    for (i = 0; i < 7; i++) mx.set(8, size - 1 - i, 0, true);
    mx.set(8, size - 8, 1, true);                   // الوحدة الداكنة

    /* معلومات الإصدار */
    if (v >= 7) {
      var bits = v;
      for (i = 0; i < 12; i++) bits = (bits << 1) ^ ((bits >>> 11) * 0x1F25);
      var vinfo = (v << 12) | bits;
      for (i = 0; i < 18; i++) {
        var bit = (vinfo >>> i) & 1;
        mx.set(Math.floor(i / 3), size - 11 + (i % 3), bit, true);
        mx.set(size - 11 + (i % 3), Math.floor(i / 3), bit, true);
      }
    }
  }

  function placeFormat(mx, ecl, mask) {
    var size = mx.size;
    var data = (ECL_BITS[ecl] << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;

    for (i = 0; i <= 5; i++) mx.set(8, i, (bits >>> i) & 1, true);
    mx.set(8, 7, (bits >>> 6) & 1, true);
    mx.set(8, 8, (bits >>> 7) & 1, true);
    mx.set(7, 8, (bits >>> 8) & 1, true);
    for (i = 9; i < 15; i++) mx.set(14 - i, 8, (bits >>> i) & 1, true);

    for (i = 0; i < 8; i++) mx.set(size - 1 - i, 8, (bits >>> i) & 1, true);
    for (i = 8; i < 15; i++) mx.set(8, size - 15 + i, (bits >>> i) & 1, true);
    mx.set(8, size - 8, 1, true);
  }

  function placeData(mx, cw, v) {
    var size = mx.size, i = 0, bitLen = cw.length * 8;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;                   // تخطّي عمود التوقيت
      for (var vert = 0; vert < size; vert++) {
        for (var k = 0; k < 2; k++) {
          var x = right - k;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (mx.fn[y * size + x]) continue;
          var bit = 0;
          if (i < bitLen) bit = (cw[i >>> 3] >>> (7 - (i & 7))) & 1;
          mx.set(x, y, bit, false);
          i++;
        }
      }
    }
  }

  function maskFn(id, x, y) {
    switch (id) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      case 7: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    }
    return false;
  }

  function applyMask(mx, id) {
    var size = mx.size;
    for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) {
      if (mx.fn[y * size + x]) continue;
      if (maskFn(id, x, y)) mx.m[y * size + x] ^= 1;
    }
  }

  /* قواعد العقوبة الأربع */
  function penalty(mx) {
    var size = mx.size, m = mx.m, score = 0, x, y, i;

    function run(line) {
      var s = 0, cur = line[0], len = 1;
      for (var t = 1; t < line.length; t++) {
        if (line[t] === cur) len++;
        else { if (len >= 5) s += 3 + (len - 5); cur = line[t]; len = 1; }
      }
      if (len >= 5) s += 3 + (len - 5);
      return s;
    }

    var row = new Array(size), col = new Array(size);
    for (y = 0; y < size; y++) {
      for (x = 0; x < size; x++) row[x] = m[y * size + x];
      score += run(row);
      /* القاعدة 3: النمط 1:1:3:1:1 محاطاً بأربع فواتح */
      score += patternScore(row);
    }
    for (x = 0; x < size; x++) {
      for (y = 0; y < size; y++) col[y] = m[y * size + x];
      score += run(col);
      score += patternScore(col);
    }

    /* القاعدة 2: كتل 2×2 */
    for (y = 0; y < size - 1; y++) for (x = 0; x < size - 1; x++) {
      var a = m[y * size + x];
      if (a === m[y * size + x + 1] && a === m[(y + 1) * size + x] &&
          a === m[(y + 1) * size + x + 1]) score += 3;
    }

    /* القاعدة 4: نسبة الوحدات الداكنة */
    var dark = 0;
    for (i = 0; i < m.length; i++) if (m[i] === 1) dark++;
    var pct = dark * 100 / m.length;
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  var PAT = [1, 0, 1, 1, 1, 0, 1];
  function patternScore(line) {
    var s = 0, n = line.length;
    for (var i = 0; i + 6 < n; i++) {
      var ok = true;
      for (var j = 0; j < 7; j++) if (line[i + j] !== PAT[j]) { ok = false; break; }
      if (!ok) continue;
      var before = true, after = true, k;
      for (k = 1; k <= 4; k++) if (i - k < 0 || line[i - k] !== 0) { before = false; break; }
      for (k = 0; k < 4; k++) if (i + 7 + k >= n || line[i + 7 + k] !== 0) { after = false; break; }
      if (before || after) s += 40;
    }
    return s;
  }

  /* ---------- الواجهة العامة ---------- */
  function encode(text, opts) {
    opts = opts || {};
    var ecl = (opts.ecl || "M").toUpperCase();
    if (!(ecl in ECL)) ecl = "M";
    var bytes = toBytes(String(text));

    var v = Math.max(1, Math.min(40, opts.minVersion || 1));
    var cw = null;
    for (; v <= 40; v++) { cw = buildCodewords(bytes, v, ecl); if (cw) break; }
    if (!cw) throw new Error("النص أطول من سعة أكبر رمز QR بهذا المستوى.");

    var all = interleave(cw, v, ecl);
    var size = 17 + 4 * v;
    var mx = new Matrix(size);
    placeFunctionPatterns(mx, v);
    placeData(mx, all, v);

    /* اختيار القناع صاحب أقل عقوبة */
    var best = 0, bestScore = Infinity, saved = Int8Array.from(mx.m);
    for (var mk = 0; mk < 8; mk++) {
      mx.m.set(saved);
      applyMask(mx, mk);
      placeFormat(mx, ecl, mk);
      var sc = penalty(mx);
      if (sc < bestScore) { bestScore = sc; best = mk; }
    }
    mx.m.set(saved);
    applyMask(mx, best);
    placeFormat(mx, ecl, best);

    var modules = [];
    for (var y = 0; y < size; y++) {
      var r = new Uint8Array(size);
      for (var x = 0; x < size; x++) r[x] = mx.m[y * size + x] === 1 ? 1 : 0;
      modules.push(r);
    }
    return { modules: modules, size: size, version: v, ecl: ecl, mask: best, bytes: bytes.length };
  }

  root.QRCode = {
    encode: encode,
    capacity: function (v, ecl) { return dataCodewords(v, ecl) - (v <= 9 ? 2 : 3); },
    _totalCodewords: totalCodewords,
    _dataCodewords: dataCodewords,
    _remainderBits: remainderBits
  };
})(typeof self !== "undefined" ? self : window);
