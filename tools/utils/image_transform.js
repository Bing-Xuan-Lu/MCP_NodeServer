// tools/utils/image_transform.js — 簡易圖片操作（resize / 加背景色 / 圓形裁切 / 合成）
// 依賴：sharp（已安裝，image_diff.js / images.js 共用）

import fs from "fs/promises";
import path from "path";
import { validateArgs } from "../_shared/utils.js";
import { resolveSecurePath } from "../../config.js";

let sharpModule = null;
async function getSharp() {
  if (!sharpModule) sharpModule = (await import("sharp")).default;
  return sharpModule;
}

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "image_transform",
    description:
      "圖片轉換：resize、加背景色、圓形裁切、多圖合成。一次呼叫可串聯多個操作，避免逐步處理。",
    inputSchema: {
      type: "object",
      properties: {
        input: {
          type: "string",
          description: "來源圖片路徑（相對 basePath 或絕對路徑）",
        },
        output: {
          type: "string",
          description: "輸出路徑（選填，預設覆蓋原檔）",
        },
        operations: {
          type: "array",
          description: "依序執行的操作清單",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["resize", "crop", "background", "circle_crop", "composite", "format", "rotate", "flip", "flop"],
                description: "操作類型",
              },
              // resize
              width: { type: "number", description: "目標寬度（px）" },
              height: { type: "number", description: "目標高度（px）" },
              fit: {
                type: "string",
                enum: ["cover", "contain", "fill", "inside", "outside"],
                description: "resize 模式（預設 cover）",
              },
              // background
              color: {
                type: "string",
                description: "背景色（CSS 色碼如 #ffffff 或 rgba(255,255,255,0.5)）",
              },
              // composite
              overlay: {
                type: "string",
                description: "疊加圖片路徑（composite 用）",
              },
              gravity: {
                type: "string",
                enum: ["centre", "north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest"],
                description: "對齊位置（預設 centre）",
              },
              // crop
              left: { type: "number", description: "裁切起始 X（px，預設 0）" },
              top: { type: "number", description: "裁切起始 Y（px，預設 0）" },
              // composite
              x: { type: "number", description: "疊加 X 偏移（px）" },
              y: { type: "number", description: "疊加 Y 偏移（px）" },
              // format
              format: {
                type: "string",
                enum: ["png", "jpeg", "webp", "avif"],
                description: "輸出格式",
              },
              quality: { type: "number", description: "壓縮品質 1-100（jpeg/webp/avif）" },
              // rotate
              angle: { type: "number", description: "旋轉角度" },
            },
            required: ["type"],
          },
        },
      },
      required: ["input", "operations"],
    },
  },
];

// ============================================
// 核心邏輯
// ============================================

/** 解析 CSS 色碼為 sharp 可用的 RGBA 物件 */
function parseColor(colorStr) {
  if (!colorStr) return { r: 255, g: 255, b: 255, alpha: 1 };

  // rgba(r,g,b,a)
  const rgbaMatch = colorStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/);
  if (rgbaMatch) {
    return {
      r: parseInt(rgbaMatch[1]),
      g: parseInt(rgbaMatch[2]),
      b: parseInt(rgbaMatch[3]),
      alpha: rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1,
    };
  }

  // #rrggbb or #rrggbbaa
  const hexMatch = colorStr.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i);
  if (hexMatch) {
    return {
      r: parseInt(hexMatch[1], 16),
      g: parseInt(hexMatch[2], 16),
      b: parseInt(hexMatch[3], 16),
      alpha: hexMatch[4] !== undefined ? parseInt(hexMatch[4], 16) / 255 : 1,
    };
  }

  // #rgb
  const shortHexMatch = colorStr.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (shortHexMatch) {
    return {
      r: parseInt(shortHexMatch[1] + shortHexMatch[1], 16),
      g: parseInt(shortHexMatch[2] + shortHexMatch[2], 16),
      b: parseInt(shortHexMatch[3] + shortHexMatch[3], 16),
      alpha: 1,
    };
  }

  throw new Error(`無法解析色碼: ${colorStr}（支援 #rrggbb、#rgb、rgba(r,g,b,a)）`);
}

/** 產生圓形裁切遮罩 SVG */
function circleMaskSVG(width, height) {
  const r = Math.min(width, height) / 2;
  const cx = width / 2;
  const cy = height / 2;
  return Buffer.from(
    `<svg width="${width}" height="${height}">` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="white"/>` +
    `</svg>`
  );
}

export async function handle(name, args) {
  if (name !== "image_transform") return undefined;
  args = validateArgs(definitions[0].inputSchema, args);

  const { input, output, operations } = args;
  const inputPath = resolveSecurePath(input);
  await fs.access(inputPath);

  const sharp = await getSharp();
  let pipeline = sharp(inputPath);
  let outputFormat = null;
  let outputQuality = 80;
  const log = [];

  for (const op of operations) {
    switch (op.type) {
      case "resize": {
        const w = op.width || undefined;
        const h = op.height || undefined;
        if (!w && !h) throw new Error("resize 需提供 width 或 height 至少一個");
        pipeline = pipeline.resize({
          width: w,
          height: h,
          fit: op.fit || "cover",
          withoutEnlargement: false,
        });
        log.push(`resize → ${w || "auto"}×${h || "auto"} (${op.fit || "cover"})`);
        break;
      }

      case "crop": {
        const cw = op.width;
        const ch = op.height;
        if (!cw || !ch) throw new Error("crop 需提供 width 和 height");
        pipeline = pipeline.extract({
          left: op.left || 0,
          top: op.top || 0,
          width: cw,
          height: ch,
        });
        log.push(`crop → ${cw}×${ch} from (${op.left || 0}, ${op.top || 0})`);
        break;
      }

      case "background": {
        const color = parseColor(op.color);
        pipeline = pipeline.flatten({ background: color });
        log.push(`background → ${op.color}`);
        break;
      }

      case "circle_crop": {
        // 需要先取得當前尺寸，所以先 toBuffer 再重新處理
        const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const mask = circleMaskSVG(info.width, info.height);
        pipeline = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
          .ensureAlpha()
          .composite([{ input: mask, blend: "dest-in" }]);
        log.push(`circle_crop → ${info.width}×${info.height}`);
        break;
      }

      case "composite": {
        if (!op.overlay) throw new Error("composite 需提供 overlay 路徑");
        const overlayPath = resolveSecurePath(op.overlay);
        await fs.access(overlayPath);
        const compositeOpts = { input: overlayPath };
        if (op.gravity) compositeOpts.gravity = op.gravity;
        if (op.x !== undefined || op.y !== undefined) {
          compositeOpts.left = op.x || 0;
          compositeOpts.top = op.y || 0;
        }
        pipeline = pipeline.composite([compositeOpts]);
        log.push(`composite → ${path.basename(overlayPath)} (${op.gravity || "centre"})`);
        break;
      }

      case "format": {
        if (!op.format) throw new Error("format 需指定輸出格式");
        outputFormat = op.format;
        if (op.quality) outputQuality = op.quality;
        log.push(`format → ${op.format}${op.quality ? ` (q${op.quality})` : ""}`);
        break;
      }

      case "rotate": {
        pipeline = pipeline.rotate(op.angle || 0);
        log.push(`rotate → ${op.angle || 0}°`);
        break;
      }

      case "flip": {
        pipeline = pipeline.flip();
        log.push(`flip (vertical)`);
        break;
      }

      case "flop": {
        pipeline = pipeline.flop();
        log.push(`flop (horizontal)`);
        break;
      }

      default:
        throw new Error(`未知操作: ${op.type}`);
    }
  }

  // 決定輸出路徑
  let outPath;
  if (output) {
    outPath = resolveSecurePath(output);
  } else {
    outPath = inputPath;
  }

  // 決定輸出格式
  const ext = path.extname(outPath).toLowerCase();
  if (outputFormat) {
    pipeline = pipeline.toFormat(outputFormat, {
      quality: outputQuality,
    });
  } else if (ext === ".png") {
    pipeline = pipeline.png();
  } else if (ext === ".jpg" || ext === ".jpeg") {
    pipeline = pipeline.jpeg({ quality: outputQuality });
  } else if (ext === ".webp") {
    pipeline = pipeline.webp({ quality: outputQuality });
  } else if (ext === ".avif") {
    pipeline = pipeline.avif({ quality: outputQuality });
  }

  // 確保目錄存在
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  // 寫入
  const result = await pipeline.toFile(outPath);

  const lines = [
    `🖼️ Image Transform 完成`,
    ``,
    `| 項目 | 值 |`,
    `|------|-----|`,
    `| 來源 | ${path.basename(inputPath)} |`,
    `| 輸出 | ${outPath} |`,
    `| 尺寸 | ${result.width}×${result.height} |`,
    `| 大小 | ${(result.size / 1024).toFixed(1)} KB |`,
    `| 格式 | ${result.format} |`,
    ``,
    `**操作紀錄：**`,
    ...log.map((l, i) => `${i + 1}. ${l}`),
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
