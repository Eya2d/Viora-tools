/* =========================================================
   عامل الخلفية — يقوم بكل العمل الثقيل:
     فكّ ترميز الصورة، قراءة بكسلاتها، التتبّع، بناء نص SVG،
     ترميزه إلى بايتات، وتجهيز معاينة نقطية.
   الخيط الرئيسي لا يلمس أي بكسل ولا أي سلسلة نصية ضخمة،
   فتبقى الواجهة سلسة مهما كان حجم الصورة.
   ========================================================= */
importScripts("vectorize.js");

var CAN_DECODE = typeof OffscreenCanvas !== "undefined" &&
                 typeof createImageBitmap === "function";

/* فكّ ترميز ملف الصورة ورسمه داخل العامل */
function decode(blob, cap) {
  return createImageBitmap(blob).then(function (bmp) {
    var ow = bmp.width, oh = bmp.height;
    var scale = (cap && Math.max(ow, oh) > cap) ? cap / Math.max(ow, oh) : 1;
    var w = Math.max(1, Math.round(ow * scale));
    var h = Math.max(1, Math.round(oh * scale));

    var cv = new OffscreenCanvas(w, h);
    var cx = cv.getContext("2d", { willReadFrequently: true });
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = "high";
    cx.drawImage(bmp, 0, 0, w, h);
    bmp.close();

    return {
      data: cx.getImageData(0, 0, w, h).data,
      width: w, height: h, origWidth: ow, origHeight: oh
    };
  });
}

/* عدّ الألوان الفريدة مع خروج مبكر عند تجاوز الحدّ */
function uniqueColors(d, limit) {
  var set = new Set(), over = false;
  for (var i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    set.add((d[i] << 24 | d[i + 1] << 16 | d[i + 2] << 8 | d[i + 3]) >>> 0);
    if (limit && set.size > limit) { over = true; break; }
  }
  return { count: set.size, over: over };
}

function fail(msg) {
  self.postMessage({ type: "error", message: msg });
}

function process(input, msg) {
  var opts = msg.opts || {};

  /* حارس الوضع «بلا فقدان»: لا نبني ملفاً عملاقاً دون موافقة صريحة */
  if (opts.mode === "exact" && !msg.force) {
    var limit = msg.maxUnique || 20000;
    var u = uniqueColors(input.data, limit);
    if (u.over) {
      self.postMessage({ type: "toobig", unique: u.count, limit: limit });
      return;
    }
  }

  var res = Vectorize.run(input, opts, function (pct, label) {
    self.postMessage({ type: "progress", pct: pct, label: label });
  });

  /* ننقل النتيجة كبايتات لا كسلسلة نصية: نقل بلا نسخ، وبلا
     إنشاء سلسلة ضخمة في ذاكرة الخيط الرئيسي.                 */
  var bytes = new TextEncoder().encode(res.svg);
  var transfer = [bytes.buffer];
  var preview = null;
  if (res.preview) {
    preview = res.preview;
    transfer.push(preview.data.buffer);
  }

  self.postMessage({
    type: "done",
    bytes: bytes.buffer,
    head: res.svg.slice(0, 4000),
    totalChars: res.svg.length,
    stats: res.stats,
    palette: res.palette,
    preview: preview
  }, transfer);
}

self.onmessage = function (e) {
  var msg = e.data;
  if (!msg || msg.cmd !== "run") return;

  try {
    if (msg.file) {
      if (!CAN_DECODE) { fail("هذا المتصفح لا يدعم فكّ الترميز داخل العامل."); return; }
      decode(msg.file, msg.maxDim)
        .then(function (input) { process(input, msg); })
        .catch(function (err) { fail(err && err.message ? err.message : String(err)); });
    } else {
      process({
        data: msg.data, width: msg.width, height: msg.height,
        origWidth: msg.origWidth, origHeight: msg.origHeight
      }, msg);
    }
  } catch (err) {
    fail(err && err.message ? err.message : String(err));
  }
};
