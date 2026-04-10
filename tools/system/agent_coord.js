// tools/agent_coord.js — 多 Agent 協調工具
// 底層：JSON 檔案讀寫，零外部依賴
// 存放位置：D:\Project\_coordination\{project}\

import fs from "fs/promises";
import path from "path";
import { validateArgs } from "../_shared/utils.js";

const COORD_ROOT = "D:\\Project\\_coordination";

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "agent_coord",
    description:
      "多 Agent 協調工具：在 channel 中發佈訊息(post)、輪詢新訊息(poll)、更新任務狀態(status)、刪除訊息(delete)、歸檔已完成訊息(archive)。底層為 JSON 檔案，適用於前後端雙 Agent 同時開發同一專案時的溝通與協調。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["post", "poll", "status", "list_channels", "role", "suggest_dispatch", "delete", "archive"],
          description: "post=發訊息, poll=讀新訊息, status=更新任務狀態, list_channels=列出所有 channel, role=查看/指派角色設定, suggest_dispatch=根據待辦清單自動建議分派方案, delete=刪除指定訊息, archive=歸檔已完成訊息",
        },
        project: {
          type: "string",
          description: "專案名稱（作為隔離 namespace，如 PG_dbox3）",
        },
        channel: {
          type: "string",
          description: "頻道名稱（如 api-contract, task-board, general）",
        },
        agent_id: {
          type: "string",
          description: "自己的身分標識（如 frontend, backend, qa）",
        },
        message: {
          type: "string",
          description: "post 動作的訊息內容",
        },
        category: {
          type: "string",
          enum: ["info", "api_change", "blocker", "request", "done"],
          description: "訊息分類（選填，預設 info）",
        },
        task: {
          type: "string",
          description: "status 動作的任務名稱",
        },
        task_status: {
          type: "string",
          enum: ["todo", "doing", "done", "blocked"],
          description: "status 動作的任務狀態",
        },
        after_id: {
          type: "number",
          description: "poll 時只取此 ID 之後的訊息（選填，預設取最新 20 則）",
        },
        message_ids: {
          type: "array",
          items: { type: "number" },
          description: "delete 動作要刪除的訊息 ID 列表",
        },
        force: {
          type: "boolean",
          description: "delete 時允許刪除非自己發的訊息（預設 false，只能刪自己的）",
        },
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "任務名稱" },
              description: { type: "string", description: "任務描述（用於分析分派依據）" },
              priority: { type: "string", enum: ["high", "medium", "low"], description: "優先級（選填）" },
            },
            required: ["name"],
          },
          description: "suggest_dispatch 動作的待辦清單",
        },
      },
      required: ["action", "project"],
    },
  },
];

// ============================================
// 工具處理
// ============================================

/** 確保目錄存在 */
async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

/** 讀 JSON 檔，不存在回傳預設值 */
async function readJson(filePath, defaultValue) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return defaultValue;
  }
}

/** 寫 JSON 檔 */
async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function getProjectDir(project) {
  // 簡單防注入：只允許英數、底線、連字號
  const safe = project.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(COORD_ROOT, safe);
}

function getChannelFile(project, channel) {
  const safe = channel.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(getProjectDir(project), `${safe}.json`);
}

function getStatusFile(project) {
  return path.join(getProjectDir(project), "_status.json");
}

function timestamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export async function handle(name, args) {
  if (name !== "agent_coord") return undefined;
  args = validateArgs(definitions[0].inputSchema, args);

  const { action, project, channel, agent_id, message, category = "info", task, task_status, after_id } = args;

  const projDir = getProjectDir(project);
  await ensureDir(projDir);

  // ─── list_channels ───
  if (action === "list_channels") {
    const files = await fs.readdir(projDir).catch(() => []);
    const channels = files
      .filter(f => f.endsWith(".json") && !f.startsWith("_"))
      .map(f => f.replace(".json", ""));

    // 也讀 status
    const statusFile = getStatusFile(project);
    const statuses = await readJson(statusFile, {});

    const lines = [`📡 Project: ${project}`, ""];

    if (channels.length === 0) {
      lines.push("（尚無 channel，用 post 發第一則訊息即自動建立）");
    } else {
      lines.push("**Channels:**");
      for (const ch of channels) {
        const data = await readJson(getChannelFile(project, ch), { messages: [] });
        lines.push(`  - \`${ch}\` (${data.messages.length} 則訊息)`);
      }
    }

    if (Object.keys(statuses).length > 0) {
      lines.push("", "**Agent Status:**");
      for (const [aid, tasks] of Object.entries(statuses)) {
        lines.push(`  🤖 ${aid}:`);
        for (const [t, s] of Object.entries(tasks)) {
          const icon = { todo: "⬜", doing: "🔄", done: "✅", blocked: "🚫" }[s.status] || "❓";
          lines.push(`    ${icon} ${t} — ${s.status} (${s.updated_at})`);
        }
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // ─── role ───
  if (action === "role") {
    const configFile = path.join(projDir, "_config.json");
    const config = await readJson(configFile, null);

    if (!config) {
      return { content: [{ type: "text", text: `❌ 找不到 ${configFile}\n請先建立 _config.json 定義角色分工。` }] };
    }

    // 如果指定了 agent_id，顯示該角色的詳細資訊
    if (agent_id && config.agents && config.agents[agent_id]) {
      const role = config.agents[agent_id];
      const statusFile = getStatusFile(project);
      const statuses = await readJson(statusFile, {});
      const myTasks = statuses[agent_id] || {};

      const lines = [
        `🤖 **你是 ${role.name}（${agent_id}）**`,
        `📁 專案：${config.project}${config.description ? ` — ${config.description}` : ""}`,
        "",
        "**負責模組：**",
        ...role.modules.map(m => `  · ${m}`),
        "",
        "**規則：**",
        ...role.rules.map(r => `  · ${r}`),
      ];

      if (config.shared) {
        lines.push("", "**共用資源（修改前須通知對方）：**");
        lines.push(...config.shared.paths.map(p => `  · ${p}`));
      }

      if (Object.keys(myTasks).length > 0) {
        lines.push("", "**目前任務：**");
        for (const [t, s] of Object.entries(myTasks)) {
          const icon = { todo: "⬜", doing: "🔄", done: "✅", blocked: "🚫" }[s.status] || "❓";
          lines.push(`  ${icon} ${t} — ${s.status} (${s.updated_at})`);
        }
      }

      // 檢查有沒有未讀訊息
      const files = await fs.readdir(projDir).catch(() => []);
      const channelFiles = files.filter(f => f.endsWith(".json") && !f.startsWith("_"));
      let unreadCount = 0;
      for (const cf of channelFiles) {
        const data = await readJson(path.join(projDir, cf), { messages: [] });
        const others = data.messages.filter(m => m.agent !== agent_id);
        unreadCount += others.length;
      }
      if (unreadCount > 0) {
        lines.push("", `📬 其他 Agent 共有 ${unreadCount} 則訊息，用 poll 查看`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    // 未指定 agent_id，顯示所有角色概覽
    const lines = [
      `📋 **${config.project} 角色設定**`,
      config.description ? `${config.description}` : "",
      "",
    ];

    if (config.agents) {
      for (const [id, role] of Object.entries(config.agents)) {
        lines.push(`**${id}** — ${role.name}`);
        lines.push(...role.modules.map(m => `  · ${m}`));
        lines.push("");
      }
    }

    if (config.shared) {
      lines.push("**共用資源（修改前須通知對方）：**");
      lines.push(...config.shared.paths.map(p => `  · ${p}`));
    }

    lines.push("", "💡 用 `agent_id` 指定角色進入身分：如 `agent_id: \"agent-a\"`");

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // ─── post ───
  if (action === "post") {
    if (!channel) return { content: [{ type: "text", text: "❌ post 需要指定 channel" }] };
    if (!agent_id) return { content: [{ type: "text", text: "❌ post 需要指定 agent_id" }] };
    if (!message) return { content: [{ type: "text", text: "❌ post 需要指定 message" }] };

    const file = getChannelFile(project, channel);
    const data = await readJson(file, { messages: [], next_id: 1 });

    const msg = {
      id: data.next_id,
      agent: agent_id,
      category,
      message,
      timestamp: timestamp(),
    };

    data.messages.push(msg);
    data.next_id++;
    await writeJson(file, data);

    return {
      content: [{
        type: "text",
        text: `✅ [${channel}] #${msg.id} by ${agent_id} (${category})\n${message}`,
      }],
    };
  }

  // ─── poll ───
  if (action === "poll") {
    if (!channel) return { content: [{ type: "text", text: "❌ poll 需要指定 channel" }] };

    const file = getChannelFile(project, channel);
    const data = await readJson(file, { messages: [], next_id: 1 });

    let msgs = data.messages;
    if (after_id !== undefined) {
      msgs = msgs.filter(m => m.id > after_id);
    } else {
      // 預設取最新 20 則
      msgs = msgs.slice(-20);
    }

    if (msgs.length === 0) {
      return { content: [{ type: "text", text: `📭 [${channel}] 沒有${after_id ? "新" : ""}訊息` }] };
    }

    const lines = [`📬 [${channel}] ${msgs.length} 則${after_id ? "新" : ""}訊息：`, ""];
    for (const m of msgs) {
      const catIcon = {
        info: "ℹ️", api_change: "🔄", blocker: "🚫", request: "📨", done: "✅",
      }[m.category] || "💬";
      lines.push(`#${m.id} ${catIcon} **${m.agent}** (${m.timestamp})`);
      lines.push(`  ${m.message}`);
      lines.push("");
    }

    lines.push(`💡 下次 poll 用 after_id: ${msgs[msgs.length - 1].id} 只取新訊息`);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // ─── status ───
  if (action === "status") {
    if (!agent_id) return { content: [{ type: "text", text: "❌ status 需要指定 agent_id" }] };
    if (!task) return { content: [{ type: "text", text: "❌ status 需要指定 task" }] };
    if (!task_status) return { content: [{ type: "text", text: "❌ status 需要指定 task_status" }] };

    const file = getStatusFile(project);
    const statuses = await readJson(file, {});

    if (!statuses[agent_id]) statuses[agent_id] = {};
    statuses[agent_id][task] = {
      status: task_status,
      updated_at: timestamp(),
    };

    await writeJson(file, statuses);

    const icon = { todo: "⬜", doing: "🔄", done: "✅", blocked: "🚫" }[task_status];
    return {
      content: [{
        type: "text",
        text: `${icon} [${agent_id}] ${task} → ${task_status}`,
      }],
    };
  }

  // ─── suggest_dispatch ───
  if (action === "suggest_dispatch") {
    const { tasks: taskList } = args;
    if (!taskList || taskList.length === 0) {
      return { content: [{ type: "text", text: "❌ suggest_dispatch 需要指定 tasks 陣列（至少一項）" }] };
    }

    // 讀取角色設定（如果有）
    const configFile = path.join(projDir, "_config.json");
    const config = await readJson(configFile, null);
    const hasRoles = config?.agents && Object.keys(config.agents).length > 0;

    // 讀取現有任務狀態
    const statusFile = getStatusFile(project);
    const statuses = await readJson(statusFile, {});

    // ── 通用分類關鍵字（無 _config.json 時使用）──
    const GENERIC_ROLES = {
      frontend: {
        name: "前端 Agent",
        keywords: ["ui", "css", "html", "js", "javascript", "typescript", "react", "vue", "component", "layout", "style", "template", "view", "page", "前端", "介面", "樣式", "頁面", "截圖", "playwright", "browser", "dom", "responsive"],
      },
      backend: {
        name: "後端 Agent",
        keywords: ["api", "php", "python", "server", "controller", "model", "route", "endpoint", "logic", "service", "class", "後端", "邏輯", "功能", "migration", "cron", "queue"],
      },
      qa: {
        name: "QA Agent",
        keywords: ["test", "qa", "verify", "check", "validation", "bug", "fix", "regression", "測試", "驗證", "品質", "校驗", "比對"],
      },
      data: {
        name: "資料 Agent",
        keywords: ["database", "db", "sql", "schema", "table", "migration", "data", "query", "index", "資料庫", "資料", "欄位", "flyway"],
      },
      devops: {
        name: "DevOps Agent",
        keywords: ["deploy", "sftp", "docker", "ci", "cd", "build", "server", "config", "env", "部署", "環境", "設定", "git"],
      },
    };

    /** 根據文字內容匹配角色（支援 _config.json 的 modules 或通用關鍵字） */
    function matchRole(text) {
      const lower = text.toLowerCase();

      if (hasRoles) {
        // 用 _config.json 的角色定義匹配
        const scores = {};
        for (const [id, role] of Object.entries(config.agents)) {
          let score = 0;
          for (const mod of (role.modules || [])) {
            const modWords = mod.toLowerCase().split(/[\s/\\,]+/);
            for (const w of modWords) {
              if (w.length > 2 && lower.includes(w)) score++;
            }
          }
          // 也匹配角色名稱
          if (lower.includes(id.toLowerCase())) score += 3;
          if (role.name && lower.includes(role.name.toLowerCase())) score += 2;
          if (score > 0) scores[id] = score;
        }
        if (Object.keys(scores).length > 0) {
          return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
        }
        return null;
      }

      // 通用關鍵字匹配
      const scores = {};
      for (const [id, role] of Object.entries(GENERIC_ROLES)) {
        let score = 0;
        for (const kw of role.keywords) {
          if (lower.includes(kw)) score++;
        }
        if (score > 0) scores[id] = score;
      }
      if (Object.keys(scores).length > 0) {
        return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
      }
      return null;
    }

    // ── 分析每個任務 ──
    const dispatch = {}; // { roleId: [task, ...] }
    const unassigned = [];

    for (const t of taskList) {
      const searchText = `${t.name} ${t.description || ""}`;
      const role = matchRole(searchText);
      if (role) {
        if (!dispatch[role]) dispatch[role] = [];
        dispatch[role].push(t);
      } else {
        unassigned.push(t);
      }
    }

    // ── 組裝輸出 ──
    const lines = [
      `📋 **任務分派建議** — ${project}（共 ${taskList.length} 項）`,
      "",
    ];

    const roleSource = hasRoles ? config.agents : GENERIC_ROLES;
    const assignedCount = taskList.length - unassigned.length;

    for (const [roleId, tasks] of Object.entries(dispatch)) {
      const roleName = roleSource[roleId]?.name || roleId;
      const icon = { frontend: "🎨", backend: "⚙️", qa: "🧪", data: "🗄️", devops: "🚀" }[roleId] || "🤖";

      // 顯示該角色目前的任務狀態（如果有）
      const currentTasks = statuses[roleId] || {};
      const doingCount = Object.values(currentTasks).filter(s => s.status === "doing").length;
      const busyNote = doingCount > 0 ? ` ⚡ 目前有 ${doingCount} 項進行中` : "";

      lines.push(`${icon} **${roleName}**（${roleId}）— ${tasks.length} 項${busyNote}`);
      for (const t of tasks) {
        const pri = t.priority ? ` [${t.priority}]` : "";
        lines.push(`  · ${t.name}${pri}`);
        if (t.description) lines.push(`    ${t.description}`);
      }
      lines.push("");
    }

    if (unassigned.length > 0) {
      lines.push(`❓ **未能自動分配**（${unassigned.length} 項，建議手動指定或由主 Agent 處理）`);
      for (const t of unassigned) {
        lines.push(`  · ${t.name}`);
        if (t.description) lines.push(`    ${t.description}`);
      }
      lines.push("");
    }

    // ── 建議行動 ──
    lines.push("---");
    lines.push("**建議行動：**");
    if (assignedCount > 0) {
      lines.push(`  1. 用 Agent 工具為每個角色啟動獨立 subagent（平行執行）`);
      lines.push(`  2. 用 status action 追蹤各 agent 進度`);
      if (taskList.length >= 5) {
        lines.push(`  3. ⚠️ 共 ${taskList.length} 項任務，強烈建議分發而非自己全做`);
      }
    }
    if (!hasRoles) {
      lines.push(`  💡 建立 _config.json 可自訂角色定義，提高分派精準度`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // ─── delete ───
  if (action === "delete") {
    if (!channel) return { content: [{ type: "text", text: "❌ delete 需要指定 channel" }] };
    if (!agent_id) return { content: [{ type: "text", text: "❌ delete 需要指定 agent_id（用於權限判斷）" }] };
    const ids = args.message_ids;
    if (!ids || ids.length === 0) return { content: [{ type: "text", text: "❌ delete 需要指定 message_ids" }] };

    const file = getChannelFile(project, channel);
    const data = await readJson(file, { messages: [], next_id: 1 });

    const deleted = [];
    const denied = [];
    const notFound = [];

    for (const id of ids) {
      const idx = data.messages.findIndex(m => m.id === id);
      if (idx === -1) {
        notFound.push(id);
        continue;
      }
      const msg = data.messages[idx];
      if (msg.agent !== agent_id && !args.force) {
        denied.push({ id, owner: msg.agent });
        continue;
      }
      data.messages.splice(idx, 1);
      deleted.push(id);
    }

    if (deleted.length > 0) await writeJson(file, data);

    const lines = [];
    if (deleted.length > 0) lines.push(`✅ 已刪除 ${deleted.length} 則：#${deleted.join(", #")}`);
    if (denied.length > 0) lines.push(`🚫 權限不足（非自己發的，需 force: true）：${denied.map(d => `#${d.id}(by ${d.owner})`).join(", ")}`);
    if (notFound.length > 0) lines.push(`⚠️ 找不到：#${notFound.join(", #")}`);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // ─── archive ───
  if (action === "archive") {
    if (!channel) return { content: [{ type: "text", text: "❌ archive 需要指定 channel" }] };

    const file = getChannelFile(project, channel);
    const data = await readJson(file, { messages: [], next_id: 1 });

    // 篩出 category=done 的訊息
    const toArchive = data.messages.filter(m => m.category === "done");
    if (toArchive.length === 0) {
      return { content: [{ type: "text", text: `📭 [${channel}] 沒有 category=done 的訊息可歸檔` }] };
    }

    // 寫入 archive 檔
    const archiveFile = path.join(getProjectDir(project), `_archive_${channel.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
    const archive = await readJson(archiveFile, { messages: [] });
    for (const m of toArchive) {
      m.archived_at = timestamp();
      archive.messages.push(m);
    }
    await writeJson(archiveFile, archive);

    // 從原 channel 移除
    const archivedIds = new Set(toArchive.map(m => m.id));
    data.messages = data.messages.filter(m => !archivedIds.has(m.id));
    await writeJson(file, data);

    return {
      content: [{
        type: "text",
        text: `📦 [${channel}] 已歸檔 ${toArchive.length} 則 done 訊息（#${toArchive.map(m => m.id).join(", #")}）\n` +
              `  → 歸檔檔案：_archive_${channel}.json（共 ${archive.messages.length} 則）\n` +
              `  → channel 剩餘 ${data.messages.length} 則訊息`,
      }],
    };
  }

  return { content: [{ type: "text", text: `❌ 未知 action: ${action}` }] };
}
