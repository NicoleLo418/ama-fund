/* 媽媽股票帳 — 前端
 *   入口 B（媽媽看）：https://liff.line.me/{LIFF_ID}/stock.html
 *   入口 A（Nicole 記帳）：https://liff.line.me/{LIFF_ID}/stock.html?edit=1
 * 能不能記帳由後端判斷（設定表「寫入者」），網址上的 edit=1 只是「想進記帳畫面」。
 */
(function () {
  'use strict';
  const CFG = window.APP_CONFIG || {};
  const API = CFG.API_URL || CFG.GAS_URL;
  const params = new URLSearchParams(location.search);
  const WANT_EDIT = params.get('edit') === '1';
  // 本機測試：只有後端是 localhost 時才允許假身分（正式後端一定會向 LINE 驗證）
  const LOCAL_UID = /^http:\/\/localhost/.test(API) ? params.get('devuid') : null;
  const dlog = window.__debugLog || function () {};

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => Math.abs(Number(n) || 0).toLocaleString('en-US');
  const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + money(n);
  const md = (d) => { const [, m, dd] = d.split('-').map(Number); return m + '/' + dd; };
  const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 台灣時間
  const newId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  const state = { data: null, filter: 'all', mode: '', form: null, confirmDel: '', editing: '', ledgerCat: 'all' };

  // ===== 後端 =====
  async function api(action, body) {
    const payload = Object.assign({ action }, body || {}, { idToken: LOCAL_UID || liff.getIDToken() });
    for (let attempt = 1; attempt <= 2; attempt++) {
      let json;
      try {
        const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
        json = JSON.parse(await res.text());
      } catch (e) {
        if (attempt === 1) { await new Promise((r) => setTimeout(r, 800)); continue; } // Google 偶爾回錯誤頁：重試一次
        throw Object.assign(new Error('網路不穩，請再按一次'), { code: 'NETWORK' });
      }
      if (!json.ok) throw Object.assign(new Error(json.error), { code: json.code });
      return json.data;
    }
  }

  // ===== 計算 =====
  const catOf = (t) => (t.type === '入金' ? 'cash' : t.type === '股息' ? 'div' : 'trade');
  const CAT_LABEL = { all: '全部（餘額）', cash: '媽媽給的現金', trade: '買賣', div: '股息' };
  const sum = (list) => list.reduce((s, t) => s + t.amount, 0);
  const typeLabel = (t) => (t.type === '入金' ? (t.symbol === '媽媽結清還款' ? '媽媽結清還款' : '媽媽給現金') : t.symbol + ' ' + t.type);

  function holdings(txs) {
    const map = new Map();
    for (const t of txs) {
      if (!['買進', '賣出', '股息'].includes(t.type)) continue;
      if (!map.has(t.symbol)) map.set(t.symbol, { symbol: t.symbol, buyCount: 0, buy: 0, sell: 0, div: 0 });
      const h = map.get(t.symbol);
      if (t.type === '買進') { h.buyCount++; h.buy += -t.amount; }
      if (t.type === '賣出') h.sell += t.amount;
      if (t.type === '股息') h.div += t.amount;
    }
    const order = (state.data.owners.mom || []);
    return [...map.values()].sort((a, b) => {
      const ia = order.indexOf(a.symbol), ib = order.indexOf(b.symbol);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
  }

  function balanceText(bal) {
    return bal < 0
      ? { cls: 'owe', label: 'Nicole 先幫媽媽墊了', note: '媽媽的錢用完了，多出來的是 Nicole 先墊的' }
      : { cls: 'ok', label: '媽媽的錢還剩', note: '媽媽給的現金，扣掉買股票，加上賣股票和股息' };
  }

  // ===== 媽媽看的畫面 =====
  function renderMom() {
    const txs = state.data.transactions;
    const bal = sum(txs);
    const b = balanceText(bal);
    const cats = { cash: sum(txs.filter((t) => catOf(t) === 'cash')), trade: sum(txs.filter((t) => catOf(t) === 'trade')), div: sum(txs.filter((t) => catOf(t) === 'div')) };
    const last = txs.length ? txs[txs.length - 1].date.replace(/-/g, '/') : '—';
    const hs = holdings(txs);
    const f = state.filter;
    const shown = (f === 'all' ? txs : f === 'cash' ? txs.filter((t) => catOf(t) === 'cash') : txs.filter((t) => t.symbol === f)).slice().reverse();
    const h = hs.find((x) => x.symbol === f);

    $('#app').innerHTML = `
      <h1>媽媽股票帳</h1>
      <p class="sub">更新到 ${esc(last)}</p>

      <section class="hero ${b.cls}">
        <div class="l">${b.label}</div>
        <div class="v num">${money(bal)}<small>元</small></div>
        <div class="m">${b.note}</div>
      </section>

      <h2>錢是怎麼來、怎麼用的</h2>
      <div class="card flow">
        <div class="ln"><span>媽媽給的現金</span><span class="num">${signed(cats.cash)}</span></div>
        <div class="ln"><span>買股票、賣股票</span><span class="num">${signed(cats.trade)}</span></div>
        <div class="ln"><span>領到的股息</span><span class="num">${signed(cats.div)}</span></div>
        <div class="ln"><span>${bal < 0 ? 'Nicole 先墊' : '媽媽的錢還剩'}</span><span class="num">${money(bal)}</span></div>
      </div>

      <h2>媽媽有的股票</h2>
      <div class="stocks">
        ${hs.map((x) => `<button class="stk" data-stock="${esc(x.symbol)}" aria-pressed="${f === x.symbol}">
          <b>${esc(x.symbol)}</b>
          ${x.buyCount ? `<span>買了 ${x.buyCount} 次，花 ${money(x.buy)} 元</span>` : ''}
          ${x.sell ? `<span>賣掉拿回 ${money(x.sell)} 元</span>` : ''}
          ${x.div ? `<span>領到股息 ${money(x.div)} 元</span>` : ''}
          <span class="go">${f === x.symbol ? '再點一次看全部' : '點我看這檔的紀錄 ↓'}</span>
        </button>`).join('')}
      </div>

      <h2 id="records">紀錄</h2>
      <div class="filters">
        <button data-filter="all" aria-pressed="${f === 'all'}">全部</button>
        <button data-filter="cash" aria-pressed="${f === 'cash'}">媽媽給的現金</button>
        ${hs.map((x) => `<button data-filter="${esc(x.symbol)}" aria-pressed="${f === x.symbol}">${esc(x.symbol)}</button>`).join('')}
      </div>
      ${h ? `<div class="subtotal">買了 ${h.buyCount} 次，共 ${money(h.buy)} 元｜賣掉拿回 ${money(h.sell)} 元｜股息 ${money(h.div)} 元</div>` : ''}
      <ul class="rec card">
        ${shown.map((t) => `<li><span class="n"><span class="d num">${md(t.date)}</span>${esc(typeLabel(t))}</span>
          <span class="a num ${t.amount > 0 ? 'pos' : ''}">${signed(t.amount)}</span></li>`).join('') || '<li>沒有紀錄</li>'}
      </ul>
      ${state.data.canWrite ? '<button class="btn ghost switch" data-go="edit">回到記帳畫面</button>' : ''}
    `;
  }

  // ===== Nicole 記帳畫面 =====
  function newForm() {
    return { type: '入金', date: today(), cashKind: '給現金', symbol: '', custom: '', amount: '', note: '' };
  }

  function formSymbol(f) {
    return f.symbol === '__other' ? f.custom.trim() : f.symbol;
  }

  /** 表單目前的檢查：block＝擋下、warn＝黃色警告 */
  function checkSymbol(f) {
    if (f.type === '入金') return {};
    const s = formSymbol(f);
    if (!s) return {};
    const o = state.data.owners;
    if ((o.nicole || []).includes(s) || (o.alwaysNicole || []).includes(s)) return { block: '這檔是 Nicole 的股票' };
    if (!(o.mom || []).includes(s)) return { warn: '「' + s + '」不在媽媽的股票清單上，確定是媽媽的再新增' };
    return {};
  }

  function previewText(f) {
    const amt = Number(f.amount);
    if (!Number.isInteger(amt) || amt <= 0) return '輸入金額後會顯示預覽';
    const s = f.type === '入金' ? (f.cashKind === '結清還款' ? '媽媽結清還款' : '媽媽給現金') : (formSymbol(f) || '（還沒選標的）') + ' ' + f.type;
    const val = f.type === '買進' ? -amt : amt;
    const after = sum(state.data.transactions) + val;
    return `會記成：<b>${md(f.date)} ${esc(s)} ${signed(val)}</b> → 記完後${after < 0 ? 'Nicole 先墊了 ' : '媽媽的錢還有 '}<b>${money(after)}</b> 元`;
  }

  function renderEdit() {
    const f = state.form || (state.form = newForm());
    const o = state.data.owners;
    const txs = state.data.transactions;
    const chk = checkSymbol(f);
    const c = state.ledgerCat;
    const catList = (k) => (k === 'all' ? txs : txs.filter((t) => catOf(t) === k));
    // 累計（依時間順序），再反過來顯示最新在上
    let run = 0;
    const rows = catList(c).map((t) => { run += t.amount; return Object.assign({}, t, { run }); }).reverse();

    $('#app').innerHTML = `
      <h1>媽媽股票帳・記帳</h1>
      <p class="sub">只有 Nicole 看得到這一頁</p>

      <section class="card" style="margin-top:12px">
        <div class="types">
          ${[['入金', '媽媽給現金'], ['買進', '買進'], ['賣出', '賣出'], ['股息', '股息']].map(([k, l]) =>
            `<button data-type="${k}" aria-pressed="${f.type === k}">${l}</button>`).join('')}
        </div>
        <div class="field"><label for="f-date">日期</label><input id="f-date" type="date" value="${esc(f.date)}"></div>
        ${f.type === '入金' ? `
          <div class="field"><label for="f-cash">說明</label>
            <select id="f-cash">
              <option ${f.cashKind === '給現金' ? 'selected' : ''}>給現金</option>
              <option ${f.cashKind === '結清還款' ? 'selected' : ''}>結清還款</option>
            </select></div>` : `
          <div class="field"><label for="f-sym">標的</label>
            <select id="f-sym">
              <option value="">請選擇</option>
              ${(o.mom || []).map((s) => `<option ${f.symbol === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
              <option value="__other" ${f.symbol === '__other' ? 'selected' : ''}>其他（自己輸入）</option>
            </select></div>
          ${f.symbol === '__other' ? `<div class="field"><label for="f-custom">股票名稱或代號</label>
            <input id="f-custom" value="${esc(f.custom)}" autocomplete="off"></div>` : ''}`}
        <div class="field"><label for="f-amt">金額（正整數，正負號會自動決定）</label>
          <input id="f-amt" inputmode="numeric" pattern="[0-9]*" value="${esc(f.amount)}" autocomplete="off"></div>
        <div class="field"><label for="f-note">備註（選填）</label><input id="f-note" value="${esc(f.note)}" autocomplete="off"></div>
        <div id="f-check">${chk.block ? `<div class="block">${esc(chk.block)}</div>` : chk.warn ? `<div class="warn">${esc(chk.warn)}</div>` : ''}</div>
        <div class="preview" id="f-preview">${previewText(f)}</div>
        <button class="btn" id="f-submit">新增這筆</button>
        <div class="toast" id="f-toast"></div>
      </section>

      <h2>明細</h2>
      <div class="cats">
        ${['all', 'cash', 'trade', 'div'].map((k) => `<button class="cat" data-lcat="${k}" aria-pressed="${c === k}">
          <span class="cl">${CAT_LABEL[k]}</span><span class="cv num ${sum(catList(k)) < 0 ? 'neg-owe' : ''}">${signed(sum(catList(k)))}</span>
          <span class="cn">${catList(k).length} 筆</span></button>`).join('')}
      </div>
      <ul class="ledger">
        ${rows.map((t) => ledgerRow(t, c)).join('')}
      </ul>
      <button class="btn ghost switch" data-go="mom">看媽媽的畫面</button>
    `;
    bindForm();
  }

  function ledgerRow(t, c) {
    const runLabel = c === 'all' ? '媽媽累計餘額' : '這類累計';
    const editing = state.editing === t.id;
    return `<li data-id="${esc(t.id)}">
      <div class="top"><span><span class="num">${md(t.date)}</span>　${esc(typeLabel(t))}</span>
        <b class="num ${t.amount > 0 ? 'pos' : ''}">${signed(t.amount)}</b></div>
      <div class="meta"><span>${esc(t.note)}</span><span class="num">${runLabel} ${signed(t.run)}</span></div>
      ${editing ? `<div class="editrow">
          <input type="date" id="e-date" value="${esc(t.date)}">
          <input id="e-amt" inputmode="numeric" value="${Math.abs(t.amount)}">
          <input class="wide" id="e-note" value="${esc(t.note)}" placeholder="備註">
        </div>
        <div class="acts"><button class="small" data-save="${esc(t.id)}">儲存</button><button class="small" data-cancel="1">取消</button></div>`
      : state.confirmDel === t.id
        ? `<div class="acts"><button class="small danger solid" data-delok="${esc(t.id)}">確定刪除</button><button class="small" data-cancel="1">不要刪</button></div>`
        : `<div class="acts"><button class="small" data-edit="${esc(t.id)}">編輯</button><button class="small danger" data-del="${esc(t.id)}">刪除</button></div>`}
    </li>`;
  }

  function bindForm() {
    const f = state.form;
    const upd = () => {
      const chk = checkSymbol(f);
      $('#f-check').innerHTML = chk.block ? `<div class="block">${esc(chk.block)}</div>` : chk.warn ? `<div class="warn">${esc(chk.warn)}</div>` : '';
      $('#f-preview').innerHTML = previewText(f);
    };
    $('#f-date').addEventListener('change', (e) => { f.date = e.target.value || today(); upd(); });
    if ($('#f-cash')) $('#f-cash').addEventListener('change', (e) => { f.cashKind = e.target.value; upd(); });
    if ($('#f-sym')) $('#f-sym').addEventListener('change', (e) => { f.symbol = e.target.value; renderEdit(); });
    if ($('#f-custom')) $('#f-custom').addEventListener('input', (e) => { f.custom = e.target.value; upd(); });
    $('#f-amt').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, ''); f.amount = e.target.value; upd(); });
    $('#f-note').addEventListener('input', (e) => { f.note = e.target.value; });
  }

  async function submit() {
    const f = state.form;
    const chk = checkSymbol(f);
    const toast = $('#f-toast');
    if (chk.block) return (toast.innerHTML = `<span class="error">${esc(chk.block)}</span>`);
    if (f.type !== '入金' && !formSymbol(f)) return (toast.innerHTML = '<span class="error">請選標的</span>');
    if (!/^\d+$/.test(f.amount) || Number(f.amount) <= 0) return (toast.innerHTML = '<span class="error">請輸入金額（正整數）</span>');
    const btn = $('#f-submit');
    btn.disabled = true;
    btn.textContent = '新增中…';
    f.pendingId = f.pendingId || newId(); // 重送同一筆不會重複
    try {
      const r = await api('stockAdd', {
        id: f.pendingId, type: f.type, date: f.date, cashKind: f.cashKind, symbol: formSymbol(f),
        amount: Number(f.amount), note: f.note.trim(), confirmNewSymbol: !!chk.warn,
      });
      await reload();
      state.form = Object.assign(newForm(), { type: f.type, date: f.date, cashKind: f.cashKind, symbol: f.symbol === '__other' ? r.tx.symbol : f.symbol });
      renderEdit();
      $('#f-toast').textContent = '已新增：' + md(r.tx.date) + ' ' + typeLabel(r.tx) + ' ' + signed(r.tx.amount) + (r.addedToMom ? '（已加進媽媽的股票清單）' : '');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '新增這筆';
      toast.innerHTML = `<span class="error">${esc(e.message)}</span>`;
    }
  }

  async function saveEdit(id) {
    const amt = $('#e-amt').value.replace(/\D/g, '');
    if (!amt || Number(amt) <= 0) return alertRow(id, '金額要是正整數');
    try {
      await api('stockEdit', { id, date: $('#e-date').value, amount: Number(amt), note: $('#e-note').value.trim() });
      state.editing = '';
      await reload();
      renderEdit();
    } catch (e) { alertRow(id, e.message); }
  }

  async function doDelete(id) {
    try {
      await api('stockDelete', { id });
      state.confirmDel = '';
      await reload();
      renderEdit();
      $('#f-toast').textContent = '已刪除';
    } catch (e) { alertRow(id, e.message); }
  }

  function alertRow(id, msg) {
    const li = document.querySelector(`li[data-id="${CSS.escape(id)}"] .acts`);
    if (li) li.insertAdjacentHTML('beforeend', `<span class="error">${esc(msg)}</span>`);
  }

  // ===== 點擊 =====
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t || t.disabled) return;
    const d = t.dataset;
    if (d.stock) {
      state.filter = state.filter === d.stock ? 'all' : d.stock;
      renderMom();
      if (state.filter !== 'all') $('#records').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (d.filter) { state.filter = d.filter; renderMom(); return; }
    if (d.go === 'mom') { state.mode = 'mom'; state.filter = 'all'; renderMom(); window.scrollTo(0, 0); return; }
    if (d.go === 'edit' && state.data.canWrite) { state.mode = 'edit'; renderEdit(); window.scrollTo(0, 0); return; }
    if (state.mode !== 'edit' || !state.data.canWrite) return; // 以下都是記帳畫面的按鈕
    if (d.type) { state.form.type = d.type; renderEdit(); return; }
    if (t.id === 'f-submit') return submit();
    if (d.lcat) { state.ledgerCat = d.lcat; renderEdit(); return; }
    if (d.del) { state.confirmDel = d.del; state.editing = ''; renderEdit(); return; }
    if (d.delok) return doDelete(d.delok);
    if (d.edit) { state.editing = d.edit; state.confirmDel = ''; renderEdit(); return; }
    if (d.save) return saveEdit(d.save);
    if (d.cancel) { state.editing = ''; state.confirmDel = ''; renderEdit(); return; }
  });

  async function reload() {
    state.data = await api('stockView');
  }

  function showMsg(text) {
    $('#app').innerHTML = `<div class="msg">${esc(text)}</div>`;
  }

  async function start() {
    try {
      if (!LOCAL_UID) {
        await liff.init({ liffId: CFG.LIFF_ID });
        if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return; }
      }
      await reload();
    } catch (e) {
      dlog('start 失敗 ' + e.code + ' ' + e.message);
      if (e.code === 'FORBIDDEN') return showMsg('你沒有權限看這本帳');
      return showMsg(e.message || '連不上，請關掉再重新打開');
    }
    // 只有後端說可以寫、而且是從記帳入口進來，才顯示記帳畫面
    state.mode = WANT_EDIT && state.data.canWrite ? 'edit' : 'mom';
    if (state.mode === 'edit') renderEdit(); else renderMom();
  }

  start();
})();
