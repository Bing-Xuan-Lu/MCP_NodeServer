import fs from "fs/promises";
import path from "path";
import { resolveSecurePath } from "../../config.js";

// 延遲載入 sharp（有 native binding，避免啟動時就載入）
let sharpModule = null;
async function getSharp() {
  if (!sharpModule) {
    sharpModule = (await import("sharp")).default;
  }
  return sharpModule;
}

const SUPPORTED_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".avif", ".svg",
]);

const MIME_MAP = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

const MAX_BATCH_SIZE = 20;

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "read_image",
    description:
      "讀取單張圖片，可選縮放以節省 token。回傳圖片供 Claude 視覺分析。",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "圖片路徑（相對 basePath 或絕對路徑）",
        },
        max_width: {
          type: "number",
          description: "最大寬度（px），超過則等比縮小（預設不縮放）",
        },
        max_height: {
          type: "number",
          description: "最大高度（px），超過則等比縮小（預設不縮放）",
        },
        quality: {
          type: "number",
          description: "JPEG/WebP 壓縮品質 1-100（預設 80）",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_images_batch",
    description:
      "批次讀取多張圖片（上限 20 張），可選縮放以節省 token。回傳圖片供 Claude 視覺分析。",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "圖片路徑陣列（上限 20 張）",
        },
        max_width: {
          type: "number",
          description: "最大寬度（px），超過則等比縮小（預設不縮放）",
        },
        max_height: {
          type: "number",
          description: "最大高度（px），超過則等比縮小（預設不縮放）",
        },
        quality: {
          type: "number",
          description: "JPEG/WebP 壓縮品質 1-100（預設 80）",
        },
      },
      required: ["paths"],
    },
  },
];

// ============================================
// 核心處理
// ============================================
async function processImage(filePath, opts = {}) {
  const securePath = resolveSecurePath(filePath);
  const ext = path.extname(securePath).toLowerCase();

  if (!SUPPORTED_EXTS.has(ext)) {
    throw new Error(
      `不支援的圖片格式: ${ext}（支援: ${[...SUPPORTED_EXTS].join(", ")}）`
    );
  }

  await fs.access(securePath);

  const { max_width, max_height, quality = 80 } = opts;
  const needsResize = max_width || max_height;

  // SVG 不走 sharp，直接回傳原始 base64
  if (ext === ".svg") {
    const buffer = await fs.readFile(securePath);
    return { data: buffer.toString("base64"), mimeType: "image/svg+xml" };
  }

  if (needsResize) {
    const sharp = await getSharp();
    let pipeline = sharp(securePath);

    pipeline = pipeline.resize({
      width: max_width || undefined,
      height: max_height || undefined,
      fit: "inside",
      withoutEnlargement: true,
    });

    // PNG/GIF 保留透明度，其餘轉 JPEG 壓縮
    if (ext === ".png" || ext === ".gif") {
      const buffer = await pipeline.png({ compressionLevel: 6 }).toBuffer();
      return { data: buffer.toString("base64"), mimeType: "image/png" };
    } else if (ext === ".webp") {
      const q = Math.max(1, Math.min(100, quality));
      const buffer = await pipeline.webp({ quality: q }).toBuffer();
      return { data: buffer.toString("base64"), mimeType: "image/webp" };
    } else {
      const q = Math.max(1, Math.min(100, quality));
      const buffer = await pipeline.jpeg({ quality: q }).toBuffer();
      return { data: buffer.toString("base64"), mimeType: "image/jpeg" };
    }
  }

  // 不縮放，直接讀取原檔
  const buffer = await fs.readFile(securePath);
  return { data: buffer.toString("base64"), mimeType: MIME_MAP[ext] || "image/png" };
}

async function getImageMeta(filePath) {
  const securePath = resolveSecurePath(filePath);
  const stat = await fs.stat(securePath);
  const sizeKB = (stat.size / 1024).toFixed(1);

  try {
    const sharp = await getSharp();
    const meta = await sharp(securePath).metadata();
    return `${meta.width}×${meta.height}, ${sizeKB} KB`;
  } catch {
    return `${sizeKB} KB`;
  }
}

// ============================================
// Handle
// ============================================
export async function handle(name, args) {
  if (name === "read_image") {
    const { data, mimeType } = await processImage(args.path, {
      max_width: args.max_width,
      max_height: args.max_height,
      quality: args.quality,
    });

    const meta = await getImageMeta(args.path);

    return {
      content: [
        { type: "text", text: `📷 ${args.path} (${meta})` },
        { type: "image", data, mimeType },
      ],
    };
  }

  if (name === "read_images_batch") {
    if (args.paths.length > MAX_BATCH_SIZE) {
      return {
        content: [
          {
            type: "text",
            text: `❌ 超過上限：收到 ${args.paths.length} 張，最多 ${MAX_BATCH_SIZE} 張。請分批處理。`,
          },
        ],
        isError: true,
      };
    }

    const content = [];

    for (const p of args.paths) {
      try {
        const { data, mimeType } = await processImage(p, {
          max_width: args.max_width,
          max_height: args.max_height,
          quality: args.quality,
        });
        const meta = await getImageMeta(p);
        content.push({ type: "text", text: `📷 ${p} (${meta})` });
        content.push({ type: "image", data, mimeType });
      } catch (err) {
        content.push({ type: "text", text: `❌ ${p}: ${err.message}` });
      }
    }

    return { content };
  }

  throw new Error(`未知工具: ${name}`);
}
