// 設定檔：只有這裡需要依照你的環境修改
window.APP_CONFIG = {
  // LINE LIFF ID（LINE Developers → channel → LIFF 分頁），還沒建立前留空
  LIFF_ID: '2011746619-WV6eVn7h',

  // 後端：Cloudflare Worker（快）。拿掉這一行就會退回下面的 Apps Script
  API_URL: 'https://ama-fund-api.ama-fund-api.workers.dev',

  // 舊後端：Google Apps Script 網頁應用程式網址（結尾是 /exec），備用
  GAS_URL: 'https://script.google.com/macros/s/AKfycbyXWGjJo3NpbaX59Ha0VHYsePOBKBiv5CRRi-guic0MNJ-m-wERi7-44r4lYH6OIl_f/exec',
};
