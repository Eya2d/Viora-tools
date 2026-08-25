/* =========================================================
   Vectorize — محرك تحويل الصور النقطية إلى مسارات SVG
   ---------------------------------------------------------
   المراحل:
     1) تحضير البكسلات (تمويه اختياري / تدرّج رمادي / عتبة)
     2) تكميم الألوان (k-means++) إلى لوحة محدودة
     3) لكل لون: بناء قناع ثنائي وتتبّع حدوده على شبكة البكسل
        (crack-following) فينتج مضلّعات مغلقة دقيقة تماماً
     4) تبسيط المضلّعات (Ramer–Douglas–Peucker)
     5) ملاءمة منحنيات بيزييه تكعيبية (خوارزمية Schneider)
     6) تجميع مسار واحد لكل لون بقاعدة evenodd (الثقوب تلقائية)
   ========================================================= */
(function (root) {
  "use strict";

  /* ============ أدوات عامة ============ */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ============ 1) تمويه صندوقي منفصل ============ */
  function boxBlur(data, w, h, r) {
    if (r < 1) return data;
    var tmp = new Uint8ClampedArray(data.length);
    var x, y, c, i, sum, n;

    for (y = 0; y < h; y++) {
      for (c = 0; c < 4; c++) {
        sum = 0; n = 0;
        for (x = -r; x <= r; x++) { i = clamp(x, 0, w - 1); sum += data[(y * w + i) * 4 + c]; n++; }
        for (x = 0; x < w; x++) {
          tmp[(y * w + x) * 4 + c] = sum / n;
          var add = clamp(x + r + 1, 0, w - 1), rem = clamp(x - r, 0, w - 1);
          sum += data[(y * w + add) * 4 + c] - data[(y * w + rem) * 4 + c];
        }
      }
    }
    for (x = 0; x < w; x++) {
      for (c = 0; c < 4; c++) {
        sum = 0; n = 0;
        for (y = -r; y <= r; y++) { i = clamp(y, 0, h - 1); sum += tmp[(i * w + x) * 4 + c]; n++; }
        for (y = 0; y < h; y++) {
          data[(y * w + x) * 4 + c] = sum / n;
          var ad = clamp(y + r + 1, 0, h - 1), rm = clamp(y - r, 0, h - 1);
          sum += tmp[(ad * w + x) * 4 + c] - tmp[(rm * w + x) * 4 + c];
        }
      }
    }
    return data;
  }

  /* ============ 2) تكميم الألوان ============ */
  function quantize(data, w, h, k, alphaMin) {
    var n = w * h, i, j;
    var idx = new Int16Array(n);

    /* عيّنة عشوائية ثابتة (بذرة ثابتة => نتائج قابلة للتكرار) */
    var maxSample = 24000;
    var step = Math.max(1, Math.floor(n / maxSample));
    var sample = [];
    for (i = 0; i < n; i += step) {
      if (data[i * 4 + 3] >= alphaMin) sample.push(i);
    }
    if (!sample.length) return { idx: idx.fill(-1), palette: [], counts: [] };

    /* --- k-means++ للتهيئة --- */
    var seed = 20260825;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

    var cent = [];
    var first = sample[Math.floor(rnd() * sample.length)];
    cent.push([data[first * 4], data[first * 4 + 1], data[first * 4 + 2]]);

    var dist = new Float64Array(sample.length).fill(Infinity);
    while (cent.length < k) {
      var total = 0, c = cent[cent.length - 1];
      for (i = 0; i < sample.length; i++) {
        var p = sample[i] * 4;
        var dr = data[p] - c[0], dg = data[p + 1] - c[1], db = data[p + 2] - c[2];
        var d2 = dr * dr + dg * dg + db * db;
        if (d2 < dist[i]) dist[i] = d2;
        total += dist[i];
      }
      if (total <= 0) break;
      var target = rnd() * total, acc = 0, pick = sample.length - 1;
      for (i = 0; i < sample.length; i++) { acc += dist[i]; if (acc >= target) { pick = i; break; } }
      var q = sample[pick] * 4;
      cent.push([data[q], data[q + 1], data[q + 2]]);
    }
    k = cent.length;

    /* --- تكرارات Lloyd على العيّنة --- */
    var sumR = new Float64Array(k), sumG = new Float64Array(k),
        sumB = new Float64Array(k), cnt = new Float64Array(k);
    for (var it = 0; it < 12; it++) {
      sumR.fill(0); sumG.fill(0); sumB.fill(0); cnt.fill(0);
      for (i = 0; i < sample.length; i++) {
        var pp = sample[i] * 4,
            r = data[pp], g = data[pp + 1], b = data[pp + 2];
        var best = 0, bd = Infinity;
        for (j = 0; j < k; j++) {
          var cj = cent[j];
          var x0 = r - cj[0], x1 = g - cj[1], x2 = b - cj[2];
          var dd = x0 * x0 + x1 * x1 + x2 * x2;
          if (dd < bd) { bd = dd; best = j; }
        }
        sumR[best] += r; sumG[best] += g; sumB[best] += b; cnt[best]++;
      }
      var moved = 0;
      for (j = 0; j < k; j++) {
        if (!cnt[j]) continue;
        var nr = sumR[j] / cnt[j], ng = sumG[j] / cnt[j], nb = sumB[j] / cnt[j];
        moved += Math.abs(nr - cent[j][0]) + Math.abs(ng - cent[j][1]) + Math.abs(nb - cent[j][2]);
        cent[j] = [nr, ng, nb];
      }
      if (moved < 1.5) break;
    }

    /* --- إسناد كل بكسل للون الأقرب --- */
    var counts = new Int32Array(k);
    var cr = new Float64Array(k), cg = new Float64Array(k), cb = new Float64Array(k);
    for (j = 0; j < k; j++) { cr[j] = cent[j][0]; cg[j] = cent[j][1]; cb[j] = cent[j][2]; }

    var accR = new Float64Array(k), accG = new Float64Array(k), accB = new Float64Array(k);
    for (i = 0; i < n; i++) {
      if (data[i * 4 + 3] < alphaMin) { idx[i] = -1; continue; }
      var R = data[i * 4], G = data[i * 4 + 1], B = data[i * 4 + 2];
      var bi = 0, bdd = Infinity;
      for (j = 0; j < k; j++) {
        var e0 = R - cr[j], e1 = G - cg[j], e2 = B - cb[j];
        var s = e0 * e0 + e1 * e1 + e2 * e2;
        if (s < bdd) { bdd = s; bi = j; }
      }
      idx[i] = bi; counts[bi]++;
      accR[bi] += R; accG[bi] += G; accB[bi] += B;
    }

    /* اللون النهائي = متوسط البكسلات الفعلية (أدقّ من مركز العيّنة) */
    var palette = [];
    for (j = 0; j < k; j++) {
      palette.push(counts[j]
        ? [Math.round(accR[j] / counts[j]), Math.round(accG[j] / counts[j]), Math.round(accB[j] / counts[j])]
        : [Math.round(cr[j]), Math.round(cg[j]), Math.round(cb[j])]);
    }
    return { idx: idx, palette: palette, counts: counts };
  }

  root.Vectorize = { _boxBlur: boxBlur, _quantize: quantize, _clamp: clamp };
})(typeof self !== "undefined" ? self : window);

/* =========================================================
   تتبّع الحدود + التبسيط + ملاءمة المنحنيات + بناء الـ SVG
   ========================================================= */
(function (root) {
  "use strict";
  var V = root.Vectorize;

  /* ============ 3) تتبّع حدود القناع الثنائي ============
     نمشي على «شقوق» شبكة البكسل (إحداثيات صحيحة) فينتج
     مضلّع مغلق يطابق البكسلات مطابقة تامة قبل التبسيط.     */
  function Tracer(w, h) {
    this.w = w; this.h = h;
    var nv = (w + 1) * (h + 1);
    this.nv = nv;
    this.dst = new Int32Array(nv * 2);
    this.dir = new Uint8Array(nv * 2);
    this.cnt = new Uint8Array(nv);
    this.gen = new Int32Array(nv);
    this.stamp = 0;
    this.touched = new Int32Array(nv);
  }

  // الاتجاهات: 0 = +x، 1 = +y، 2 = -x، 3 = -y
  Tracer.prototype.trace = function (mask) {
    var w = this.w, h = this.h, W = w + 1;
    var dst = this.dst, dir = this.dir, cnt = this.cnt, gen = this.gen;
    var touched = this.touched, nTouched = 0;
    var stamp = ++this.stamp;
    var x, y, v;

    function add(a, b, d) {
      if (gen[a] !== stamp) { gen[a] = stamp; cnt[a] = 0; touched[nTouched++] = a; }
      var s = a * 2 + cnt[a];
      dst[s] = b; dir[s] = d; cnt[a]++;
    }

    /* بناء الأضلاع الموجّهة حول كل بكسل مضاء */
    for (y = 0; y < h; y++) {
      var row = y * w;
      for (x = 0; x < w; x++) {
        if (!mask[row + x]) continue;
        var tl = y * W + x, tr = tl + 1, bl = (y + 1) * W + x, br = bl + 1;
        if (y === 0     || !mask[row - w + x]) add(tl, tr, 0); // أعلى  →
        if (x === w - 1 || !mask[row + x + 1]) add(tr, br, 1); // يمين  ↓
        if (y === h - 1 || !mask[row + w + x]) add(br, bl, 2); // أسفل  ←
        if (x === 0     || !mask[row + x - 1]) add(bl, tl, 3); // يسار  ↑
      }
    }

    /* متابعة الحلقات (تفضيل الانعطاف يساراً يبقي البكسلات
       المتلاصقة قطرياً شكلاً واحداً) */
    return this._follow(touched, nTouched, W);
  };

  /* تتبّع طبقة انطلاقاً من قائمة بكسلاتها فقط — التكلفة تتناسب مع
     حجم اللون لا مع حجم الصورة، وهو ما يجعل وضع «بلا فقدان» ممكناً
     حتى مع مئات الآلاف من الألوان. النتيجة مطابقة لـ trace(mask).   */
  Tracer.prototype.traceList = function (idx, ci, list, from, to) {
    var w = this.w, h = this.h, W = w + 1;
    var dst = this.dst, dir = this.dir, cnt = this.cnt, gen = this.gen;
    var touched = this.touched, nTouched = 0;
    var stamp = ++this.stamp;

    function add(a, b, d) {
      if (gen[a] !== stamp) { gen[a] = stamp; cnt[a] = 0; touched[nTouched++] = a; }
      var s = a * 2 + cnt[a];
      dst[s] = b; dir[s] = d; cnt[a]++;
    }

    for (var t = from; t < to; t++) {
      var p = list[t], x = p % w, y = (p / w) | 0;
      var tl = y * W + x, tr = tl + 1, bl = (y + 1) * W + x, br = bl + 1;
      if (y === 0     || idx[p - w] !== ci) add(tl, tr, 0);
      if (x === w - 1 || idx[p + 1] !== ci) add(tr, br, 1);
      if (y === h - 1 || idx[p + w] !== ci) add(br, bl, 2);
      if (x === 0     || idx[p - 1] !== ci) add(bl, tl, 3);
    }
    return this._follow(touched, nTouched, W);
  };

  /* متابعة الحلقات — مشتركة بين طريقتَي التتبّع */
  Tracer.prototype._follow = function (touched, nTouched, W) {
    var dst = this.dst, dir = this.dir, cnt = this.cnt;
    var polys = [];
    for (var t = 0; t < nTouched; t++) {
      var start = touched[t];
      for (var slot = 0; slot < cnt[start]; slot++) {
        if (dst[start * 2 + slot] < 0) continue;

        var pts = [];
        var cur = start, d = dir[start * 2 + slot], next = dst[start * 2 + slot];
        dst[start * 2 + slot] = -1;
        pts.push(start % W, (start / W) | 0);

        while (next !== start) {
          cur = next;
          pts.push(cur % W, (cur / W) | 0);
          var order = [(d + 3) & 3, d, (d + 1) & 3, (d + 2) & 3];
          var chosen = -1;
          for (var oi = 0; oi < 4 && chosen < 0; oi++) {
            for (var s2 = 0; s2 < cnt[cur]; s2++) {
              var sl = cur * 2 + s2;
              if (dst[sl] >= 0 && dir[sl] === order[oi]) { chosen = sl; break; }
            }
          }
          if (chosen < 0) break;
          d = dir[chosen]; next = dst[chosen]; dst[chosen] = -1;
        }
        if (pts.length >= 6) polys.push(pts);
      }
    }
    return polys;
  };

  /* مساحة المضلّع (بصيغة الحذاء) */
  function polyArea(p) {
    var a = 0, n = p.length / 2;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      a += p[j * 2] * p[i * 2 + 1] - p[i * 2] * p[j * 2 + 1];
    }
    return a / 2;
  }

  /* ============ 4) تبسيط Ramer–Douglas–Peucker ============ */
  function rdp(pts, first, last, eps2, keep) {
    var ax = pts[first * 2], ay = pts[first * 2 + 1];
    var bx = pts[last * 2], by = pts[last * 2 + 1];
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var maxD = -1, maxI = -1;

    for (var i = first + 1; i < last; i++) {
      var px = pts[i * 2] - ax, py = pts[i * 2 + 1] - ay;
      var d;
      if (len2 === 0) { d = px * px + py * py; }
      else {
        var cross = px * dy - py * dx;
        d = (cross * cross) / len2;
      }
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > eps2 && maxI > 0) {
      rdp(pts, first, maxI, eps2, keep);
      keep.push(maxI);
      rdp(pts, maxI, last, eps2, keep);
    }
  }

  function simplifyClosed(pts, eps) {
    var n = pts.length / 2;
    if (n < 4 || eps <= 0) return pts;

    /* نقطتا الارتكاز: الأبعد عن بعضهما لتجنّب انحياز نقطة البداية */
    var x0 = pts[0], y0 = pts[1], far = 0, fd = -1, i;
    for (i = 1; i < n; i++) {
      var dx = pts[i * 2] - x0, dy = pts[i * 2 + 1] - y0;
      var d = dx * dx + dy * dy;
      if (d > fd) { fd = d; far = i; }
    }
    var keepA = [], keepB = [];
    rdp(pts, 0, far, eps * eps, keepA);
    rdp(pts, far, n - 1, eps * eps, keepB);

    var order = [0].concat(keepA.sort(function (a, b) { return a - b; }),
                 [far], keepB.sort(function (a, b) { return a - b; }));
    var out = [];
    for (i = 0; i < order.length; i++) out.push(pts[order[i] * 2], pts[order[i] * 2 + 1]);
    return out.length >= 6 ? out : pts;
  }

  V._Tracer = Tracer;
  V._polyArea = polyArea;
  V._simplifyClosed = simplifyClosed;
})(typeof self !== "undefined" ? self : window);

/* =========================================================
   ملاءمة منحنيات بيزييه (Schneider) + بناء مستند SVG
   ========================================================= */
(function (root) {
  "use strict";
  var V = root.Vectorize;

  /* ---- عمليات متجهات صغيرة ---- */
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function norm(a) { var l = len(a); return l ? [a[0] / l, a[1] / l] : [0, 0]; }

  function bezierQ(c, t) {
    var mt = 1 - t;
    var a0 = mt * mt * mt, a1 = 3 * mt * mt * t, a2 = 3 * mt * t * t, a3 = t * t * t;
    return [c[0][0] * a0 + c[1][0] * a1 + c[2][0] * a2 + c[3][0] * a3,
            c[0][1] * a0 + c[1][1] * a1 + c[2][1] * a2 + c[3][1] * a3];
  }
  function bezierQPrime(c, t) {
    var mt = 1 - t;
    return [3 * mt * mt * (c[1][0] - c[0][0]) + 6 * mt * t * (c[2][0] - c[1][0]) + 3 * t * t * (c[3][0] - c[2][0]),
            3 * mt * mt * (c[1][1] - c[0][1]) + 6 * mt * t * (c[2][1] - c[1][1]) + 3 * t * t * (c[3][1] - c[2][1])];
  }
  function bezierQPrimePrime(c, t) {
    return [6 * (1 - t) * (c[2][0] - 2 * c[1][0] + c[0][0]) + 6 * t * (c[3][0] - 2 * c[2][0] + c[1][0]),
            6 * (1 - t) * (c[2][1] - 2 * c[1][1] + c[0][1]) + 6 * t * (c[3][1] - 2 * c[2][1] + c[1][1])];
  }

  function chordLengthParameterize(pts, first, last) {
    var u = [0], i;
    for (i = first + 1; i <= last; i++) u[i - first] = u[i - first - 1] + len(sub(pts[i], pts[i - 1]));
    var total = u[last - first] || 1;
    for (i = 1; i < u.length; i++) u[i] /= total;
    return u;
  }

  function generateBezier(pts, first, last, uPrime, t1, t2) {
    var nPts = last - first + 1, i;
    var A = [], C = [[0, 0], [0, 0]], X = [0, 0];

    for (i = 0; i < nPts; i++) {
      var u = uPrime[i], mt = 1 - u;
      A.push([mul(t1, 3 * u * mt * mt), mul(t2, 3 * mt * u * u)]);
    }
    for (i = 0; i < nPts; i++) {
      C[0][0] += dot(A[i][0], A[i][0]);
      C[0][1] += dot(A[i][0], A[i][1]);
      C[1][0] = C[0][1];
      C[1][1] += dot(A[i][1], A[i][1]);
      var u2 = uPrime[i], mt2 = 1 - u2;
      var tmp = sub(pts[first + i], [
        pts[first][0] * mt2 * mt2 * mt2 + pts[first][0] * 3 * mt2 * mt2 * u2 +
        pts[last][0] * 3 * mt2 * u2 * u2 + pts[last][0] * u2 * u2 * u2,
        pts[first][1] * mt2 * mt2 * mt2 + pts[first][1] * 3 * mt2 * mt2 * u2 +
        pts[last][1] * 3 * mt2 * u2 * u2 + pts[last][1] * u2 * u2 * u2
      ]);
      X[0] += dot(A[i][0], tmp);
      X[1] += dot(A[i][1], tmp);
    }

    var detC = C[0][0] * C[1][1] - C[1][0] * C[0][1];
    var detX0 = X[0] * C[1][1] - C[0][1] * X[1];
    var detX1 = C[0][0] * X[1] - X[0] * C[1][0];
    var a1 = detC === 0 ? 0 : detX0 / detC;
    var a2 = detC === 0 ? 0 : detX1 / detC;

    var segLen = len(sub(pts[last], pts[first]));
    var eps = 1e-6 * segLen;
    if (a1 < eps || a2 < eps) { a1 = a2 = segLen / 3; }

    return [pts[first], add(pts[first], mul(t1, a1)), add(pts[last], mul(t2, a2)), pts[last]];
  }

  function reparameterize(bez, pts, first, last, u) {
    var out = [];
    for (var i = first; i <= last; i++) {
      var t = u[i - first];
      var d = sub(bezierQ(bez, t), pts[i]);
      var d1 = bezierQPrime(bez, t), d2 = bezierQPrimePrime(bez, t);
      var num = d[0] * d1[0] + d[1] * d1[1];
      var den = d1[0] * d1[0] + d1[1] * d1[1] + d[0] * d2[0] + d[1] * d2[1];
      out.push(den === 0 ? t : t - num / den);
    }
    return out;
  }

  function computeMaxError(pts, first, last, bez, u) {
    var maxDist = 0, split = ((last - first + 1) / 2) | 0;
    for (var i = first + 1; i < last; i++) {
      var p = bezierQ(bez, u[i - first]);
      var d = sub(p, pts[i]);
      var dist = d[0] * d[0] + d[1] * d[1];
      if (dist >= maxDist) { maxDist = dist; split = i; }
    }
    return [maxDist, split];
  }

  function fitCubic(pts, first, last, t1, t2, errSq, out, depth) {
    if (last - first === 1) {
      var d = len(sub(pts[last], pts[first])) / 3;
      out.push([pts[first], add(pts[first], mul(t1, d)), add(pts[last], mul(t2, d)), pts[last]]);
      return;
    }
    var u = chordLengthParameterize(pts, first, last);
    var bez = generateBezier(pts, first, last, u, t1, t2);
    var res = computeMaxError(pts, first, last, bez, u);

    if (res[0] < errSq) { out.push(bez); return; }

    if (res[0] < errSq * 16 && depth < 24) {
      for (var i = 0; i < 12; i++) {
        var uPrime = reparameterize(bez, pts, first, last, u);
        bez = generateBezier(pts, first, last, uPrime, t1, t2);
        res = computeMaxError(pts, first, last, bez, uPrime);
        if (res[0] < errSq) { out.push(bez); return; }
        u = uPrime;
      }
    }
    if (depth > 24) { out.push(bez); return; }

    var split = res[1];
    if (split <= first) split = first + 1;
    if (split >= last) split = last - 1;
    var tC = norm(sub(pts[split - 1], pts[split + 1]));
    fitCubic(pts, first, split, t1, tC, errSq, out, depth + 1);
    fitCubic(pts, split, last, [-tC[0], -tC[1]], t2, errSq, out, depth + 1);
  }

  /* ملاءمة حلقة مغلقة، مع تقسيمها عند الزوايا الحادّة */
  function fitClosed(flat, error, cornerCos) {
    var n = flat.length / 2, i;
    var pts = new Array(n);
    for (i = 0; i < n; i++) pts[i] = [flat[i * 2], flat[i * 2 + 1]];

    /* إزالة النقاط المكرّرة المتتالية */
    var clean = [pts[0]];
    for (i = 1; i < n; i++) {
      var p = pts[i], q = clean[clean.length - 1];
      if (p[0] !== q[0] || p[1] !== q[1]) clean.push(p);
    }
    if (clean.length > 1) {
      var f = clean[0], l = clean[clean.length - 1];
      if (f[0] === l[0] && f[1] === l[1]) clean.pop();
    }
    pts = clean; n = pts.length;
    if (n < 3) return null;

    /* كشف الزوايا */
    var corners = [];
    for (i = 0; i < n; i++) {
      var a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
      var v1 = norm(sub(b, a)), v2 = norm(sub(c, b));
      if (dot(v1, v2) < cornerCos) corners.push(i);
    }

    var segs = [];
    var errSq = error * error;

    if (!corners.length) {
      /* حلقة ناعمة كاملة: نغلقها بإعادة أول نقطة في النهاية */
      var loop = pts.concat([pts[0]]);
      var tS = norm(sub(loop[1], loop[loop.length - 2]));
      fitCubic(loop, 0, loop.length - 1, tS, [-tS[0], -tS[1]], errSq, segs, 0);
      return segs;
    }

    for (var ci = 0; ci < corners.length; ci++) {
      var s = corners[ci], e = corners[(ci + 1) % corners.length];
      var chain = [];
      var idx = s;
      chain.push(pts[idx]);
      do { idx = (idx + 1) % n; chain.push(pts[idx]); } while (idx !== e);
      if (chain.length < 2) continue;
      var tA = norm(sub(chain[1], chain[0]));
      var tB = norm(sub(chain[chain.length - 2], chain[chain.length - 1]));
      fitCubic(chain, 0, chain.length - 1, tA, tB, errSq, segs, 0);
    }
    return segs;
  }

  V._fitClosed = fitClosed;
})(typeof self !== "undefined" ? self : window);

/* =========================================================
   المشغّل الرئيسي: بكسلات ➜ مستند SVG
   ========================================================= */
(function (root) {
  "use strict";
  var V = root.Vectorize;

  function fmt(v, p) {
    var s = v.toFixed(p);
    if (s.indexOf(".") > -1) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s === "-0" ? "0" : s;
  }
  function hex(c) {
    return "#" + ((1 << 24) + (c[0] << 16) + (c[1] << 8) + c[2]).toString(16).slice(1);
  }

  function polyToPath(flat, sx, sy, p) {
    var d = "M" + fmt(flat[0] * sx, p) + " " + fmt(flat[1] * sy, p);
    for (var i = 1; i < flat.length / 2; i++) {
      d += "L" + fmt(flat[i * 2] * sx, p) + " " + fmt(flat[i * 2 + 1] * sy, p);
    }
    return d + "Z";
  }
  function bezToPath(segs, sx, sy, p) {
    var s0 = segs[0][0];
    var d = "M" + fmt(s0[0] * sx, p) + " " + fmt(s0[1] * sy, p);
    for (var i = 0; i < segs.length; i++) {
      var b = segs[i];
      d += "C" + fmt(b[1][0] * sx, p) + " " + fmt(b[1][1] * sy, p) +
           " " + fmt(b[2][0] * sx, p) + " " + fmt(b[2][1] * sy, p) +
           " " + fmt(b[3][0] * sx, p) + " " + fmt(b[3][1] * sy, p);
    }
    return d + "Z";
  }

  /* ============ ملاءمة تدرّج خطّي لطبقة لون ============
     السبب الجذري للتشريط (banding) أن كل لون يُرسم مساحةً مسطّحة،
     فتظهر حدود حادّة بين الشرائح. هنا نستخرج من بكسلات الصورة
     الأصلية اتجاه تغيّر اللون داخل الطبقة ثم نبني تدرّجاً متعدّد
     المحطّات بمتوسّطات فعلية، فتتلاشى الحدود بين الشرائح.
       1) ملاءمة مستوٍ بالمربّعات الصغرى لكل قناة: v = A·x + B·y + C
       2) الاتجاه الرئيسي = المتجه الذاتي الأكبر لـ Σ (A,B)(A,B)ᵀ
       3) توزيع البكسلات على محطّات حسب إسقاطها على ذلك الاتجاه
          وأخذ متوسّط اللون الفعلي في كل محطّة                      */
  function fitGradient(data, w, list, from, to, sx, sy, id, minVar) {
    var m = to - from, i, c;
    if (m < 48) return null;                       // مساحة صغيرة: لون مسطّح أوفر

    var Sx = 0, Sy = 0, Sxx = 0, Sxy = 0, Syy = 0;
    var S = [0, 0, 0], Sxv = [0, 0, 0], Syv = [0, 0, 0];

    for (i = from; i < to; i++) {
      var p = list[i], x = p % w, y = (p / w) | 0, o = p * 4;
      Sx += x; Sy += y; Sxx += x * x; Sxy += x * y; Syy += y * y;
      S[0] += data[o]; S[1] += data[o + 1]; S[2] += data[o + 2];
      Sxv[0] += x * data[o]; Sxv[1] += x * data[o + 1]; Sxv[2] += x * data[o + 2];
      Syv[0] += y * data[o]; Syv[1] += y * data[o + 1]; Syv[2] += y * data[o + 2];
    }

    var N = m;
    var cxx = Sxx - Sx * Sx / N, cxy = Sxy - Sx * Sy / N, cyy = Syy - Sy * Sy / N;
    var det = cxx * cyy - cxy * cxy;
    if (!isFinite(det) || Math.abs(det) < 1e-9) return null;

    var A = [0, 0, 0], B = [0, 0, 0];
    for (c = 0; c < 3; c++) {
      var bx = Sxv[c] - Sx * S[c] / N, by = Syv[c] - Sy * S[c] / N;
      A[c] = ( cyy * bx - cxy * by) / det;
      B[c] = (-cxy * bx + cxx * by) / det;
    }

    var m00 = 0, m01 = 0, m11 = 0;
    for (c = 0; c < 3; c++) { m00 += A[c] * A[c]; m01 += A[c] * B[c]; m11 += B[c] * B[c]; }
    var tr = m00 + m11;
    if (tr < 1e-10) return null;                   // اللون ثابت فعلياً

    var disc = Math.sqrt(Math.max(0, (m00 - m11) * (m00 - m11) + 4 * m01 * m01));
    var lam = (tr + disc) / 2, dx, dy;
    if (Math.abs(m01) > 1e-14) { dx = lam - m11; dy = m01; }
    else if (m00 >= m11)       { dx = 1; dy = 0; }
    else                       { dx = 0; dy = 1; }
    var L = Math.sqrt(dx * dx + dy * dy);
    if (!L || !isFinite(L)) return null;
    dx /= L; dy /= L;

    /* توزيع البكسلات على محطّات على امتداد الاتجاه */
    var tmin = Infinity, tmax = -Infinity, t;
    for (i = from; i < to; i++) {
      var q = list[i];
      t = (q % w) * dx + ((q / w) | 0) * dy;
      if (t < tmin) tmin = t;
      if (t > tmax) tmax = t;
    }
    var span = tmax - tmin;
    if (!(span > 1)) return null;

    var NB = 16;
    var br = new Float64Array(NB), bg = new Float64Array(NB),
        bb = new Float64Array(NB), bn = new Float64Array(NB);
    for (i = from; i < to; i++) {
      var r2 = list[i], o2 = r2 * 4;
      t = ((r2 % w) * dx + ((r2 / w) | 0) * dy - tmin) / span;
      var k = Math.min(NB - 1, Math.floor(t * NB));
      br[k] += data[o2]; bg[k] += data[o2 + 1]; bb[k] += data[o2 + 2]; bn[k]++;
    }

    /* محطّات فارغة: تأخذ قيمة أقرب محطّة مأهولة */
    var cols = new Array(NB), last = null;
    for (i = 0; i < NB; i++) {
      if (bn[i]) {
        cols[i] = [br[i] / bn[i], bg[i] / bn[i], bb[i] / bn[i]];
        last = cols[i];
      } else cols[i] = null;
    }
    for (i = 0; i < NB; i++) if (!cols[i]) {
      var a2 = null, b2 = null, j;
      for (j = i - 1; j >= 0; j--) if (cols[j]) { a2 = cols[j]; break; }
      for (j = i + 1; j < NB; j++) if (cols[j]) { b2 = cols[j]; break; }
      cols[i] = a2 || b2 || last || [0, 0, 0];
    }

    /* إن كان التغيّر ضئيلاً فاللون المسطّح أوفر وأدق */
    var lo = [255, 255, 255], hi = [0, 0, 0];
    for (i = 0; i < NB; i++) for (c = 0; c < 3; c++) {
      if (cols[i][c] < lo[c]) lo[c] = cols[i][c];
      if (cols[i][c] > hi[c]) hi[c] = cols[i][c];
    }
    var vmax = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    /* عتبة منخفضة عمداً: شرائح التكميم الواحدة يتراوح مداها
       اللوني حول 3 وحدات فقط، ورفع العتبة يترك أغلبها مسطّحاً. */
    if (vmax < (minVar == null ? 1.2 : minVar)) return null;

    function hx(v) {
      var n2 = Math.max(0, Math.min(255, Math.round(v)));
      return (n2 < 16 ? "0" : "") + n2.toString(16);
    }

    /* المحطّات تقع في مراكز الشرائح، فيبقى طرفا التدرّج مسطّحين
       ويظهر أثرهما كخطوة صغيرة عند حدود الشرائح المتجاورة.
       نستقرئ لوني الطرفين 0 و 1 حتى تلتقي الشرائح بلا قفزة.      */
    var offs = [], cl = [];
    offs.push(0);
    cl.push([0, 1, 2].map(function (c2) {
      return cols[0][c2] - (cols[Math.min(1, NB - 1)][c2] - cols[0][c2]) * 0.5;
    }));
    for (i = 0; i < NB; i++) { offs.push((i + 0.5) / NB); cl.push(cols[i]); }
    offs.push(1);
    cl.push([0, 1, 2].map(function (c2) {
      return cols[NB - 1][c2] + (cols[NB - 1][c2] - cols[Math.max(0, NB - 2)][c2]) * 0.5;
    }));

    var stops = "", prev = null;
    for (i = 0; i < offs.length; i++) {
      var col = "#" + hx(cl[i][0]) + hx(cl[i][1]) + hx(cl[i][2]);
      if (col === prev && i > 0 && i < offs.length - 1) continue;   // دمج المتماثلة
      prev = col;
      stops += '<stop offset="' + offs[i].toFixed(4) + '" stop-color="' + col + '"/>';
    }

    var x1 = (dx * tmin * sx).toFixed(2), y1 = (dy * tmin * sy).toFixed(2),
        x2 = (dx * tmax * sx).toFixed(2), y2 = (dy * tmax * sy).toFixed(2);

    /* جدول بحث بنفس استيفاء SVG الخطّي، تستعمله المعاينة كي تطابق
       الملف المُنزَّل بدل أن تعرض شيئاً آخر.                        */
    var LUT = 128, lut = new Uint8Array(LUT * 3);
    for (var qq = 0; qq < LUT; qq++) {
      var tq = qq / (LUT - 1), si = 0;
      while (si < offs.length - 2 && offs[si + 1] < tq) si++;
      var t0 = offs[si], t1 = offs[si + 1];
      var fq = (t1 > t0) ? (tq - t0) / (t1 - t0) : 0;
      for (c = 0; c < 3; c++) {
        var vq = cl[si][c] + (cl[si + 1][c] - cl[si][c]) * fq;
        lut[qq * 3 + c] = Math.max(0, Math.min(255, Math.round(vq)));
      }
    }

    return {
      id: id,
      dx: dx, dy: dy, tmin: tmin, span: span, lut: lut, lutN: LUT,
      def: '<linearGradient id="' + id + '" gradientUnits="userSpaceOnUse" x1="' + x1 +
           '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '">' + stops + '</linearGradient>'
    };
  }

  V._fitGradient = fitGradient;

  /* opts:
     mode: "color" | "gray" | "bw"
     colors, threshold, blur, simplify, curveError, smooth,
     minArea, precision, transparentBg                      */
  function run(input, opts, progress) {
    var t0 = (root.performance || Date).now();
    var w = input.width, h = input.height;
    var origW = input.origWidth || w, origH = input.origHeight || h;
    var data = input.data;
    var P = progress || function () {};

    opts = opts || {};
    var mode      = opts.mode || "color";
    var K         = Math.max(2, Math.min(256, opts.colors || 16));
    var blurR     = Math.max(0, Math.min(6, opts.blur || 0));
    var simplify  = opts.simplify == null ? 0.8 : opts.simplify;
    var curveErr  = opts.curveError == null ? 0.9 : opts.curveError;
    var smooth    = opts.smooth !== false;
    var minArea   = opts.minArea == null ? 2 : opts.minArea;
    var prec      = opts.precision == null ? 2 : opts.precision;
    var alphaMin  = opts.alphaMin == null ? 128 : opts.alphaMin;
    var cornerCos = Math.cos((opts.cornerAngle == null ? 75 : opts.cornerAngle) * Math.PI / 180);

    /* وضع «طبق الأصل»: كل تفصيلة تُحفظ كما هي — لا تكميم ولا تمويه
       ولا تبسيط ولا منحنيات ولا حذف بقع ولا توسيع حدود.            */
    /* التدرّجات: مطفأة في الأنماط التي لا معنى لها فيها */
    var gradients = opts.gradients !== false && mode !== "bw" && mode !== "exact";

    var exact = mode === "exact";
    if (exact) {
      blurR = 0; simplify = 0; smooth = false; minArea = 0; prec = 0;
    }

    P(4, "تحضير البكسلات");
    if (blurR) V._boxBlur(data, w, h, blurR);

    var i, n = w * h;
    var idx, palette, counts;

    if (exact) {
      /* فهرس لكل لون RGBA فريد في الصورة، بلا أي فقدان */
      P(10, "فهرسة الألوان الفعلية");
      var map = new Map();
      var pal = [], cnts = [];
      idx = new Int32Array(n);
      for (i = 0; i < n; i++) {
        var A = data[i * 4 + 3];
        if (A === 0) { idx[i] = -1; continue; }
        var key = (data[i * 4] << 24 | data[i * 4 + 1] << 16 | data[i * 4 + 2] << 8 | A) >>> 0;
        var vi = map.get(key);
        if (vi === undefined) {
          vi = pal.length;
          map.set(key, vi);
          pal.push([data[i * 4], data[i * 4 + 1], data[i * 4 + 2], A]);
          cnts.push(0);
        }
        idx[i] = vi; cnts[vi]++;
      }
      palette = pal; counts = cnts;
    } else if (mode === "bw") {
      var th = opts.threshold == null ? 128 : opts.threshold;
      idx = new Int16Array(n);
      counts = new Int32Array(2);
      for (i = 0; i < n; i++) {
        if (data[i * 4 + 3] < alphaMin) { idx[i] = -1; continue; }
        var lum = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
        var b = lum < th ? 0 : 1;
        idx[i] = b; counts[b]++;
      }
      palette = [[0, 0, 0], [255, 255, 255]];
    } else {
      if (mode === "gray") {
        for (i = 0; i < n; i++) {
          var g = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
          data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = g;
        }
      }
      /* اختيار تلقائي لعدد الألوان حسب غنى الصورة:
         الشعارات تكتفي بعشرات، والصور الفوتوغرافية تحتاج مئات
         وإلا ظهر التشريط مهما فُعّلت التدرّجات.                  */
      if (opts.autoColors) {
        P(7, "تقدير غنى الألوان");
        var seen = new Uint8Array(32768), rich = 0;
        var stepA = Math.max(1, Math.floor(n / 20000));
        for (i = 0; i < n; i += stepA) {
          if (data[i * 4 + 3] < alphaMin) continue;
          var k5 = ((data[i * 4] >> 3) << 10) | ((data[i * 4 + 1] >> 3) << 5) | (data[i * 4 + 2] >> 3);
          if (!seen[k5]) { seen[k5] = 1; rich++; }
        }
        /* القسمة على 2 سخيّة عمداً: التشريط يظهر حتى في الصور
           قليلة الأطياف إن كانت تدرّجاتها ناعمة وواسعة. */
        K = Math.max(16, Math.min(256, Math.round(rich / 2)));
      }
      P(10, "تكميم الألوان (" + K + " لوناً)");
      var q = V._quantize(data, w, h, K, alphaMin);
      idx = q.idx; palette = q.palette; counts = q.counts;
    }

    /* ترتيب الطبقات: الأكبر مساحةً في الأسفل */
    var order = [];
    for (i = 0; i < palette.length; i++) if (counts[i] > 0) order.push(i);
    order.sort(function (a, b) { return counts[b] - counts[a]; });

    /* رُتب الألوان: نحتاجها للطبقات المتراكمة */
    var rank = new Int32Array(palette.length).fill(-1);
    for (i = 0; i < order.length; i++) rank[order[i]] = i;

    /* معالجة الفواصل الشعرية بين الألوان:
         hairline = حدّ رفيع بلون التعبئة يغطّي الشعرة (الأدق والأخف)
         stacked  = كل طبقة تضمّ لونها وكل ما فوقه فتغطّي ما تحتها
         none     = طبقات منفصلة كما هي                              */
    var seam = exact ? "none" : (opts.seam || "hairline");
    var seamW = opts.seamWidth == null ? 0.12 : opts.seamWidth;
    var stacked = seam === "stacked";
    var startAt = (opts.transparentBg && order.length > 1) ? 1 : 0;

    var sx = origW / w, sy = origH / h;
    var tracer = new V._Tracer(w, h);
    var paths = [], gradDefs = [], gradInfo = [], nodes = 0, contours = 0;

    /* الطبقات المنفصلة تُتتبَّع من قوائم بكسلاتها (ترتيب عدّي O(n))
       بدل مسح الصورة كاملةً لكل لون — ضروري مع آلاف الألوان.       */
    var mask = null, sorted = null, off = null;
    if (stacked) mask = new Uint8Array(n);
    if (!stacked || gradients) {
      off = new Int32Array(palette.length + 1);
      for (i = 0; i < n; i++) if (idx[i] >= 0) off[idx[i] + 1]++;
      for (i = 0; i < palette.length; i++) off[i + 1] += off[i];
      var cursor = new Int32Array(palette.length);
      for (i = 0; i < palette.length; i++) cursor[i] = off[i];
      sorted = new Int32Array(off[palette.length]);
      for (i = 0; i < n; i++) { var ck = idx[i]; if (ck >= 0) sorted[cursor[ck]++] = i; }
    }

    var reportEvery = Math.max(1, Math.round(order.length / 40));
    for (var oi = startAt; oi < order.length; oi++) {
      var ci = order[oi];
      /* مع آلاف الطبقات لا نرسل تقدّماً لكل واحدة */
      if (oi % reportEvery === 0) {
        P(20 + Math.round(70 * oi / order.length),
          "تتبّع الطبقة " + (oi + 1) + "/" + order.length);
      }

      var polys;
      if (stacked) {
        for (i = 0; i < n; i++) mask[i] = (idx[i] >= 0 && rank[idx[i]] >= oi) ? 1 : 0;
        polys = tracer.trace(mask);
      } else {
        polys = tracer.traceList(idx, ci, sorted, off[ci], off[ci + 1]);
      }
      if (!polys.length) continue;

      var d = "";
      for (var pi = 0; pi < polys.length; pi++) {
        var poly = polys[pi];
        if (Math.abs(V._polyArea(poly)) < minArea) continue;

        var simp = V._simplifyClosed(poly, simplify);
        if (simp.length < 6) continue;

        if (smooth) {
          var segs = V._fitClosed(simp, curveErr, cornerCos);
          if (!segs || !segs.length) continue;
          d += bezToPath(segs, sx, sy, prec);
          nodes += segs.length;
        } else {
          d += polyToPath(simp, sx, sy, prec);
          nodes += simp.length / 2;
        }
        contours++;
      }
      if (d) {
        var flat = hex(palette[ci]), paint = flat;
        if (gradients) {
          var gr = V._fitGradient(data, w, sorted, off[ci], off[ci + 1],
                                  sx, sy, "g" + ci, opts.gradientMinVar);
          if (gr) { gradDefs.push(gr.def); gradInfo[ci] = gr; paint = "url(#" + gr.id + ")"; }
        }
        paths.push({
          fill: paint, color: flat,
          alpha: palette[ci].length > 3 ? palette[ci][3] : 255,
          d: d, count: counts[ci]
        });
      }
    }

    /* ---- معاينة نقطية جاهزة للعرض ----
       تُبنى من الفهرس واللوحة، أي أنها تمثّل ما يرمّزه الـ SVG تماماً،
       فيستطيع الخيط الرئيسي عرض نتيجة أي صورة مهما كبرت بلا تجمّد.  */
    var preview = null;
    if (opts.preview) {
      P(92, "تجهيز المعاينة");
      var pcap = opts.preview;
      var ps = Math.max(w, h) > pcap ? pcap / Math.max(w, h) : 1;
      var pw = Math.max(1, Math.round(w * ps)), ph = Math.max(1, Math.round(h * ps));
      var pd = new Uint8ClampedArray(pw * ph * 4);
      var dropped = startAt > 0 ? order[0] : -1;
      for (var py = 0; py < ph; py++) {
        var syy = Math.min(h - 1, Math.floor(py / ps));
        for (var px = 0; px < pw; px++) {
          var sxx = Math.min(w - 1, Math.floor(px / ps));
          var pi2 = syy * w + sxx, pc = idx[pi2], po = (py * pw + px) * 4;
          if (pc < 0 || pc === dropped) continue;      // شفاف
          var pcol = palette[pc];
          var gi = gradInfo[pc];
          if (gi) {
            /* نفس حساب linearGradient في SVG، فتطابق المعاينة الملف */
            var tt = (sxx * gi.dx + syy * gi.dy - gi.tmin) / gi.span;
            tt = tt < 0 ? 0 : (tt > 1 ? 1 : tt);
            var qi = Math.round(tt * (gi.lutN - 1)) * 3;
            pd[po] = gi.lut[qi]; pd[po + 1] = gi.lut[qi + 1]; pd[po + 2] = gi.lut[qi + 2];
          } else {
            pd[po] = pcol[0]; pd[po + 1] = pcol[1]; pd[po + 2] = pcol[2];
          }
          pd[po + 3] = pcol.length > 3 ? pcol[3] : 255;
        }
      }
      preview = { data: pd, width: pw, height: ph };
    }

    var edge = (seam === "hairline")
      ? function (c) { return ' stroke="' + c + '" stroke-width="' + seamW + '" stroke-linejoin="round"'; }
      : function () { return ""; };

    P(94, "بناء ملف SVG");
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + origW + ' ' + origH +
              '" width="' + origW + '" height="' + origH + '"' +
              /* المحاذاة الحادّة تُسقط التنعيم فتُرسم كل بكسل كما هو تماماً */
              (exact ? ' shape-rendering="crispEdges"' : '') + '>\n';
    if (gradDefs.length) svg += "<defs>" + gradDefs.join("") + "</defs>\n";
    for (i = 0; i < paths.length; i++) {
      svg += '<path fill="' + paths[i].fill + '" fill-rule="evenodd"' +
             (paths[i].alpha < 255 ? ' fill-opacity="' + (paths[i].alpha / 255).toFixed(4) + '"' : '') +
             edge(paths[i].fill) +
             ' d="' + paths[i].d + '"/>\n';
    }
    svg += '</svg>';

    P(100, "تم");
    return {
      svg: svg,
      preview: preview,
      stats: {
        paths: paths.length,
        contours: contours,
        nodes: nodes,
        colors: paths.length,
        uniqueColors: palette.length,
        colorsUsed: K,
        gradients: gradDefs.length,
        exact: exact,
        bytes: svg.length,
        ms: Math.round(((root.performance || Date).now()) - t0),
        width: origW, height: origH,
        traceWidth: w, traceHeight: h
      },
      /* عيّنة من اللوحة فقط — قد تبلغ الألوان مئات الآلاف في الوضع الدقيق */
      palette: paths.slice(0, 256).map(function (p) { return { color: p.color, count: p.count }; })
    };
  }

  V.run = run;
})(typeof self !== "undefined" ? self : window);
