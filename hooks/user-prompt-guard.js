#!/usr/bin/env node
/**
 * UserPromptSubmit Hook — Prompt Context Guard
 *
 * 偵測前端/後端/QC 類型訊息，若缺少關鍵上下文，
 * 注入提示讓 Claude 主動詢問使用者補充資訊再開始執行。
 *
 * 觸發條件：訊息長度 30–600 字，且符合特定場景模式
 * 靜默失敗：exit 0，不影響對話進行
 */

// === 略過條件 ===
const SKIP_SHORT = 30;
const SKIP_LONG  = 600;

// 略過這些非開發任務的訊息
const SKIP_PATTERNS = [
  /^(好|謝謝|嗯|是的|對|不是|ok|yes|no|確認|知道了|收到)/i,
  /memory|skill|hook|mcp|settings|github|audit|dashboard|readme/i,
  /閱讀|讀一下|摘要|文章|這篇|網頁|blog/i,
  /commit|git log|version|版本號|tag|changelog/i,
  /skill.*做|做.*skill|新增.*skill|建.*skill/i,
  /分析|差距|架構|規劃.*系統|系統.*規劃/i,
];

// === 場景偵測 ===
const SCENARIOS = {
  frontend: {
    name: '前端樣式',
    patterns: [
      /css|style[^d]|樣式|排版|切版|跑版|margin|padding|border|flex|grid/i,
      /顯示.*?(不對|問題|錯誤)|位置.*?(不對|偏|跑)|間距|顏色|字型|font/i,
      /responsive|rwd|手機版|斷點|breakpoint|畫面.*?(問題|壞掉|跑版)/i,
      /class.*?改|改.*?class|ui.*?問題|layout.*?問題|前台.*?(修|改|壞)/i,
    ],
    needed: [
      { label: '頁面網址（localhost 帶 port）',     check: /http|localhost|127\.0\.0\.1|\.php.*\?|\/[a-z]+\.php/i },
      { label: '目標元素（class / id / 選擇器）',   check: /class=|#[a-z]|\.[a-z][\w-]+|選擇器|element|selector/i },
      { label: '預期 vs 實際效果描述，或截圖',       check: /預期|expected|actual|截圖|應該.*但|但.*卻|本來.*現在/i },
    ]
  },

  backend: {
    name: '後端除錯',
    patterns: [
      /error|exception|500|php.*?錯誤|錯誤.*?(訊息|message)/i,
      /debug|除錯|不能.*?(執行|存|取|跑)|無法.*?(執行|存|取|跑)/i,
      /為什麼.*?(失敗|不對|回傳|出現)|(?:修|解決).*?bug/i,
    ],
    needed: [
      { label: '錯誤訊息 / log 內容',              check: /error:|exception:|line \d+|訊息|message|log|錯誤.*[:：]/i },
      { label: '哪支 PHP 檔案 / 哪個函式',         check: /\.php|function |class |method|函式|哪支|哪個檔|controller|model/i },
      { label: '如何重現（操作步驟或 API 請求）',   check: /步驟|操作|重現|reproduce|按.*後|填.*後|送出後|request/i },
    ]
  },

  qc: {
    name: 'QC / 全站測試',
    patterns: [
      /qc|品保|校稿|全站.*?(測|驗|掃)|逐頁.*?(測|驗)/i,
      /測試.*?(範圍|計畫|清單)|跑.*?測試/i,
    ],
    needed: [
      { label: '規格書（AxShare URL 或 spec_index.md）', check: /spec|axshare|規格|spec_index|\.md/i },
      { label: '測試網站 URL',                           check: /http|localhost|測試機|網址/i },
    ]
  },

  playwright: {
    name: 'Playwright 瀏覽器操作',
    patterns: [
      /playwright|browser.*?(?:點|填|截圖|打開|開啟)|截圖.*?page|打開.*?瀏覽器/i,
      /自動化.*?測試|e2e|端對端/i,
    ],
    needed: [
      { label: '目標頁面 URL',                          check: /http|localhost|網址|\.php/i },
      { label: '要操作的元素（class / id / 按鈕名稱）', check: /class|#[a-z]|\.[a-z]|按鈕|button|input|element/i },
    ]
  },
};

function matchesAny(text, patterns) {
  return patterns.some(p => p.test(text));
}

function detectScenario(prompt) {
  for (const [key, scenario] of Object.entries(SCENARIOS)) {
    if (matchesAny(prompt, scenario.patterns)) return scenario;
  }
  return null;
}

function getMissing(prompt, needed) {
  return needed.filter(item => !item.check.test(prompt)).map(item => item.label);
}

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data   = JSON.parse(input);
    const prompt = (data.prompt || '').trim();

    if (prompt.length < SKIP_SHORT || prompt.length > SKIP_LONG) { process.exit(0); }
    if (SKIP_PATTERNS.some(p => p.test(prompt))) { process.exit(0); }

    const scenario = detectScenario(prompt);
    if (!scenario) { process.exit(0); }

    const missing = getMissing(prompt, scenario.needed);
    if (missing.length === 0) { process.exit(0); }

    const msg =
      `[Prompt Guard] 偵測到「${scenario.name}」任務，缺少以下關鍵資訊：\n` +
      missing.map(m => `  ▸ ${m}`).join('\n') +
      `\n在開始執行前，請先詢問使用者補充上述資訊。`;

    process.stdout.write(msg + '\n');
    process.exit(0);
  } catch (e) {
    process.exit(0);
  }
});
