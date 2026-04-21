/**
 * tools/_shared/utils.js
 * 共用工具函式：參數驗證、錯誤處理、路徑操作
 */

/**
 * 驗證必需參數（舊 API，向下相容）
 * @param {Object} args - 參數物件
 * @param {Array<string>} required - 必需參數名稱陣列
 * @throws {Error} 缺少必需參數
 */
export function validateRequired(args, required) {
  const missing = required.filter(key => args[key] === undefined || args[key] === null || args[key] === "");
  if (missing.length > 0) {
    throw new Error(`缺少必需參數: ${missing.join(", ")}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Schema-Driven Validation Pipeline
// 靈感來源：mcporter（steipete/mcporter）的 server-proxy 設計
// ─────────────────────────────────────────────────────────────

/**
 * 從 JSON Schema properties 萃取並填入 default 值。
 * 只填入 args 中「完全缺少（undefined）」的欄位。
 *
 * @param {Object} schema - tool definition.inputSchema
 * @param {Object} args   - 傳入的原始參數物件
 * @returns {Object} 合併 defaults 後的新參數物件（不修改原始 args）
 */
export function applySchemaDefaults(schema, args) {
  const props = schema?.properties;
  if (!props) return { ...args };

  const result = { ...args };
  for (const [key, def] of Object.entries(props)) {
    if (result[key] === undefined && def.default !== undefined) {
      result[key] = def.default;
    }
  }
  return result;
}

/**
 * 依 JSON Schema required 陣列驗證必填欄位。
 * 視 0 / false / "" 為有效值，只有 undefined / null 才算缺少。
 *
 * @param {Object} schema   - tool definition.inputSchema
 * @param {Object} args     - 傳入的參數物件（建議先跑 applySchemaDefaults）
 * @throws {Error} 列出所有缺少的必填欄位
 */
export function validateSchemaRequired(schema, args) {
  const required = schema?.required;
  if (!required?.length) return;

  const missing = required.filter(key => args[key] === undefined || args[key] === null);
  if (missing.length > 0) {
    throw new Error(`缺少必填參數: ${missing.join(", ")}`);
  }
}

/**
 * Schema-Driven 完整驗證流程：applyDefaults → validateRequired。
 * 同時回傳填好 defaults 的新參數物件。
 *
 * 用法：
 *   const args = validateArgs(definition.inputSchema, rawArgs);
 *   // 之後直接用 args，不需另外判斷 defaults
 *
 * @param {Object} schema - tool definition.inputSchema
 * @param {Object} args   - 原始傳入參數
 * @returns {Object} 合併 defaults 後的參數物件
 * @throws {Error} 必填欄位缺少時拋出
 */
export function validateArgs(schema, args) {
  const merged = applySchemaDefaults(schema, args);
  coerceSchemaArrays(schema, merged);
  validateSchemaRequired(schema, merged);
  return merged;
}

/**
 * 對所有 schema 標記 type:"array" 的欄位做正規化（原地修改）。
 * 修掉「MCP client 傳 JSON 字串，Node 直接當字串 iterate 導致逐字元 ENOENT」的 bug。
 */
export function coerceSchemaArrays(schema, args) {
  const props = schema?.properties;
  if (!props || !args) return;
  for (const [key, def] of Object.entries(props)) {
    if (def?.type === "array" && args[key] !== undefined && args[key] !== null) {
      if (!Array.isArray(args[key])) {
        args[key] = normalizeArrayArg(args[key]);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Result 萃取 Helpers
// 統一處理 MCP tool 回傳的不同 content type
// ─────────────────────────────────────────────────────────────

/**
 * 從 MCP callTool 回傳結果萃取純文字。
 * 合併所有 type=text 的 content 項目。
 *
 * @param {Object} result - MCP tool 回傳物件 { content: [...] }
 * @returns {string}
 */
export function extractText(result) {
  return (result?.content ?? [])
    .filter(c => c.type === "text")
    .map(c => c.text)
    .join("\n");
}

/**
 * 從 MCP 回傳結果中解析 JSON。
 * 嘗試解析第一個 type=text 的內容；失敗回傳 null。
 *
 * @param {Object} result - MCP tool 回傳物件
 * @param {*} fallback - 解析失敗時的預設值（預設 null）
 * @returns {*}
 */
export function extractJson(result, fallback = null) {
  const text = extractText(result);
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * 從 MCP 回傳結果萃取所有圖片（type=image）。
 * 回傳 { mimeType, data } 陣列（data 為 base64 字串）。
 *
 * @param {Object} result - MCP tool 回傳物件
 * @returns {Array<{mimeType: string, data: string}>}
 */
export function extractImages(result) {
  return (result?.content ?? [])
    .filter(c => c.type === "image")
    .map(c => ({ mimeType: c.mimeType, data: c.data }));
}

/**
 * 判斷 MCP 回傳結果是否為成功（無 isError 或 isError=false）。
 *
 * @param {Object} result - MCP tool 回傳物件
 * @returns {boolean}
 */
export function isSuccess(result) {
  return !result?.isError;
}

/**
 * 建立帶有多個 content 項目的 MCP 回傳物件（成功）。
 * 支援混合 text + image content。
 *
 * @param {Array<{type: string, text?: string, mimeType?: string, data?: string}>} contents
 * @returns {Object}
 */
export function createResult(contents) {
  return { content: contents };
}

/**
 * 驗證數值範圍
 * @param {number} value - 要驗證的值
 * @param {number} min - 最小值（含）
 * @param {number} max - 最大值（含）
 * @param {string} fieldName - 欄位名稱（用於錯誤訊息）
 * @throws {Error} 值超出範圍
 */
export function validateRange(value, min, max, fieldName) {
  if (value < min || value > max) {
    throw new Error(`${fieldName} 必須介於 ${min} 到 ${max} 之間，收到: ${value}`);
  }
}

/**
 * 驗證陣列長度
 * @param {Array} arr - 要驗證的陣列
 * @param {number} maxLength - 最大長度
 * @param {string} fieldName - 欄位名稱
 * @throws {Error} 陣列過長
 */
export function validateArrayLength(arr, maxLength, fieldName) {
  if (arr && arr.length > maxLength) {
    throw new Error(`${fieldName} 最多 ${maxLength} 項，收到 ${arr.length} 項`);
  }
}

/**
 * 驗證是否為有效的 URL
 * @param {string} url - URL 字串
 * @throws {Error} URL 無效
 */
export function validateUrl(url) {
  try {
    new URL(url);
  } catch {
    throw new Error(`無效的 URL: ${url}`);
  }
}

/**
 * 格式化錯誤訊息
 * @param {Error|string} error - 錯誤物件或訊息
 * @param {string} context - 上下文描述
 * @returns {string} 格式化的錯誤訊息
 */
export function formatError(error, context) {
  const msg = error instanceof Error ? error.message : String(error);
  return context ? `${context}: ${msg}` : msg;
}

/**
 * 建立 MCP 工具回傳物件（錯誤）
 * @param {string} message - 錯誤訊息
 * @param {boolean} isError - 是否為錯誤（預設 true）
 * @returns {Object} MCP 回傳物件
 */
export function createError(message, isError = true) {
  return {
    isError,
    content: [{ type: "text", text: message }],
  };
}

/**
 * 建立 MCP 工具回傳物件（成功）
 * @param {string} message - 回傳訊息
 * @returns {Object} MCP 回傳物件
 */
export function createSuccess(message) {
  return {
    content: [{ type: "text", text: message }],
  };
}

/**
 * 帶 timeout 的 Promise 執行
 * @param {Promise} promise - 要執行的 Promise
 * @param {number} timeoutMs - timeout 毫秒數
 * @param {string} label - 操作標籤（用於錯誤訊息）
 * @returns {Promise} 原 Promise 或 timeout 錯誤
 */
export async function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`操作超時 [${label}]（${timeoutMs}ms）`)), timeoutMs)
    ),
  ]);
}

/**
 * 並發控制：執行任務但限制同時執行數量
 * @param {Array<Function>} tasks - 非同步函式陣列（各自返回 Promise）
 * @param {number} concurrency - 最大並發數
 * @returns {Promise<Array>} 結果陣列
 */
export async function runWithConcurrency(tasks, concurrency = 1) {
  const results = [];
  const executing = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]();
    const promise = task.then((result) => {
      executing.splice(executing.indexOf(promise), 1);
      return result;
    });

    results.push(promise);
    executing.push(promise);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

/**
 * 延遲執行
 * @param {number} ms - 毫秒數
 * @returns {Promise} 解決後的 Promise
 */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 安全的 JSON 解析
 * @param {string} jsonStr - JSON 字串
 * @param {*} fallback - 解析失敗時的預設值
 * @returns {*} 解析結果或預設值
 */
export function safeJsonParse(jsonStr, fallback = null) {
  try {
    return JSON.parse(jsonStr);
  } catch {
    return fallback;
  }
}

/**
 * 正規化陣列參數：容忍 JSON 字串 / 單值 / undefined。
 * 用於 *_batch 工具避免「陣列被序列化成字串後被逐字元迭代」的 bug。
 *
 * - 已是陣列 → 原樣回傳
 * - 字串 → 嘗試 JSON.parse；成功且為陣列回傳之，否則包成單元素陣列
 * - 物件 → 包成單元素陣列
 * - null/undefined → 空陣列
 */
export function normalizeArrayArg(val) {
  if (Array.isArray(val)) return val;
  if (val == null) return [];
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
        return [parsed];
      } catch { /* fall through */ }
    }
    return [val];
  }
  return [val];
}
