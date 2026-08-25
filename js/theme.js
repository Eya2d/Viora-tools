/* =========================================================
   إدارة الوضع الليلي / النهاري
   - عند أول زيارة: يتبع وضع الجهاز (prefers-color-scheme)
   - عند اختيار المستخدم يدوياً: يُحفظ في localStorage ويُحترم دائماً
   ========================================================= */
window.Theme = (function () {
  "use strict";

  var KEY   = "theme";
  var root  = document.documentElement;
  var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function store(v) {
    try { return v === undefined ? localStorage.getItem(KEY) : localStorage.setItem(KEY, v); }
    catch (e) { return null; }
  }
  function clear() { try { localStorage.removeItem(KEY); } catch (e) {} }

  /* الوضع المختار: "light" | "dark" | "system" */
  function mode() {
    var s = store();
    return (s === "light" || s === "dark") ? s : "system";
  }

  /* الوضع الفعلي المطبّق على الصفحة */
  function resolved() {
    var m = mode();
    if (m !== "system") return m;
    return media && media.matches ? "dark" : "light";
  }

  function apply() {
    var r = resolved();
    root.setAttribute("data-theme", r);

    var tip = document.getElementById("themeTip");
    if (tip) tip.textContent = r === "dark" ? "الوضع النهاري" : "الوضع الليلي";

    var btn = document.getElementById("themeToggle");
    if (btn) btn.setAttribute("aria-pressed", r === "dark" ? "true" : "false");

    // إشعار بقية الصفحة (مثل صفحة الإعدادات) بالتغيير
    document.dispatchEvent(new CustomEvent("themechange", {
      detail: { mode: mode(), resolved: r }
    }));
  }

  /* تعيين وضع محدد: "light" | "dark" | "system" */
  function set(m) {
    if (m === "system") clear(); else store(m);
    apply();
  }

  /* التبديل بين الليلي والنهاري */
  function toggle() {
    set(resolved() === "dark" ? "light" : "dark");
  }

  /* متابعة تغيّر وضع الجهاز طالما لم يختر المستخدم يدوياً */
  if (media) {
    var onSys = function () { if (mode() === "system") apply(); };
    if (media.addEventListener) media.addEventListener("change", onSys);
    else if (media.addListener) media.addListener(onSys);
  }

  /* مزامنة بين تبويبات المتصفح المفتوحة */
  window.addEventListener("storage", function (e) {
    if (e.key === KEY) apply();
  });

  document.addEventListener("DOMContentLoaded", apply);

  var btn = document.getElementById("themeToggle");
  if (btn) btn.addEventListener("click", toggle);

  apply();

  return { mode: mode, resolved: resolved, set: set, toggle: toggle, apply: apply };
})();
