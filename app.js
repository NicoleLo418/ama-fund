/* 基金記帳 — 前端（原生 JavaScript，不需要編譯）
 *
 * 結構：
 *   1. 設定與小工具
 *   2. 身分（LINE 登入 / 開發模式假身分）
 *   3. 呼叫後端 API
 *   4. 畫面：分頁、記一筆、總覽
 *   5. 彈出視窗
 *   6. 啟動
 */
(function () {
  'use strict';

  // ===== 1. 設定與小工具 =====
  const CFG = window.APP_CONFIG || {};
  const CATEGORIES = ['菜肉', '水果', '日用品', '醫療', '車資', '給零用錢', '其他'];

  // 畫面上的稱呼：從試算表「設定」表的「管理人稱呼」「長輩稱呼」讀取（後端透過 me 回傳），
  // 並存在手機裡，下次打開不用等後端就能顯示正確的稱呼
  const LABELS_KEY = 'ama-fund.labels.v1';
  const DEFAULT_LABELS = { manager: '大哥', elder: '阿母' };
  let L = Object.assign({}, DEFAULT_LABELS);
  const appTitle = () => L.elder + '基金記帳';
  const MAX_DIGITS = 6;
  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

  const params = new URLSearchParams(location.search);
  // 沒設定 LIFF_ID，或網址加上 ?dev，就用開發模式（瀏覽器測試用假身分）
  const DEV = !CFG.LIFF_ID || params.has('dev');
  const DEV_USERS = [
    { userId: 'dev-xiuhui', displayName: '秀慧（測試）' },
    { userId: 'dev-xiaomi', displayName: '小咪（測試）' },
    { userId: 'dev-dad', displayName: '大哥（測試）' },
  ];

  const $ = (sel) => document.querySelector(sel);
  const APP_VERSION = '2026-09-26c';
  const dlog = window.__debugLog || function () {}; // 診斷模式（?debug=1）才有作用

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function money(n) {
    return Number(n || 0).toLocaleString('en-US');
  }

  function toDateStr(d) {
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function today() {
    return toDateStr(new Date());
  }

  /** 2026-09-25 → 「今天」「昨天」或「9月25日（四）」 */
  function friendlyDate(s) {
    if (!s) return '';
    if (s === today()) return '今天';
    const y = new Date(); y.setDate(y.getDate() - 1);
    if (s === toDateStr(y)) return '昨天';
    const [yy, mm, dd] = s.split('-').map(Number);
    const d = new Date(yy, mm - 1, dd);
    return mm + '月' + dd + '日（' + WEEKDAYS[d.getDay()] + '）';
  }

  function shortDate(s) {
    if (!s) return '';
    const [, mm, dd] = s.split('-').map(Number);
    return mm + '/' + dd;
  }

  function newRequestId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  // ===== 2. 身分 =====
  function currentDevUser() {
    let id = null;
    try { id = localStorage.getItem('devUserId'); } catch (e) { /* 無法存取就用預設 */ }
    return DEV_USERS.find((u) => u.userId === id) || DEV_USERS[0];
  }

  function setupDevBar() {
    const bar = $('#devbar');
    const sel = $('#dev-user');
    bar.hidden = false;
    sel.innerHTML = DEV_USERS.map((u) =>
      `<option value="${esc(u.userId)}">${esc(u.displayName)}（${esc(u.userId)}）</option>`
    ).join('');
    sel.value = currentDevUser().userId;
    sel.addEventListener('change', () => {
      try { localStorage.setItem('devUserId', sel.value); } catch (e) { /* 忽略 */ }
      location.reload();
    });
  }

  /** LINE 登入：成功回傳 true；需要跳轉去登入時回傳 false */
  async function initLiff() {
    await liff.init({ liffId: CFG.LIFF_ID });
    dlog('liff.init 完成 inClient=' + liff.isInClient() + ' os=' + liff.getOS() + ' LINE=' + liff.getLineVersion() +
      ' sdk=' + liff.getVersion() + ' context=' + JSON.stringify(liff.getContext() && liff.getContext().type));
    if (!liff.isLoggedIn()) {
      liff.login({ redirectUri: location.href });
      return false;
    }
    return true;
  }

  /** 登入過期時重新登入一次（用 sessionStorage 記錄，避免無限循環） */
  function relogin() {
    let tried = false;
    try { tried = sessionStorage.getItem('relogin') === '1'; sessionStorage.setItem('relogin', '1'); } catch (e) { /* 忽略 */ }
    if (tried) return false;
    liff.logout();
    liff.login({ redirectUri: location.href });
    return true;
  }

  let liffReady = Promise.resolve(true);

  /** 每個請求都附上的身分資料（後端會向 LINE 驗證 idToken） */
  function authPayload() {
    if (DEV) return { dev: currentDevUser() };
    return { idToken: liff.getIDToken() };
  }

  // ===== 3. 呼叫後端 API =====
  /** 呼叫後端。Google 偶爾會回錯誤網頁而不是資料，這時自動重試一次。
   *  寫入類動作都帶 requestId，就算第一次其實已寫入，重試也不會記成兩筆。 */
  async function api(action, data) {
    try {
      apiTries = 1;
      return await apiOnce(action, data);
    } catch (e) {
      if (!e.retryable) throw e;
      dlog('api ' + action + ' 第一次失敗（' + e.detail + '），自動重試');
      await new Promise((r) => setTimeout(r, 800));
      apiTries = 2;
      return apiOnce(action, data);
    }
  }

  async function apiOnce(action, data) {
    await liffReady;
    const body = Object.assign({ action: action }, data || {}, authPayload());
    const ctrl = new AbortController();
    // Google 後端閒置後第一次回應可能要 30 秒以上，所以等久一點
    const timer = setTimeout(() => ctrl.abort(), 60000);
    const slowTimer = setTimeout(() => {
      document.querySelectorAll('.slow-hint').forEach((el) => { el.hidden = false; });
    }, 8000);
    let json;
    try {
      const res = await fetch(CFG.API_URL || CFG.GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // 用 text/plain 避免 CORS 預檢
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      try {
        json = JSON.parse(text);
      } catch (e) {
        throw Object.assign(new Error('網路不穩，請再按一次'), {
          retryable: true, detail: 'HTTP ' + res.status + ' 非資料：' + text.slice(0, 60).replace(/s+/g, ' '),
        });
      }
    } catch (e) {
      if (e.retryable) throw e;
      const timedOut = e.name === 'AbortError';
      throw Object.assign(new Error('網路不穩，請再按一次'), { retryable: !timedOut, detail: e.name + ' ' + e.message });
    } finally {
      clearTimeout(timer);
      clearTimeout(slowTimer);
      document.querySelectorAll('.slow-hint').forEach((el) => { el.hidden = true; });
    }
    lastMeta = { idle: json._idle, script: json._t ? json._t['程式總計'] : null };
    if (!json.ok) {
      const err = new Error(json.error || '系統出了點問題，請再按一次');
      err.code = json.code;
      if (json.code === 'PENDING') showPending(); // 還沒核准（或被改回待核准）
      throw err;
    }
    return json.data;
  }
  let lastMeta = {};
  let apiTries = 1; // 最近一次 api() 總共送了幾次（含自動重試）

  // ===== 4. 畫面 =====
  const state = {
    me: null,
    tab: '', // 目前的分頁（'' ＝ 還沒顯示任何分頁）
    form: null,
    requestId: null, // 同一筆送出重試時沿用，避免重複記帳
  };

  // 表單模式：claim＝代墊（記一筆）、expense＝管理人支出、withdraw＝從長輩帳戶領錢、stocktake＝盤點
  const MODES = {
    claim: { type: '代墊', category: true, note: true },
    expense: { type: '支出', category: true, note: true },
    withdraw: { type: '領出', category: false, note: true },
    stocktake: { type: '盤點', category: false, note: false },
  };

  function newForm(mode) {
    return { mode: mode || 'claim', category: '', amount: '', note: '', date: today(), target: '' };
  }

  const isAdmin = () => !!(state.me && state.me.role === 'admin');

  const TABS = [
    { id: 'add', icon: '✏️', label: () => '記一筆', render: () => renderAdd() },
    { id: 'claims', icon: '🧾', label: () => '我的請款', render: () => renderClaims() },
    { id: 'overview', icon: '📊', label: () => '總覽', render: () => renderOverview() },
    { id: 'admin', icon: '🔑', label: () => L.manager + '專用', render: () => renderAdmin(), admin: true },
  ];
  const visibleTabs = () => TABS.filter((t) => !t.admin || isAdmin());

  function renderTabs() {
    const nav = $('#tabs');
    nav.hidden = false;
    nav.innerHTML = visibleTabs().map((t) =>
      `<button class="tab" data-tab="${t.id}" ${t.id === state.tab ? 'aria-current="page"' : ''}>
         <span class="icon" aria-hidden="true">${t.icon}</span>${esc(t.label())}
       </button>`
    ).join('');
  }

  function showTab(id) {
    dlog('showTab(' + id + ')');
    state.tab = id;
    renderTabs();
    if (id === 'admin') state.adminView = 'home';
    const tab = visibleTabs().find((t) => t.id === id) || TABS[0];
    $('#page-title').textContent = tab.label();
    renderTestBanner();
    window.scrollTo(0, 0);
    Promise.resolve().then(tab.render).catch((e) => {
      dlog('畫面 ' + id + ' 出錯：' + e.message);
      $('#app').innerHTML = `<div class="error-box">讀取失敗，請再按一次</div>
        <button class="btn btn-primary" data-tab="${id}">再試一次</button>`;
    });
  }

  // ----- 記一筆 -----
  function renderAdd() {
    if (!state.form || state.form.mode !== 'claim') state.form = newForm('claim');
    renderForm();
  }

  /** 通用表單：記一筆（代墊）／記支出／領錢／盤點 */
  function renderForm() {
    const f = state.form;
    const m = MODES[f.mode];
    let n = 0;
    const step = (title) => `<h2 class="section-title">${++n}. ${title}</h2>`;
    const back = state.tab === 'admin'
      ? `<button class="btn back-btn" data-admin="home">← 回${esc(L.manager)}專用</button>` : '';
    const heading = { expense: L.manager + '記支出', withdraw: '從' + L.elder + '帳戶領錢', stocktake: '盤點手上的現金' }[f.mode];
    const whoPicker = f.mode === 'claim' && isAdmin() ? `
      <section class="section">
        <h2 class="section-title">幫誰記？</h2>
        <select class="text-input" id="target">
          <option value="">自己（${esc(state.me.name)}）</option>
          ${(state.members || []).filter((x) => x.userId !== state.me.userId).map((x) =>
            `<option value="${esc(x.userId)}" ${x.userId === f.target ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
        </select>
      </section>` : '';
    $('#app').innerHTML = `
      ${back}
      ${heading ? `<h2 class="form-heading">${esc(heading)}</h2>` : ''}
      ${whoPicker}
      ${m.category ? `<section class="section">
        ${step(f.mode === 'expense' ? '買了什麼？' : '買了什麼？')}
        <div class="cat-grid">
          ${CATEGORIES.map((c) =>
            `<button class="cat-btn" data-cat="${esc(c)}" aria-pressed="${c === f.category}">${esc(c)}</button>`
          ).join('')}
        </div>
      </section>` : ''}

      <section class="section">
        ${step(f.mode === 'stocktake' ? '手上實際有多少現金？' : f.mode === 'withdraw' ? '領了多少錢？' : '多少錢？')}
        <div class="amount-display" id="amount-display"></div>
        <div class="keypad">
          ${['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) =>
            `<button class="key" data-key="${k}">${k}</button>`).join('')}
          <button class="key fn" data-key="clear">清除</button>
          <button class="key" data-key="0">0</button>
          <button class="key fn" data-key="back" aria-label="退格">⌫ 退格</button>
        </div>
      </section>

      ${m.note ? `<section class="section">
        ${step('說明 <span class="hint">（可不填）</span>')}
        <input class="text-input" id="note" type="text" maxlength="100"
               placeholder="${f.mode === 'withdraw' ? '例：從' + esc(L.elder) + '帳戶領出' : '例：雞肉、葡萄'}" value="${esc(f.note)}" enterkeyhint="done">
      </section>` : ''}

      <section class="section">
        ${step('哪一天？')}
        <div class="date-row">
          <span class="date-text" id="date-text">${esc(friendlyDate(f.date))}</span>
          <input class="text-input" id="date" type="date" value="${esc(f.date)}" max="${today()}"
                 aria-label="改日期">
        </div>
      </section>

      <section class="section">
        <button class="btn btn-primary" id="submit">送出</button>
      </section>
    `;
    updateAmount();

    if ($('#note')) {
      $('#note').addEventListener('input', (e) => { f.note = e.target.value; });
      $('#note').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
    }
    if ($('#target')) $('#target').addEventListener('change', (e) => { f.target = e.target.value; });
    if (f.mode === 'claim' && isAdmin() && !state.members) loadMembers();
    $('#date').addEventListener('change', (e) => {
      f.date = e.target.value || today();
      $('#date-text').textContent = friendlyDate(f.date);
    });
  }

  function updateAmount() {
    const el = $('#amount-display');
    if (!el) return;
    el.innerHTML = state.form.amount
      ? `<span class="num">${money(state.form.amount)}</span><span class="unit">元</span>`
      : '<span class="num empty">請按下面的數字</span>';
  }

  function pressKey(k) {
    const f = state.form;
    if (k === 'clear') f.amount = '';
    else if (k === 'back') f.amount = f.amount.slice(0, -1);
    else if (f.amount === '0') f.amount = k === '0' ? '0' : k;
    else if (f.amount.length < MAX_DIGITS && !(f.amount === '' && k === '0' && f.mode !== 'stocktake')) f.amount += k;
    updateAmount();
  }

  function selectCategory(c) {
    state.form.category = c;
    document.querySelectorAll('.cat-btn').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.cat === c));
    });
  }

  async function loadMembers() {
    try {
      state.members = (await api('members')).members;
      if (state.form && state.form.mode === 'claim' && $('#target') === null && state.tab === 'add') renderForm();
    } catch (e) { /* 選人清單拿不到就只能記自己 */ }
  }

  function confirmAdd() {
    const f = state.form;
    const m = MODES[f.mode];
    if (m.category && !f.category) return showMessage('還沒選分類', '請先按上面「買了什麼？」的其中一個按鈕。');
    if (!f.amount) return showMessage('還沒輸入金額', '請用數字按鈕輸入金額。');
    if (!state.requestId) state.requestId = newRequestId();

    const targetName = f.target ? ((state.members || []).find((x) => x.userId === f.target) || {}).name : '';
    const what = { claim: (targetName ? targetName + ' 代墊・' : '') + f.category, expense: L.manager + '支出・' + f.category,
      withdraw: '從' + L.elder + '帳戶領出', stocktake: '手上現金' }[f.mode];
    const noteLine = f.note.trim() ? `<br>（${esc(f.note.trim())}）` : '';
    showModal(`
      <p class="modal-title">對嗎？</p>
      <p class="modal-body">
        ${esc(friendlyDate(f.date))}・${esc(what)}
        <span class="modal-big">${money(f.amount)} 元</span>
        ${noteLine}
      </p>
      <p class="hint slow-hint" hidden>網路比較慢，請再等一下，不要關掉…</p>
      <div id="modal-error"></div>
      <div class="btn-row">
        <button class="btn btn-primary" data-modal="send">對，送出</button>
        <button class="btn" data-modal="close">返回修改</button>
      </div>
    `, { send: sendAdd });
  }

  async function sendAdd() {
    const f = state.form;
    setModalBusy(true, '送出中…');
    try {
      const result = await api('addEntry', {
        requestId: state.requestId,
        type: MODES[f.mode].type,
        category: MODES[f.mode].category ? f.category : '',
        amount: Number(f.amount),
        note: f.note.trim(),
        date: f.date,
        targetUserId: f.mode === 'claim' && f.target ? f.target : undefined,
      });
      state.requestId = null;
      const mode = f.mode;
      state.form = newForm(mode);
      const e = result.entry;
      let body;
      if (mode === 'claim') {
        if (state.me && e.targetUserId === state.me.userId) state.me.pendingTotal = result.pendingTotal;
        body = `${esc(e.category)} ${money(e.amount)} 元<br><br>${esc(e.targetName)}目前還沒拿到：
          <span class="modal-big">${money(result.pendingTotal)} 元</span>`;
      } else if (mode === 'stocktake') {
        const st = result.stocktake;
        body = `數到 ${money(st.counted)} 元<br>帳上應有 ${money(st.expected)} 元<br><br>${diffText(st.diff)}`;
      } else {
        body = `${mode === 'expense' ? esc(e.category) + ' ' : ''}${money(e.amount)} 元<br><br>${esc(L.manager)}手上的現金（帳上）：
          <span class="modal-big">${money(result.fundBalance)} 元</span>`;
      }
      showModal(`
        <p class="modal-title">✅ 記好了！</p>
        <p class="modal-body">${body}</p>
        <button class="btn btn-primary" data-modal="close">好</button>
      `);
      if (state.tab === 'admin') { state.adminView = 'home'; renderAdmin(); } else renderForm();
    } catch (e) {
      setModalBusy(false);
      const box = $('#modal-error'); // 待核准時彈出視窗已被關掉
      if (box) box.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
    }
  }

  // ----- 總覽 -----
  const TYPE_LABEL = {
    代墊: (e) => `${e.targetName} 代墊`,
    付款: (e) => `${L.manager}付給 ${e.targetName}`,
    支出: () => `${L.manager}支出`,
    領出: () => `從${L.elder}帳戶領出`,
    盤點: () => '盤點現金',
  };

  function diffText(diff) {
    if (diff === 0) return '<b>剛好，沒有差</b>';
    return diff > 0 ? `<span class="diff-plus">多了 ${money(diff)} 元</span>` : `<span class="diff-minus">少了 ${money(-diff)} 元</span>`;
  }

  function entryItem(e, opts) {
    const title = (TYPE_LABEL[e.type] || (() => e.type))(e);
    const tag = e.type !== '代墊' ? ''
      : e.status === '已付' ? '<span class="tag tag-paid">已付</span>'
      : '<span class="tag tag-pending">待付</span>';
    const sub = [shortDate(e.date), e.category, e.note].filter(Boolean).map(esc).join('・');
    return `<li>
      <div class="entry-main">
        <div class="entry-title">${esc(title)}${tag}</div>
        <div class="entry-sub">${sub}</div>
      </div>
      <div class="entry-side">
        <div class="amount">${money(e.amount)} 元</div>
        ${opts && opts.deletable ? `<button class="small-btn danger" data-del="${esc(e.id)}">刪除</button>` : ''}
      </div>
    </li>`;
  }

  // 上一次看到的總覽存在這支手機裡，下次打開先顯示，不用乾等後端
  const OVERVIEW_KEY = 'ama-fund.overview.v1';

  /** 檢查總覽資料的格式是否完整（缺欄位就不要拿來畫） */
  function isOverview(d) {
    return !!d && typeof d === 'object' && typeof d.month === 'string' &&
      Array.isArray(d.members) && Array.isArray(d.monthCategories) && Array.isArray(d.recent);
  }

  function describeData(d) {
    if (d === null || typeof d !== 'object') return typeof d + ' ' + String(d).slice(0, 80);
    return 'keys=' + Object.keys(d).join(',');
  }

  function loadSavedOverview() {
    try {
      // 舊版用的名稱：記錄內容以便診斷，然後清掉
      const legacy = localStorage.getItem('overview');
      if (legacy !== null) {
        dlog('舊版存檔 overview（' + legacy.length + ' 字）：' + legacy.slice(0, 200));
        localStorage.removeItem('overview');
      }
      const d = JSON.parse(localStorage.getItem(OVERVIEW_KEY) || 'null');
      if (d && !isOverview(d)) {
        dlog('手機存的總覽格式不對，丟掉：' + describeData(d));
        localStorage.removeItem(OVERVIEW_KEY);
        return null;
      }
      return d;
    } catch (e) {
      return null;
    }
  }

  function saveOverview(d) {
    try { localStorage.setItem(OVERVIEW_KEY, JSON.stringify(d)); } catch (e) { /* 存不了就算了 */ }
  }

  function showOverviewError(message) {
    const box = `<div class="error-box">${esc(message)}</div>
      <button class="btn btn-primary" id="retry">再試一次</button>`;
    const status = $('#overview-status');
    if (status) status.innerHTML = box;
    else $('#app').innerHTML = box;
    $('#retry').addEventListener('click', renderOverview);
  }

  /** 畫總覽；萬一資料有問題，顯示「讀取失敗」而不是卡住 */
  function safeDrawOverview(d, updating) {
    try {
      drawOverview(d, updating);
      return true;
    } catch (e) {
      dlog('drawOverview 失敗：' + e.message + ' 資料 ' + describeData(d));
      return false;
    }
  }

  async function renderOverview() {
    const app = $('#app');
    const saved = loadSavedOverview();
    const showedSaved = saved && safeDrawOverview(saved, true);
    if (!showedSaved) app.innerHTML = '<div class="loading-page"><div class="spinner"></div><p>載入中…</p><p class="hint slow-hint" hidden>網路比較慢，請再等一下…</p></div>';

    let d;
    try {
      d = await api('overview');
    } catch (e) {
      if (state.tab === 'overview') showOverviewError(e.message);
      return;
    }
    if (!isOverview(d)) {
      dlog('後端回傳的總覽格式不對：' + describeData(d));
      if (state.tab === 'overview') showOverviewError('讀取失敗，請再按一次');
      return;
    }
    saveOverview(d);
    if (state.tab !== 'overview') return; // 載入時已切到別的分頁
    if (!safeDrawOverview(d, false)) showOverviewError('讀取失敗，請再按一次');
  }

  /** updating = true：畫面是上次存的舊資料，最上面顯示「更新中」 */
  function drawOverview(d, updating) {
    const app = $('#app');

    const st = d.lastStocktake;
    const stocktake = !st ? '' : `
      <p class="hint">上次盤點（${esc(shortDate(st.date))}）：數到 ${money(st.counted)} 元，
        帳上應有 ${money(st.expected)} 元，
        ${diffText(st.diff)}
      </p>`;

    const max = Math.max(1, ...d.monthCategories.map((c) => c.amount));
    const monthNum = Number(d.month.split('-')[1]);

    app.innerHTML = `
      <div id="overview-status">${updating
        ? '<p class="updating"><span class="spinner"></span>正在更新最新資料…<span class="slow-hint" hidden>（網路比較慢，請再等一下）</span></p>'
        : ''}</div>
      <section class="section card">
        <div class="stat-label">大家還沒拿到的錢</div>
        <div class="big-number">${money(d.pendingTotal)} 元</div>
        <ul class="list">
          ${d.members.map((m) => `<li>
            <span>${esc(m.name)}</span>
            <span class="amount ${m.pending ? '' : 'zero'}">${m.pending ? money(m.pending) + ' 元' : '已結清'}</span>
          </li>`).join('') || '<li>還沒有人使用</li>'}
        </ul>
      </section>

      <section class="section card">
        <div class="stat-label">${esc(L.manager)}手上的現金（帳上應有）</div>
        <div class="big-number">${money(d.fundBalance)} 元</div>
        ${stocktake}
      </section>

      <section class="section card">
        <div class="stat-label">${monthNum} 月花了多少</div>
        <div class="big-number">${money(d.monthTotal)} 元</div>
        ${d.monthCategories.map((c) => `
          <div class="bar-row">
            <span>${esc(c.category)}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${(c.amount / max * 100).toFixed(1)}%"></div></div>
            <span class="bar-value">${money(c.amount)}</span>
          </div>`).join('')}
      </section>

      <section class="section card">
        <div class="stat-label">最近 20 筆</div>
        <ul class="list">
          ${d.recent.map((e) => entryItem(e, { deletable: isAdmin() })).join('') || '<li>還沒有紀錄</li>'}
        </ul>
      </section>
    `;
  }

  // ----- 測試模式提示 -----
  function renderTestBanner() {
    let el = $('#test-banner');
    const on = !!(state.me && state.me.tester);
    if (!on) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'test-banner';
      el.className = 'test-banner';
      document.body.insertBefore(el, document.body.firstChild);
    }
    el.textContent = '🧪 測試中：你新增、修改、刪除的紀錄都會標記為「測試」，之後可以一次還原';
  }

  // ----- 我的請款 -----
  async function renderClaims() {
    const app = $('#app');
    app.innerHTML = '<div class="loading-page"><div class="spinner"></div><p>載入中…</p></div>';
    let d;
    try {
      d = await api('myClaims');
    } catch (e) {
      if (state.tab === 'claims') showPageError(e.message, 'claims');
      return;
    }
    if (state.tab !== 'claims') return;
    app.innerHTML = `
      <section class="section card">
        <div class="stat-label">還沒拿到</div>
        <div class="big-number">${money(d.pendingTotal)} 元</div>
        ${d.pending.length ? '' : '<p>目前沒有待付的紀錄 👍</p>'}
        <ul class="list">
          ${d.pending.map((e) => entryItem(e, { deletable: true })).join('')}
        </ul>
      </section>
      <details class="section card">
        <summary class="stat-label">已經拿到的（最近 ${d.paid.length} 筆）</summary>
        <ul class="list">
          ${d.paid.map((e) => entryItem(e)).join('') || '<li>還沒有</li>'}
        </ul>
      </details>
    `;
  }

  function showPageError(message, tab) {
    $('#app').innerHTML = `<div class="error-box">${esc(message)}</div>
      <button class="btn btn-primary" data-tab="${tab}">再試一次</button>`;
  }

  // ----- 管理人專用 -----
  function adminGo(view) {
    if (view === 'home') { state.adminView = 'home'; return renderAdmin(); }
    state.adminView = view; // expense / withdraw / stocktake
    state.form = newForm(view);
    state.requestId = null;
    window.scrollTo(0, 0);
    renderForm();
  }

  async function renderAdmin() {
    if (state.adminView && state.adminView !== 'home') return renderForm();
    const app = $('#app');
    app.innerHTML = '<div class="loading-page"><div class="spinner"></div><p>載入中…</p></div>';
    let d, ov;
    try {
      [d, ov] = await Promise.all([api('pendingByPerson'), api('overview')]);
    } catch (e) {
      if (state.tab === 'admin') showPageError(e.message, 'admin');
      return;
    }
    if (state.tab !== 'admin' || state.adminView !== 'home') return;
    state.pendingPeople = d.people;
    const st = d.lastStocktake;
    app.innerHTML = `
      <section class="section card">
        <div class="stat-label">${esc(L.manager)}手上的現金（帳上應有）</div>
        <div class="big-number">${money(d.fundBalance)} 元</div>
        ${st ? `<p class="hint">上次盤點（${esc(shortDate(st.date))}）：數到 ${money(st.counted)} 元，帳上應有 ${money(st.expected)} 元，${diffText(st.diff)}</p>` : ''}
        <div class="btn-row admin-actions">
          <button class="btn" data-admin="expense">🛒 記支出</button>
          <button class="btn" data-admin="withdraw">🏧 從${esc(L.elder)}帳戶領錢</button>
          <button class="btn" data-admin="stocktake">🧮 盤點</button>
        </div>
      </section>

      <section class="section card">
        <div class="stat-label">待付清單</div>
        ${d.people.length ? '' : '<p>目前沒有人需要付 👍</p>'}
        ${d.people.map((g) => `
          <div class="pay-group">
            <div class="pay-head">
              <span class="pay-name">${esc(g.name)}</span>
              <span class="amount">${money(g.total)} 元</span>
            </div>
            <button class="btn btn-primary" data-payall="${esc(g.userId)}">全部付清 ${money(g.total)} 元</button>
            <details>
              <summary>看明細（${g.entries.length} 筆）</summary>
              <ul class="list">
                ${g.entries.map((e) => `<li>
                  <div class="entry-main">
                    <div class="entry-title">${esc(e.category)} ${money(e.amount)} 元</div>
                    <div class="entry-sub">${[shortDate(e.date), e.note].filter(Boolean).map(esc).join('・')}</div>
                  </div>
                  <button class="small-btn" data-payone="${esc(g.userId)}|${esc(e.id)}">已付</button>
                </li>`).join('')}
              </ul>
            </details>
          </div>`).join('')}
      </section>

      <section class="section card">
        <div class="stat-label">最近 20 筆（可刪除）</div>
        <ul class="list">
          ${ov.recent.map((e) => entryItem(e, { deletable: true })).join('') || '<li>還沒有紀錄</li>'}
        </ul>
      </section>
    `;
  }

  function confirmPay(userId, entryId) {
    const g = (state.pendingPeople || []).find((x) => x.userId === userId);
    if (!g) return;
    const e = entryId ? g.entries.find((x) => x.id === entryId) : null;
    const amount = e ? e.amount : g.total;
    state.requestId = newRequestId();
    showModal(`
      <p class="modal-title">確定付錢？</p>
      <p class="modal-body">
        付給 ${esc(g.name)}
        <span class="modal-big">${money(amount)} 元</span>
        ${e ? `（${esc(e.category)}${e.note ? '：' + esc(e.note) : ''}）` : `（全部 ${g.entries.length} 筆）`}
      </p>
      <p class="hint slow-hint" hidden>網路比較慢，請再等一下，不要關掉…</p>
      <div id="modal-error"></div>
      <div class="btn-row">
        <button class="btn btn-primary" data-modal="send">確定，已付</button>
        <button class="btn" data-modal="close">取消</button>
      </div>
    `, { send: () => sendPay(userId, entryId) });
  }

  async function sendPay(userId, entryId) {
    setModalBusy(true, '處理中…');
    try {
      const r = await api('pay', { requestId: state.requestId, targetUserId: userId, entryIds: entryId ? [entryId] : undefined });
      state.requestId = null;
      showModal(`
        <p class="modal-title">✅ 已付 ${esc(r.targetName)} ${money(r.amount)} 元</p>
        <p class="modal-body">${r.settled ? esc(r.targetName) + '已結清' : esc(r.targetName) + '還有 ' + money(r.remaining) + ' 元沒拿到'}<br><br>
          ${esc(L.manager)}手上的現金（帳上）：<span class="modal-big">${money(r.fundBalance)} 元</span></p>
        <button class="btn btn-primary" data-modal="close">好</button>
      `);
      if (state.tab === 'admin') renderAdmin();
    } catch (e) {
      setModalBusy(false);
      const box = $('#modal-error');
      if (box) box.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
    }
  }

  function confirmDelete(id) {
    const li = document.querySelector(`[data-del="${CSS.escape(id)}"]`);
    const title = li ? li.closest('li').querySelector('.entry-title').textContent : '';
    const amount = li ? li.closest('li').querySelector('.amount').textContent : '';
    state.requestId = newRequestId();
    showModal(`
      <p class="modal-title">要刪除這筆嗎？</p>
      <p class="modal-body">${esc(title)}<span class="modal-big">${esc(amount)}</span>
        刪除後不會出現在帳上（試算表仍會保留紀錄）</p>
      <p class="hint slow-hint" hidden>網路比較慢，請再等一下，不要關掉…</p>
      <div id="modal-error"></div>
      <div class="btn-row">
        <button class="btn btn-danger btn-primary" data-modal="send">確定刪除</button>
        <button class="btn" data-modal="close">不要刪</button>
      </div>
    `, { send: () => sendDelete(id) });
  }

  async function sendDelete(id) {
    setModalBusy(true, '刪除中…');
    try {
      const r = await api('deleteEntry', { requestId: state.requestId, id });
      state.requestId = null;
      showModal(`
        <p class="modal-title">✅ 已刪除</p>
        ${r.reverted ? `<p class="modal-body">相關的 ${r.reverted} 筆代墊已改回「待付」</p>` : ''}
        <button class="btn btn-primary" data-modal="close">好</button>
      `);
      const tab = TABS.find((t) => t.id === state.tab);
      if (tab) tab.render();
    } catch (e) {
      setModalBusy(false);
      const box = $('#modal-error');
      if (box) box.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
    }
  }

  // ===== 5. 彈出視窗 =====
  let modalHandlers = {};

  function showModal(html, handlers) {
    modalHandlers = handlers || {};
    $('#modal-box').innerHTML = html;
    $('#modal').hidden = false;
  }

  function hideModal() {
    $('#modal').hidden = true;
    $('#modal-box').innerHTML = '';
    modalHandlers = {};
  }

  function showMessage(title, body) {
    showModal(`
      <p class="modal-title">${esc(title)}</p>
      <p class="modal-body">${esc(body)}</p>
      <button class="btn btn-primary" data-modal="close">好</button>
    `);
  }

  /** 送出中：按鈕全部停用，主要按鈕顯示轉圈圈 */
  function setModalBusy(busy, text) {
    document.querySelectorAll('#modal-box button').forEach((b) => {
      b.disabled = busy;
      if (b.classList.contains('btn-primary')) {
        if (busy) { b.dataset.label = b.textContent; b.innerHTML = `<span class="spinner"></span>${esc(text)}`; }
        else if (b.dataset.label) b.textContent = b.dataset.label;
      }
    });
    if (busy) $('#modal-error').innerHTML = '';
  }

  // ===== 6. 啟動 =====
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t || t.disabled) return;
    dlog('app 收到點擊 → ' + (t.dataset.tab ? 'tab=' + t.dataset.tab : t.dataset.cat || t.dataset.key || t.dataset.modal || t.id));
    if (t.dataset.tab) return showTab(t.dataset.tab);
    if (t.dataset.cat) return selectCategory(t.dataset.cat);
    if (t.dataset.key) return pressKey(t.dataset.key);
    if (t.id === 'submit') return confirmAdd();
    if (t.dataset.del) return confirmDelete(t.dataset.del);
    if (t.dataset.payall) return confirmPay(t.dataset.payall, null);
    if (t.dataset.payone) return confirmPay(t.dataset.payone.split('|')[0], t.dataset.payone.split('|')[1]);
    if (t.dataset.admin) return adminGo(t.dataset.admin);
    if (t.dataset.modal === 'close') return hideModal();
    if (t.dataset.modal && modalHandlers[t.dataset.modal]) return modalHandlers[t.dataset.modal]();
  });

  // ----- 開啟速度 -----
  // ready：從網頁開始載入到「記一筆」可以按的毫秒數；mode：cached＝已核准直接顯示、first＝等後端確認
  const openInfo = { ready: null, mode: '' };

  function markReady(mode) {
    if (openInfo.ready !== null) return;
    openInfo.ready = Math.round(performance.now());
    openInfo.mode = mode;
    dlog('畫面可用（' + mode + '）');
  }

  async function start() {
    dlog('app.js 版本 ' + APP_VERSION + ' DEV=' + DEV);
    if (DEV) setupDevBar();
    applyLabels(loadJSON(LABELS_KEY));

    // 已核准過的人：連 LINE 登入都不等，「記一筆」馬上顯示；登入與身分確認在背景做。
    // （後端每次寫入/讀取都會再檢查核准狀態，安全性不變）
    const guessUid = DEV ? currentDevUser().userId : loadJSON(LAST_UID_KEY);
    let fast = isApprovedCached(guessUid);
    if (fast) {
      state.uid = guessUid;
      showTab('add');
      markReady('cached');
    }

    if (!DEV) {
      liffReady = initLiff();
      let loggedIn;
      try {
        loggedIn = await liffReady;
      } catch (e) {
        showFatal('連不上 LINE，請關掉再從群組重新打開');
        return;
      }
      if (!loggedIn) return; // 正在跳轉到 LINE 登入
    }

    const uid = currentUid();
    saveJSON(LAST_UID_KEY, uid);
    if (fast && uid !== state.uid) {
      // 這支手機換了 LINE 帳號：改回「等後端確認」
      dlog('LINE 帳號與上次不同，改為等後端確認');
      fast = false;
      state.tab = '';
      $('#tabs').hidden = true;
      $('#app').innerHTML = LOADING_FIRST;
    }
    state.uid = uid;

    if (fast) {
      loadMe(false);
    } else {
      // 第一次使用（或尚未核准）：要等後端確認身分，才決定顯示什麼
      $('#app').innerHTML = LOADING_FIRST;
      await loadMe(true);
      if (state.me && state.me.approved) {
        showTab('add');
        markReady('first');
        const p = loadJSON(PERF_KEY); // 補上這次的「畫面可用」時間
        if (p) saveJSON(PERF_KEY, Object.assign(p, { ready: openInfo.ready, mode: openInfo.mode }));
      }
    }
  }

  const LAST_UID_KEY = 'ama-fund.lastUid.v1';
  const LOADING_FIRST = `<div class="loading-page"><div class="spinner"></div>
    <p>正在確認你的身分，請稍等…</p>
    <p class="hint">第一次打開會比較久，之後就會很快。</p></div>`;

  /** 套用稱呼：標題、以及目前畫面上用到稱呼的地方 */
  function applyLabels(labels) {
    const next = Object.assign({}, DEFAULT_LABELS, labels || {});
    const changed = next.manager !== L.manager || next.elder !== L.elder;
    L = next;
    document.title = appTitle();
    if (!state.tab || state.tab === 'pending') $('#page-title').textContent = appTitle();
    return changed;
  }

  /** blocking = true：畫面還沒顯示任何東西，失敗時要整頁提示 */
  async function loadMe(blocking) {
    const perf = loadJSON(PERF_KEY);
    const t0 = Date.now();
    try {
      state.me = await api('me', perf ? { perf: perf } : {});
      // 記下這次打開等了多久，下次打開時交給後端寫進「效能紀錄」
      saveJSON(PERF_KEY, { ms: Date.now() - t0, at: t0, idle: lastMeta.idle, script: lastMeta.script,
        ready: openInfo.ready, mode: openInfo.mode, tries: apiTries });
      if (state.me.labels) {
        saveJSON(LABELS_KEY, state.me.labels);
        if (applyLabels(state.me.labels) && state.tab === 'overview') renderOverview();
      }
      dlog('me 成功 role=' + state.me.role + ' 核准=' + state.me.approved + ' 花 ' + (Date.now() - t0) + 'ms');
      try { sessionStorage.removeItem('relogin'); } catch (e) { /* 忽略 */ }
      $('#who').textContent = '你好，' + state.me.name;
      if (!state.me.approved) return showPending();
      setApprovedCache(state.uid, true);
      renderTestBanner();
      if (!blocking) renderTabs();
    } catch (e) {
      dlog('me 失敗 ' + e.code + ' ' + e.message);
      if (e.code === 'PENDING') return; // showPending 已處理
      if (!DEV && e.code === 'AUTH' && relogin()) return;
      // 已核准過的人：網路不穩時先不打擾，送出時會再提示；登入或設定問題才整頁顯示
      if (blocking || e.code === 'AUTH' || e.code === 'CONFIG') showFatal(e.message);
    }
  }

  // ----- 核准狀態 -----
  const APPROVED_KEY = 'ama-fund.approved.v1';
  const PERF_KEY = 'ama-fund.perf.v1';

  function loadJSON(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }

  function saveJSON(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* 存不了就算了 */ }
  }

  function currentUid() {
    if (DEV) return currentDevUser().userId;
    try { return (liff.getDecodedIDToken() || {}).sub || ''; } catch (e) { return ''; }
  }

  function isApprovedCached(uid) {
    const list = loadJSON(APPROVED_KEY);
    return !!uid && Array.isArray(list) && list.indexOf(uid) >= 0;
  }

  function setApprovedCache(uid, approved) {
    if (!uid) return;
    const list = (loadJSON(APPROVED_KEY) || []).filter((u) => u !== uid);
    if (approved) list.push(uid);
    saveJSON(APPROVED_KEY, list);
  }

  /** 待核准畫面：不能記帳、不能看總覽 */
  function showPending() {
    state.tab = 'pending';
    setApprovedCache(state.uid, false);
    saveJSON(OVERVIEW_KEY, null); // 不留帳務資料在手機上
    hideModal();
    $('#tabs').hidden = true;
    $('#page-title').textContent = appTitle();
    const name = state.me && state.me.name ? esc(state.me.name) + '，' : '';
    $('#app').innerHTML = `
      <section class="section card pending-card">
        <p class="pending-icon" aria-hidden="true">⏳</p>
        <p class="pending-title">請等待管理員確認</p>
        <p>${name}你好！<br>第一次使用，要先請管理員確認身分。</p>
        <p>管理員確認好之後，按下面的按鈕就可以開始記帳。</p>
        <button class="btn btn-primary" id="recheck">重新檢查</button>
      </section>`;
    $('#recheck').addEventListener('click', recheck);
  }

  async function recheck() {
    const btn = $('#recheck');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>檢查中…';
    await loadMe(true);
    if (state.me && state.me.approved) showTab('add');
    else if (state.tab === 'pending') showMessage('還沒確認', '管理員還沒確認，請晚一點再試。');
  }

  function showFatal(message) {
    $('#app').innerHTML = `<div class="error-box">${esc(message)}</div>
      <button class="btn btn-primary" onclick="location.reload()">重新整理</button>`;
    $('#tabs').hidden = true;
  }

  start();
})();
