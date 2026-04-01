/**
 * tools/_shared/utils.js
 * 共用工具函式：參數驗證、錯誤處理、路徑操作
 */

/**
 * 驗證必需參數
 * @param {Object} args - 參數物件
 * @param {Array<string>} required - 必需參數名稱陣列
 * @throws {Error} 缺少必需參數
 */
export function validateRequired(args, required) {
  const missing = required.filter(key => !args[key]);
  if (missing.length > 0) {
    throw new Error(`缺少必需參數: ${missing.join(", ")}`);
  }
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
