/**
 * tools/rag_index.js — RAG 索引工具（ChromaDB）
 * 負責：檔案掃描、切片、embedding、增量索引
 *
 * 選用功能：ChromaDB 未啟動時，其他 MCP 工具完全不受影響。
 * 啟動方式：cd chromadb && docker compose up -d
 */

import fs from "fs/promises";
import path from "path";
import { resolveSecurePath, CONFIG } from "../../config.js";
import {
  CHROMA_URL,
  EMBEDDING_MODEL,
  SKIP_DIRS,
  DEFAULT_EXTENSIONS,
  SKIP_FILE_PATTERNS,
  THIRD_PARTY_SIGNATURES,
  MINIFIED_LINE_THRESHOLD,
  MINIFIED_MAX_LINES,
  MAX_FILE_SIZE,
  CHUNK_LINES,
  CHUNK_OVERLAP,
  EMBED_CONCURRENCY,
  EMBED_BATCH_SIZE,
  FILE_TIMEOUT_MS,
  PROGRESS_INTERVAL,
  AUTO_BATCH_LIMIT,
  getChromaClient,
  getCollection,
  chromaUnavailable,
  logProgress,
  scanFiles,
  chunkFile,
  detectPhpFunctions,
  buildChunkMeta,
  getRelPath,
  detectLanguage,
  runWithConcurrency,
  withTimeout,
} from "../_shared/_rag_common.js";

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
        chunk_lines: {
          type: "integer",
          description: "每個 chunk 的行數(預設 60)",
        },
        chunk_overlap: {
          type: "integer",
          description: "chunk 之間的重疊行數(預設 10)",
        },
      },
      required: ["project", "paths"],
    },
  },
];

// ============================================
// 工具邏輯
// ============================================
export async function handle(name, args) {
  if (name !== "rag_index") return;

  const client = await getChromaClient();
  if (!client) return chromaUnavailable();

  return await handleIndex(client, args);
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
  const chunkLines = args.chunk_lines || CHUNK_LINES;
  const chunkOverlap = args.chunk_overlap || CHUNK_OVERLAP;

  const collection = await getCollection(client, collectionName, true);

  // ── 0. 預熱 Embedding 模型（首次載入 ONNX ~30-60s，避免 FILE_TIMEOUT 誤殺） ──
  if (global.embeddingFn) {
    logProgress(`預熱 Embedding 模型中（首次載入較慢）...`);
    try {
      await global.embeddingFn.generate(["warmup"]);
      logProgress(`Embedding 模型就緒`);
    } catch (err) {
      logProgress(`Embedding 預熱失敗: ${err.message}`);
      return {
        isError: true,
        content: [{ type: "text", text: `❌ Embedding 模型載入失敗: ${err.message}\n請確認 @chroma-core/default-embed 已安裝且 ONNX 模型快取完整。` }],
      };
    }
  }

  // ── 1. 收集所有目標檔案 ──
  logProgress(`掃描檔案中...`);
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
  logProgress(`找到 ${allFiles.length} 個檔案`);

  // ── 2. 批次增量檢查（一次拉所有已索引檔案的 metadata） ──
  let indexedFileMap = new Map(); // relPath → latest indexed_at
  if (!force) {
    logProgress(`載入已索引檔案清單...`);
    try {
      // 分批拉取（ChromaDB get limit）
      const PAGE_SIZE = 5000;
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const batch = await collection.get({
          limit: PAGE_SIZE,
          offset,
          include: ["metadatas"],
        });
        if (!batch.ids || batch.ids.length === 0) {
          hasMore = false;
          break;
        }
        for (const m of batch.metadatas) {
          const existing = indexedFileMap.get(m.file_path);
          if (!existing || m.indexed_at > existing) {
            indexedFileMap.set(m.file_path, m.indexed_at);
          }
        }
        offset += batch.ids.length;
        if (batch.ids.length < PAGE_SIZE) hasMore = false;
      }
      logProgress(`已索引檔案: ${indexedFileMap.size} 個`);
    } catch {
      // collection 可能為空
      logProgress(`Collection 為空或無法讀取，將索引所有檔案`);
    }
  }

  // ── 3. 過濾需要處理的檔案 ──
  const filesToProcess = [];
  let skipped = 0;
  for (const file of allFiles) {
    const relPath = getRelPath(file.fullPath);
    if (!force) {
      const lastIndexed = indexedFileMap.get(relPath);
      if (lastIndexed && new Date(lastIndexed).getTime() >= file.mtime) {
        skipped++;
        continue;
      }
    }
    filesToProcess.push({ ...file, relPath });
  }
  logProgress(`需處理: ${filesToProcess.length} | 跳過(未變更): ${skipped}`);

  if (filesToProcess.length === 0) {
    return {
      content: [{
        type: "text",
        text: `✅ 索引已是最新 → collection: ${collectionName}\n` +
              `   檔案總數: ${allFiles.length} | 全部跳過（無變更）`,
      }],
    };
  }

  // ── 4. 自動分批處理（防止記憶體溢出） ──
  const totalBatches = Math.ceil(filesToProcess.length / AUTO_BATCH_LIMIT);
  if (totalBatches > 1) {
    logProgress(`檔案數 ${filesToProcess.length} → 自動分 ${totalBatches} 批（每批 ${AUTO_BATCH_LIMIT}）`);
  }

  let indexed = 0;
  let chunksCreated = 0;
  let skippedThirdParty = 0;
  const errors = [];
  const startTime = Date.now();

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const batchFiles = filesToProcess.slice(
      batchIdx * AUTO_BATCH_LIMIT,
      (batchIdx + 1) * AUTO_BATCH_LIMIT
    );
    if (totalBatches > 1) {
      logProgress(`── 批次 ${batchIdx + 1}/${totalBatches}（${batchFiles.length} 檔）──`);
    }

    const tasks = batchFiles.map((file) => async () => {
      try {
        const result = await withTimeout(
          processFile(collection, file, args.project, chunkLines, chunkOverlap),
          FILE_TIMEOUT_MS,
          file.relPath
        );
        if (result.skipped) {
          skippedThirdParty++;
          logProgress(`⊘ 第三方跳過: ${file.relPath} (${result.reason})`);
        } else {
          indexed++;
          chunksCreated += result.chunks;
        }

        // 進度回報
        const done = indexed + skippedThirdParty + errors.length;
        if (done % PROGRESS_INTERVAL === 0 || done === filesToProcess.length) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const rate = (done / (Date.now() - startTime) * 1000).toFixed(1);
          logProgress(
            `[${done}/${filesToProcess.length}] ${elapsed}s elapsed, ` +
            `${rate} files/s, ${chunksCreated} chunks`
          );
        }
      } catch (err) {
        errors.push(`${file.relPath}: ${err.message}`);
        const done = indexed + skippedThirdParty + errors.length;
        if (done % PROGRESS_INTERVAL === 0) {
          logProgress(`[${done}/${filesToProcess.length}] (${errors.length} errors)`);
        }
      }
    });

    await runWithConcurrency(tasks, EMBED_CONCURRENCY);

    // 批次間暫停，讓 GC 有機會釋放記憶體
    if (totalBatches > 1 && batchIdx < totalBatches - 1) {
      if (global.gc) {
        global.gc();
        logProgress(`GC 完成`);
      }
      await new Promise((r) => setTimeout(r, 2000));
      logProgress(`批次 ${batchIdx + 1} 完成，等待 2s 後繼續...`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const lines = [
    `✅ 索引完成 → collection: ${collectionName}`,
    `   掃描: ${allFiles.length} 檔` + (totalBatches > 1 ? ` → ${totalBatches} 批自動分批` : ``),
    `   檔案索引: ${indexed} | 跳過(未變更): ${skipped} | 跳過(第三方): ${skippedThirdParty} | 切片: ${chunksCreated}`,
    `   耗時: ${elapsed}s`,
  ];
  if (errors.length > 0) {
    lines.push(`   ❌ 錯誤 (${errors.length}):`);
    errors.slice(0, 10).forEach((e) => lines.push(`      ${e}`));
    if (errors.length > 10) lines.push(`      ...及其他 ${errors.length - 10} 個`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

/** 偵測第三方 / minified 檔案 */
function isThirdParty(content) {
  // 1. 內容特徵：前 5 行比對已知套件簽名
  const headLines = content.split(/\r?\n/, 5);
  const head = headLines.join("\n");
  if (THIRD_PARTY_SIGNATURES.some((re) => re.test(head))) {
    return `signature match in header`;
  }

  // 2. 壓縮偵測：極少行但單行超長 → minified
  const lines = content.split(/\r?\n/);
  if (lines.length <= MINIFIED_MAX_LINES) {
    const maxLen = Math.max(...lines.map((l) => l.length));
    if (maxLen > MINIFIED_LINE_THRESHOLD) {
      return `minified (${lines.length} lines, longest ${maxLen} chars)`;
    }
  }

  return null; // 不是第三方
}

/** 處理單一檔案：讀取 → 切片 → 刪舊 → 批次寫入 */
async function processFile(collection, file, project, chunkLinesCount = CHUNK_LINES, chunkOverlap = CHUNK_OVERLAP) {
  const { fullPath, relPath, size } = file;
  const content = await fs.readFile(fullPath, "utf-8");

  // 第三方 / minified 偵測 → 跳過並清除舊 chunks
  const thirdPartyReason = isThirdParty(content);
  if (thirdPartyReason) {
    try { await collection.delete({ where: { file_path: relPath } }); } catch {}
    return { chunks: 0, skipped: true, reason: thirdPartyReason };
  }

  const chunks = chunkFile(content, relPath, chunkLinesCount, chunkOverlap);
  const language = detectLanguage(fullPath);
  const now = new Date().toISOString();

  // 刪除該檔案的舊 chunks
  try {
    await collection.delete({ where: { file_path: relPath } });
  } catch {
    // collection 可能為空，忽略
  }

  // 批次插入新 chunks
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    await collection.add({
      ids: batch.map((c) => `${relPath}:${c.startLine}-${c.endLine}`),
      documents: batch.map((c) => c.text),
      metadatas: batch.map((c) => ({
        project,
        file_path: relPath,
        start_line: c.startLine,
        end_line: c.endLine,
        language,
        file_size: size,
        indexed_at: now,
        ...(c.class_name ? { class_name: c.class_name } : {}),
        ...(c.methods ? { methods: c.methods } : {}),
        ...(c.file_type ? { file_type: c.file_type } : {}),
      })),
    });
  }

  return { chunks: chunks.length };
}
