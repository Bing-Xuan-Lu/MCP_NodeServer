#!/usr/bin/env node
/**
 * UserPromptSubmit Hook — Prompt Context Guard
 *
 * 兩層防護：
 * Layer 0 — 模糊指令偵測（全域強制，4 字起攔）
 *   偵測含「動作 + 模糊指示詞」但缺具體錨點的指令，強制 Claude 先問再做。
 *   涵蓋：方向性（往前/往後）、程度性（大一點/小一點）、指代性（這個/那個改一下）
 *
 * Layer 1 — 場景偵測（30–600 字，特定場景缺上下文時提醒）
 *   前端/後端/QC/Playwright 場景，缺關鍵資訊時注入提示。
 *
 * 方案 A+B 連動：透過 write-guard state file 通知 write-guard 阻擋/重置
 * 靜默失敗：exit 0，不影響對話進行
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const WG_STATE_DIR = path.join(os.tmpdir(), 'claude-write-guard');
const WG_STATE_FILE = path.join(WG_STATE_DIR, 'state.json');

function wgFreshState() {
  return { ts: Date.now(), files: [], promptGuardActive: false, batchAcked: false };
}
function wgLoadState() {
  try {
    if (fs.existsSync(WG_STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(WG_STATE_FILE, 'utf-8'));
      const age = Date.now() - (raw.ts || 0);
      if (age > 30 * 60 * 1000) return wgFreshState();
      // promptGuardActive 短 TTL：超過 2 分鐘自動解除，避免 stuck state
      if (raw.promptGuardActive && age > 2 * 60 * 1000) {
        raw.promptGuardActive = false;
      }
      return raw;
    }
  } catch (e) {}
  return wgFreshState();
}

// 明確的「使用者確認」訊號 — 命中時保證解除 promptGuardActive 並輸出正向回饋
const EXPLICIT_CONFIRM_PATTERNS = [
  /^(確認可以|確認|可以|OK|好的?|繼續|沒問題|沒錯|對|是|yes|y|執行|go|do it|ok 繼續|繼續執行)[\s,，.。!！]*$/i,
  /^(?:選項?\s*)?[A-Da-d](?:\s|$|[,.。!！])/,                  // "A" / "選 A" / "A,"
  /^(?:選\s*)?\d+(?:\s|$|[,.。!！])/,                          // "1" / "選 1"
  /^(我?確認|沒錯就這樣|就這樣|按你說的|照你說的|照辦|去做)/,
];
function isExplicitConfirm(prompt) {
  return EXPLICIT_CONFIRM_PATTERNS.some(p => p.test(prompt.trim()));
}
function wgSaveState(state) {
  try {
    if (!fs.existsSync(WG_STATE_DIR)) fs.mkdirSync(WG_STATE_DIR, { recursive: true });
    state.ts = Date.now();
    fs.writeFileSync(WG_STATE_FILE, JSON.stringify(state));
  } catch (e) {}
}

function matchesAny(text, patterns) {
  return patterns.some(p => p.test(text));
}

/** 觸發 write-guard 阻擋並輸出訊息 */
function emitGuard(message) {
  const wgState = wgLoadState();
  wgState.promptGuardActive = true;
  wgSaveState(wgState);
  process.stdout.write(message + '\n');
  process.exit(0);
}

// =============================================
// Layer 0 — 模糊指令偵測（全域強制）
// =============================================

// 最短觸發長度（排除「好」「OK」等極短確認）
const VAGUE_MIN_LEN = 4;

// ── 0a. 略過：非操作性訊息（問句、查詢、確認、工具管理）──
const VAGUE_SKIP = [
  // 確認詞：後面不能接漢字（避免「對齊」「好看」被誤殺）
  /^(好的?|謝謝|嗯|是的|對啊?|不是|ok|yes|no|確認|知道了|收到|繼續|可以|沒問題)[\s,，.。!！?？]*$/i,
  /^(什麼|為什麼|怎麼|如何|哪|幾|多少|是否|能不能|可不可以)/,
  /memory|skill|hook|mcp|settings|github|audit|dashboard|readme|commit|changelog/i,
  /閱讀|讀一下|摘要|文章|這篇|網頁|blog|分析|架構|規劃|設計/i,
  /解釋|說明|告訴我|列出|顯示|查看|查詢|(?:搜尋|找)(?!.*(?:清|刪|改|移|調|換)).*在哪/i,
];

// ── 0b. 模糊信號：動作 + 模糊指示詞 ──
// 每個 pattern 群獨立計分，命中越多信號越強
const VAGUE_SIGNALS = [
  // 指代性：這個/那個/它/這裡/那裡 + 動作
  { type: '指代', weight: 2, patterns: [
    /(?:把|將)?\s*(?:這個?|那個?|這邊|那邊|這裡|那裡|它)\s*(?:改|修|換|調|刪|移|弄|搬|拿掉|去掉|拆|補|加)/,
    /(?:改|修|換|調|刪|移|弄|搬|拿掉|去掉|拆|補|加)\s*(?:這個?|那個?|這邊|那邊|這裡|那裡|它)/,
  ]},
  // 程度性：大一點/小一點/多一些/少一點/短一點/長一點
  { type: '程度', weight: 2, patterns: [
    /(?:大|小|寬|窄|高|低|長|短|粗|細|快|慢|多|少|深|淺|亮|暗|鬆|緊|密|疏|厚|薄|重|輕)\s*一?\s*(?:點|些|點點)/,
    /(?:再|更|稍微)\s*(?:大|小|寬|窄|高|低|長|短|粗|細|快|慢|多|少|深|淺|亮|暗)/,
  ]},
  // 方向性：往前/往後/移上去/放到前面
  { type: '方向', weight: 2, patterns: [
    /(?:移|搬|放|擺|調|換|排).*?(?:到|去)?\s*(?:前面|後面|上面|下面|左邊|右邊|前方|後方)/,
    /往(?:前|後|上|下|左|右)(?:移|搬|放|調)?/,
    /(?:移|搬|提|降|拉)(?:上去|下來|上來|下去|過去|過來)/,
    /(?:前|後|上|下)移/,
    /放.*?(?:前|後|上|下)面一點/,
  ]},
  // 泛動作 + 「一下」：改一下/調一下/弄一下/動一下/處理一下
  { type: '泛動作', weight: 2, patterns: [
    /(?:改|修|調|弄|動|處理|優化|整理|清理|重構|更新|替換)\s*一下/,
  ]},
  // 相對引用：跟上次一樣/跟之前一樣/像那個/照舊
  { type: '相對引用', weight: 2, patterns: [
    /跟\s*(?:上次|之前|前面|剛才|原本|原來)\s*一樣/,
    /(?:像|如同|比照)\s*(?:上次|之前|那個|那時)/,
    /照舊|維持原樣|不要動/,
  ]},
  // 模糊範圍：「都」「全部」「整個」+ 動作，但沒說具體範圍
  { type: '範圍', weight: 2, patterns: [
    /(?:都|全部|整個|所有|每個)\s*(?:改|刪|換|移|調|更新|替換|清掉)/,
    /(?:改|刪|換|移|調|更新|替換|清掉)\s*(?:全部|整個|所有|每個)/,
  ]},
  // 模糊刪除：「多餘的」「不要的」「沒用的」刪掉，但沒指明哪些
  { type: '模糊刪除', weight: 2, patterns: [
    /(?:刪掉?|移除|拿掉|去掉|清掉|清除|清理|清乾淨)\s*(?:多餘|不要|沒用|不需要|重複|冗餘)?的?/,
    /(?:多餘|不要|沒用|不需要|重複|冗餘)的?\s*(?:刪掉?|移除|拿掉|去掉|清掉|清除)/,
  ]},
  // 順序/反轉：「反過來」「顛倒」「倒過來」
  { type: '順序', weight: 2, patterns: [
    /(?:反過來|顛倒|倒過來|倒轉|反轉|翻轉|逆序)/,
    /(?:順序|排序)\s*(?:反|倒|換|調)/,
    /(?:對調|互換|交換)\s*(?:順序|位置)?/,
  ]},
  // 對齊：「對齊」「靠左/靠右/置中」但沒指定目標
  { type: '對齊', weight: 2, patterns: [
    /(?:對齊|靠左|靠右|置中|居中|左對齊|右對齊|水平對齊|垂直對齊)/,
    /(?:排列?|排好|排整齊|對整齊)/,
  ]},
  // 一致性：「統一」「保持一致」「風格一樣」
  { type: '一致性', weight: 2, patterns: [
    /(?:統一|保持一致|風格一樣|格式一樣|樣式一樣|一致化)/,
    /(?:統一)\s*(?:一下|格式|風格|樣式|寫法|命名)/,
  ]},
  // 主觀美感：「好看一點」「漂亮一點」「醜」「難看」
  { type: '美感', weight: 2, patterns: [
    /(?:好看|漂亮|美觀|精緻|質感)\s*一?\s*(?:點|些)/,
    /(?:醜|難看|粗糙|陽春|太醜|不好看|很醜)/,
    /(?:美化|優化)\s*(?:一下|介面|畫面|UI)?/,
  ]},
  // 模糊重構：「簡化」「精簡」「優化」「重構」無具體對象
  { type: '重構', weight: 2, patterns: [
    /(?:簡化|精簡|優化|重構|瘦身|整理)\s*(?:一下|程式碼?|code)?$/,
  ]},
  // 模糊問題：「怪怪的」「有問題」「壞了」「不對」無具體描述
  { type: '問題', weight: 2, patterns: [
    /(?:怪怪的|有問題|壞了|壞掉|掛了|不對|不正常|異常|不work|沒反應)/,
    /(?:那邊|這邊|那裡|這裡)\s*(?:有問題|怪怪的|壞了|不對)/,
  ]},
];

// 信號總分 >= 此閾值才觸發
const VAGUE_THRESHOLD = 2;

// ── 0c. 具體錨點（命中任一 = 不模糊）──
const CONCRETE_ANCHORS = [
  // 檔案路徑
  /[\w/-]+\.\w{1,5}\b/,                        // file.php, style.css, app.js
  // CSS 選擇器
  /[.#][\w][\w-]{1,}/,                          // .my-class, #main-id
  // HTML 標籤
  /<\/?[a-z][\w-]*[\s>]/i,                      // <div>, </section>
  // 函式/方法名
  /(?:function|def|class|method)\s+\w+/i,       // function getData
  /\w+\s*\(.*?\)/,                              // getData(), foo(x)
  // 行號
  /(?:第|line|L)\s*\d+\s*(?:行|列)?/i,         // 第 42 行, line 10
  // URL
  /https?:\/\/\S+/i,
  // SQL / DB
  /(?:SELECT|INSERT|UPDATE|DELETE|ALTER|FROM|WHERE|TABLE|CREATE)\s+/i,
  // 變數名（含底線或駝峰，至少 4 字元）
  /\b[a-z_]\w{3,}(?:_\w+)+\b/,                 // my_variable, data_list
  /\b[a-z][a-zA-Z]{3,}[A-Z]\w*\b/,             // myVariable, getData
  // 明確的 UI 元素名（中文 3+ 字 + 元素詞尾）
  /[\u4e00-\u9fff]{3,}(?:按鈕|欄位|選單|表格|標題|頁籤|彈窗|modal|dialog|sidebar|header|footer|nav|form|input|textarea|table)/,
  // 具體數值指定
  /\d+\s*(?:px|em|rem|%|pt|vh|vw|秒|ms|個|筆|列|行|頁)\b/,
];

function getVagueScore(prompt) {
  let score = 0;
  const matched = [];
  for (const group of VAGUE_SIGNALS) {
    if (matchesAny(prompt, group.patterns)) {
      score += group.weight;
      matched.push(group);
    }
  }
  return { score, matched };
}

function hasConcrete(prompt) {
  return CONCRETE_ANCHORS.some(p => p.test(prompt));
}

// =============================================
// Layer 1 — 場景偵測（原有邏輯）
// =============================================

const SCENE_SKIP_SHORT = 30;
const SCENE_SKIP_LONG  = 600;

const SCENE_SKIP_PATTERNS = [
  /^(好|謝謝|嗯|是的|對|不是|ok|yes|no|確認|知道了|收到)/i,
  /memory|skill|hook|mcp|settings|github|audit|dashboard|readme/i,
  /閱讀|讀一下|摘要|文章|這篇|網頁|blog/i,
  /commit|git log|version|版本號|tag|changelog/i,
  /skill.*做|做.*skill|新增.*skill|建.*skill/i,
  /分析|差距|架構|規劃.*系統|系統.*規劃/i,
];

// 後端關鍵字：出現這些詞時，frontend 場景不適用（純後端問題誤判修正）
const BACKEND_KEYWORDS = /列印|發票|運費|訂單金額|金額計算|計算錯|對帳|報表|匯出|匯入|寄信|寄送|發送|email|mail|寄出|簡訊|sms|通知|cron|排程|sql|資料庫|db.*?(查|寫|存|刪|更新)|後台.*?(邏輯|流程|計算|資料)|api.*?(回傳|參數|錯誤)|session|cookie|權限|登入.*?(失敗|錯誤)|缺少規格|規格.*?缺|消失|沒存到|未寫入|寫入失敗|資料.*?(不見|消失|遺失|錯)/i;

const SCENARIOS = {
  frontend: {
    name: '前端樣式',
    patterns: [
      /css|style[^d]|樣式|排版|切版|跑版|margin|padding|border|flex|grid/i,
      /顯示.*?(不對|問題|錯誤)|位置.*?(不對|偏|跑)|間距|顏色|字型|font/i,
      /responsive|rwd|手機版|斷點|breakpoint|畫面.*?(問題|壞掉|跑版)/i,
      /class.*?改|改.*?class|ui.*?問題|layout.*?問題|前台.*?(修|改|壞)/i,
    ],
    excludeIf: BACKEND_KEYWORDS,
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

function detectScenario(prompt) {
  for (const [key, scenario] of Object.entries(SCENARIOS)) {
    if (!matchesAny(prompt, scenario.patterns)) continue;
    if (scenario.excludeIf && scenario.excludeIf.test(prompt)) continue;
    return scenario;
  }
  return null;
}

function getMissing(prompt, needed) {
  return needed.filter(item => !item.check.test(prompt)).map(item => item.label);
}

// =============================================
// 主程式
// =============================================

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data   = JSON.parse(input);
    const prompt = (data.prompt || '').trim();

    // 每次使用者發話 → 重置 write-guard 的批次計數與 Prompt Guard 旗標
    // 同時保存 lastPrompt 供其他 hook (repetition-detector L2.83) 判斷情境
    const prevState = wgLoadState();
    const wasGuardActive = prevState.promptGuardActive === true;
    {
      const fresh = wgFreshState();
      fresh.lastPrompt = prompt.slice(0, 500);
      wgSaveState(fresh);
    }

    // 明確確認偵測：使用者清楚表達同意 → 輸出正向回饋，明示已解除
    // （reset 已在上面跑過，這裡只是讓使用者看到「擋住的東西已放行」）
    if (isExplicitConfirm(prompt) && wasGuardActive) {
      process.stdout.write(
        `[Prompt Guard] ✅ 偵測到使用者確認 ("${prompt.slice(0, 30)}") — 已解除 Edit/Write 阻擋，AI 可繼續執行。\n\n`
      );
      process.exit(0);
    }

    // ── CSS Trouble 偵測：使用者回報排版/跑版/樣式問題 → 強制下次 .css 寫入前先 inspect ──
    const CSS_TROUBLE_PATTERNS = [
      /排版.*?(?:有問題|壞|錯|怪|跑版|不對|亂)/,
      /跑版|版面.*?(?:壞|跑|亂)|樣式.*?(?:壞|跑|亂|蓋)/,
      /css.*?(?:沒生效|沒用|不work|蓋不掉|被蓋)/i,
      /位置.*?(?:不對|偏|跑掉|歪)/,
      /(?:沒有?生效|沒套到|沒吃到).*?(?:css|樣式|class)/i,
      /(?:對齊|置中|靠左|靠右).*?(?:不對|失敗|沒用)/,
    ];
    if (CSS_TROUBLE_PATTERNS.some(p => p.test(prompt))) {
      const wgState = wgLoadState();
      wgState.cssInspectRequired = true;
      wgSaveState(wgState);
      process.stdout.write(
        `[Prompt Guard] 🎯 偵測到 CSS 排版問題回報 — 已啟動 cssInspectRequired flag。\n` +
        `  → 下次 .css/.scss 寫入前必須先執行 css_computed_winner / css_specificity_check / css_inspect 之一。\n` +
        `  → 過去模式：使用者說「排版有問題」→ AI 直接 Edit CSS 加 !important → 跑版更嚴重。\n` +
        `  → 新模式：先 inspect 拿事實 → 看誰贏 → 再決定改源頭 / 隔離 class / 提 specificity。\n` +
        `  → flag 在 inspect 工具被呼叫後自動解除（由 repetition-detector 偵測 history）。\n\n`
      );
    }

    // ── Layer 0：模糊指令偵測（4 字起，優先於一切）──
    if (prompt.length >= VAGUE_MIN_LEN && !VAGUE_SKIP.some(p => p.test(prompt))) {
      const { score } = getVagueScore(prompt);

      if (score >= VAGUE_THRESHOLD && !hasConcrete(prompt)) {
        // 根據命中的信號類型，生成具體的補充建議
        const tips = [];
        const { matched } = getVagueScore(prompt);
        const hitTypes = new Set(matched.map(g => g.type));

        // 面向使用者的補充建議（根據模糊類型客製）
        if (hitTypes.has('指代'))     tips.push('「這個/那個」→ 請說明具體是哪個檔案、元素、函式');
        if (hitTypes.has('程度'))     tips.push('「大一點/小一點」→ 請給具體數值（如 16px → 20px）或參照物（如「跟標題一樣大」）');
        if (hitTypes.has('方向'))     tips.push('「往前/往後」→ 請說明移到哪個元素之前/之後，或第幾行');
        if (hitTypes.has('泛動作'))   tips.push('「改一下/調一下」→ 請說明要改成什麼樣子');
        if (hitTypes.has('相對引用')) tips.push('「跟上次一樣」→ AI 無法存取歷史對話，請直接描述期望結果');
        if (hitTypes.has('範圍'))       tips.push('「全部改」→ 請指定範圍：哪個資料夾？哪些檔案？符合什麼條件的？');
        if (hitTypes.has('模糊刪除')) tips.push('「刪掉多餘的」→ 請說明哪些是多餘的，或給出判斷條件');
        if (hitTypes.has('順序'))     tips.push('「反過來/對調」→ 請指明哪些項目要交換，或目標排序規則');
        if (hitTypes.has('對齊'))     tips.push('「對齊/置中」→ 請指定哪個元素要對齊、對齊到什麼參照物');
        if (hitTypes.has('一致性'))   tips.push('「統一/保持一致」→ 請說明以哪個為準（統一成 A 的風格？還是 B 的？）');
        if (hitTypes.has('美感'))     tips.push('「好看一點/美化」→ 主觀標準無法執行，請描述具體要改的屬性（間距、顏色、字型、圓角…）');
        if (hitTypes.has('重構'))     tips.push('「簡化/重構」→ 請指定目標檔案或函式，以及簡化的方向（拆分、合併、去重複…）');
        if (hitTypes.has('問題'))     tips.push('「怪怪的/有問題」→ 請描述預期行為 vs 實際行為，或附截圖');
        if (tips.length === 0)        tips.push('請補充：改哪裡？改成什麼？');

        emitGuard(
          `[Prompt Guard] ⛔ 指令不夠具體，AI 無法準確執行。\n` +
          `\n` +
          `  📝 請補充以下資訊再重新送出：\n` +
          tips.map(t => `  ▸ ${t}`).join('\n') +
          `\n` +
          `\n` +
          `  ── 以下為 AI 指令 ──\n` +
          `  你 **禁止** 猜測使用者意圖並直接修改程式碼。\n` +
          `  必須先列出你不確定的部分，請使用者釐清後才可執行。`
        );
      }
    }

    // ── Layer 1：場景偵測（30–600 字）──
    if (prompt.length < SCENE_SKIP_SHORT || prompt.length > SCENE_SKIP_LONG) { process.exit(0); }
    if (SCENE_SKIP_PATTERNS.some(p => p.test(prompt))) { process.exit(0); }

    const scenario = detectScenario(prompt);
    if (!scenario) { process.exit(0); }

    // 前端樣式任務：在進 missing 判斷前先輸出「先 inspect 再改」提醒（非阻擋）
    if (scenario.name === '前端樣式') {
      process.stdout.write(
        `[Prompt Guard] 💡 前端樣式任務提醒 — 改 CSS 前先 inspect，避免猜 specificity 反覆跑版：\n` +
        `  ▸ mcp__css_computed_winner(url, selector, property)：直接看哪條規則「贏」，避免猜哪個樣式蓋過去\n` +
        `  ▸ mcp__css_specificity_check(url, selector)：列出所有命中的規則 + specificity，找出該不該蓋\n` +
        `  ▸ mcp__css_inspect(url, selector)：取 computed style + 來源檔行號\n` +
        `  ▸ mcp__browser_interact 內建 evaluate：在 console 跑 getComputedStyle 即時驗證\n` +
        `  → 規則：寧可多查 1 次也不要連改 5 次猜不中。看到要寫 !important 就停下查 specificity。\n\n`
      );
    }

    const missing = getMissing(prompt, scenario.needed);
    const provided = scenario.needed.length - missing.length;
    // 只有「缺多數」才擋：提供資訊 < 一半時才 block，避免 URL+錯誤訊息已齊全仍被要求補 PHP 檔名
    // 例：3 項需求只給 1 項 → 擋；3 項給 2 項 → 放行；2 項給 1 項 → 放行
    const threshold = Math.ceil(scenario.needed.length / 2);
    if (provided >= threshold) { process.exit(0); }

    emitGuard(
      `[Prompt Guard] 偵測到「${scenario.name}」任務，缺少以下關鍵資訊：\n` +
      missing.map(m => `  ▸ ${m}`).join('\n') +
      `\n在開始執行前，請先詢問使用者補充上述資訊。`
    );
  } catch (e) {
    process.stderr.write(`[user-prompt-guard] error: ${e.message}\n`);
    process.exit(0);
  }
});
