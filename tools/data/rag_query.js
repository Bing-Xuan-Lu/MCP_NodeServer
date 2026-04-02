/**
 * tools/rag_query.js — RAG 查詢工具（ChromaDB）
 * 負責：語意搜尋、批次查詢、索引狀態查看
 *
 * 選用功能：ChromaDB 未啟動時，其他 MCP 工具完全不受影響。
 * 啟動方式：cd chromadb && docker compose up -d
 */

import {
  getChromaClient,
  getCollection,
  chromaUnavailable,
  logProgress,
} from "../_shared/_rag_common.js";

// ============================================
// 工具定義
// ============================================
export const definitions = [
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
        filter_class: {
          type: "string",
          description: "限定 PHP class 名稱（精確匹配，如 order、news）",
        },
        filter_file_type: {
          type: "string",
          enum: ["model", "admin", "ajax", "js"],
          description: "限定檔案類型（model=cls/model, admin=adminControl, ajax=AJAX, js=JavaScript）",
        },
      },
      required: ["project", "query"],
    },
  },
  {
    name: "rag_query_batch",
    description:
      "批次語意搜尋（一次送多個查詢，共用 embedding 載入，比逐次 rag_query 更高效）",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "專案資料夾名稱（查詢 rag_{project} collection）",
        },
        queries: {
          type: "array",
          items: { type: "string" },
          description: "多個自然語言查詢陣列",
        },
        n_results: {
          type: "integer",
          description: "每個查詢的回傳結果數量（預設 3，最多 10）",
        },
        filter_path: {
          type: "string",
          description: "限定檔案路徑前綴（所有查詢共用）",
        },
        filter_language: {
          type: "string",
          description: "限定程式語言（所有查詢共用）",
        },
        filter_class: {
          type: "string",
          description: "限定 PHP class 名稱（所有查詢共用）",
        },
        filter_file_type: {
          type: "string",
          enum: ["model", "admin", "ajax", "js"],
          description: "限定檔案類型（所有查詢共用）",
        },
      },
      required: ["project", "queries"],
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
// 工具邏輯
// ============================================
export async function handle(name, args) {
  const client = await getChromaClient();
  if (!client) return chromaUnavailable();

  if (name === "rag_query") return await handleQuery(client, args);
  if (name === "rag_query_batch") return await handleQueryBatch(client, args);
  if (name === "rag_status") return await handleStatus(client, args);
}

// ── rag_query ──────────────────────────────────
async function handleQuery(client, args) {
  const nResults = Math.min(args.n_results || 5, 20);
  const collectionName = `rag_${args.project}`;

  // 預熱 Embedding（首次查詢時載入模型）
  if (global.embeddingFn) {
    try { await global.embeddingFn.generate(["warmup"]); } catch { /* ignore */ }
  }

  // 構建 where 過濾條件
  const whereConditions = [];
  if (args.filter_language) whereConditions.push({ language: args.filter_language });
  if (args.filter_class) whereConditions.push({ class_name: args.filter_class });
  if (args.filter_file_type) whereConditions.push({ file_type: args.filter_file_type });

  const where = whereConditions.length > 1
    ? { $and: whereConditions }
    : whereConditions.length === 1
      ? whereConditions[0]
      : undefined;

  // 多取一些結果以供 post-filter 路徑篩選
  const fetchCount = args.filter_path ? nResults * 3 : nResults;

  // 查詢專案 collection
  let results = [];
  try {
    const collection = await getCollection(client, collectionName);
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
      const sharedCol = await getCollection(client, "rag_shared");
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

  // 低信心度警告
  const bestDistance = results.length > 0 ? results[0].distance : 1;
  const lowConfidence = bestDistance > 0.45;
  const warning = lowConfidence
    ? `\n⚠️ 最佳結果 distance=${bestDistance.toFixed(3)}，語意搜尋信心度低。建議改用 Grep 精確搜尋或 class_method_lookup 直接定位。\n`
    : "";

  return { content: [{ type: "text", text: header + warning + parts.join("\n\n") }] };
}

// ── rag_query_batch ────────────────────────────
async function handleQueryBatch(client, args) {
  const nResults = Math.min(args.n_results || 3, 10);
  const collectionName = `rag_${args.project}`;

  // 預熱 Embedding（只做一次，所有查詢共用）
  if (global.embeddingFn) {
    try { await global.embeddingFn.generate(["warmup"]); } catch { /* ignore */ }
  }

  // 構建 where 過濾條件
  const batchWhereConditions = [];
  if (args.filter_language) batchWhereConditions.push({ language: args.filter_language });
  if (args.filter_class) batchWhereConditions.push({ class_name: args.filter_class });
  if (args.filter_file_type) batchWhereConditions.push({ file_type: args.filter_file_type });

  const where = batchWhereConditions.length > 1
    ? { $and: batchWhereConditions }
    : batchWhereConditions.length === 1
      ? batchWhereConditions[0]
      : undefined;
  const fetchCount = args.filter_path ? nResults * 3 : nResults;

  let collection;
  try {
    collection = await getCollection(client, collectionName);
  } catch (err) {
    if (err.message?.includes("does not exist")) {
      return {
        content: [{
          type: "text",
          text: `⚠️ Collection ${collectionName} 不存在。請先執行 rag_index。`,
        }],
      };
    }
    throw err;
  }

  const allParts = [];
  let hasLowConfidence = false;
  for (let qi = 0; qi < args.queries.length; qi++) {
    const query = args.queries[qi];
    let results = [];

    try {
      const res = await collection.query({
        queryTexts: [query],
        nResults: fetchCount,
        where,
        include: ["documents", "metadatas", "distances"],
      });

      if (res.ids[0]) {
        for (let i = 0; i < res.ids[0].length; i++) {
          const meta = res.metadatas[0][i];
          if (args.filter_path && !meta.file_path.includes(args.filter_path)) continue;
          results.push({
            text: res.documents[0][i],
            metadata: meta,
            distance: res.distances[0][i],
          });
        }
      }
    } catch {
      allParts.push(`── Q${qi + 1}: "${query}" → ❌ 查詢失敗`);
      continue;
    }

    results.sort((a, b) => a.distance - b.distance);
    results = results.slice(0, nResults);

    if (results.length === 0) {
      allParts.push(`── Q${qi + 1}: "${query}" → 無結果`);
      continue;
    }

    // 檢查信心度
    if (results[0].distance > 0.45) hasLowConfidence = true;

    const lines = results.map((r, i) => {
      const m = r.metadata;
      const score = (1 - r.distance).toFixed(3);
      let text = r.text;
      if (text.length > 1000) text = text.slice(0, 1000) + "\n... (截斷)";
      return `  #${i + 1} | ${m.file_path}:${m.start_line}-${m.end_line} | ${score} | ${m.language}\n${text}`;
    });

    allParts.push(`── Q${qi + 1}: "${query}" → ${results.length} 個結果\n${lines.join("\n\n")}`);
  }

  const header = `🔍 批次查詢: ${args.queries.length} 個 → collection ${collectionName}\n\n`;
  const warning = hasLowConfidence
    ? `⚠️ 部分查詢最佳結果 distance > 0.45，語意搜尋信心度低。建議改用 Grep 精確搜尋或 class_method_lookup 直接定位。\n\n`
    : "";
  return { content: [{ type: "text", text: header + warning + allParts.join("\n\n") }] };
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
    const collection = await getCollection(client, collectionName);
    const count = await collection.count();

    // 取得所有已索引檔案的 metadata（分頁拉取）
    const allMetadatas = [];
    const PAGE_SIZE = 5000;
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      const batch = await collection.get({
        limit: PAGE_SIZE,
        offset,
        include: ["metadatas"],
      });
      if (!batch.ids || batch.ids.length === 0) break;
      allMetadatas.push(...batch.metadatas);
      offset += batch.ids.length;
      if (batch.ids.length < PAGE_SIZE) hasMore = false;
    }

    // 統計
    const fileMap = new Map();
    for (const m of allMetadatas) {
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
