import fs from "fs/promises";
import path from "path";
import { resolveSecurePath } from "../../config.js";

// 動態 import pdfjs-dist legacy build（Node.js 環境必須用 legacy）
let pdfjsLib = null;
async function getPdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjsLib;
}

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "read_pdf_file",
    description:
      "讀取 PDF 檔案，逐頁提取文字內容，輸出 Markdown 或純文字格式。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "檔案路徑（相對 basePath 或絕對路徑）" },
        format: {
          type: "string",
          enum: ["markdown", "text"],
          description: "輸出格式（預設 markdown）",
        },
        pages: {
          type: "string",
          description: "指定頁碼範圍，如 '1-5' 或 '3,7,10-12'（預設全部）",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_pdf_files_batch",
    description: "批次讀取多個 PDF 檔案，回傳文字摘要。",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "檔案路徑陣列",
        },
        format: {
          type: "string",
          enum: ["markdown", "text"],
          description: "輸出格式（預設 markdown）",
        },
      },
      required: ["paths"],
    },
  },
];

// ============================================
// 頁碼解析
// ============================================
function parsePageRange(rangeStr, totalPages) {
  if (!rangeStr) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const pages = new Set();
  const parts = rangeStr.split(",").map((s) => s.trim());

  for (const part of parts) {
    if (part.includes("-")) {
      const [startStr, endStr] = part.split("-").map((s) => s.trim());
      const start = Math.max(1, parseInt(startStr) || 1);
      const end = Math.min(totalPages, parseInt(endStr) || totalPages);
      for (let i = start; i <= end; i++) pages.add(i);
    } else {
      const p = parseInt(part);
      if (p >= 1 && p <= totalPages) pages.add(p);
    }
  }

  return Array.from(pages).sort((a, b) => a - b);
}

// ============================================
// 核心轉換
// ============================================
async function convertPdf(filePath, format = "markdown", pagesStr = null) {
  const securePath = resolveSecurePath(filePath);
  const ext = path.extname(securePath).toLowerCase();

  if (ext !== ".pdf") {
    throw new Error(`僅支援 .pdf 格式，收到: ${ext}`);
  }

  await fs.access(securePath);

  const pdfjs = await getPdfjs();
  const data = new Uint8Array(await fs.readFile(securePath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;

  const totalPages = doc.numPages;
  const pageNums = parsePageRange(pagesStr, totalPages);

  const pages = [];

  for (const pageNum of pageNums) {
    const page = await doc.getPage(pageNum);
    const textContent = await page.getTextContent();

    // 組合文字，按 y 座標分行
    const items = textContent.items.filter((item) => item.str !== undefined);

    if (items.length === 0) {
      pages.push({ pageNum, text: "(此頁無文字內容)" });
      continue;
    }

    // 用 transform[5] (y 座標) 分行，相近 y 值歸為同一行
    const lines = [];
    let currentLine = [];
    let lastY = null;

    for (const item of items) {
      const y = Math.round(item.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 3) {
        if (currentLine.length > 0) {
          lines.push(currentLine.join(""));
        }
        currentLine = [];
      }
      currentLine.push(item.str);
      lastY = y;
    }
    if (currentLine.length > 0) {
      lines.push(currentLine.join(""));
    }

    pages.push({ pageNum, text: lines.join("\n") });
  }

  // 組合輸出
  let content;
  if (format === "text") {
    content = pages
      .map((p) => `[Page ${p.pageNum}]\n${p.text}`)
      .join("\n\n---\n\n");
  } else {
    content = pages
      .map((p) => `## Page ${p.pageNum}\n\n${p.text}`)
      .join("\n\n---\n\n");
  }

  return { content, totalPages, readPages: pageNums.length };
}

// ============================================
// Handle
// ============================================
export async function handle(name, args) {
  if (name === "read_pdf_file") {
    const format = args.format || "markdown";
    const { content, totalPages, readPages } = await convertPdf(args.path, format, args.pages);

    const meta = [`📄 共 ${totalPages} 頁，已讀取 ${readPages} 頁`];
    const text = `<!-- ${meta.join(" | ")} -->\n\n${content}`;

    return { content: [{ type: "text", text }] };
  }

  if (name === "read_pdf_files_batch") {
    const format = args.format || "markdown";
    const results = [];

    for (const p of args.paths) {
      try {
        const { content, totalPages, readPages } = await convertPdf(p, format);
        const meta = `${totalPages} 頁`;
        const truncated =
          content.length > 10000
            ? content.slice(0, 10000) + "\n\n... (截斷，請單獨讀取完整內容)"
            : content;
        results.push(`## 📄 ${p} (${meta})\n\n${truncated}`);
      } catch (err) {
        results.push(`## ❌ ${p}\n\n錯誤: ${err.message}`);
      }
    }

    return { content: [{ type: "text", text: results.join("\n\n---\n\n") }] };
  }

  throw new Error(`未知工具: ${name}`);
}
