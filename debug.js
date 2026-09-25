/* 診斷模式：網址加上 ?debug=1 才會啟動。
 * 在畫面上方顯示一個小框，記錄每次點擊/觸碰落在哪個元素、JavaScript 錯誤與視窗大小，
 * 用來排查只在手機 LINE 裡才發生的問題。平常不會出現，也不影響使用。
 */
(function () {
  'use strict';
  const q = location.search + ' ' + decodeURIComponent(location.search);
  if (!/[?&]debug=1/.test(q) && q.indexOf('debug=1') < 0) return;

  const lines = [];
  let box;

  function describe(el) {
    if (!el || !el.tagName) return String(el);
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\s+/).join('.');
    if (el.dataset && el.dataset.tab) s += '[tab=' + el.dataset.tab + ']';
    return s;
  }

  function log(msg) {
    const t = new Date();
    lines.push(t.toTimeString().slice(0, 8) + ' +' + Math.round(performance.now()) + 'ms ' + msg);
    while (lines.length > 30) lines.shift();
    if (box) box.textContent = lines.slice().reverse().join('\n');
  }
  window.__debugLog = log;

  function env() {
    const nav = document.querySelector('#tabs');
    const r = nav && nav.getBoundingClientRect();
    const vv = window.visualViewport;
    log('視窗 inner=' + innerWidth + 'x' + innerHeight +
      (vv ? ' visual=' + Math.round(vv.width) + 'x' + Math.round(vv.height) + ' offTop=' + Math.round(vv.offsetTop) : '') +
      ' scrollY=' + Math.round(scrollY) +
      ' | nav ' + (r ? 'top=' + Math.round(r.top) + ' bottom=' + Math.round(r.bottom) + ' hidden=' + nav.hidden : '無'));
  }
  window.__debugEnv = env;

  function onPointer(type) {
    return function (e) {
      const p = e.touches && e.touches[0] ? e.touches[0] : (e.changedTouches && e.changedTouches[0]) || e;
      const x = Math.round(p.clientX), y = Math.round(p.clientY);
      const top = document.elementFromPoint(x, y);
      log(type + ' (' + x + ',' + y + ') target=' + describe(e.target) + ' 最上層=' + describe(top) +
        (e.defaultPrevented ? ' [已被攔截]' : ''));
    };
  }

  document.addEventListener('touchstart', onPointer('touchstart'), true);
  document.addEventListener('touchend', onPointer('touchend'), true);
  document.addEventListener('click', onPointer('click'), true);
  window.addEventListener('error', function (e) { log('❌ 錯誤: ' + e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno); });
  window.addEventListener('unhandledrejection', function (e) { log('❌ Promise 錯誤: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)); });
  window.addEventListener('resize', env);

  document.addEventListener('DOMContentLoaded', function () {
    box = document.createElement('pre');
    box.id = 'debug-box';
    box.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99;max-height:38vh;overflow:auto;margin:0;' +
      'padding:6px 8px;background:rgba(0,0,0,.85);color:#7CFC00;font:11px/1.35 monospace;white-space:pre-wrap;pointer-events:none;';
    document.body.appendChild(box);
    log('診斷模式啟動 UA=' + navigator.userAgent);
    log('網址=' + location.href);
    env();
    setTimeout(env, 3000);
  });
})();
