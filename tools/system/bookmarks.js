import fs from "fs/promises";
import path from "path";
import os from "os";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const crypto = require("crypto");

// ============================================
// 內部 Helpers
// ============================================
async function loadBookmarks(profilePath) {
  let bookmarkPath = profilePath;
  if (!bookmarkPath) {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    bookmarkPath = path.join(
      localAppData,
      "Google", "Chrome", "User Data", "Default", "Bookmarks",
    );
  }
  const content = await fs.readFile(bookmarkPath, "utf-8");
  return { data: JSON.parse(content), path: bookmarkPath };
}

function findNodeByPath(roots, pathStr) {
  const parts = pathStr.split(">").map((s) => s.trim());
  let current = null;
  const rootName = parts.shift();

  if (rootName === "書籤列") current = roots.bookmark_bar;
  else if (rootName === "其他書籤") current = roots.other;
  else if (rootName === "行動裝置") current = roots.synced;
  else return null;

  for (const part of parts) {
    if (!current.children) return null;
    const found = current.children.find(
      (child) => child.type === "folder" && child.name === part,
    );
    if (!found) return null;
    current = found;
  }
  return current;
}

const isPrivateUrl = (url) => {
  try {
    const hostname = new URL(url).hostname;
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("10.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal")
    );
  } catch { return false; }
};

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "create_bookmark_folder",
    description: "在指定的父資料夾底下，建立一個新的空資料夾 (例如在 '書籤列 > 改CODE之路' 底下建立 '【Python】')。",
    inputSchema: {
      type: "object",
      properties: {
        parentPath: { type: "string", description: "父資料夾的路徑 (例如 '書籤列 > 改CODE之路')" },
        newFolderName: { type: "string", description: "新資料夾的名稱 (例如 '【Python】')" },
        profilePath: { type: "string" },
      },
      required: ["parentPath", "newFolderName"],
    },
  },
  {
    name: "scan_and_clean_bookmarks",
    description: "掃描 Chrome 書籤。若發現無效連結 (404/DNS Error)，可選擇直接移除。支援自動備份。",
    inputSchema: {
      type: "object",
      properties: {
        profilePath: { type: "string", description: "Chrome User Data 路徑 (選填)" },
        checkLimit: { type: "number", description: "限制檢查數量 (預設 100)", default: 100 },
        autoRemove: {
          type: "boolean",
          description: "是否自動刪除無效書籤？(預設 false，設為 true 則會直接刪除並存檔)",
          default: false,
        },
      },
    },
  },
  {
    name: "remove_chrome_bookmarks",
    description: "刪除 Chrome 書籤中的特定網址 (請務必先關閉 Chrome)。會自動建立備份。",
    inputSchema: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description: "要刪除的網址清單 (例如 ['http://bad-site.com', '...'])",
        },
        profilePath: { type: "string", description: "Chrome User Data 路徑 (選填)" },
      },
      required: ["urls"],
    },
  },
  {
    name: "get_bookmark_structure",
    description: "取得 Chrome 書籤的資料夾結構 (不列出網址，只列出資料夾名稱與層級)，讓 AI 了解目前的分類狀況。",
    inputSchema: {
      type: "object",
      properties: { profilePath: { type: "string" } },
    },
  },
  {
    name: "move_bookmarks",
    description: "將書籤從來源資料夾搬移到目標資料夾。支援關鍵字篩選 (例如：把 '未分類' 裡面含有 'docker' 的網址都搬到 'DevOps')。",
    inputSchema: {
      type: "object",
      properties: {
        sourcePath: { type: "string", description: "來源資料夾路徑" },
        targetPath: { type: "string", description: "目標資料夾路徑" },
        keyword: { type: "string", description: "篩選關鍵字 (選填，若不填則移動該資料夾內所有書籤)" },
        profilePath: { type: "string" },
      },
      required: ["sourcePath", "targetPath"],
    },
  },
  {
    name: "get_folder_contents",
    description: "取得指定資料夾內的所有書籤清單 (回傳 ID, Title, URL)，用於讓 AI 分析分類。",
    inputSchema: {
      type: "object",
      properties: {
        folderPath: { type: "string", description: "資料夾路徑 (例如: '書籤列 > 改CODE之路')" },
        profilePath: { type: "string" },
      },
      required: ["folderPath"],
    },
  },
  {
    name: "move_specific_bookmarks",
    description: "將指定的書籤 ID 列表搬移到目標資料夾。⚠️ 極重要限制：由於系統傳輸限制，每次呼叫此工具的 'bookmarkIds' 陣列長度「絕對不可超過 20 個」。若需搬移大量書籤，你必須分多次呼叫。",
    inputSchema: {
      type: "object",
      properties: {
        bookmarkIds: {
          type: "array",
          items: { type: "string" },
          description: "要搬移的書籤 ID 陣列 (Max limit: 20 items per request)",
        },
        targetPath: { type: "string", description: "目標資料夾路徑" },
        profilePath: { type: "string" },
      },
      required: ["bookmarkIds", "targetPath"],
    },
  },
  {
    name: "sort_bookmarks",
    description: "將指定資料夾內的書籤進行排序 (規則：資料夾置頂，並依名稱 A-Z / 中文筆劃排序)。",
    inputSchema: {
      type: "object",
      properties: {
        folderPath: { type: "string", description: "要排序的資料夾路徑 (例如 '書籤列 > 改CODE之路')" },
        profilePath: { type: "string" },
      },
      required: ["folderPath"],
    },
  },
  {
    name: "rename_bookmark_folder",
    description: "修改書籤資料夾的名稱 (例如將 'C# .net' 改為 'NET')。",
    inputSchema: {
      type: "object",
      properties: {
        folderPath: { type: "string", description: "原資料夾路徑 (例如 '書籤列 > C# .net')" },
        newName: { type: "string", description: "新的名稱 (例如 'NET')" },
        profilePath: { type: "string" },
      },
      required: ["folderPath", "newName"],
    },
  },
  {
    name: "delete_bookmark_folder",
    description: "刪除指定的書籤資料夾。 (預設只能刪除空資料夾，除非開啟強制模式)",
    inputSchema: {
      type: "object",
      properties: {
        folderPath: { type: "string", description: "要刪除的資料夾路徑" },
        force: {
          type: "boolean",
          description: "是否強制刪除？(若設為 true，即使資料夾內有書籤也會一併刪除)",
          default: false,
        },
        profilePath: { type: "string" },
      },
      required: ["folderPath"],
    },
  },
  {
    name: "export_bookmarks_to_html",
    description: "將目前的書籤導出為標準 HTML 格式 (Netscape Format)，可用於直接匯入 Chrome 或其他瀏覽器。",
    inputSchema: {
      type: "object",
      properties: {
        outputFilename: {
          type: "string",
          description: "導出的檔案名稱 (預設: bookmarks_cleaned.html)",
          default: "bookmarks_cleaned.html",
        },
        profilePath: { type: "string" },
      },
    },
  },
  {
    name: "remove_duplicates",
    description: "掃描整個書籤設定檔，移除重複的網址 (Duplicate URLs)。保留最早建立的那一個，刪除後來的重複項。",
    inputSchema: {
      type: "object",
      properties: { profilePath: { type: "string" } },
    },
  },
];

// ============================================
// 工具邏輯
// ============================================
export async function handle(name, args) {
  if (name === "create_bookmark_folder") {
    const { data, path: filePath } = await loadBookmarks(args.profilePath);
    const parentNode = findNodeByPath(data.roots, args.parentPath);

    if (!parentNode) {
      return {
        isError: true,
        content: [{ type: "text", text: `❌ 錯誤：找不到父資料夾 '${args.parentPath}'` }],
      };
    }
    if (!parentNode.children) parentNode.children = [];

    const existingFolder = parentNode.children.find(
      (c) => c.type === "folder" && c.name === args.newFolderName,
    );
    if (existingFolder) {
      return {
        content: [
          {
            type: "text",
            text: `⚠️ 資料夾已存在：'${args.newFolderName}' 已經在 '${args.parentPath}' 底下，無需重複建立。`,
          },
        ],
      };
    }

    const newFolder = {
      date_added: (Date.now() * 1000).toString(),
      guid: crypto.randomUUID(),
      id: Math.floor(Math.random() * 1000000).toString(),
      name: args.newFolderName,
      type: "folder",
      children: [],
    };

    parentNode.children.push(newFolder);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
    return {
      content: [
        {
          type: "text",
          text: `✅ 資料夾建立成功！\n已在 '${args.parentPath}' 底下建立新資料夾：'${args.newFolderName}'`,
        },
      ],
    };
  }

  if (name === "scan_and_clean_bookmarks") {
    let bookmarkPath = args.profilePath;
    if (!bookmarkPath) {
      const localAppData =
        process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
      bookmarkPath = path.join(localAppData, "Google", "Chrome", "User Data", "Default", "Bookmarks");
    }

    try { await fs.access(bookmarkPath); }
    catch (e) { throw new Error(`找不到 Chrome 書籤檔: ${bookmarkPath}`); }

    const content = await fs.readFile(bookmarkPath, "utf-8");
    let data = JSON.parse(content);

    const allNodes = [];
    const traverse = (node, pathName) => {
      if (node.url && node.url.startsWith("http")) {
        allNodes.push({ node, path: pathName });
      }
      if (node.children) {
        const newPath = pathName ? `${pathName} > ${node.name}` : node.name;
        node.children.forEach((child) => traverse(child, newPath));
      }
    };
    if (data.roots.bookmark_bar) traverse(data.roots.bookmark_bar, "書籤列");
    if (data.roots.other) traverse(data.roots.other, "其他書籤");
    if (data.roots.synced) traverse(data.roots.synced, "行動裝置");

    const limit = args.checkLimit || 100;
    const nodesToCheck = allNodes.slice(0, limit);
    const badUrls = new Set();
    const reportLog = [];
    let skippedPrivate = 0;

    const checkNode = async (item) => {
      if (isPrivateUrl(item.node.url)) { skippedPrivate++; return; }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const fetchOpts = {
          signal: controller.signal,
          redirect: "follow",
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
        };

        let res = await fetch(item.node.url, { ...fetchOpts, method: "HEAD" });
        if (res.status === 405 || res.status === 403) {
          const controller2 = new AbortController();
          const timer2 = setTimeout(() => controller2.abort(), 10000);
          res = await fetch(item.node.url, { ...fetchOpts, method: "GET", signal: controller2.signal });
          clearTimeout(timer2);
        }
        clearTimeout(timer);

        if (res.status >= 400) {
          badUrls.add(item.node.url);
          reportLog.push(`❌ [${res.status}] ${item.node.url}`);
        }
      } catch (err) {
        badUrls.add(item.node.url);
        reportLog.push(`❌ [Error] ${item.node.url} (${err.cause?.code || err.message})`);
      }
    };

    for (let i = 0; i < nodesToCheck.length; i += 20) {
      await Promise.all(nodesToCheck.slice(i, i + 20).map(checkNode));
    }

    let resultText = `🔍 掃描 ${nodesToCheck.length} 個書籤，發現 ${badUrls.size} 個失效。\n`;
    if (skippedPrivate > 0) {
      resultText += `⏭️ 跳過 ${skippedPrivate} 個內網/本機網址 (192.168.x / 10.x / localhost)。\n`;
    }

    if (args.autoRemove && badUrls.size > 0) {
      const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
      const backupPath = `${bookmarkPath}.bak.${timestamp}`;
      await fs.copyFile(bookmarkPath, backupPath);

      let deletedCount = 0;
      const removeRecursive = (node) => {
        if (!node.children) return;
        const initialLen = node.children.length;
        node.children = node.children.filter((child) => {
          if (child.url && badUrls.has(child.url)) return false;
          if (child.children) removeRecursive(child);
          return true;
        });
        deletedCount += initialLen - node.children.length;
      };

      if (data.roots.bookmark_bar) removeRecursive(data.roots.bookmark_bar);
      if (data.roots.other) removeRecursive(data.roots.other);
      if (data.roots.synced) removeRecursive(data.roots.synced);

      await fs.writeFile(bookmarkPath, JSON.stringify(data, null, 2), "utf-8");
      resultText += `\n✅ **已執行自動清理**\n- 成功移除: ${deletedCount} 個\n- 備份檔案: ${backupPath}\n- 請重新啟動 Chrome。\n`;
    } else if (badUrls.size > 0) {
      resultText += `\n⚠️ 建議移除清單 (尚未刪除，請設 autoRemove=true):\n` + reportLog.join("\n");
    } else {
      resultText += `🎉 恭喜，檢查範圍內的書籤都是健康的！`;
    }

    return { content: [{ type: "text", text: resultText }] };
  }

  if (name === "remove_chrome_bookmarks") {
    const { data, path: filePath } = await loadBookmarks(args.profilePath);
    const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
    const backupPath = `${filePath}.bak.${timestamp}`;
    await fs.copyFile(filePath, backupPath);

    const targets = new Set(args.urls);
    let removedCount = 0;

    const removeRecursive = (node) => {
      if (!node.children) return;
      const originalLength = node.children.length;
      node.children = node.children.filter((child) => {
        if (child.url && targets.has(child.url)) return false;
        if (child.children) removeRecursive(child);
        return true;
      });
      removedCount += originalLength - node.children.length;
    };

    if (data.roots.bookmark_bar) removeRecursive(data.roots.bookmark_bar);
    if (data.roots.other) removeRecursive(data.roots.other);
    if (data.roots.synced) removeRecursive(data.roots.synced);

    if (removedCount > 0) {
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      return {
        content: [
          {
            type: "text",
            text: `✅ 已成功刪除 ${removedCount} 個書籤。\n\n⚠️ 原始檔案已備份至：\n${backupPath}\n\n請重新啟動 Chrome 以查看變更。`,
          },
        ],
      };
    } else {
      return { content: [{ type: "text", text: "⚠️ 未發現符合的網址，沒有刪除任何書籤。" }] };
    }
  }

  if (name === "get_bookmark_structure") {
    const { data } = await loadBookmarks(args.profilePath);

    const buildTree = (node) => {
      if (!node.children) return null;
      const folders = node.children
        .filter((c) => c.type === "folder")
        .map((c) => {
          const sub = buildTree(c);
          return sub ? { [c.name]: sub } : c.name;
        });
      const linkCount = node.children.filter((c) => c.type === "url").length;
      return folders.length > 0 ? { __links: linkCount, folders } : { __links: linkCount };
    };

    const structure = {
      書籤列: buildTree(data.roots.bookmark_bar),
      其他書籤: buildTree(data.roots.other),
      行動裝置: buildTree(data.roots.synced),
    };

    return { content: [{ type: "text", text: JSON.stringify(structure, null, 2) }] };
  }

  if (name === "move_bookmarks") {
    const { data, path: filePath } = await loadBookmarks(args.profilePath);
    const sourceNode = findNodeByPath(data.roots, args.sourcePath);
    const targetNode = findNodeByPath(data.roots, args.targetPath);

    if (!sourceNode) throw new Error(`找不到來源: ${args.sourcePath}`);
    if (!targetNode) throw new Error(`找不到目標: ${args.targetPath}`);

    const toMove = [];
    const keep = [];

    sourceNode.children.forEach((child) => {
      if (!args.keyword) {
        toMove.push(child);
      } else {
        const kw = args.keyword.toLowerCase();
        if (child.type === "url") {
          if (child.name.toLowerCase().includes(kw) || child.url.toLowerCase().includes(kw)) {
            toMove.push(child);
          } else {
            keep.push(child);
          }
        } else if (child.type === "folder") {
          if (child.name.toLowerCase().includes(kw)) toMove.push(child);
          else keep.push(child);
        } else {
          keep.push(child);
        }
      }
    });

    if (toMove.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `⚠️ 在 '${args.sourcePath}' 中找不到符合 '${args.keyword || "*"}' 的書籤。`,
          },
        ],
      };
    }

    sourceNode.children = keep;
    targetNode.children.push(...toMove);

    const backupPath = `${filePath}.bak.reorg.${Date.now()}`;
    await fs.copyFile(filePath, backupPath);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");

    return {
      content: [
        {
          type: "text",
          text: `✅ 已將 ${toMove.length} 個書籤從 [${args.sourcePath}] 搬移至 [${args.targetPath}]。`,
        },
      ],
    };
  }

  if (name === "get_folder_contents") {
    const { data } = await loadBookmarks(args.profilePath);
    const targetNode = findNodeByPath(data.roots, args.folderPath);

    if (!targetNode) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `❌ 錯誤：找不到資料夾 '${args.folderPath}'。請先確認路徑是否正確 (例如：'書籤列 > 改CODE之路')。`,
          },
        ],
      };
    }

    const files = targetNode.children
      .filter((c) => c.type === "url")
      .map((c) => ({ id: c.id, name: c.name }));

    return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
  }

  if (name === "move_specific_bookmarks") {
    const { data, path: filePath } = await loadBookmarks(args.profilePath);
    const targetNode = findNodeByPath(data.roots, args.targetPath);
    if (!targetNode) throw new Error(`找不到目標資料夾: ${args.targetPath}`);

    const idsToMove = new Set(args.bookmarkIds);
    const movedItems = [];

    const removeRecursive = (node) => {
      if (!node.children) return;
      const toKeep = [];
      node.children.forEach((child) => {
        if (child.type === "url" && idsToMove.has(child.id)) {
          movedItems.push(child);
        } else {
          toKeep.push(child);
          if (child.children) removeRecursive(child);
        }
      });
      node.children = toKeep;
    };

    if (data.roots.bookmark_bar) removeRecursive(data.roots.bookmark_bar);
    if (data.roots.other) removeRecursive(data.roots.other);
    if (data.roots.synced) removeRecursive(data.roots.synced);

    if (movedItems.length > 0) {
      targetNode.children.push(...movedItems);
      const backupPath = `${filePath}.bak.move.${Date.now()}`;
      await fs.copyFile(filePath, backupPath);
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      return {
        content: [
          { type: "text", text: `✅ 已成功搬移 ${movedItems.length} 個書籤到 '${args.targetPath}'。` },
        ],
      };
    } else {
      return { content: [{ type: "text", text: "⚠️ 找不到指定的書籤 ID，未進行任何搬移。" }] };
    }
  }

  if (name === "sort_bookmarks") {
    const { data, path: filePath } = await loadBookmarks(args.profilePath);
    const targetNode = findNodeByPath(data.roots, args.folderPath);

    if (!targetNode) {
      return { isError: true, content: [{ type: "text", text: `❌ 找不到資料夾: ${args.folderPath}` }] };
    }
    if (!targetNode.children || targetNode.children.length === 0) {
      return { content: [{ type: "text", text: `⚠️ 資料夾 '${args.folderPath}' 是空的，無需排序。` }] };
    }

    targetNode.children.sort((a, b) => {
      if (a.type === "folder" && b.type !== "folder") return -1;
      if (a.type !== "folder" && b.type === "folder") return 1;
      return a.name.localeCompare(b.name, "zh-TW", { sensitivity: "base" });
    });

    const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
    const backupPath = `${filePath}.bak.sort.${timestamp}`;
    await fs.copyFile(filePath, backupPath);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");

    return {
      content: [
        {
          type: "text",
          text: `✅ 已完成排序！\n資料夾 '${args.folderPath}' 內的項目已依照 [資料夾優先 -> 名稱排序] 重新排列。\n原始檔案已備份。`,
        },
      ],
    };
  }

  if (name === "rename_bookmark_folder") {
    const { data, path: filePath } = await loadBookmarks(args.profilePath);
    const targetNode = findNodeByPath(data.roots, args.folderPath);

    if (!targetNode) {
      return { isError: true, content: [{ type: "text", text: `❌ 找不到資料夾: ${args.folderPath}` }] };
    }

    const oldName = targetNode.name;
    targetNode.name = args.newName;
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");

    return {
      content: [{ type: "text", text: `✅ 改名成功！\n已將 '${oldName}' 修改為 '${args.newName}'。` }],
    };
  }

  if (name === "delete_bookmark_folder") {
    const { data, path: filePath } = await loadBookmarks(args.profilePath);
    const pathParts = args.folderPath.split(">").map((s) => s.trim());
    const targetName = pathParts.pop();
    const parentPath = pathParts.join(" > ");

    if (!parentPath) {
      return { isError: true, content: [{ type: "text", text: `❌ 無法刪除根目錄 (書籤列/其他書籤)！` }] };
    }

    const parentNode = findNodeByPath(data.roots, parentPath);
    if (!parentNode) {
      return { isError: true, content: [{ type: "text", text: `❌ 找不到父資料夾: ${parentPath}` }] };
    }

    const targetIndex = parentNode.children.findIndex(
      (c) => c.type === "folder" && c.name === targetName,
    );
    if (targetIndex === -1) {
      return {
        isError: true,
        content: [{ type: "text", text: `❌ 在 '${parentPath}' 底下找不到名為 '${targetName}' 的資料夾。` }],
      };
    }

    const targetNode = parentNode.children[targetIndex];
    if (targetNode.children?.length > 0 && !args.force) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `⚠️ 刪除失敗：資料夾 '${targetName}' 不是空的 (裡面有 ${targetNode.children.length} 個項目)。\n若要強制刪除，請設定 force: true。`,
          },
        ],
      };
    }

    parentNode.children.splice(targetIndex, 1);

    const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
    const backupPath = `${filePath}.bak.del.${timestamp}`;
    await fs.copyFile(filePath, backupPath);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");

    return {
      content: [{ type: "text", text: `🗑️ 已成功刪除資料夾: ${args.folderPath}\n(原始檔案已備份)` }],
    };
  }

  if (name === "export_bookmarks_to_html") {
    const { data } = await loadBookmarks(args.profilePath);
    const outputFile = args.outputFilename || "bookmarks_cleaned.html";

    let htmlContent = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
`;

    const processNode = (node) => {
      let output = "";
      if (node.type === "url") {
        output += `    <DT><A HREF="${node.url}" ADD_DATE="${node.date_added || Date.now()}">${node.name}</A>\n`;
      } else if (node.type === "folder") {
        let extraAttr = "";
        if (node.name === "書籤列" || node.name === "Bookmarks bar") {
          extraAttr = ` PERSONAL_TOOLBAR_FOLDER="true"`;
        }
        output += `    <DT><H3${extraAttr} ADD_DATE="${node.date_added || Date.now()}">${node.name}</H3>\n`;
        output += `    <DL><p>\n`;
        if (node.children) node.children.forEach((child) => { output += processNode(child); });
        output += `    </DL><p>\n`;
      }
      return output;
    };

    if (data.roots.bookmark_bar) htmlContent += processNode(data.roots.bookmark_bar);
    if (data.roots.other) htmlContent += processNode(data.roots.other);
    if (data.roots.synced) htmlContent += processNode(data.roots.synced);
    htmlContent += `</DL><p>`;

    const finalPath = path.resolve(process.cwd(), outputFile);
    await fs.writeFile(finalPath, htmlContent, "utf-8");

    return {
      content: [
        {
          type: "text",
          text: `✅ 書籤匯出成功！\n檔案位置: ${finalPath}\n\n您可以開啟 Chrome -> 書籤 -> 匯入書籤和設定 -> 選擇此 HTML 檔案。`,
        },
      ],
    };
  }

  if (name === "remove_duplicates") {
    const { data, path: filePath } = await loadBookmarks(args.profilePath);
    const urlMap = new Map();
    let removeCount = 0;

    const traverseAndMark = (node) => {
      if (!node.children) return;
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        if (child.type === "url") {
          if (urlMap.has(child.url)) {
            node.children.splice(i, 1);
            removeCount++;
          } else {
            urlMap.set(child.url, true);
          }
        } else if (child.type === "folder") {
          traverseAndMark(child);
        }
      }
    };

    if (data.roots.bookmark_bar) traverseAndMark(data.roots.bookmark_bar);
    if (data.roots.other) traverseAndMark(data.roots.other);
    if (data.roots.synced) traverseAndMark(data.roots.synced);

    if (removeCount > 0) {
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
    }

    return {
      content: [
        { type: "text", text: `✅ 重複移除完成！\n共刪除了 ${removeCount} 個重複的書籤連結。` },
      ],
    };
  }
}
