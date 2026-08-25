/* =========================================================
   دُرج الشريط الجانبي في وضع الهاتف
   ---------------------------------------------------------
   • مخفيّ افتراضياً، ويُفتح بالسحب من أول ٢٠ بكسل من اليمين
   • يتبع الإصبع تدريجياً أثناء السحب في الاتجاهين
   • يُغلق بالسحب من داخله نحو اليمين، أو باللمس خارجه
     (لحظة ملامسة الإصبع، بلا انتظار رفعه)
   • يُغلق فوراً عند النقر على زر صفحة بداخله
   ========================================================= */
(function () {
  "use strict";

  var sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;

  var mq = window.matchMedia('(max-width: 640px)');

  /* منع السحب الأصلي داخل الشريط في كل الأوضاع.
     روابط <a> قابلة للسحب افتراضياً، وسحبها يبدأ عملية سحب
     رابط يستولي فيها المتصفح على المؤشّر ويُلغي النقرة بعدها،
     فتبدو الأيقونات غير قابلة للنقر. السمة تغطّي فايرفوكس،
     و preventDefault يضمنها في بقية المتصفحات.              */
  Array.prototype.forEach.call(
    sidebar.querySelectorAll('a, img, svg'),
    function (el) { el.setAttribute('draggable', 'false'); }
  );
  sidebar.addEventListener('dragstart', function (e) { e.preventDefault(); });

  var edge = document.createElement('div');
  edge.className = 'drawer-edge';
  document.body.appendChild(edge);

  var scrim = document.createElement('div');
  scrim.className = 'drawer-scrim';
  document.body.appendChild(scrim);

  var open = false;          // هل الدُرج مفتوح
  var dragging = false;      // هل يجري سحب فعلي الآن
  var mode = null;           // 'open' أو 'close'
  var startX = 0, startY = 0, shift = 0, pending = false;

  /* المسافة التي يختفي بها الدُرج كاملاً = عرضه + هامشه */
  function hiddenDist() { return sidebar.offsetWidth + 16; }

  function setShift(px) {
    var max = hiddenDist();
    px = px < 0 ? 0 : (px > max ? max : px);
    shift = px;
    sidebar.style.transform = 'translateX(' + px + 'px)';
  }

  /* إنهاء السحب وتسليم الحركة المتبقّية لانتقال CSS.
     نُعيد تفعيل الانتقال ونُجبر إعادة تدفّق قبل إزالة الإزاحة
     اليدوية، وإلا حُسبت الحالتان في إطار واحد فقفز الدُرج. */
  function settle() {
    dragging = false;
    pending = false;
    mode = null;
    sidebar.classList.remove('dragging');
    void sidebar.offsetWidth;
    sidebar.style.transform = '';
  }

  function openDrawer() {
    open = true;
    sidebar.classList.add('open');
    settle();
    scrim.classList.add('on');
  }

  function closeDrawer() {
    open = false;
    sidebar.classList.remove('open');
    settle();
    scrim.classList.remove('on');
  }

  /* ---------- السحب من الحافة للفتح ---------- */
  edge.addEventListener('pointerdown', function (e) {
    if (!mq.matches || open) return;
    e.preventDefault();
    mode = 'open';
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    sidebar.classList.add('dragging');
    sidebar.classList.add('open');     // نلغي إزاحة CSS ونتحكّم يدوياً
    setShift(hiddenDist());
    scrim.classList.add('on');
    try { edge.setPointerCapture(e.pointerId); } catch (err) {}
  });

  edge.addEventListener('pointermove', function (e) {
    if (!dragging || mode !== 'open') return;
    setShift(hiddenDist() - (startX - e.clientX));
  });

  function finishEdge(e) {
    if (!dragging || mode !== 'open') return;
    var half = hiddenDist() / 2;
    if (shift < half) openDrawer(); else closeDrawer();
  }
  edge.addEventListener('pointerup', finishEdge);
  edge.addEventListener('pointercancel', finishEdge);

  /* ---------- السحب من داخل الدُرج للإغلاق ---------- */
  sidebar.addEventListener('pointerdown', function (e) {
    if (!mq.matches || !open) return;
    pending = true;                    // ننتظر حركة كافية قبل اعتباره سحباً
    mode = 'close';
    startX = e.clientX; startY = e.clientY;
  });

  sidebar.addEventListener('pointermove', function (e) {
    if (!mq.matches || !open || mode !== 'close') return;
    var dx = e.clientX - startX, dy = e.clientY - startY;

    if (pending) {
      /* لا نبدأ السحب إلا بعد ٨ بكسل أفقياً، كي تبقى النقرات تعمل */
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy)) return;
      pending = false;
      dragging = true;
      sidebar.classList.add('dragging');
      try { sidebar.setPointerCapture(e.pointerId); } catch (err) {}
    }
    if (dragging) { e.preventDefault(); setShift(dx); }
  });

  function finishInside() {
    if (!dragging || mode !== 'close') { pending = false; mode = null; return; }
    /* ثُلث المسافة يكفي للإغلاق */
    if (shift > hiddenDist() / 3) closeDrawer(); else openDrawer();
  }
  sidebar.addEventListener('pointerup', finishInside);
  sidebar.addEventListener('pointercancel', finishInside);

  /* ---------- اللمس خارج الدُرج يغلقه فوراً ---------- */
  scrim.addEventListener('pointerdown', function (e) {
    if (!open) return;
    e.preventDefault();
    closeDrawer();
  });

  /* ---------- النقر على زر صفحة يغلقه فوراً ---------- */
  sidebar.addEventListener('click', function (e) {
    if (!mq.matches || !open) return;
    if (e.target.closest('a.nav-item[data-page]')) closeDrawer();
  });

  /* الرجوع/التقدّم في المتصفح يغلقه أيضاً */
  window.addEventListener('hashchange', function () {
    if (mq.matches && open) closeDrawer();
  });

  /* ---------- الخروج من وضع الهاتف ---------- */
  function onModeChange() {
    if (!mq.matches) {
      open = false;
      sidebar.classList.remove('open');
      settle();
      scrim.classList.remove('on');
    }
  }
  if (mq.addEventListener) mq.addEventListener('change', onModeChange);
  else if (mq.addListener) mq.addListener(onModeChange);

  /* واجهة صغيرة للاختبار والاستدعاء الخارجي */
  window.Drawer = {
    open: function () { if (mq.matches) openDrawer(); },
    close: closeDrawer,
    isOpen: function () { return open; },
    hiddenDistance: hiddenDist
  };
})();
