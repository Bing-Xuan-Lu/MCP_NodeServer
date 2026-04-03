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
      "多 Agent 協調工具：在 channel 中發佈訊息(post)、輪詢新訊息(poll)、更新任務狀態(status)。底層為 JSON 檔案，適用於前後端雙 Agent 同時開發同一專案時的溝通與協調。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["post", "poll", "status", "list_channels", "role"],
          description: "post=發訊息, poll=讀新訊息, status=更新任務狀態, list_channels=列出所有 channel, role=查看/指派角色設定",
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

  return { content: [{ type: "text", text: `❌ 未知 action: ${action}` }] };
}
