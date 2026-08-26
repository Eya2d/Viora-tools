/* =========================================================
   منطق صفحة «تحويل الصور إلى SVG»  (pages/code.html)
   ---------------------------------------------------------
   يُعاد تنفيذ هذا الملف كلّما حُمّلت الصفحة داخل التطبيق،
   فكل حالته محليّة داخل الدالة، ويُحرّر موارده عند pageleave.
   ========================================================= */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  /* الملف الخارجي يُحمَّل بعد حقن الصفحة؛ إن غادرها المستخدم
     قبل ذلك فلا وجود لعناصرها ولا داعي لتشغيل أي شيء. */
  if (!$('drop')) return;
  var drop = $('drop'), file = $('file'), stage = $('stage'), statusEl = $('status'),
      bar = $('bar'), go = $('go'), cancelBtn = $('cancel'), dl = $('dl'), cp = $('cp'),
      out = $('out'), statsEl = $('stats'), swatches = $('swatches'),
      viewSeg = $('view'), notices = $('notices'), colorBtn = $('color-file');

  /* حدّ عرض الـ SVG الحقيقي: فوقه نعرض معاينة نقطية بدلاً منه، لأن
     رسم عشرات آلاف المسارات يجمّد الخيط الرئيسي مهما كان الجهاز.  */
  var HEAVY_BYTES = 2 * 1024 * 1024, HEAVY_PATHS = 4000;

  /* فكّ الترميز داخل العامل متاح؟ وإلا نرجع للمسار القديم */
  var WORKER_DECODE = typeof OffscreenCanvas !== 'undefined' &&
                      typeof createImageBitmap === 'function';

  var srcFile = null, img = null, imgURL = null, svgBlob = null, svgURL = null,
      previewData = null, lastStats = null, lastPalette = [], heavy = false,
      forceExact = false, worker = null, view = 'svg', timer = null, busy = false;

  /* ---------- المنزلقات ---------- */
  var sliders = { colors: 0, threshold: 0, simplify: 1, curve: 1, corner: 0, blur: 0, minarea: 0 };
  Object.keys(sliders).forEach(function (id) {
    var el = $(id), lab = $('v-' + id);
    el._show = function () {
      lab.textContent = (+el.value).toFixed(sliders[id]) + (id === 'corner' ? '°' : '');
    };
    el.addEventListener('input', function () { el._show(); schedule(); });
    el._show();
  });

  /* الإعداد الافتراضي = أقصى تفصيل، يُطبَّق تلقائياً مع كل صورة جديدة */
  var PRESET = { colors: 64, simplify: 0, curve: 0.1, corner: 75, blur: 0, minarea: 0,
                 threshold: 128, seam: 'hairline', gradients: true, smooth: true,
                 transbg: false, autocolors: true };

  function applyPreset() {
    Object.keys(sliders).forEach(function (id) {
      if (PRESET[id] === undefined) return;
      var el = $(id);
      el.value = PRESET[id];
      el._show();
    });
    $('seam').value = PRESET.seam;
    $('gradients').checked = PRESET.gradients;
    $('autocolors').checked = PRESET.autocolors;
    $('colors').disabled = PRESET.autocolors;
    $('smooth').checked = PRESET.smooth;
    $('transbg').checked = PRESET.transbg;
  }

  /* ---------- إظهار ما يخصّ كل نمط ---------- */
  function applyMode() {
    var m = $('mode').value, bw = m === 'bw', ex = m === 'exact';
    $('f-threshold').hidden = !bw;
    $('f-colors').hidden = bw || ex;
    ['f-simplify', 'f-curve', 'f-corner', 'f-blur', 'f-minarea', 'f-seam', 'f-maxdim']
      .forEach(function (fid) { $(fid).hidden = ex; });
    $('c-smooth').hidden = ex;
    $('c-grad').hidden = ex || bw;
    $('c-transbg').hidden = ex;
    $('exact-note').hidden = !ex;
    if (ex) $('maxdim').value = '0';
  }

  ['mode', 'maxdim', 'seam', 'gradients', 'smooth', 'transbg', 'autocolors'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      if (id === 'mode') { applyMode(); forceExact = false; }
      if (id === 'autocolors') $('colors').disabled = $('autocolors').checked;
      schedule();
    });
  });
  applyMode();

  go.addEventListener('click', function () { start(); });
  cancelBtn.addEventListener('click', function () { abort('أُلغيت العملية.'); });

  /* ---------- استقبال الصورة ---------- */
  drop.addEventListener('click', function () { file.click(); });
  file.addEventListener('change', function () { if (file.files[0]) load(file.files[0]); });

  ['dragenter', 'dragover'].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) {
    var f = e.dataTransfer.files[0];
    if (f) load(f);
  });

  function onPaste(e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') === 0) { load(items[i].getAsFile()); break; }
    }
  }
  document.addEventListener('paste', onPaste);

  function load(f) {
    if (!f || f.type.indexOf('image') !== 0) { say('الملف ليس صورة.'); return; }
    if (imgURL) URL.revokeObjectURL(imgURL);

    srcFile = f;
    forceExact = false;
    imgURL = URL.createObjectURL(f);

    var im = new Image();
    im.onload = function () {
      img = im;
      go.disabled = false;
      applyPreset();                       // إعدادات أقصى تفصيل مع كل صورة
      say('الصورة: ' + im.naturalWidth + '×' + im.naturalHeight + ' بكسل');
      if (view === 'img') showImage();
      start();
    };
    im.onerror = function () { say('تعذّر قراءة الصورة.'); };
    im.src = imgURL;
  }

  /* ---------- التشغيل ---------- */
  function schedule() {
    if (!srcFile || !$('auto').checked) return;
    clearTimeout(timer);
    timer = setTimeout(start, 420);
  }

  function opts() {
    return {
      mode: $('mode').value,
      colors: +$('colors').value,
      autoColors: $('autocolors').checked,
      threshold: +$('threshold').value,
      simplify: +$('simplify').value,
      curveError: +$('curve').value,
      cornerAngle: +$('corner').value,
      blur: +$('blur').value,
      minArea: +$('minarea').value,
      gradients: $('gradients').checked,
      smooth: $('smooth').checked,
      seam: $('seam').value,
      transparentBg: $('transbg').checked,
      precision: 2,
      preview: 1800
    };
  }

  /* أي طلب جديد يُنهي السابق فوراً بدل انتظاره */
  function abort(msg) {
    if (worker) { worker.terminate(); worker = null; }
    busy = false;
    cancelBtn.classList.remove('on');
    if (msg) progress(0, msg);
  }

  function start() {
    if (!srcFile) return;
    clearTimeout(timer);
    if (busy) abort(null);

    busy = true;
    cancelBtn.classList.add('on');
    notices.innerHTML = '';
    progress(3, 'بدء المعالجة…');

    var cap = +$('maxdim').value;
    ensureWorker();

    if (WORKER_DECODE) {
      /* الملف نفسه يُسلَّم للعامل: لا فكّ ترميز ولا canvas على الخيط الرئيسي */
      worker.postMessage({
        cmd: 'run', file: srcFile, maxDim: cap,
        opts: opts(), force: forceExact, maxUnique: 20000
      });
    } else {
      legacyDispatch(cap);
    }
  }

  /* مسار احتياطي للمتصفحات القديمة (بلا OffscreenCanvas) */
  function legacyDispatch(cap) {
    if (!img) { busy = false; return; }
    var ow = img.naturalWidth, oh = img.naturalHeight;
    var scale = (cap && Math.max(ow, oh) > cap) ? cap / Math.max(ow, oh) : 1;
    var w = Math.max(1, Math.round(ow * scale)), h = Math.max(1, Math.round(oh * scale));

    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);

    var id;
    try { id = ctx.getImageData(0, 0, w, h); }
    catch (err) { abort('تعذّر قراءة بكسلات الصورة: ' + err.message); return; }

    worker.postMessage({
      cmd: 'run', data: id.data, width: w, height: h,
      origWidth: ow, origHeight: oh,
      opts: opts(), force: forceExact, maxUnique: 20000
    }, [id.data.buffer]);
  }

  function ensureWorker() {
    if (worker) return;
    worker = new Worker('js/vector-worker.js');
    worker.onmessage = function (e) {
      var m = e.data;
      if (m.type === 'progress') { progress(m.pct, m.label + '…'); return; }

      busy = false;
      cancelBtn.classList.remove('on');

      if (m.type === 'error') { progress(0, 'خطأ: ' + m.message); return; }
      if (m.type === 'toobig') { tooBig(m); return; }
      finish(m);
    };
    worker.onerror = function (e) {
      abort('خطأ في العامل: ' + (e.message || 'غير معروف'));
    };
  }

  /* ---------- تحذير الوضع بلا فقدان ---------- */
  function tooBig(m) {
    progress(0, 'الصورة تحوي أكثر من ' + m.limit.toLocaleString('en') + ' لون فريد.');
    var box = document.createElement('div');
    box.className = 'notice warn';
    box.innerHTML = '<span><b>ملف ضخم متوقّع.</b> الوضع «بلا فقدان» ينتج مساراً لكل لون فريد، ' +
                    'وقد يبلغ الحجم مئات الميجابايت.</span>';
    var b = document.createElement('button');
    b.textContent = 'تحويل على أي حال';
    b.onclick = function () { forceExact = true; start(); };
    box.appendChild(b);
    notices.innerHTML = '';
    notices.appendChild(box);
  }

  /* ---------- عرض النتيجة ---------- */
  function finish(m) {
    lastStats = m.stats;

    if (svgURL) { URL.revokeObjectURL(svgURL); svgURL = null; }
    svgBlob = new Blob([new Uint8Array(m.bytes)], { type: 'image/svg+xml' });
    previewData = m.preview || null;

    heavy = svgBlob.size > HEAVY_BYTES || m.stats.paths > HEAVY_PATHS;
    dl.disabled = cp.disabled = false;

    if (view === 'svg') showResult();

    var s = m.stats;
    if ($('autocolors').checked && s.colorsUsed) {
      $('colors').value = s.colorsUsed;
      $('colors')._show();
    }
    statsEl.innerHTML = '';
    [['المسارات', s.paths], ['الألوان الفريدة', s.uniqueColors],
     ['الألوان', s.colorsUsed], ['التدرّجات', s.gradients], ['الحدود', s.contours], ['العقد', s.nodes],
     ['الحجم', kb(svgBlob.size)], ['الأبعاد', s.width + '×' + s.height],
     ['الزمن', s.ms + ' م.ث']].forEach(function (p) {
      var d = document.createElement('div');
      d.className = 'stat';
      d.innerHTML = '<span>' + p[0] + '</span><b>' + p[1] + '</b>';
      statsEl.appendChild(d);
    });

    swatches.innerHTML = '';
    lastPalette = m.palette || [];
    lastPalette.forEach(function (c) {
      var sw = document.createElement('i');
      sw.style.background = c.color;
      sw.title = c.color;
      swatches.appendChild(sw);
    });

    out.hidden = false;
    out.textContent = m.head + (m.totalChars > m.head.length
      ? '\n\n… (' + (m.totalChars - m.head.length).toLocaleString('en') +
        ' حرفاً إضافياً — استخدم «نسخ الكود» أو «تنزيل SVG»)'
      : '');

    progress(100, 'تم في ' + s.ms + ' م.ث · ' + s.paths + ' مسار · ' + kb(svgBlob.size));
  }

  /* المعاينة: الـ SVG نفسه ما دام خفيفاً، وإلا نسخة نقطية جاهزة من العامل */
  function showResult(forceSVG) {
    notices.innerHTML = '';
    if (!svgBlob) { stage.innerHTML = '<div class="empty">لا يوجد ناتج بعد.</div>'; return; }

    if (heavy && !forceSVG) {
      if (previewData) {
        var cv = document.createElement('canvas');
        cv.width = previewData.width; cv.height = previewData.height;
        cv.getContext('2d').putImageData(
          new ImageData(new Uint8ClampedArray(previewData.data), previewData.width, previewData.height), 0, 0);
        stage.innerHTML = '';
        stage.appendChild(cv);
      } else {
        stage.innerHTML = '<div class="empty">الناتج كبير — نزّله لعرضه.</div>';
      }

      var box = document.createElement('div');
      box.className = 'notice';
      box.innerHTML = '<span><b>معاينة سريعة.</b> الناتج ' + kb(svgBlob.size) + ' و' +
                      lastStats.paths.toLocaleString('en') + ' مسار — عرضه مباشرةً يجمّد الصفحة. ' +
                      'الملف نفسه كامل الدقة وجاهز للتنزيل.</span>';
      var b = document.createElement('button');
      b.textContent = 'عرض الـ SVG الفعلي احتمال (تجمد)';
      b.onclick = function () { showResult(true); };
      box.appendChild(b);
      notices.appendChild(box);
      return;
    }

    if (!svgURL) svgURL = URL.createObjectURL(svgBlob);
    stage.innerHTML = '<img alt="الناتج" src="' + svgURL + '">';
  }

  function showImage() {
    notices.innerHTML = '';
    stage.innerHTML = imgURL
      ? '<img alt="الأصل" src="' + imgURL + '">'
      : '<div class="empty">لم تُحمّل أي صورة بعد.</div>';
  }

  viewSeg.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-v]');
    if (!b) return;
    view = b.dataset.v;
    viewSeg.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
    if (view === 'svg') { showResult(); } else { showImage(); }
  });

  /* ---------- تنزيل / نسخ ---------- */
  /* اسم الملف مشتقّ من اسم الصورة الأصلية */
  function baseName() {
    var n = (srcFile && srcFile.name) || 'vector';
    return n.replace(/\.[^.]+$/, '').replace(/[\\\/:*?"<>|]+/g, '_') || 'vector';
  }

  function note(html, warn) {
    var box = document.createElement('div');
    box.className = 'notice' + (warn ? ' warn' : '');
    box.innerHTML = '<span>' + html + '</span>';
    notices.appendChild(box);
    return box;
  }

  dl.addEventListener('click', function () {
    if (!svgBlob) { flash(dl, 'لا يوجد ناتج'); return; }

    var name = baseName() + '.svg';
    var url;
    try {
      url = URL.createObjectURL(svgBlob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      if (url) URL.revokeObjectURL(url);
      flash(dl, 'تعذّر التنزيل');
      note('تعذّر بدء التنزيل: ' + (err && err.message ? err.message : err), true);
      return;
    }

    /* الملفات الكبيرة تحتاج وقتاً للكتابة على القرص، فلا نُبطل الرابط مبكراً */
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);

    flash(dl, 'تم التنزيل ✓');
    var box = note('<b>بدأ تنزيل ' + name + '</b> · ' + kb(svgBlob.size) +
                   ' — تفقّد مجلد التنزيلات لديك. جارٍ التحقّق من سلامة الملف…');

    /* تحقّق فعلي: نقرأ ما أُرسل للتنزيل ونتأكّد أنه SVG سليم بالأبعاد الصحيحة */
    verify(svgBlob).then(function (r) {
      if (r.ok) {
        box.className = 'notice';
        box.innerHTML = '<span><b>تم التنزيل ✓</b> ' + name + ' · ' + kb(svgBlob.size) +
                        ' · ' + r.width + '×' + r.height + ' · ' +
                        r.paths.toLocaleString('en') + ' مسار — الملف سليم وقابل للفتح.</span>';
      } else {
        box.className = 'notice warn';
        box.innerHTML = '<span><b>تحذير:</b> الملف نُزّل لكن التحقّق منه فشل — ' + r.reason + '</span>';
      }
    });
  });

  /* يفكّ الملف المُنزَّل ويتأكّد أنه يُحلَّل كـ SVG صالح ويُرسم فعلاً */
  function verify(blob) {
    return blob.slice(0, 4096).text().then(function (head) {
      if (head.indexOf('<svg') === -1) throw new Error('لا يبدأ بوسم svg');
      var doc = new DOMParser().parseFromString(head + '</svg>', 'image/svg+xml');
      var root = doc.documentElement;
      if (!root || root.nodeName === 'parsererror') throw new Error('تعذّر تحليل الوسوم');
      var vb = (root.getAttribute('viewBox') || '').split(/\s+/);
      return new Promise(function (res) {
        var u = URL.createObjectURL(blob), im = new Image();
        im.onload = function () {
          URL.revokeObjectURL(u);
          res({ ok: true, width: im.naturalWidth || +vb[2], height: im.naturalHeight || +vb[3],
                paths: lastStats ? lastStats.paths : 0 });
        };
        im.onerror = function () {
          URL.revokeObjectURL(u);
          res({ ok: false, reason: 'المتصفح لم يستطع رسم الملف.' });
        };
        im.src = u;
      });
    }).catch(function (e) {
      return { ok: false, reason: (e && e.message) || 'سبب غير معروف' };
    });
  }

  /* ---------- ملف الألوان ---------- */
  /* مستند HTML قائم بذاته: مربّع لكل لون وبجانبه كوده.
     العناصر لا تُبنى دفعة واحدة بل على دفعات من ٣٠، وبين كل
     دفعة والتي تليها ميلي ثانية واحدة، كي لا يتجمّد المتصفح
     حين تكون الألوان بالمئات. */
  var COLOR_BATCH = 30, COLOR_DELAY = 1;

  function colorFileHTML(palette) {
    var NL = String.fromCharCode(10);
    var name = esc(baseName());
    var colors = JSON.stringify(palette.map(function (c) { return c.color; }));
    var L = [];

    L.push('<!doctype html>');
    L.push('<html lang="ar" dir="rtl">');
    L.push('<head>');
    L.push('<meta charset="utf-8">');
    L.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
    L.push('<title>ألوان ' + name + '</title>');
    L.push('<style>');
    L.push('  :root{color-scheme:light dark;--bg:#fff;--fg:#111;--muted:#6b7280;--line:#e5e7eb;--card:#fafafa}');
    L.push('  @media (prefers-color-scheme:dark){');
    L.push('    :root{--bg:#111418;--fg:#e8eaed;--muted:#9aa0a6;--line:#2a2f36;--card:#181c22}');
    L.push('  }');
    L.push('  *{box-sizing:border-box}');
    L.push('  body{margin:0;padding:28px 20px;background:var(--bg);color:var(--fg);');
    L.push('       font:15px/1.7 system-ui,"Segoe UI",Tahoma,sans-serif}');
    L.push('  h1{margin:0 0 4px;font-size:20px}');
    L.push('  p.sub{margin:0 0 22px;color:var(--muted);font-size:13px}');
    L.push('  ul{list-style:none;margin:0;padding:0;display:grid;gap:8px;');
    L.push('     grid-template-columns:repeat(auto-fill,minmax(180px,1fr))}');
    L.push('  li{display:flex;align-items:center;gap:10px;padding:8px 10px;direction:ltr;');
    L.push('     background:var(--card);border:1px solid var(--line);border-radius:9px;');
    L.push('     animation:in .18s ease both}');
    L.push('  @keyframes in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}');
    L.push('  li i{width:26px;height:26px;border-radius:6px;border:1px solid var(--line);');
    L.push('       flex:none;display:block}');
    L.push('  code{font:13px ui-monospace,Consolas,monospace;text-transform:uppercase;flex:1}');
    L.push('  .n{color:var(--muted);font-size:11px}');
    L.push('  #loading{color:var(--muted);font-size:13px;margin-top:14px}');
    L.push('</style>');
    L.push('</head>');
    L.push('<body>');
    L.push('<h1>ألوان ' + name + '</h1>');
    L.push('<p class="sub"><b id="count">0</b> من ' + palette.length + ' لوناً — مستخرجة من الصورة عند التحويل إلى SVG.</p>');
    L.push('<ul id="list"></ul>');
    L.push('<p id="loading">جارٍ عرض الألوان…</p>');

    /* السكربت الذي يبني العناصر على دفعات */
    L.push('<script>');
    L.push('(function () {');
    L.push('  var COLORS = ' + colors + ';');
    L.push('  var STEP = ' + COLOR_BATCH + ', DELAY = ' + COLOR_DELAY + ';');
    L.push('  var list = document.getElementById("list");');
    L.push('  var counter = document.getElementById("count");');
    L.push('  var loading = document.getElementById("loading");');
    L.push('  var i = 0;');
    L.push('  function batch() {');
    L.push('    var frag = document.createDocumentFragment();');
    L.push('    var end = Math.min(i + STEP, COLORS.length);');
    L.push('    for (; i < end; i++) {');
    L.push('      var li = document.createElement("li");');
    L.push('      var box = document.createElement("i");');
    L.push('      box.style.background = COLORS[i];');
    L.push('      var code = document.createElement("code");');
    L.push('      code.textContent = COLORS[i];');
    L.push('      var num = document.createElement("span");');
    L.push('      num.className = "n";');
    L.push('      num.textContent = i + 1;');
    L.push('      li.appendChild(box); li.appendChild(code); li.appendChild(num);');
    L.push('      frag.appendChild(li);');
    L.push('    }');
    L.push('    list.appendChild(frag);');
    L.push('    counter.textContent = i;');
    L.push('    if (i < COLORS.length) setTimeout(batch, DELAY);');
    L.push('    else loading.hidden = true;');
    L.push('  }');
    L.push('  batch();');
    L.push('})();');
    L.push('<' + '/script>');

    L.push('</body>');
    L.push('</html>');

    return L.join(NL) + NL;
  }

  function esc(t) {
    return String(t).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  if (colorBtn) colorBtn.addEventListener('click', function () {
    if (!lastPalette.length) { flash(colorBtn, 'لا توجد ألوان بعد'); return; }

    var blob = new Blob([colorFileHTML(lastPalette)], { type: 'text/html;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'color.html';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);

    flash(colorBtn, 'تم التنزيل ✓');
    note('<b>تم تنزيل color.html</b> · ' + lastPalette.length + ' لوناً · ' + kb(blob.size) +
         ' — تُعرض على دفعات من ' + COLOR_BATCH + '.');
  });

  cp.addEventListener('click', function () {
    if (!svgBlob) return;
    flash(cp, 'جارٍ التجهيز…');
    svgBlob.text()
      .then(function (t) { return navigator.clipboard.writeText(t); })
      .then(function () { flash(cp, 'تم النسخ ✓'); },
            function () { flash(cp, 'تعذّر النسخ'); });
  });

  function flash(btn, txt) {
    if (!btn._orig) btn._orig = btn.textContent;
    btn.textContent = txt;
    clearTimeout(btn._t);
    btn._t = setTimeout(function () { btn.textContent = btn._orig; }, 1600);
  }

  /* ---------- مساعدات ---------- */
  function kb(b) {
    return b < 1024 ? b + ' ب'
         : b < 1048576 ? (b / 1024).toFixed(1) + ' ك.ب'
         : (b / 1048576).toFixed(2) + ' م.ب';
  }
  function say(t) { statusEl.textContent = t; }
  function progress(p, t) { bar.style.width = p + '%'; say(t); }

  /* ---------- تنظيف عند مغادرة الصفحة ---------- */
  document.addEventListener('pageleave', function cleanup() {
    document.removeEventListener('pageleave', cleanup);
    document.removeEventListener('paste', onPaste);
    clearTimeout(timer);
    if (worker) worker.terminate();
    if (imgURL) URL.revokeObjectURL(imgURL);
    if (svgURL) URL.revokeObjectURL(svgURL);
  });
})();
