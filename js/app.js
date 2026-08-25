/* =========================================================
   راوتر بسيط: يحمّل صفحات HTML داخل #app بدون إعادة تحميل
   ========================================================= */
(function () {
  "use strict";

  var ROUTES = {
    home:    "pages/home.html",
    code:    "pages/code.html",
    barcode:  "pages/barcode.html",
    settings: "pages/settings.html"
  };
  var DEFAULT = "home";

  var app       = document.getElementById("app");
  var loader    = document.getElementById("loader");
  var indicator = document.getElementById("indicator");
  var items     = Array.prototype.slice.call(document.querySelectorAll(".nav-item[data-page]"));

  var cache = {};   // تخزين مؤقت حتى لا تُطلب الصفحة أكثر من مرة
  var current = null;

  /* ---------- تحريك المؤشر الجانبي ---------- */
  function moveIndicator(item) {
    // العنصر الأب (.nav) موضعه relative، لذا offsetTop محسوب بالنسبة له مباشرة
    indicator.style.transform = "translateY(" + item.offsetTop + "px)";
    indicator.style.height = item.offsetHeight + "px";
  }

  function setActive(page) {
    var inNav = false;
    items.forEach(function (el) {
      var on = el.dataset.page === page;
      el.classList.toggle("active", on);
      if (on && el.closest(".nav")) { moveIndicator(el); inNav = true; }
    });
    // المؤشر يخصّ أيقونات التنقل العلوية فقط
    indicator.classList.toggle("hidden", !inNav);
  }

  /* ---------- جلب محتوى الصفحة ---------- */
  function fetchPage(url) {
    if (cache[url]) return Promise.resolve(cache[url]);

    return fetch(url, { cache: "no-cache" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then(function (html) {
        cache[url] = html;
        return html;
      });
  }

  /* ---------- عرض الصفحة ---------- */
  function render(page) {
    if (!ROUTES[page]) page = DEFAULT;
    if (page === current) return;

    current = page;
    setActive(page);
    loader.classList.add("show");
    app.classList.add("leaving");

    fetchPage(ROUTES[page])
      .then(function (html) {
        app.classList.remove("leaving");
        // إشعار الصفحة السابقة كي تحرّر مواردها (عمّال، مؤقّتات...)
        document.dispatchEvent(new CustomEvent("pageleave"));
        app.innerHTML = html;
        // إعادة تشغيل أنيميشن الظهور
        app.style.animation = "none";
        void app.offsetWidth;
        app.style.animation = "";
        // تشغيل أي <script> داخل الصفحة المحمّلة
        runScripts(app);
        document.title = (app.querySelector("h1") || {}).textContent || "لوحة التحكم";
      })
      .catch(function (err) {
        app.classList.remove("leaving");
        app.innerHTML =
          '<div class="error"><b>تعذّر تحميل الصفحة.</b><br>' +
          "السبب: " + err.message + "<br><br>" +
          "إن كنت تفتح الملف مباشرة عبر <code>file://</code> فالمتصفح يمنع " +
          "<code>fetch</code>. شغّل خادماً محلياً، مثلاً:<br>" +
          "<code>python -m http.server 8000</code> ثم افتح " +
          "<code>http://localhost:8000</code></div>";
      })
      .then(function () {
        loader.classList.remove("show");
      });
  }

  /* ---------- تنفيذ السكربتات الموجودة داخل المحتوى المحمّل ---------- */
  function runScripts(container) {
    container.querySelectorAll("script").forEach(function (old) {
      var s = document.createElement("script");
      Array.prototype.forEach.call(old.attributes, function (a) {
        s.setAttribute(a.name, a.value);
      });
      s.textContent = old.textContent;
      old.replaceWith(s);
    });
  }

  /* ---------- التوجيه عبر الهاش ---------- */
  function routeFromHash() {
    return (location.hash.replace(/^#\/?/, "") || DEFAULT).toLowerCase();
  }

  window.addEventListener("hashchange", function () {
    render(routeFromHash());
  });

  // إبقاء المؤشر في مكانه الصحيح عند تغيير حجم النافذة
  window.addEventListener("resize", function () {
    var active = document.querySelector(".nav .nav-item.active");
    if (active) moveIndicator(active);
  });

  /* ---------- الإقلاع ---------- */
  indicator.style.transition = "none";
  setActive(routeFromHash());
  requestAnimationFrame(function () {
    indicator.style.transition = "";
  });

  if (!location.hash) location.replace("#/" + DEFAULT);
  render(routeFromHash());
})();
