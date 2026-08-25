/* =========================================================
   Barcode1D — مرمّز الباركود الشريطي، بلا مكتبات خارجية
   ---------------------------------------------------------
   يدعم: EAN-13، EAN-8، UPC-A، Code128 (تبديل تلقائي B/C)
   ويعيد وصفاً هندسياً (أشرطة + نصوص) يصلح للرسم على canvas
   أو للإخراج المباشر كـ SVG.
   ========================================================= */
(function (root) {
  "use strict";

  /* ---------- EAN / UPC ---------- */
  var L_CODE = ["0001101","0011001","0010011","0111101","0100011",
                "0110001","0101111","0111011","0110111","0001011"];
  var G_CODE = ["0100111","0110011","0011011","0100001","0011101",
                "0111001","0000101","0010001","0001001","0010111"];
  var R_CODE = ["1110010","1100110","1101100","1000010","1011100",
                "1001110","1010000","1000100","1001000","1110100"];
  /* نمط التكافؤ للنصف الأيسر حسب الرقم الأول */
  var PARITY = ["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG",
                "LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"];

  function eanChecksum(digits) {
    var sum = 0, n = digits.length;
    for (var i = 0; i < n; i++) {
      var d = digits[n - 1 - i];
      sum += (i % 2 === 0) ? d * 3 : d;
    }
    return (10 - (sum % 10)) % 10;
  }

  function parseDigits(text, expect, name) {
    var s = String(text).replace(/\D/g, "");
    if (s.length === expect - 1) {
      var arr = s.split("").map(Number);
      s += eanChecksum(arr);                         // نحسب رقم التحقّق
    }
    if (s.length !== expect)
      throw new Error(name + " يحتاج " + (expect - 1) + " أو " + expect + " رقماً (المُدخل " + s.length + ").");
    var d = s.split("").map(Number);
    if (eanChecksum(d.slice(0, expect - 1)) !== d[expect - 1])
      throw new Error("رقم التحقّق غير صحيح — الصحيح " + eanChecksum(d.slice(0, expect - 1)) + ".");
    return d;
  }

  /* يبني مصفوفة وحدات (0/1) + مواضع النصوص أسفلها */
  function ean13(text) {
    var d = parseDigits(text, 13, "EAN-13");
    var bits = "101";                                 // حارس البداية
    var parity = PARITY[d[0]];
    for (var i = 1; i <= 6; i++)
      bits += (parity[i - 1] === "L" ? L_CODE : G_CODE)[d[i]];
    bits += "01010";                                  // الحارس الأوسط
    for (i = 7; i <= 12; i++) bits += R_CODE[d[i]];
    bits += "101";                                    // حارس النهاية

    /* الأشرطة الحارسة تمتدّ لأسفل تحت خطّ الأرقام */
    var guards = [0, 1, 2, 45, 46, 47, 48, 49, 92, 93, 94];
    return {
      bits: bits, type: "EAN-13", value: d.join(""), guards: guards,
      quiet: 11,
      texts: [
        { text: String(d[0]), from: -9, to: -1 },
        { text: d.slice(1, 7).join(""), from: 3, to: 44 },
        { text: d.slice(7).join(""), from: 50, to: 91 }
      ]
    };
  }

  function ean8(text) {
    var d = parseDigits(text, 8, "EAN-8");
    var bits = "101";
    for (var i = 0; i < 4; i++) bits += L_CODE[d[i]];
    bits += "01010";
    for (i = 4; i < 8; i++) bits += R_CODE[d[i]];
    bits += "101";
    var guards = [0, 1, 2, 31, 32, 33, 34, 35, 64, 65, 66];
    return {
      bits: bits, type: "EAN-8", value: d.join(""), guards: guards, quiet: 7,
      texts: [
        { text: d.slice(0, 4).join(""), from: 3, to: 30 },
        { text: d.slice(4).join(""), from: 36, to: 63 }
      ]
    };
  }

  function upca(text) {
    var s = String(text).replace(/\D/g, "");
    if (s.length === 11 || s.length === 12) s = "0" + s;
    var r = ean13(s);
    r.type = "UPC-A";
    r.value = r.value.slice(1);
    r.texts = [
      { text: r.value[0], from: 3, to: 10 },
      { text: r.value.slice(1, 6), from: 11, to: 44 },
      { text: r.value.slice(6, 11), from: 50, to: 83 },
      { text: r.value[11], from: 85, to: 92 }
    ];
    return r;
  }

  /* ---------- Code128 ---------- */
  var C128 = [
    "11011001100","11001101100","11001100110","10010011000","10010001100",
    "10001001100","10011001000","10011000100","10001100100","11001001000",
    "11001000100","11000100100","10110011100","10011011100","10011001110",
    "10111001100","10011101100","10011100110","11001110010","11001011100",
    "11001001110","11011100100","11001110100","11101101110","11101001100",
    "11100101100","11100100110","11101100100","11100110100","11100110010",
    "11011011000","11011000110","11000110110","10100011000","10001011000",
    "10001000110","10110001000","10001101000","10001100010","11010001000",
    "11000101000","11000100010","10110111000","10110001110","10001101110",
    "10111011000","10111000110","10001110110","11101110110","11010001110",
    "11000101110","11011101000","11011100010","11011101110","11101011000",
    "11101000110","11100010110","11101101000","11101100010","11100011010",
    "11101111010","11001000010","11110001010","10100110000","10100001100",
    "10010110000","10010000110","10000101100","10000100110","10110010000",
    "10110000100","10011010000","10011000010","10000110100","10000110010",
    "11000010010","11001010000","11110111010","11000010100","10001111010",
    "10100111100","10010111100","10010011110","10111100100","10011110100",
    "10011110010","11110100100","11110010100","11110010010","11011011110",
    "11011110110","11110110110","10101111000","10100011110","10001011110",
    "10111101000","10111100010","11110101000","11110100010","10111011110",
    "10111101110","11101011110","11110101110","11010000100","11010010000",
    "11010011100","11000111010"
  ];
  var STOP128 = "1100011101011";

  function code128(text) {
    var s = String(text);
    for (var i = 0; i < s.length; i++)
      if (s.charCodeAt(i) < 32 || s.charCodeAt(i) > 126)
        throw new Error("Code128 هنا يدعم المحارف المطبوعة (ASCII 32–126) فقط.");
    if (!s.length) throw new Error("أدخل نصاً للترميز.");

    /* تبديل تلقائي: المقاطع الرقمية الطويلة تُرمَّز بالنمط C (رقمان لكل رمز) */
    var codes = [], startB = 104, startC = 105, mode = null;

    function digitsAt(pos) {
      var n = 0;
      while (pos + n < s.length && s[pos + n] >= "0" && s[pos + n] <= "9") n++;
      return n;
    }

    var p = 0;
    var firstRun = digitsAt(0);
    if (firstRun >= 4 && firstRun % 2 === 0) { codes.push(startC); mode = "C"; }
    else { codes.push(startB); mode = "B"; }

    while (p < s.length) {
      var run = digitsAt(p);
      if (mode === "C") {
        if (run >= 2) { codes.push(parseInt(s.substr(p, 2), 10)); p += 2; }
        else { codes.push(100); mode = "B"; }        // Code B
      } else {
        if (run >= 6 || (run >= 4 && p + run === s.length && run % 2 === 0)) {
          if (run % 2 === 1) { codes.push(s.charCodeAt(p) - 32); p++; }
          codes.push(99); mode = "C";                // Code C
        } else { codes.push(s.charCodeAt(p) - 32); p++; }
      }
    }

    var sum = codes[0];
    for (i = 1; i < codes.length; i++) sum += codes[i] * i;
    codes.push(sum % 103);

    var bits = "";
    for (i = 0; i < codes.length; i++) bits += C128[codes[i]];
    bits += STOP128;

    return {
      bits: bits, type: "Code128", value: s, guards: [], quiet: 10,
      texts: [{ text: s, from: 0, to: bits.length - 1 }]
    };
  }

  /* ---------- الواجهة ---------- */
  var MAKERS = { "ean13": ean13, "ean8": ean8, "upca": upca, "code128": code128 };

  function build(type, text) {
    var fn = MAKERS[type];
    if (!fn) throw new Error("نوع باركود غير معروف: " + type);
    return fn(text);
  }

  /* رسم على canvas */
  function draw(canvas, data, opt) {
    opt = opt || {};
    var mw = opt.moduleWidth || 3;
    var height = opt.height || 160;
    var showText = opt.showText !== false;
    var fontSize = opt.fontSize || 22;
    var pad = opt.quietZone == null ? data.quiet : opt.quietZone;
    var textH = showText ? fontSize + 8 : 0;
    var margin = opt.margin == null ? 12 : opt.margin;

    var n = data.bits.length;
    var W = (n + pad * 2) * mw + margin * 2;
    var H = height + textH + margin * 2;

    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = opt.background || "#ffffff";
    if (opt.background !== "transparent") ctx.fillRect(0, 0, W, H);
    else ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = opt.foreground || "#000000";
    var x0 = margin + pad * mw, y0 = margin;
    var guardSet = {};
    for (var g = 0; g < data.guards.length; g++) guardSet[data.guards[g]] = 1;

    for (var i = 0; i < n; i++) {
      if (data.bits[i] !== "1") continue;
      var bh = height + (showText && guardSet[i] ? fontSize * 0.55 : 0);
      ctx.fillRect(x0 + i * mw, y0, mw, bh);
    }

    if (showText) {
      ctx.fillStyle = opt.foreground || "#000000";
      ctx.font = "600 " + fontSize + "px ui-monospace, Menlo, Consolas, monospace";
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "center";
      var ty = y0 + height + fontSize + 2;
      for (var t = 0; t < data.texts.length; t++) {
        var s = data.texts[t];
        var cx = x0 + ((s.from + s.to + 1) / 2) * mw;
        ctx.fillText(s.text, cx, ty);
      }
    }
    return { width: W, height: H };
  }

  /* إخراج SVG */
  function toSVG(data, opt) {
    opt = opt || {};
    var mw = opt.moduleWidth || 3;
    var height = opt.height || 160;
    var showText = opt.showText !== false;
    var fontSize = opt.fontSize || 22;
    var pad = opt.quietZone == null ? data.quiet : opt.quietZone;
    var margin = opt.margin == null ? 12 : opt.margin;
    var textH = showText ? fontSize + 8 : 0;
    var n = data.bits.length;
    var W = (n + pad * 2) * mw + margin * 2;
    var H = height + textH + margin * 2;
    var fg = opt.foreground || "#000000";

    var guardSet = {};
    for (var g = 0; g < data.guards.length; g++) guardSet[data.guards[g]] = 1;

    var out = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H +
              '" width="' + W + '" height="' + H + '" shape-rendering="crispEdges">\n';
    if (opt.background && opt.background !== "transparent")
      out += '<rect width="' + W + '" height="' + H + '" fill="' + opt.background + '"/>\n';

    var x0 = margin + pad * mw, d = "";
    for (var i = 0; i < n; i++) {
      if (data.bits[i] !== "1") continue;
      var bh = height + (showText && guardSet[i] ? fontSize * 0.55 : 0);
      d += "M" + (x0 + i * mw) + " " + margin + "h" + mw + "v" + bh + "h" + (-mw) + "Z";
    }
    out += '<path fill="' + fg + '" d="' + d + '"/>\n';

    if (showText) {
      out += '<g fill="' + fg + '" font-family="ui-monospace, Consolas, monospace" font-weight="600" ' +
             'font-size="' + fontSize + '" text-anchor="middle">\n';
      for (var t = 0; t < data.texts.length; t++) {
        var s = data.texts[t];
        var cx = x0 + ((s.from + s.to + 1) / 2) * mw;
        out += '<text x="' + cx.toFixed(1) + '" y="' + (margin + height + fontSize + 2) + '">' +
               String(s.text).replace(/[&<>]/g, function (c) {
                 return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c];
               }) + '</text>\n';
      }
      out += '</g>\n';
    }
    return out + '</svg>';
  }

  root.Barcode1D = { build: build, draw: draw, toSVG: toSVG, checksum: eanChecksum };
})(typeof self !== "undefined" ? self : window);
