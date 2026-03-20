/**
 * tools/rag.js — RAG 向量檢索工具（ChromaDB）
 *
 * 選用功能：ChromaDB 未啟動時，其他 MCP 工具完全不受影響。
 * 啟動方式：cd chromadb && docker compose up -d
 */

import fs from "fs/promises";
import path from "path";
import { resolveSecurePath, CONFIG } from "../config.js";

// ============================================
// 設定常數
// ============================================
const CHROMA_URL = "http://localhost:8010";

const SKIP_DIRS = new Set([
  "vendor", "node_modules", ".git", ".svn",
  "storage", "cache", ".idea", ".vscode",
]);

const DEFAULT_EXTENSIONS = [
  ".php", ".js", ".ts", ".css", ".sql",
  ".md", ".json", ".html", ".vue", ".twig",
];

const MAX_FILE_SIZE = 500 * 1024; // 500KB
const CHUNK_LINES = 60;
const CHUNK_OVERLAP = 10;

// Lazy-loaded ChromaDB client
let chromaClient = null;

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "rag_index",
    description:
      "將專案檔案索引至 ChromaDB 向量資料庫，支援增量索引（僅處理變更檔案）。" +
      "需先啟動 ChromaDB Docker 容器。",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description:
            "專案資料夾名稱（如 PG_dbox3），自動建立 collection rag_{project}",
        },
        paths: {
          type: "array",
          items: { type: "string" },
          description:
            "要索引的檔案或目錄路徑陣列（相對 basePath）。目錄會遞迴掃描",
        },
        shared: {
          type: "boolean",
          description:
            "設為 true 寫入 rag_shared collection（跨專案共用知識）",
        },
        force: {
          type: "boolean",
          description: "強制重新索引所有檔案（忽略 mtime 檢查）",
        },
        extensions: {
          type: "array",
          items: { type: "string" },
          description:
            "要索引的副檔名（預設 .php,.js,.ts,.css,.sql,.md,.json,.html,.vue,.twig）",
        },
      },
      required: ["project", "paths"],
    },
  },
  {
    name: "rag_query",
    description:
      "語意搜尋已索引的程式碼（從 ChromaDB 向量檢索最相關的片段）",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "專案資料夾名稱（查詢 rag_{project} collection）",
        },
        query: {
          type: "string",
          description:
            "自然語言查詢（如「使用者登入驗證邏輯」「PDF 匯出功能」）",
        },
        n_results: {
          type: "integer",
          description: "回傳結果數量（預設 5，最多 20）",
        },
        include_shared: {
          type: "boolean",
          description: "同時查詢 rag_shared collection（預設 false）",
        },
        filter_path: {
          type: "string",
          description: "限定檔案路徑前綴（如 admin/order/ 只搜尋該目錄）",
        },
        filter_language: {
          type: "string",
          description: "限定程式語言（如 php、js）",
        },
      },
      required: ["project", "query"],
    },
  },
  {
    name: "rag_status",
    description:
      "查看 RAG 索引狀態（ChromaDB 連線、collection 統計、已索引檔案清單）",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description:
            "專案名稱（查看特定 collection，不填則列出所有 collections）",
        },
      },
    },
  },
];

// ============================================
// ChromaDB 連線（Lazy + Graceful）
// ============================================
async function getChromaClient() {
  if (chromaClient) {
    try {
      await chromaClient.heartbeat();
      return chromaClient;
    } catch {
      chromaClient = null;
    }
  }

  try {
    const { ChromaClient } = await import("chromadb");
    const client = new ChromaClient({ host: "localhost", port: 8010 });
    await client.heartbeat();
    chromaClient = client;
    return client;
  } catch {
    return null;
  }
}

function chromaUnavailable() {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          "⚠️ ChromaDB 未連線（RAG 為選用功能，不影響其他工具）。\n" +
          "啟動方式：\n" +
          "  cd D:\\MCP_Server\\chromadb && docker compose up -d\n" +
          "確認連線：http://localhost:8010/api/v1/heartbeat",
      },
    ],
  };
}

// ============================================
// 檔案掃描
// ============================================
async function scanFiles(dirPath, extensions) {
  const results = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          await walk(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (extensions.includes(ext)) {
          try {
            const stat = await fs.stat(fullPath);
            if (stat.size <= MAX_FILE_SIZE) {
              results.push({ fullPath, size: stat.size, mtime: stat.mtimeMs });
            }
          } catch {
            // skip unreadable files
          }
        }
      }
    }
  }

  await walk(dirPath);
  return results;
}

// ============================================
// 切片（Chunking）
// ============================================
function chunkFile(content, relPath) {
  const lines = content.split(/\r?\n/);
  const chunks = [];

  if (lines.length <= CHUNK_LINES) {
    // 小檔案不切片
    chunks.push({
      text: content,
      startLine: 1,
      endLine: lines.length,
    });
    return chunks;
  }

  let start = 0;
  while (start < lines.length) {
    let end = Math.min(start + CHUNK_LINES, lines.length);

    // 智慧邊界：如果切到函式中間，往後找空行或頂層 }
    if (end < lines.length) {
      const searchLimit = Math.min(end + 10, lines.length);
      for (let i = end; i < searchLimit; i++) {
        const line = lines[i].trim();
        if (line === "" || line === "}" || line === "};") {
          end = i + 1;
          break;
        }
      }
    }

    const chunkLines = lines.slice(start, end);
    chunks.push({
      text: chunkLines.join("\n"),
      startLine: start + 1,
      endLine: end,
    });

    // 下一個 chunk 起始點（含重疊）
    start = end - CHUNK_OVERLAP;
    if (start <= chunks[chunks.length - 1].startLine - 1) {
      start = end; // 防止無限迴圈
    }
  }

  return chunks;
}

/** 取得相對於 basePath 的路徑 */
function getRelPath(fullPath) {
  const base = CONFIG.basePath.replace(/\\/g, "/").replace(/\/$/, "");
  const full = fullPath.replace(/\\/g, "/");
  return full.startsWith(base + "/") ? full.slice(base.length + 1) : full;
}

/** 從副檔名推斷語言 */
function detectLanguage(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const map = {
    php: "php", js: "javascript", ts: "typescript", jsx: "javascript",
    tsx: "typescript", css: "css", html: "html", vue: "vue",
    sql: "sql", json: "json", md: "markdown", twig: "twig",
  };
  return map[ext] || ext;
}

// ============================================
// 工具邏輯
// ============================================
export async function handle(name, args) {
  const client = await getChromaClient();
  if (!client) return chromaUnavailable();

  if (name === "rag_index") return handleIndex(client, args);
  if (name === "rag_query") return handleQuery(client, args);
  if (name === "rag_status") return handleStatus(client, args);
}

// ── rag_index ──────────────────────────────────
async function handleIndex(client, args) {
  const collectionName = args.shared
    ? "rag_shared"
    : `rag_${args.project}`;
  const extensions = (args.extensions || DEFAULT_EXTENSIONS).map((e) =>
    e.startsWith(".") ? e : `.${e}`
  );
  const force = args.force || false;

  const collection = await client.getOrCreateCollection({
    name: collectionName,
  });

  // 收集所有目標檔案
  let allFiles = [];
  for (const p of args.paths) {
    const fullPath = resolveSecurePath(p);
    const stat = await fs.stat(fullPath);

    if (stat.isDirectory()) {
      const files = await scanFiles(fullPath, extensions);
      allFiles.push(...files);
    } else if (stat.isFile()) {
      allFiles.push({ fullPath, size: stat.size, mtime: stat.mtimeMs });
    }
  }

  let indexed = 0;
  let skipped = 0;
  let chunksCreated = 0;
  const errors = [];

  for (const file of allFiles) {
    const relPath = getRelPath(file.fullPath);

    try {
      // 增量檢查：查現有 chunks 的 indexed_at
      if (!force) {
        const existing = await collection.get({
          where: { file_path: relPath },
          limit: 1,
        });

        if (existing && existing.ids.length > 0) {
          const lastIndexed = existing.metadatas[0]?.indexed_at;
          if (lastIndexed && new Date(lastIndexed).getTime() >= file.mtime) {
            skipped++;
            continue;
          }
        }
      }

      // 讀取並切片
      const content = await fs.readFile(file.fullPath, "utf-8");
      const chunks = chunkFile(content, relPath);
      const language = detectLanguage(file.fullPath);
      const now = new Date().toISOString();

      // 刪除該檔案的舊 chunks
      try {
        await collection.delete({
          where: { file_path: relPath },
        });
      } catch {
        // collection 可能為空，忽略
      }

      // 批次插入新 chunks（ChromaDB 建議每次不超過 5000）
      const batchSize = 100;
      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        await collection.add({
          ids: batch.map(
            (c) => `${relPath}:${c.startLine}-${c.endLine}`
          ),
          documents: batch.map((c) => c.text),
          metadatas: batch.map((c) => ({
            project: args.project,
            file_path: relPath,
            start_line: c.startLine,
            end_line: c.endLine,
            language,
            file_size: file.size,
            indexed_at: now,
          })),
        });
      }

      indexed++;
      chunksCreated += chunks.length;
    } catch (err) {
      errors.push(`${relPath}: ${err.message}`);
    }
  }

  const lines = [
    `✅ 索引完成 → collection: ${collectionName}`,
    `   檔案處理: ${indexed} | 跳過（未變更）: ${skipped} | 切片: ${chunksCreated}`,
  ];
  if (errors.length > 0) {
    lines.push(`   ❌ 錯誤 (${errors.length}):`);
    errors.slice(0, 5).forEach((e) => lines.push(`      ${e}`));
    if (errors.length > 5) lines.push(`      ...及其他 ${errors.length - 5} 個`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ── rag_query ──────────────────────────────────
async function handleQuery(client, args) {
  const nResults = Math.min(args.n_results || 5, 20);
  const collectionName = `rag_${args.project}`;

  // 構建 where 過濾條件（僅支援精確匹配，路徑過濾改用 post-filter）
  const where = args.filter_language
    ? { language: args.filter_language }
    : undefined;

  // 多取一些結果以供 post-filter 路徑篩選
  const fetchCount = args.filter_path ? nResults * 3 : nResults;

  // 查詢專案 collection
  let results = [];
  try {
    const collection = await client.getCollection({ name: collectionName });
    const res = await collection.query({
      queryTexts: [args.query],
      nResults: fetchCount,
      where,
      include: ["documents", "metadatas", "distances"],
    });

    if (res.ids[0]) {
      for (let i = 0; i < res.ids[0].length; i++) {
        const meta = res.metadatas[0][i];
        // post-filter: 路徑前綴篩選
        if (args.filter_path && !meta.file_path.includes(args.filter_path)) {
          continue;
        }
        results.push({
          id: res.ids[0][i],
          text: res.documents[0][i],
          metadata: meta,
          distance: res.distances[0][i],
          source: "project",
        });
      }
    }
  } catch (err) {
    if (err.message?.includes("does not exist")) {
      return {
        content: [
          {
            type: "text",
            text:
              `⚠️ Collection ${collectionName} 不存在。\n` +
              `請先執行 rag_index 建立索引：\n` +
              `  rag_index { project: "${args.project}", paths: ["${args.project}/"] }`,
          },
        ],
      };
    }
    throw err;
  }

  // 查詢 shared collection
  if (args.include_shared) {
    try {
      const sharedCol = await client.getCollection({ name: "rag_shared" });
      const res = await sharedCol.query({
        queryTexts: [args.query],
        nResults: Math.ceil(nResults / 2),
        include: ["documents", "metadatas", "distances"],
      });

      if (res.ids[0]) {
        for (let i = 0; i < res.ids[0].length; i++) {
          results.push({
            id: res.ids[0][i],
            text: res.documents[0][i],
            metadata: res.metadatas[0][i],
            distance: res.distances[0][i],
            source: "shared",
          });
        }
      }
    } catch {
      // rag_shared 不存在就跳過
    }
  }

  // 依 distance 排序（越小越相關）
  results.sort((a, b) => a.distance - b.distance);
  results = results.slice(0, nResults);

  if (results.length === 0) {
    return {
      content: [{ type: "text", text: "找不到相關結果。試試不同的查詢詞或先建立索引。" }],
    };
  }

  // 格式化輸出
  const parts = results.map((r, i) => {
    const m = r.metadata;
    const score = (1 - r.distance).toFixed(3);
    const tag = r.source === "shared" ? " [shared]" : "";
    const header =
      `── #${i + 1}${tag} | ${m.file_path}:${m.start_line}-${m.end_line} | ` +
      `相關度: ${score} | ${m.language}`;

    // 截斷過長的片段
    const maxChars = 2000;
    let text = r.text;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + "\n... (截斷)";
    }

    return `${header}\n${text}`;
  });

  const header = `🔍 查詢: "${args.query}" → ${results.length} 個結果\n`;
  return { content: [{ type: "text", text: header + parts.join("\n\n") }] };
}

// ── rag_status ─────────────────────────────────
async function handleStatus(client, args) {
  if (!args.project) {
    // 列出所有 collections
    const collections = await client.listCollections();

    if (collections.length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              "ChromaDB 已連線 ✅，但尚無任何 collection。\n" +
              "使用 rag_index 建立索引。",
          },
        ],
      };
    }

    const lines = [`ChromaDB 已連線 ✅ | ${collections.length} 個 collections：\n`];

    for (const col of collections) {
      const colName = col._name || col.name || String(col);
      try {
        const count = await col.count();
        lines.push(`  📦 ${colName} — ${count} 個切片`);
      } catch {
        lines.push(`  📦 ${colName} — (無法讀取)`);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // 特定專案詳情
  const collectionName = `rag_${args.project}`;
  try {
    const collection = await client.getCollection({ name: collectionName });
    const count = await collection.count();

    // 取得所有已索引檔案的 metadata
    const all = await collection.get({
      limit: 10000,
      include: ["metadatas"],
    });

    // 統計
    const fileMap = new Map();
    for (const m of all.metadatas) {
      if (!fileMap.has(m.file_path)) {
        fileMap.set(m.file_path, {
          chunks: 0,
          language: m.language,
          indexed_at: m.indexed_at,
        });
      }
      const f = fileMap.get(m.file_path);
      f.chunks++;
      if (m.indexed_at > f.indexed_at) f.indexed_at = m.indexed_at;
    }

    // 依語言分組統計
    const langStats = {};
    for (const [, info] of fileMap) {
      langStats[info.language] = (langStats[info.language] || 0) + 1;
    }

    const lines = [
      `📦 Collection: ${collectionName}`,
      `   切片總數: ${count}`,
      `   檔案總數: ${fileMap.size}`,
      `   語言分佈: ${Object.entries(langStats).map(([k, v]) => `${k}(${v})`).join(", ")}`,
      "",
    ];

    // 最近索引的 10 個檔案
    const sorted = [...fileMap.entries()].sort(
      (a, b) => (b[1].indexed_at || "").localeCompare(a[1].indexed_at || "")
    );
    lines.push("   最近索引的檔案：");
    sorted.slice(0, 10).forEach(([fp, info]) => {
      const time = info.indexed_at
        ? new Date(info.indexed_at).toLocaleString("zh-TW")
        : "?";
      lines.push(`     ${fp} (${info.chunks} chunks, ${time})`);
    });
    if (sorted.length > 10) {
      lines.push(`     ...及其他 ${sorted.length - 10} 個檔案`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    if (err.message?.includes("does not exist")) {
      return {
        content: [
          {
            type: "text",
            text:
              `Collection ${collectionName} 不存在。\n` +
              `使用 rag_index 建立索引：rag_index { project: "${args.project}", paths: ["${args.project}/"] }`,
          },
        ],
      };
    }
    throw err;
  }
}
