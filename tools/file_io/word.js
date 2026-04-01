import fs from "fs/promises";
import path from "path";
import mammoth from "mammoth";
import TurndownService from "turndown";
import { resolveSecurePath } from "../config.js";

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "read_word_file",
    description:
      "讀取 Word (.docx) 檔案，可輸出 Markdown、HTML 或純文字格式。圖片自動提取到同目錄 images/ 資料夾。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "檔案路徑（相對 basePath 或絕對路徑）" },
        format: {
          type: "string",
          enum: ["markdown", "html", "text"],
          description: "輸出格式（預設 markdown）",
        },
        extract_images: {
          type: "boolean",
          description: "是否提取圖片到檔案（預設 true，false 則跳過圖片）",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_word_files_batch",
    description: "批次讀取多個 Word (.docx) 檔案，回傳 Markdown 摘要。",
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
          enum: ["markdown", "html", "text"],
          description: "輸出格式（預設 markdown）",
        },
      },
      required: ["paths"],
    },
  },
];

// ============================================
// Turndown 設定
// ============================================
function createTurndown() {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  // 保留 img 標籤轉成 markdown 圖片語法
  td.addRule("images", {
    filter: "img",
    replacement(_content, node) {
      const alt = node.getAttribute("alt") || "";
      const src = node.getAttribute("src") || "";
      return src ? `![${alt}](${src})` : "";
    },
  });

  // 表格支援
  td.addRule("table", {
    filter: "table",
    replacement(_content, node) {
      const rows = Array.from(node.querySelectorAll("tr"));
      if (rows.length === 0) return "";

      const matrix = rows.map((row) =>
        Array.from(row.querySelectorAll("th, td")).map((cell) =>
          cell.textContent.trim().replace(/\|/g, "\\|").replace(/\n/g, " ")
        )
      );

      const colCount = Math.max(...matrix.map((r) => r.length));
      const padded = matrix.map((r) => {
        while (r.length < colCount) r.push("");
        return r;
      });

      const lines = [];
      lines.push("| " + padded[0].join(" | ") + " |");
      lines.push("| " + padded[0].map(() => "---").join(" | ") + " |");
      for (let i = 1; i < padded.length; i++) {
        lines.push("| " + padded[i].join(" | ") + " |");
      }
      return "\n\n" + lines.join("\n") + "\n\n";
    },
  });

  return td;
}

// ============================================
// MIME → 副檔名
// ============================================
const MIME_EXT = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/svg+xml": ".svg",
  "image/webp": ".webp",
  "image/emf": ".emf",
  "image/x-emf": ".emf",
  "image/x-wmf": ".wmf",
};

// ============================================
// 從 HTML 提取 base64 圖片並存檔
// ============================================
const BASE64_IMG_RE = /<img\s[^>]*src="data:image\/([\w+.-]+);base64,([^"]+)"[^>]*>/gi;

const MIME_TO_EXT = {
  png: ".png", jpeg: ".jpg", jpg: ".jpg", gif: ".gif",
  bmp: ".bmp", tiff: ".tiff", "svg+xml": ".svg",
  webp: ".webp", emf: ".emf", "x-emf": ".emf", "x-wmf": ".wmf",
};

async function extractBase64Images(html, imagesDir, imagesDirName) {
  let imageCount = 0;
  let dirCreated = false;

  const replaced = await replaceAsync(html, BASE64_IMG_RE, async (_match, mimeType, b64Data) => {
    imageCount++;
    const ext = MIME_TO_EXT[mimeType] || ".png";
    const imgName = `img_${String(imageCount).padStart(3, "0")}${ext}`;
    const imgPath = path.join(imagesDir, imgName);

    if (!dirCreated) {
      await fs.mkdir(imagesDir, { recursive: true });
      dirCreated = true;
    }

    await fs.writeFile(imgPath, Buffer.from(b64Data, "base64"));
    return `<img src="${imagesDirName}/${imgName}" alt="${imgName}">`;
  });

  return { html: replaced, imageCount };
}

/** async-capable String.replace */
async function replaceAsync(str, regex, asyncFn) {
  const matches = [];
  str.replace(regex, (...args) => { matches.push(args); return ""; });

  const replacements = await Promise.all(
    matches.map((args) => asyncFn(...args))
  );

  let i = 0;
  return str.replace(regex, () => replacements[i++]);
}

// ============================================
// 核心轉換
// ============================================
async function convertWord(filePath, format = "markdown", extractImages = true) {
  const securePath = resolveSecurePath(filePath);
  const ext = path.extname(securePath).toLowerCase();

  if (ext !== ".docx") {
    throw new Error(`僅支援 .docx 格式，收到: ${ext}`);
  }

  await fs.access(securePath);

  const buffer = await fs.readFile(securePath);
  const docDir = path.dirname(securePath);
  const docName = path.basename(securePath, ext);

  if (format === "text") {
    const result = await mammoth.extractRawText({ buffer });
    return { content: result.value, warnings: result.messages, imageCount: 0 };
  }

  const imagesDirName = `${docName}_images`;
  const imagesDir = path.join(docDir, imagesDirName);

  // mammoth convertImage 攔截標準 Word media 圖片
  let mammothImgCount = 0;
  const options = { buffer };

  if (extractImages) {
    options.convertImage = mammoth.images.imgElement(async (image) => {
      mammothImgCount++;
      const imgExt = MIME_TO_EXT[image.contentType?.split("/")[1]] || ".png";
      const imgName = `img_m${String(mammothImgCount).padStart(3, "0")}${imgExt}`;
      const imgPath = path.join(imagesDir, imgName);
      await fs.mkdir(imagesDir, { recursive: true });
      const imgBuffer = await image.read();
      await fs.writeFile(imgPath, imgBuffer);
      return { src: `${imagesDirName}/${imgName}` };
    });
  }

  const result = await mammoth.convertToHtml(options);
  let html = result.value;
  let imageCount = mammothImgCount;

  // 後處理：提取 mammoth 未攔截的 base64 內嵌圖片（VML/OLE 等）
  if (extractImages && html.includes("data:image")) {
    const extracted = await extractBase64Images(html, imagesDir, imagesDirName);
    html = extracted.html;
    imageCount += extracted.imageCount;
  }

  if (format === "html") {
    return { content: html, warnings: result.messages, imageCount };
  }

  // Markdown
  const td = createTurndown();
  const markdown = td.turndown(html);
  return { content: markdown, warnings: result.messages, imageCount };
}

// ============================================
// Handle
// ============================================
export async function handle(name, args) {
  if (name === "read_word_file") {
    const format = args.format || "markdown";
    const extractImages = args.extract_images !== false;
    const { content, warnings, imageCount } = await convertWord(args.path, format, extractImages);

    let text = content;

    // 前置資訊
    const meta = [];
    if (imageCount > 0) meta.push(`📷 已提取 ${imageCount} 張圖片`);
    if (warnings && warnings.length > 0) {
      meta.push(...warnings.map((w) => `⚠ ${w.message}`));
    }
    if (meta.length > 0) {
      text = `<!-- ${meta.join(" | ")} -->\n\n${text}`;
    }

    return { content: [{ type: "text", text }] };
  }

  if (name === "read_word_files_batch") {
    const format = args.format || "markdown";
    const results = [];

    for (const p of args.paths) {
      try {
        const { content, imageCount } = await convertWord(p, format);
        const imgNote = imageCount > 0 ? ` (📷 ${imageCount} 張圖片)` : "";
        const truncated =
          content.length > 10000
            ? content.slice(0, 10000) + "\n\n... (截斷，請單獨讀取完整內容)"
            : content;
        results.push(`## 📄 ${p}${imgNote}\n\n${truncated}`);
      } catch (err) {
        results.push(`## ❌ ${p}\n\n錯誤: ${err.message}`);
      }
    }

    return { content: [{ type: "text", text: results.join("\n\n---\n\n") }] };
  }

  throw new Error(`未知工具: ${name}`);
}
