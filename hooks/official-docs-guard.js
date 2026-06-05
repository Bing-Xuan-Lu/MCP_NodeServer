#!/usr/bin/env node
/**
 * UserPromptSubmit Hook — Official Docs Guard
 *
 * 偵測「第三方技術行為」類問題（瀏覽器 / Web 標準 / 框架 / API 規範 / 為什麼…行為），
 * 在 Claude 回合開頭注入提醒：回答前先用 WebFetch 查官方文件，禁止憑訓練記憶直接答。
 *
 * 動機：訓練記憶對第三方技術的版本行為、規範細節常過期或不精確，直接答易產生
 *      「聽起來對但實際錯」的幻覺。把「先查官方」變成每回合可見的預設提醒，
 *      比寫在 memory 裡有效（memory 可能被略過，hook 注入文字每回合一定看到）。
 *
 * 非阻擋：只注入提醒文字（stdout），exit 0，不影響對話進行。
 * 靜默失敗：任何錯誤都 exit 0。
 */

import process from 'process';

// ── 瀏覽器產品名（夠具體，命中即算）──
const BROWSER_PRODUCT = /\b(chrome|chromium|firefox|safari|webkit|blink|gecko)\b/i;
// ── 泛指瀏覽器（需搭配「查文件意圖」才算，避免 Playwright 測試類誤判）──
const BROWSER_GENERIC = /瀏覽器|\bbrowser\b|devtools|開發者工具/i;

// ── Web 標準 / 跨域 / 安全規範（最容易憑記憶記錯，命中即算）──
const WEBSTD = [
  /\b(w3c|whatwg|mdn|ecmascript|ecma-?\d+|caniuse|rfc\s*\d+)\b/i,
  /\b(cors|csp|csrf)\b/i,
  /content[\s-]*security[\s-]*policy/i,
  /same[\s-]*site|samesite/i,
  /referrer[\s-]*policy|cross[\s-]*origin/i,
  /service\s*worker|web\s*worker|manifest\s*v?[23]\b/i,
  /\bhttp\/?[12](\.\d)?\b|cache[\s-]*control|content[\s-]*disposition/i,
];

// ── 規範類詞（需搭配技術語境才算，避免「公司規範」等誤判）──
const SPEC_WORD = /\b(spec|specification)\b|規範|標準規格|標準(?:文件|行為|規格)/i;
const TECH_CONTEXT = /\b(api|http|css|html|js|javascript|dom|web|oauth|token|jwt|websocket|webrtc|sse|fetch|xhr|ajax)\b|瀏覽器|介接|串接|協定/i;

// ── 框架 / 函式庫（需搭配「查文件意圖」才算）──
const FRAMEWORK = /\b(react|vue|angular|svelte|next\.?js|nuxt|tailwind(?:css)?|bootstrap|jquery|node\.?js|express|axios|playwright|puppeteer|webpack|vite|eslint)\b/i;

// ── 「查官方文件意圖」訊號：行為 / 版本 / 規範 / 為什麼 ──
const DOC_INTENT = /行為|版本|breaking|deprecated|棄用|相容|相容性|compatibility|為什麼|為何|怎麼會|預設值?|\bdefault\b|官方|文件|doc(?:s|umentation)?\b|語法|用法|參數|選項|\boption\b|限制|規則|規範|\bspec\b|標準/i;

// ── 瀏覽器自動化 / E2E 測試語境（這類是「用瀏覽器做事」不是「問瀏覽器行為」）──
const AUTOMATION = /playwright|browser_interact|截圖|screenshot|測一下|跑一?次?測|\be2e\b|自動化測試|導航|navigate|點(?:一下|擊)|\bclick\b|開啟?(?:這|那|該)?(?:頁|網頁|頁面)/i;

// ── 跳過：與第三方技術文件無關的任務 ──
const SKIP = [
  /^.{0,3}$/s,                                                  // 極短
  /^(好的?|ok|yes|no|對|是|嗯|繼續|謝謝|收到|確認)[\s,，.。!！?？]*$/i,  // 純確認
  /\b(hook|settings\.json|dashboard)\b|claude\.md|readme\.md|記憶|memory|\bskill\b|教訓|retro|lesson/i,  // 本系統 meta 維護
  /不(?:用|需要?)查|別查|不要查|我(?:已|自己)知道/,             // 使用者明確表示不需查
];

function detectHits(prompt) {
  if (SKIP.some(p => p.test(prompt))) return null;
  // 純瀏覽器自動化、且無查文件意圖 → 不擾
  if (AUTOMATION.test(prompt) && !DOC_INTENT.test(prompt)) return null;

  const hits = new Set();
  if (BROWSER_PRODUCT.test(prompt)) hits.add('瀏覽器');
  if (BROWSER_GENERIC.test(prompt) && DOC_INTENT.test(prompt)) hits.add('瀏覽器');
  if (WEBSTD.some(re => re.test(prompt))) hits.add('Web標準');
  if (SPEC_WORD.test(prompt) && TECH_CONTEXT.test(prompt)) hits.add('規範');
  if (FRAMEWORK.test(prompt) && DOC_INTENT.test(prompt)) hits.add('框架行為');

  return hits.size ? [...hits] : null;
}

let input = '';
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const prompt = (data.prompt || '').trim();
    if (!prompt) process.exit(0);

    const hits = detectHits(prompt);
    if (!hits) process.exit(0);

    process.stdout.write(
      `[Official Docs Guard] 📚 此題涉及第三方技術行為（命中：${hits.join('/')}）。\n` +
      `  ▸ 回答前先用 WebFetch 查官方文件 / 規範，禁止憑訓練記憶直接答。\n` +
      `  ▸ 訓練記憶對版本行為、規範細節常過期，易產生「聽起來對但實際錯」的幻覺。\n` +
      `  ▸ 若已查證、或屬使用者自家程式邏輯（非第三方規範），可忽略本提醒繼續。\n\n`
    );
    process.exit(0);
  } catch (e) {
    process.stderr.write(`[official-docs-guard] error: ${e.message}\n`);
    process.exit(0);
  }
});
