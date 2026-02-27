# n8n 新建工作流 SOP — 從零建立並啟用 n8n workflow 的標準程序

## 背景
n8n MCP 工具的 `create_workflow` 不支援 `settings` 參數，建立後必須補 PUT 加上 `executionOrder:"v1"`，否則 worker 崩潰。流程固定為：Create → PUT settings → Activate → Backup。

## 輸入
- `<workflow_name>` — 工作流名稱
- `<n8n_base_url>` — n8n API Base URL（預設 `http://localhost:5678/api/v1`）
- `<api_key>` — N8N_API_KEY（見 .env 或 .mcp.json）
- `<nodes_json>` — nodes 陣列設計（含 id、name、type、position、parameters）
- `<connections_json>` — connections 物件
- `<backup_path>` — flows/ 備份目錄（例如 `D:\Develop\n8nwork\flows\`）

## 步驟

### 1. 設計 Nodes

常用節點類型參考：

| 用途 | type |
|------|------|
| 排程 | `n8n-nodes-base.scheduleTrigger` (typeVersion: 1.1) |
| Webhook | `n8n-nodes-base.webhook` (typeVersion: 2) |
| HTTP 請求 | `n8n-nodes-base.httpRequest` (typeVersion: 4) |
| Code | `n8n-nodes-base.code` (typeVersion: 2) |
| Discord | `n8n-nodes-base.discord` (typeVersion: 2) |
| Merge | `n8n-nodes-base.merge` (typeVersion: 3) |

**Webhook 節點必須在頂層加 `webhookId`（UUID 格式），不可放在 parameters 裡。**

### 2. 用 MCP 工具建立工作流

```
使用 mcp__n8n__create_workflow：
  name: <workflow_name>
  nodes: <nodes_json>
  connections: <connections_json>
  active: false
```

記錄回傳的 `id`（後續步驟需要）。

### 3. 補上 settings（寫入暫存 JSON 檔再 curl）

將完整 payload 寫入暫存檔，原因：中文字元在 bash -d 參數容易截斷。

```bash
# 暫存檔路徑範例
PAYLOAD_FILE="D:/Develop/n8nwork/scripts/tmp-payload.json"
```

Payload 結構（必填 settings）：
```json
{
  "name": "<workflow_name>",
  "nodes": [...],
  "connections": {...},
  "settings": {
    "executionOrder": "v1",
    "saveExecutionProgress": true,
    "saveManualExecutions": true,
    "saveDataErrorExecution": "all",
    "saveDataSuccessExecution": "all",
    "executionTimeout": 3600
  },
  "staticData": null
}
```

執行 PUT：
```bash
API_KEY=$(grep N8N_API_KEY /d/Develop/n8nwork/.env | cut -d= -f2)
curl -s -X PUT <n8n_base_url>/workflows/<workflow_id> \
  -H "X-N8N-API-KEY: $API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @"$PAYLOAD_FILE" \
  | grep -o '"executionOrder":"[^"]*"\|"versionId":"[^"]*"'
```

確認輸出包含 `"executionOrder":"v1"` 且 `versionId` 已更新。

### 4. 啟用工作流

**⚠️ MCP `activate_workflow` 有 415 bug，必須用 curl：**

```bash
curl -s -X POST <n8n_base_url>/workflows/<workflow_id>/activate \
  -H "X-N8N-API-KEY: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{}" \
  | grep -o '"active":[a-z]*\|"activeVersionId":"[^"]*"'
```

確認 `active:true` 且 `activeVersionId` 與步驟 3 的 `versionId` 相同。

### 5. 備份 JSON 並清理暫存檔

```bash
curl -s <n8n_base_url>/workflows/<workflow_id> \
  -H "X-N8N-API-KEY: $API_KEY" \
  > "<backup_path>/<workflow_name>.json"

rm "$PAYLOAD_FILE"
```

### 6. 更新 CLAUDE.md 工作流清單

在 `CLAUDE.md` 的工作流清單表格末尾新增一列：

```markdown
| <workflow_name> | `<workflow_id>` | <觸發方式> | <說明> |
```

## 輸出
- n8n 工作流已建立並啟用（`active: true`）
- `settings.executionOrder: "v1"` 已設定
- flows/ 備份已更新
- CLAUDE.md 工作流清單已更新

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| worker 崩潰、`finished:false` | `executionOrder:"v1"` 未設定 | 執行步驟 3 的 PUT |
| PUT 無作用（versionId 未變） | 中文字元在 bash -d 截斷 | 改用 `--data-binary @file` |
| activate 回 415 | MCP 工具 bug | 改用 curl POST |
| Webhook 404 | `webhookId` 放在 parameters 而非頂層 | 移到節點頂層 |

## Webhook 觸發 + 排程 並存範例

```json
{
  "每週排程":    {"main": [[{"node": "下一節點", "type": "main", "index": 0}]]},
  "Webhook觸發": {"main": [[{"node": "下一節點", "type": "main", "index": 0}]]}
}
```

兩個觸發節點都指向同一個下游節點，實現「自動排程 + 隨時手動」雙觸發。
