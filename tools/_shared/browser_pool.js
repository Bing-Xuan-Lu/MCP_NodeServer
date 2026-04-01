/**
 * tools/_shared/browser_pool.js
 * 提取共用的 Playwright browser pool 邏輯
 * 避免重複初始化瀏覽器進程（dom_compare、css_tools、playwright_tools 等共用）
 */

let playwrightModule = null;

export async function getPlaywright() {
  if (!playwrightModule) {
    playwrightModule = await import("@playwright/test");
  }
  return playwrightModule;
}

/**
 * 建立 browser pool
 * @param {number} ttl - 無活動後自動關閉的時間（毫秒，預設 60000）
 * @returns {Object} pool 物件 { acquire(viewport, headless), release() }
 */
export function createBrowserPool(ttl = 60000) {
  let pooledBrowser = null;
  let poolTimer = null;

  return {
    /**
     * 取得或創建瀏覽器實例
     * @param {Object} options - { viewport: {width, height}, headless: boolean }
     */
    async acquire(options = {}) {
      const { viewport = { width: 1920, height: 1080 }, headless = true } = options;

      // 檢查現有連線
      if (pooledBrowser && pooledBrowser.isConnected?.()) {
        clearTimeout(poolTimer);
        poolTimer = setTimeout(() => this.release(), ttl);
        return pooledBrowser;
      }

      // 建立新連線
      const { chromium } = await getPlaywright();
      pooledBrowser = await chromium.launch({ headless });
      poolTimer = setTimeout(() => this.release(), ttl);
      return pooledBrowser;
    },

    /**
     * 關閉瀏覽器連線
     */
    release() {
      if (pooledBrowser) {
        pooledBrowser.close?.().catch(() => {});
        pooledBrowser = null;
        clearTimeout(poolTimer);
        poolTimer = null;
      }
    },

    /**
     * 檢查連線狀態
     */
    isConnected() {
      return pooledBrowser?.isConnected?.() ?? false;
    },
  };
}

/**
 * 預設全域 pool（供需要的工具使用）
 * 建議在模組層級建立，避免每個工具各自建立 pool
 */
export const defaultBrowserPool = createBrowserPool();
