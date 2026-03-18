# /n8n_discord_dispatcher — n8n Discord 指令調度器

## 可用工具

- **HTTP API 呼叫**：`send_http_request`, `send_http_requests_batch`

## 背景
在 n8n 中使用 community node `n8n-nodes-discord-trigger` 建立即時（非輪詢）Discord 指令調度器。
適用於 n8n 版本缺少內建 discordTrigger 實作，但已安裝 community 套件的環境。

## 輸入
- `<CHANNEL_ID>` — 要監聽的 Discord 頻道 ID
- `<GUILD_ID>` — Discord Server（Guild）ID
- `<COMMANDS>` — 指令列表，例如 `['!news', '!週報', '!help']`
- `<TRIGGER_CREDENTIAL_ID>` — `discordBotTriggerApi` credential ID
- `<BOT_CREDENTIAL_ID>` — `discordBotApi` credential ID（用於回覆）

## 步驟

### 1. 確認 community node 正確安裝
```bash
docker exec <n8n-container> ls /home/node/.n8n/nodes/node_modules/ | grep discord
# 應看到 n8n-nodes-discord-trigger
```

### 2. 確認節點參數（讀取 Docker 內 source）
```bash
docker exec <n8n-container> sh -c "grep -n 'default:' \
  /home/node/.n8n/nodes/node_modules/n8n-nodes-discord-trigger/dist/nodes/DiscordTrigger/DiscordTrigger.node.options.js"
```
**關鍵陷阱**：`pattern` 預設值是 `'start'`，此時 `value` 欄位變成 required → 啟用失敗。
**解法**：設定 `pattern: 'every'`，在 Code node 內過濾。

### 3. Trigger Node 正確參數
```json
{
  "type": "n8n-nodes-discord-trigger.discordTrigger",
  "typeVersion": 1,
  "parameters": {
    "type": "message",
    "guildIds": [],
    "channelIds": [],
    "pattern": "every"
  },
  "credentials": {
    "discordBotTriggerApi": { "id": "<TRIGGER_CREDENTIAL_ID>", "name": "..." }
  }
}
```

### 4. 篩選 Code Node
```javascript
const CHANNEL_ID = '<CHANNEL_ID>';
const COMMANDS = ['!news', '!週報', '!help'];
const items = $input.all();
const results = [];
for (const item of items) {
  const msg = item.json;
  if (msg.author && msg.author.bot) continue;
  const channelId = msg.channelId || msg.channel_id || '';
  if (channelId !== CHANNEL_ID) continue;
  const content = (msg.content || '').trim();
  if (!COMMANDS.includes(content)) continue;
  results.push({ json: { command: content, channelId, authorName: msg.author?.username || 'unknown' } });
}
return results;
```

### 5. Reply Node（使用 n8n-nodes-base.discord，非 HTTP Request）
```json
{
  "type": "n8n-nodes-base.discord",
  "typeVersion": 2,
  "parameters": {
    "resource": "message",
    "guildId": { "__rl": true, "value": "<GUILD_ID>", "mode": "list" },
    "channelId": { "__rl": true, "value": "<CHANNEL_ID>", "mode": "list" },
    "content": "回覆訊息內容",
    "options": {}
  },
  "credentials": {
    "discordBotApi": { "id": "<BOT_CREDENTIAL_ID>", "name": "..." }
  }
}
```

### 6. 建立並啟用工作流
```bash
# MCP activate_workflow 有 415 bug，改用 curl
curl -X POST http://localhost:5678/api/v1/workflows/<ID>/activate \
  -H "X-N8N-API-KEY: $KEY" \
  -H "Content-Type: application/json" -d '{}'
```

### 7. 更新工作流 SOP（避免 activeVersion 不更新）
```
deactivate → PUT → activate
```

## 輸出
- 即時監聽 Discord 頻道的調度器工作流（active: true）
- 依指令路由到對應的回覆節點 + 下游觸發 webhook
- 備份至 `flows/Discord指令調度器.json`
