# /n8n_workflow_ops — 建立或更新 n8n workflow 的標準程序

支援兩種模式：
- **新建模式**：從零建立並啟用 n8n workflow
- **更新模式**：安全更新現有 workflow 節點與設定

## 背景

n8n workflow 操作有固定的 API 規則，違反會導致 worker 崩潰或更新無效：
- `settings.executionOrder` 必須為 `"v1"`（PUT 時必填，否則 `finished:false`）
- MCP `activate_workflow` 有 415 bug，**啟用/停用必須用 curl**
- 更新時必須先 deactivate → PUT → activate，否則 activeVersion 不更新

## 輸入

共用：
- `<workflow_id>` — 工作流 ID（更新模式必填；新建後由 create 回傳）
- `<n8n_base_url>` — n8n API Base URL（預設 `http://localhost:5678/api/v1`）
- `<api_key>` — N8N_API_KEY（見 `.env` 或 `.mcp.json`）

新建額外需要：
- `<workflow_name>` — 工作流名稱
- `<nodes_json>` — nodes 陣列（含 id、name、type、position、parameters）
- `<connections_json>` — connections 物件
- `<backup_path>` — flows/ 備份目錄

## 模式判斷

| 使用者說 | 模式 |
|---------|------|
| 建立新工作流、新增 workflow | 新建模式 |
| 更新、修改、調整現有 workflow | 更新模式 |

---

## 新建模式

### 步驟 1：設計 Nodes

常用節點類型：

| 用途 | type |
|------|------|
| 排程 | `n8n-nodes-base.scheduleTrigger` (typeVersion: 1.1) |
| Webhook | `n8n-nodes-base.webhook` (typeVersion: 2) |
| HTTP 請求 | `n8n-nodes-base.httpRequest` (typeVersion: 4) |
| Code | `n8n-nodes-base.code` (typeVersion: 2) |
| Discord | `n8n-nodes-base.discord` (typeVersion: 2) |
| Merge | `n8n-nodes-base.merge` (typeVersion: 3) |

**Webhook 節點必須在頂層加 `webhookId`（UUID），不可放在 parameters 裡。**

### 步驟 2：建立工作流

```
使用 mcp__n8n__create_workflow：
  name: <workflow_name>
  nodes: <nodes_json>
  connections: <connections_json>
  active: false
```

記錄回傳的 `id`。

### 步驟 3：補上 settings（寫暫存檔再 curl）

將 payload 寫入暫存檔（避免中文字元在 bash -d 截斷）：

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

```bash
PAYLOAD_FILE="D:/Develop/n8nwork/scripts/tmp-payload.json"
API_KEY=$(grep N8N_API_KEY /d/Develop/n8nwork/.env | cut -d= -f2)
curl -s -X PUT <n8n_base_url>/workflows/<workflow_id> \
  -H "X-N8N-API-KEY: $API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @"$PAYLOAD_FILE" \
  | grep -o '"executionOrder":"[^"]*"\|"versionId":"[^"]*"'
```

確認輸出含 `"executionOrder":"v1"` 且 `versionId` 已更新。

### 步驟 4：啟用工作流

```bash
curl -s -X POST <n8n_base_url>/workflows/<workflow_id>/activate \
  -H "X-N8N-API-KEY: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{}" \
  | grep -o '"active":[a-z]*\|"activeVersionId":"[^"]*"'
```

確認 `active:true`。

### 步驟 5：備份並清理

```bash
curl -s <n8n_base_url>/workflows/<workflow_id> \
  -H "X-N8N-API-KEY: $API_KEY" \
  > "<backup_path>/<workflow_name>.json"
rm "$PAYLOAD_FILE"
```

### 步驟 6：更新 CLAUDE.md 工作流清單

```markdown
| <workflow_name> | `<workflow_id>` | <觸發方式> | <說明> |
```

---

## 更新模式

### 步驟 1：確認目前狀態

```bash
curl -s <n8n_base_url>/workflows/<workflow_id> \
  -H "X-N8N-API-KEY: <api_key>" \
  | python -c "import sys,json; d=json.load(sys.stdin); print('active:', d['active'], '| versionId:', d['versionId'])"
```

### 步驟 2：停用工作流

```bash
curl -s -X POST <n8n_base_url>/workflows/<workflow_id>/deactivate \
  -H "X-N8N-API-KEY: <api_key>" \
  -H "Content-Type: application/json"
```

### 步驟 3：PUT 更新內容

```bash
curl -s -X PUT <n8n_base_url>/workflows/<workflow_id> \
  -H "X-N8N-API-KEY: <api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "<workflow_name>",
    "nodes": <new_nodes_json>,
    "connections": <new_connections_json>,
    "settings": { "executionOrder": "v1" },
    "staticData": null
  }'
```

### 步驟 4：重新啟用

```bash
curl -s -X POST <n8n_base_url>/workflows/<workflow_id>/activate \
  -H "X-N8N-API-KEY: <api_key>" \
  -H "Content-Type: application/json" \
  -d "{}"
```

### 步驟 5：驗證

```bash
curl -s <n8n_base_url>/workflows/<workflow_id> \
  -H "X-N8N-API-KEY: <api_key>" \
  | python -c "import sys,json; d=json.load(sys.stdin); print('active:', d['active'], '| versionId:', d['versionId'])"
```

確認 `active: True` 且 `versionId` 已更新。

---

## 輸出

**新建模式**：workflow 已建立啟用、settings 已設定、備份完成、CLAUDE.md 已更新
**更新模式**：workflow 已更新並重新啟用、versionId 為最新版本

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| worker 崩潰、`finished:false`、`nodeResults:{}` | `executionOrder:"v1"` 未設定 | PUT 補上 settings |
| PUT 無效（versionId 未變） | 中文字元在 bash -d 截斷 | 改用 `--data-binary @file` |
| activate 回 415 | MCP bug | 改用 curl POST |
| Webhook 404 | `webhookId` 放在 parameters 而非頂層 | 移到節點頂層 |
| PUT 後仍執行舊版 | 未先 deactivate | 先 deactivate → PUT → activate |
| `400 must NOT have additional properties` | body 含 `pinData` | 移除 `pinData` |
| Webhook path 重用 404 | 刪除舊 workflow 後 DB 留舊記錄 | 改用新 webhook path |
| Credential 無法更新 | PUT credential 不支援 | DELETE + POST 重建 |
