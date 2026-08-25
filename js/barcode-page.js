/* =========================================================
   منطق صفحة «مولّد الباركود»  (pages/barcode.html)
   ---------------------------------------------------------
   يحمّل محرّكيه عند الحاجة (qrcode.js و barcode1d.js)، ثم
   يرسم على canvas ويصدّر PNG و SVG. حالته كلها محليّة،
   ويحرّر موارده عند pageleave.
   ========================================================= */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  if (!$('bc-canvas')) return;          // غادر المستخدم قبل اكتمال التحميل

  /* ---------- تحميل المحرّكات مرة واحدة ---------- */
  var LOADED = (window.__bcLoaded = window.__bcLoaded || {});
  function need(src, global) {
    if (window[global]) return Promise.resolve();
    if (LOADED[src]) return LOADED[src];
    LOADED[src] = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { res(); };
      s.onerror = function () { rej(new Error('تعذّر تحميل ' + src)); };
      document.head.appendChild(s);
    });
    return LOADED[src];
  }

  var canvas = $('bc-canvas'), statusEl = $('bc-status'),
      statsEl = $('bc-stats'), notices = $('bc-notices');

  var kind = 'qr', logoImg = null, logoURL = null, logoName = '',
      lastSVG = '', lastType = 'qr', timer = null, alive = true;

  function say(t) { statusEl.textContent = t; }

  function note(html, warn) {
    var b = document.createElement('div');
    b.className = 'notice' + (warn ? ' warn' : '');
    b.innerHTML = '<span>' + html + '</span>';
    notices.appendChild(b);
    return b;
  }

  /* ---------- ربط المنزلقات ---------- */
  [['qr-scale', 0], ['qr-margin', 0], ['logo-size', 0], ['logo-pad', 0],
   ['bar-mw', 0], ['bar-h', 0]].forEach(function (p) {
    var el = $(p[0]), lab = $('v-' + p[0]);
    el.addEventListener('input', function () { lab.textContent = el.value; schedule(); });
    lab.textContent = el.value;
  });

  ['qr-text', 'bar-text'].forEach(function (id) {
    $(id).addEventListener('input', schedule);
  });
  ['qr-ecl', 'qr-fg', 'qr-bg', 'qr-transparent', 'logo-round',
   'bar-type', 'bar-fg', 'bar-bg', 'bar-showtext'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      if (id === 'bar-type') updateBarHint();
      schedule();
    });
  });

  /* ---------- تبديل النوع ---------- */
  $('kind').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-k]');
    if (!b) return;
    kind = b.dataset.k;
    $('kind').querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
    $('qr-panel').hidden = kind !== 'qr';
    $('bar-panel').hidden = kind !== 'bar';
    render();
  });

  function updateBarHint() {
    var t = $('bar-type').value, el = $('bar-hint'), inp = $('bar-text');
    if (t === 'ean13') { el.textContent = '١٢ رقماً، ورقم التحقّق يُحسب تلقائياً.'; inp.value = digitsOnly(inp.value, 12) || '000000000000'; }
    else if (t === 'ean8') { el.textContent = '٧ أرقام، ورقم التحقّق يُحسب تلقائياً.'; inp.value = digitsOnly(inp.value, 7) || '0000000'; }
    else if (t === 'upca') { el.textContent = '١١ رقماً، ورقم التحقّق يُحسب تلقائياً.'; inp.value = digitsOnly(inp.value, 11) || '00000000000'; }
    else { el.textContent = 'أي نص بمحارف ASCII المطبوعة؛ يبدّل تلقائياً بين النمطين B و C.'; }
  }
  function digitsOnly(s, n) { return String(s).replace(/\D/g, '').slice(0, n); }

  /* ---------- الشعار ---------- */
  var logoDrop = $('logo-drop'), logoFile = $('logo-file');
  logoDrop.addEventListener('click', function () { logoFile.click(); });
  logoFile.addEventListener('change', function () { if (logoFile.files[0]) loadLogo(logoFile.files[0]); });
  ['dragenter', 'dragover'].forEach(function (t) {
    logoDrop.addEventListener(t, function (e) { e.preventDefault(); logoDrop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    logoDrop.addEventListener(t, function (e) { e.preventDefault(); logoDrop.classList.remove('over'); });
  });
  logoDrop.addEventListener('drop', function (e) {
    var f = e.dataTransfer.files[0];
    if (f) loadLogo(f);
  });
  $('logo-clear').addEventListener('click', clearLogo);

  function loadLogo(f) {
    if (!f || f.type.indexOf('image') !== 0) { say('ملف الشعار ليس صورة.'); return; }
    var fr = new FileReader();
    fr.onload = function () {
      var im = new Image();
      im.onload = function () {
        logoImg = im; logoURL = fr.result; logoName = f.name;
        $('logo-thumb').src = logoURL;
        $('logo-name').textContent = f.name;
        $('logo-info').hidden = false;
        $('f-logo-size').hidden = false;
        $('f-logo-pad').hidden = false;
        /* الشعار يحجب وحدات، فالتصحيح H هو الخيار الآمن */
        var raised = $('qr-ecl').value !== 'H';
        if (raised) $('qr-ecl').value = 'H';
        render();                                  // render يمسح التنبيهات أولاً
        if (raised) note('رُفع مستوى التصحيح إلى <b>H</b> تلقائياً كي يبقى الرمز قابلاً للقراءة مع الشعار.');
      };
      im.onerror = function () { say('تعذّر قراءة صورة الشعار.'); };
      im.src = fr.result;
    };
    fr.readAsDataURL(f);
  }

  function clearLogo() {
    logoImg = null; logoURL = null; logoName = '';
    $('logo-info').hidden = true;
    $('f-logo-size').hidden = true;
    $('f-logo-pad').hidden = true;
    logoFile.value = '';
    render();
  }

  /* ---------- الرسم ---------- */
  function schedule() { clearTimeout(timer); timer = setTimeout(render, 180); }

  function render() {
    if (!alive) return;
    notices.innerHTML = '';
    if (kind === 'qr') {
      need('js/qrcode.js', 'QRCode').then(renderQR).catch(function (e) { say(e.message); });
    } else {
      need('js/barcode1d.js', 'Barcode1D').then(renderBar).catch(function (e) { say(e.message); });
    }
  }

  /* ===== رمز QR ===== */
  function qrOpts() {
    return {
      scale: +$('qr-scale').value,
      margin: +$('qr-margin').value,
      fg: $('qr-fg').value,
      bg: $('qr-transparent').checked ? null : $('qr-bg').value,
      logoPct: +$('logo-size').value / 100,
      logoPad: +$('logo-pad').value,
      logoRound: $('logo-round').checked
    };
  }

  function renderQR() {
    var text = $('qr-text').value;
    if (!text) { say('أدخل نصاً أو رابطاً.'); clearCanvas(); return; }

    var qr;
    try { qr = QRCode.encode(text, { ecl: $('qr-ecl').value }); }
    catch (e) { say(e.message); clearCanvas(); return; }

    var o = qrOpts();
    var size = qr.size, W = (size + o.margin * 2) * o.scale;
    canvas.width = W; canvas.height = W;
    var ctx = canvas.getContext('2d');

    if (o.bg) { ctx.fillStyle = o.bg; ctx.fillRect(0, 0, W, W); }
    else ctx.clearRect(0, 0, W, W);

    ctx.fillStyle = o.fg;
    for (var y = 0; y < size; y++) {
      var row = qr.modules[y];
      for (var x = 0; x < size; x++) {
        if (!row[x]) continue;
        /* دمج الوحدات المتتالية أفقياً يقلّل عدد عمليات الرسم */
        var run = 1;
        while (x + run < size && row[x + run]) run++;
        ctx.fillRect((o.margin + x) * o.scale, (o.margin + y) * o.scale, run * o.scale, o.scale);
        x += run - 1;
      }
    }

    var logoBox = null;
    if (logoImg) logoBox = drawLogo(ctx, W, o);

    lastSVG = qrSVG(qr, o, logoBox);
    lastType = 'qr';

    stats([
      ['النوع', 'QR'], ['الإصدار', qr.version], ['الوحدات', size + '×' + size],
      ['التصحيح', qr.ecl], ['القناع', qr.mask], ['البايتات', qr.bytes],
      ['أبعاد الصورة', W + '×' + W]
    ]);
    say('تم إنشاء رمز QR — الإصدار ' + qr.version + ' (' + size + '×' + size + ' وحدة).');

    if (logoImg && o.logoPct > 0.27)
      note('الشعار يغطّي أكثر من ٢٧٪ من الرمز — اختبر قراءته قبل الاعتماد عليه.', true);
  }

  function drawLogo(ctx, W, o) {
    var side = Math.round(W * o.logoPct);
    var x = Math.round((W - side) / 2), y = x;
    var pad = o.logoPad;
    var bx = x - pad, by = y - pad, bs = side + pad * 2;

    if (pad > 0) {
      ctx.fillStyle = o.bg || '#ffffff';
      if (o.logoRound) {
        var r = bs / 2 * 0.35;
        roundRect(ctx, bx, by, bs, bs, r);
        ctx.fill();
      } else ctx.fillRect(bx, by, bs, bs);
    }

    /* الحفاظ على نسبة أبعاد الشعار */
    var iw = logoImg.naturalWidth, ih = logoImg.naturalHeight;
    var sc = Math.min(side / iw, side / ih);
    var dw = iw * sc, dh = ih * sc;
    var dx = x + (side - dw) / 2, dy = y + (side - dh) / 2;
    ctx.drawImage(logoImg, dx, dy, dw, dh);

    return { x: dx, y: dy, w: dw, h: dh, bx: bx, by: by, bs: bs, pad: pad, round: o.logoRound };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function qrSVG(qr, o, logoBox) {
    var size = qr.size, W = (size + o.margin * 2) * o.scale;
    var s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + W +
            '" width="' + W + '" height="' + W + '" shape-rendering="crispEdges">\n';
    if (o.bg) s += '<rect width="' + W + '" height="' + W + '" fill="' + o.bg + '"/>\n';

    var d = '';
    for (var y = 0; y < size; y++) {
      var row = qr.modules[y];
      for (var x = 0; x < size; x++) {
        if (!row[x]) continue;
        var run = 1;
        while (x + run < size && row[x + run]) run++;
        d += 'M' + (o.margin + x) * o.scale + ' ' + (o.margin + y) * o.scale +
             'h' + run * o.scale + 'v' + o.scale + 'h' + (-run * o.scale) + 'Z';
        x += run - 1;
      }
    }
    s += '<path fill="' + o.fg + '" d="' + d + '"/>\n';

    if (logoBox && logoURL) {
      if (logoBox.pad > 0) {
        var rr = logoBox.round ? (logoBox.bs / 2 * 0.35) : 0;
        s += '<rect x="' + logoBox.bx + '" y="' + logoBox.by + '" width="' + logoBox.bs +
             '" height="' + logoBox.bs + '" rx="' + rr.toFixed(1) + '" fill="' + (o.bg || '#ffffff') + '"/>\n';
      }
      s += '<image x="' + logoBox.x.toFixed(1) + '" y="' + logoBox.y.toFixed(1) +
           '" width="' + logoBox.w.toFixed(1) + '" height="' + logoBox.h.toFixed(1) +
           '" href="' + logoURL + '" preserveAspectRatio="xMidYMid meet"/>\n';
    }
    return s + '</svg>';
  }

  /* ===== الباركود الشريطي ===== */
  function renderBar() {
    var type = $('bar-type').value;
    var opt = {
      moduleWidth: +$('bar-mw').value,
      height: +$('bar-h').value,
      showText: $('bar-showtext').checked,
      foreground: $('bar-fg').value,
      background: $('bar-bg').value
    };
    var data;
    try { data = Barcode1D.build(type, $('bar-text').value); }
    catch (e) { say(e.message); clearCanvas(); statsEl.innerHTML = ''; return; }

    var dim = Barcode1D.draw(canvas, data, opt);
    lastSVG = Barcode1D.toSVG(data, opt);
    lastType = 'bar';

    stats([
      ['المعيار', data.type], ['القيمة', data.value],
      ['الوحدات', data.bits.length], ['أبعاد الصورة', dim.width + '×' + dim.height]
    ]);
    say('تم إنشاء باركود ' + data.type + ' — ' + data.value);
  }

  function clearCanvas() {
    canvas.width = 320; canvas.height = 160;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 320, 160);
    lastSVG = '';
  }

  function stats(rows) {
    statsEl.innerHTML = '';
    rows.forEach(function (p) {
      var d = document.createElement('div');
      d.className = 'stat';
      d.innerHTML = '<span>' + p[0] + '</span><b>' + p[1] + '</b>';
      statsEl.appendChild(d);
    });
  }

  /* ---------- التصدير ---------- */
  function baseName() {
    if (kind === 'qr') return 'qrcode';
    return $('bar-type').value + '-' + (String($('bar-text').value).replace(/[^\w-]+/g, '_') || 'code');
  }

  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
    note('<b>تم التنزيل ✓</b> ' + name + ' · ' + Math.round(blob.size / 1024) + ' ك.ب');
  }

  $('bc-png').addEventListener('click', function () {
    canvas.toBlob(function (b) {
      if (!b) { note('تعذّر إنتاج ملف PNG.', true); return; }
      saveBlob(b, baseName() + '.png');
    }, 'image/png');
  });

  $('bc-svg').addEventListener('click', function () {
    if (!lastSVG) { note('لا يوجد رمز لتنزيله.', true); return; }
    saveBlob(new Blob([lastSVG], { type: 'image/svg+xml' }), baseName() + '.svg');
  });

  $('bc-copy').addEventListener('click', function () {
    if (!navigator.clipboard || !window.ClipboardItem) { note('المتصفح لا يدعم نسخ الصور.', true); return; }
    canvas.toBlob(function (b) {
      navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]).then(
        function () { note('نُسخت الصورة إلى الحافظة ✓'); },
        function () { note('تعذّر النسخ إلى الحافظة.', true); }
      );
    }, 'image/png');
  });

  /* ---------- التنظيف ---------- */
  document.addEventListener('pageleave', function cleanup() {
    document.removeEventListener('pageleave', cleanup);
    alive = false;
    clearTimeout(timer);
  });

  updateBarHint();
  render();
})();
