/* 阿嬤基金記帳 — 前端（原生 JavaScript，不需要編譯）
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
  const CATEGORIES = ['菜肉', '水果', '日用品', '醫療', '車資', '給阿嬤', '其他'];
  const MAX_DIGITS = 6;
  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

  const params = new URLSearchParams(location.search);
  // 沒設定 LIFF_ID，或網址加上 ?dev，就用開發模式（瀏覽器測試用假身分）
  const DEV = !CFG.LIFF_ID || params.has('dev');
  const DEV_USERS = [
    { userId: 'dev-xiuhui', displayName: '秀慧（測試）' },
    { userId: 'dev-xiaomi', displayName: '小咪（測試）' },
    { userId: 'dev-dad', displayName: '爸爸（測試）' },
  ];

  const $ = (sel) => document.querySelector(sel);

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

  /** 每個請求都附上的身分資料（後端會向 LINE 驗證 idToken） */
  function authPayload() {
    if (DEV) return { dev: currentDevUser() };
    return { idToken: liff.getIDToken() };
  }

  // ===== 3. 呼叫後端 API =====
  async function api(action, data) {
    const body = Object.assign({ action: action }, data || {}, authPayload());
    const ctrl = new AbortController();
    // Google 後端閒置後第一次回應可能要 30 秒以上，所以等久一點
    const timer = setTimeout(() => ctrl.abort(), 60000);
    const slowTimer = setTimeout(() => {
      document.querySelectorAll('.slow-hint').forEach((el) => { el.hidden = false; });
    }, 8000);
    let json;
    try {
      const res = await fetch(CFG.GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // 用 text/plain 避免 CORS 預檢
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      json = await res.json();
    } catch (e) {
      throw new Error('網路不穩，請再按一次');
    } finally {
      clearTimeout(timer);
      clearTimeout(slowTimer);
      document.querySelectorAll('.slow-hint').forEach((el) => { el.hidden = true; });
    }
    if (!json.ok) {
      const err = new Error(json.error || '系統出了點問題，請再按一次');
      err.code = json.code;
      throw err;
    }
    return json.data;
  }

  // ===== 4. 畫面 =====
  const state = {
    me: null,
    tab: 'add',
    form: null,
    requestId: null, // 同一筆送出重試時沿用，避免重複記帳
  };

  function newForm() {
    return { category: '', amount: '', note: '', date: today() };
  }

  const TABS = [
    { id: 'add', icon: '✏️', label: '記一筆', render: renderAdd },
    { id: 'overview', icon: '📊', label: '總覽', render: renderOverview },
  ];

  function renderTabs() {
    const nav = $('#tabs');
    nav.hidden = false;
    nav.innerHTML = TABS.map((t) =>
      `<button class="tab" data-tab="${t.id}" ${t.id === state.tab ? 'aria-current="page"' : ''}>
         <span class="icon" aria-hidden="true">${t.icon}</span>${esc(t.label)}
       </button>`
    ).join('');
  }

  function showTab(id) {
    state.tab = id;
    renderTabs();
    const tab = TABS.find((t) => t.id === id) || TABS[0];
    $('#page-title').textContent = tab.label;
    window.scrollTo(0, 0);
    tab.render();
  }

  // ----- 記一筆 -----
  function renderAdd() {
    if (!state.form) state.form = newForm();
    const f = state.form;
    $('#app').innerHTML = `
      <section class="section">
        <h2 class="section-title">1. 買了什麼？</h2>
        <div class="cat-grid">
          ${CATEGORIES.map((c) =>
            `<button class="cat-btn" data-cat="${esc(c)}" aria-pressed="${c === f.category}">${esc(c)}</button>`
          ).join('')}
        </div>
      </section>

      <section class="section">
        <h2 class="section-title">2. 多少錢？</h2>
        <div class="amount-display" id="amount-display"></div>
        <div class="keypad">
          ${['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) =>
            `<button class="key" data-key="${k}">${k}</button>`).join('')}
          <button class="key fn" data-key="clear">清除</button>
          <button class="key" data-key="0">0</button>
          <button class="key fn" data-key="back" aria-label="退格">⌫ 退格</button>
        </div>
      </section>

      <section class="section">
        <h2 class="section-title">3. 說明 <span class="hint">（可不填）</span></h2>
        <input class="text-input" id="note" type="text" maxlength="100"
               placeholder="例：雞肉、葡萄" value="${esc(f.note)}" enterkeyhint="done">
      </section>

      <section class="section">
        <h2 class="section-title">4. 哪一天？</h2>
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

    $('#note').addEventListener('input', (e) => { f.note = e.target.value; });
    $('#note').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
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
    else if (f.amount.length < MAX_DIGITS && !(f.amount === '' && k === '0')) f.amount += k;
    updateAmount();
  }

  function selectCategory(c) {
    state.form.category = c;
    document.querySelectorAll('.cat-btn').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.cat === c));
    });
  }

  function confirmAdd() {
    const f = state.form;
    if (!f.category) return showMessage('還沒選分類', '請先按上面「買了什麼？」的其中一個按鈕。');
    if (!f.amount) return showMessage('還沒輸入金額', '請用數字按鈕輸入金額。');
    if (!state.requestId) state.requestId = newRequestId();

    const noteLine = f.note.trim() ? `<br>（${esc(f.note.trim())}）` : '';
    showModal(`
      <p class="modal-title">對嗎？</p>
      <p class="modal-body">
        ${esc(friendlyDate(f.date))}・${esc(f.category)}
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
        type: '代墊',
        category: f.category,
        amount: Number(f.amount),
        note: f.note.trim(),
        date: f.date,
      });
      state.requestId = null;
      state.form = newForm();
      if (state.me) state.me.pendingTotal = result.pendingTotal;
      showModal(`
        <p class="modal-title">✅ 記好了！</p>
        <p class="modal-body">
          ${esc(result.entry.category)} ${money(result.entry.amount)} 元<br><br>
          ${esc(result.entry.targetName)}目前還沒拿到：
          <span class="modal-big">${money(result.pendingTotal)} 元</span>
        </p>
        <button class="btn btn-primary" data-modal="close">好</button>
      `);
      renderAdd();
    } catch (e) {
      setModalBusy(false);
      $('#modal-error').innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
    }
  }

  // ----- 總覽 -----
  const TYPE_LABEL = {
    代墊: (e) => `${e.targetName} 代墊`,
    付款: (e) => `爸爸付給 ${e.targetName}`,
    支出: () => '爸爸支出',
    領出: () => '從阿嬤帳戶領出',
    盤點: () => '盤點現金',
  };

  function entryItem(e) {
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
      <div class="amount">${money(e.amount)} 元</div>
    </li>`;
  }

  // 上一次看到的總覽存在這支手機裡，下次打開先顯示，不用乾等後端
  function loadSavedOverview() {
    try { return JSON.parse(localStorage.getItem('overview') || 'null'); } catch (e) { return null; }
  }

  function saveOverview(d) {
    try { localStorage.setItem('overview', JSON.stringify(d)); } catch (e) { /* 存不了就算了 */ }
  }

  async function renderOverview() {
    const app = $('#app');
    const saved = loadSavedOverview();
    if (saved) drawOverview(saved, true);
    else app.innerHTML = '<div class="loading-page"><div class="spinner"></div><p>載入中…</p><p class="hint slow-hint" hidden>網路比較慢，請再等一下…</p></div>';

    let d;
    try {
      d = await api('overview');
    } catch (e) {
      if (state.tab !== 'overview') return;
      const box = `<div class="error-box">${esc(e.message)}</div>
        <button class="btn btn-primary" id="retry">再試一次</button>`;
      if (saved) $('#overview-status').innerHTML = box;
      else app.innerHTML = box;
      $('#retry').addEventListener('click', renderOverview);
      return;
    }
    saveOverview(d);
    if (state.tab !== 'overview') return; // 載入時已切到別的分頁
    drawOverview(d, false);
  }

  /** updating = true：畫面是上次存的舊資料，最上面顯示「更新中」 */
  function drawOverview(d, updating) {
    const app = $('#app');

    const st = d.lastStocktake;
    const stocktake = !st ? '' : `
      <p class="hint">上次盤點（${esc(shortDate(st.date))}）：數到 ${money(st.counted)} 元，
        帳上應有 ${money(st.expected)} 元，
        ${st.diff === 0 ? '<b>剛好</b>'
          : st.diff > 0 ? `<span class="diff-plus">多 ${money(st.diff)} 元</span>`
          : `<span class="diff-minus">少 ${money(-st.diff)} 元</span>`}
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
        <div class="stat-label">爸爸手上的零用金（帳上應有）</div>
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
          ${d.recent.map(entryItem).join('') || '<li>還沒有紀錄</li>'}
        </ul>
      </section>
    `;
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
    if (t.dataset.tab) return showTab(t.dataset.tab);
    if (t.dataset.cat) return selectCategory(t.dataset.cat);
    if (t.dataset.key) return pressKey(t.dataset.key);
    if (t.id === 'submit') return confirmAdd();
    if (t.dataset.modal === 'close') return hideModal();
    if (t.dataset.modal && modalHandlers[t.dataset.modal]) return modalHandlers[t.dataset.modal]();
  });

  async function start() {
    if (DEV) setupDevBar();
    try {
      if (!DEV && !(await initLiff())) return; // 正在跳轉到 LINE 登入
    } catch (e) {
      showFatal('連不上 LINE，請關掉再從群組重新打開');
      return;
    }
    // 「記一筆」不需要等後端，先顯示；同時在背景叫醒後端、取得自己的資料
    showTab('add');
    loadMe();
  }

  async function loadMe() {
    try {
      state.me = await api('me');
      try { sessionStorage.removeItem('relogin'); } catch (e) { /* 忽略 */ }
      $('#who').textContent = '你好，' + state.me.name;
      renderTabs();
    } catch (e) {
      if (!DEV && e.code === 'AUTH' && relogin()) return;
      // 網路不穩時先不打擾，送出時會再提示；登入或設定問題才整頁顯示
      if (e.code === 'AUTH' || e.code === 'CONFIG') showFatal(e.message);
    }
  }

  function showFatal(message) {
    $('#app').innerHTML = `<div class="error-box">${esc(message)}</div>
      <button class="btn btn-primary" onclick="location.reload()">重新整理</button>`;
    $('#tabs').hidden = true;
  }

  start();
})();
