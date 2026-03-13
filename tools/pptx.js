import fs from "fs/promises";
import path from "path";
import JSZip from "jszip";
import { resolveSecurePath } from "../config.js";

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "read_pptx_file",
    description:
      "讀取 PowerPoint (.pptx) 檔案，輸出 Markdown 格式（含圖片提取）或純文字。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "檔案路徑（相對 basePath 或絕對路徑）" },
        format: {
          type: "string",
          enum: ["markdown", "text"],
          description: "輸出格式（預設 markdown）",
        },
        extract_images: {
          type: "boolean",
          description: "是否提取圖片到檔案（預設 true）",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_pptx_files_batch",
    description: "批次讀取多個 PowerPoint (.pptx) 檔案。",
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
// 從 slide XML 提取文字與圖片引用
// ============================================

/** 從 XML 中提取所有 <a:t> 文字節點 */
function extractTextsFromXml(xml) {
  const paragraphs = [];
  // 按 <a:p> 段落拆分
  const pParts = xml.split(/<a:p[ >]/);
  for (let i = 1; i < pParts.length; i++) {
    const pEnd = pParts[i].indexOf("</a:p>");
    const pContent = pEnd >= 0 ? pParts[i].substring(0, pEnd) : pParts[i];

    // 提取該段落所有 <a:t>...</a:t>
    const texts = [];
    const tRe = /<a:t>([\s\S]*?)<\/a:t>/g;
    let m;
    while ((m = tRe.exec(pContent)) !== null) {
      texts.push(m[1]);
    }
    if (texts.length > 0) {
      paragraphs.push(texts.join(""));
    }
  }
  return paragraphs;
}

/** 從 slide XML 提取圖片關係 ID (r:embed) */
function extractImageRels(xml) {
  const ids = [];
  // <a:blip r:embed="rId3" />
  const re = /r:embed="(rId\d+)"/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    ids.push(m[1]);
  }
  return ids;
}

/** 從 .rels XML 建立 rId → target 映射 */
function parseRels(relsXml) {
  const map = {};
  const re = /Id="(rId\d+)"[^>]*Target="([^"]+)"/g;
  let m;
  while ((m = re.exec(relsXml)) !== null) {
    map[m[1]] = m[2];
  }
  return map;
}

// ============================================
// 核心轉換
// ============================================
async function convertPptx(filePath, format = "markdown", extractImages = true) {
  const securePath = resolveSecurePath(filePath);
  const ext = path.extname(securePath).toLowerCase();

  if (ext !== ".pptx") {
    throw new Error(`僅支援 .pptx 格式，收到: ${ext}`);
  }

  await fs.access(securePath);

  const buffer = await fs.readFile(securePath);
  const zip = await JSZip.loadAsync(buffer);

  const docDir = path.dirname(securePath);
  const docName = path.basename(securePath, ext);
  const imagesDirName = `${docName}_images`;
  const imagesDir = path.join(docDir, imagesDirName);

  // 找出所有 slide（按編號排序）
  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)/)[1]);
      const nb = parseInt(b.match(/slide(\d+)/)[1]);
      return na - nb;
    });

  const slides = [];
  let imageCount = 0;
  let dirCreated = false;

  for (const slideFile of slideFiles) {
    const slideNum = parseInt(slideFile.match(/slide(\d+)/)[1]);
    const slideXml = await zip.file(slideFile).async("string");
    const paragraphs = extractTextsFromXml(slideXml);

    // 圖片處理
    const slideImages = [];
    if (extractImages && format === "markdown") {
      const imageRelIds = extractImageRels(slideXml);

      if (imageRelIds.length > 0) {
        // 讀取該 slide 的 .rels
        const relsPath = `ppt/slides/_rels/slide${slideNum}.xml.rels`;
        const relsFile = zip.file(relsPath);

        if (relsFile) {
          const relsXml = await relsFile.async("string");
          const relsMap = parseRels(relsXml);

          for (const rId of imageRelIds) {
            const target = relsMap[rId];
            if (!target) continue;

            // target 通常是 ../media/image1.png
            const mediaPath = target.startsWith("../")
              ? "ppt/" + target.slice(3)
              : target.startsWith("/")
                ? target.slice(1)
                : "ppt/slides/" + target;

            const mediaFile = zip.file(mediaPath);
            if (!mediaFile) continue;

            imageCount++;
            const imgExt = path.extname(mediaPath) || ".png";
            const imgName = `img_${String(imageCount).padStart(3, "0")}${imgExt}`;

            if (!dirCreated) {
              await fs.mkdir(imagesDir, { recursive: true });
              dirCreated = true;
            }

            const imgBuffer = await mediaFile.async("nodebuffer");
            await fs.writeFile(path.join(imagesDir, imgName), imgBuffer);
            slideImages.push(`![${imgName}](${imagesDirName}/${imgName})`);
          }
        }
      }
    }

    slides.push({ slideNum, paragraphs, images: slideImages });
  }

  // 組合輸出
  let content;

  if (format === "text") {
    content = slides
      .map((s) => `[Slide ${s.slideNum}]\n${s.paragraphs.join("\n")}`)
      .join("\n\n---\n\n");
  } else {
    // Markdown
    content = slides
      .map((s) => {
        const parts = [`## Slide ${s.slideNum}`];
        if (s.paragraphs.length > 0) {
          parts.push(s.paragraphs.join("\n\n"));
        }
        if (s.images.length > 0) {
          parts.push(s.images.join("\n\n"));
        }
        return parts.join("\n\n");
      })
      .join("\n\n---\n\n");
  }

  return { content, imageCount, slideCount: slides.length };
}

// ============================================
// Handle
// ============================================
export async function handle(name, args) {
  if (name === "read_pptx_file") {
    const format = args.format || "markdown";
    const extractImages = args.extract_images !== false;
    const { content, imageCount, slideCount } = await convertPptx(args.path, format, extractImages);

    const meta = [`📊 ${slideCount} 頁投影片`];
    if (imageCount > 0) meta.push(`📷 ${imageCount} 張圖片`);
    const text = `<!-- ${meta.join(" | ")} -->\n\n${content}`;

    return { content: [{ type: "text", text }] };
  }

  if (name === "read_pptx_files_batch") {
    const format = args.format || "markdown";
    const results = [];

    for (const p of args.paths) {
      try {
        const { content, imageCount, slideCount } = await convertPptx(p, format);
        const meta = `${slideCount} 頁`;
        const imgNote = imageCount > 0 ? `, 📷 ${imageCount} 張圖片` : "";
        const truncated =
          content.length > 10000
            ? content.slice(0, 10000) + "\n\n... (截斷，請單獨讀取完整內容)"
            : content;
        results.push(`## 📄 ${p} (${meta}${imgNote})\n\n${truncated}`);
      } catch (err) {
        results.push(`## ❌ ${p}\n\n錯誤: ${err.message}`);
      }
    }

    return { content: [{ type: "text", text: results.join("\n\n---\n\n") }] };
  }

  throw new Error(`未知工具: ${name}`);
}
