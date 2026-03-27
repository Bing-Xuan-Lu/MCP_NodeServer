// tools/image_diff.js — 設計稿 vs 截圖像素級比對，產生 diff 圖
// 依賴：pixelmatch (pure JS)、pngjs、sharp (already installed)

import fs from "fs/promises";
import path from "path";
import { resolveSecurePath } from "../config.js";

// 延遲載入
let sharpModule = null;
async function getSharp() {
  if (!sharpModule) sharpModule = (await import("sharp")).default;
  return sharpModule;
}

let pixelmatchModule = null;
async function getPixelmatch() {
  if (!pixelmatchModule) pixelmatchModule = (await import("pixelmatch")).default;
  return pixelmatchModule;
}

let pngjsModule = null;
async function getPNG() {
  if (!pngjsModule) pngjsModule = (await import("pngjs")).PNG;
  return pngjsModule;
}

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "image_diff",
    description:
      "像素級比對兩張圖片（設計稿 vs 截圖），產生差異標記圖並回傳不一致百分比。支援 PNG/JPG/WebP，尺寸不同時自動 resize。",
    inputSchema: {
      type: "object",
      properties: {
        image_a: {
          type: "string",
          description: "基準圖片路徑（設計稿，相對 basePath 或絕對路徑）",
        },
        image_b: {
          type: "string",
          description: "比對圖片路徑（網站截圖）",
        },
        output_path: {
          type: "string",
          description: "diff 圖輸出路徑（選填，預設自動產生於 image_a 同目錄）",
        },
        threshold: {
          type: "number",
          description: "顏色容差 0~1，越小越嚴格（預設 0.1）",
        },
        include_aa: {
          type: "boolean",
          description: "是否將 anti-aliasing 差異也標記（預設 false，忽略抗鋸齒差異）",
        },
        alpha: {
          type: "number",
          description: "原圖在 diff 結果中的透明度 0~1（預設 0.1，越高原圖越清晰）",
        },
        diff_color: {
          type: "object",
          properties: {
            r: { type: "number" },
            g: { type: "number" },
            b: { type: "number" },
          },
          description: "差異標記顏色 RGB（預設紅色 {r:255, g:0, b:0}）",
        },
        resize_to: {
          type: "string",
          enum: ["a", "b"],
          description: "尺寸不同時以哪張為基準 resize（預設 'a'，即以設計稿尺寸為準）",
        },
      },
      required: ["image_a", "image_b"],
    },
  },
];

// ============================================
// 核心邏輯
// ============================================

/** 載入圖片為 raw RGBA buffer */
async function loadImageRGBA(filePath) {
  const sharp = await getSharp();
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

export async function handle(name, args) {
  if (name !== "image_diff") return undefined;

  const {
    image_a,
    image_b,
    output_path,
    threshold = 0.1,
    include_aa = false,
    alpha = 0.1,
    diff_color = { r: 255, g: 0, b: 0 },
    resize_to = "a",
  } = args;

  // 解析路徑
  const pathA = resolveSecurePath(image_a);
  const pathB = resolveSecurePath(image_b);

  // 確認檔案存在
  await fs.access(pathA);
  await fs.access(pathB);

  // 載入圖片
  const imgA = await loadImageRGBA(pathA);
  const imgB = await loadImageRGBA(pathB);

  // 決定比對尺寸
  const refImg = resize_to === "b" ? imgB : imgA;
  const targetWidth = refImg.width;
  const targetHeight = refImg.height;

  let bufA = imgA.buffer;
  let bufB = imgB.buffer;
  const warnings = [];

  // 尺寸不同時 resize
  if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
    const sharp = await getSharp();
    const ratioA = imgA.width / imgA.height;
    const ratioB = imgB.width / imgB.height;
    if (Math.abs(ratioA - ratioB) > 0.05) {
      warnings.push(
        `⚠ 長寬比差異較大 (A: ${ratioA.toFixed(2)}, B: ${ratioB.toFixed(2)})，` +
        `強制 resize 可能造成變形，建議調整截圖 viewport。`
      );
    }

    if (resize_to === "b") {
      // resize A to match B
      const resized = await sharp(pathA)
        .resize(targetWidth, targetHeight, { fit: "fill" })
        .ensureAlpha()
        .raw()
        .toBuffer();
      bufA = resized;
    } else {
      // resize B to match A
      const resized = await sharp(pathB)
        .resize(targetWidth, targetHeight, { fit: "fill" })
        .ensureAlpha()
        .raw()
        .toBuffer();
      bufB = resized;
    }

    warnings.push(
      `尺寸不同 (A: ${imgA.width}x${imgA.height}, B: ${imgB.width}x${imgB.height})` +
      ` → 已將 image_${resize_to === "b" ? "a" : "b"} resize 至 ${targetWidth}x${targetHeight}`
    );
  }

  // 執行 pixelmatch
  const pixelmatch = await getPixelmatch();
  const totalPixels = targetWidth * targetHeight;
  const diffBuffer = Buffer.alloc(targetWidth * targetHeight * 4);

  const mismatchCount = pixelmatch(
    bufA, bufB, diffBuffer,
    targetWidth, targetHeight,
    {
      threshold,
      includeAA: include_aa,
      alpha,
      diffColor: [diff_color.r || 255, diff_color.g || 0, diff_color.b || 0],
    }
  );

  const mismatchPct = ((mismatchCount / totalPixels) * 100).toFixed(2);

  // 編碼 diff 為 PNG
  const PNG = await getPNG();
  const png = new PNG({ width: targetWidth, height: targetHeight });
  diffBuffer.copy(png.data);
  const pngBuffer = PNG.sync.write(png);

  // 決定輸出路徑
  let outPath;
  if (output_path) {
    outPath = resolveSecurePath(output_path);
  } else {
    const dir = path.dirname(pathA);
    const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
    outPath = path.join(dir, `diff_${ts}.png`);
  }

  // 確保目錄存在
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, pngBuffer);

  // 組裝結果
  const lines = [
    `📊 Image Diff Result`,
    ``,
    `| 項目 | 值 |`,
    `|------|-----|`,
    `| Image A | ${imgA.width}x${imgA.height} — ${path.basename(pathA)} |`,
    `| Image B | ${imgB.width}x${imgB.height} — ${path.basename(pathB)} |`,
    `| 比對尺寸 | ${targetWidth}x${targetHeight} |`,
    `| Threshold | ${threshold} |`,
    `| 差異像素 | ${mismatchCount.toLocaleString()} / ${totalPixels.toLocaleString()} (${mismatchPct}%) |`,
    `| Diff 圖 | ${outPath} |`,
  ];

  if (warnings.length > 0) {
    lines.push("", ...warnings);
  }

  // 判定
  const pct = parseFloat(mismatchPct);
  if (pct === 0) lines.push("", "✅ 完全一致");
  else if (pct < 1) lines.push("", "✅ 差異極小（< 1%），可能是 anti-aliasing / 字體渲染差異");
  else if (pct < 5) lines.push("", "⚠ 有明顯差異，建議檢查紅色標記區域");
  else lines.push("", "❌ 差異顯著，請對照 diff 圖逐區檢查");

  // 回傳文字 + diff 圖（inline）
  const content = [
    { type: "text", text: lines.join("\n") },
    { type: "image", data: pngBuffer.toString("base64"), mimeType: "image/png" },
  ];

  return { content };
}
