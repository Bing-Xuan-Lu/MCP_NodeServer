# n8n 工作流更新流程 — 安全更新 n8n workflow 的標準程序

## 背景
n8n 工作流更新有特定操作順序與 API 規則。跳過步驟或用錯參數會導致工作流看似更新但實際仍跑舊版，或觸發 worker 崩潰。

## 輸入
- `<workflow_id>` — 工作流 ID（從 n8n UI 或 GET /api/v1/workflows 取得）
- `<n8n_base_url>` — n8n API Base URL（預設 `http://localhost:5678/api/v1`）
- `<api_key>` — N8N_API_KEY（見 .env 或 .mcp.json）
- `<workflow_name>` — 工作流名稱
- `<new_nodes_json>` — 更新後的 nodes 陣列（JSON）
- `<new_connections_json>` — 更新後的 connections 物件（JSON）

## 步驟

### 1. 取得目前工作流（確認現況）

```bash
curl -s <n8n_base_url>/workflows/<workflow_id> \
  -H "X-N8N-API-KEY: <api_key>" \
  | python -c "import sys,json; d=json.load(sys.stdin); print('active:', d['active'], '| versionId:', d['versionId'])"
```

### 2. 停用工作流（必要步驟，不可跳過）

```bash
curl -s -X POST <n8n_base_url>/workflows/<workflow_id>/deactivate \
  -H "X-N8N-API-KEY: <api_key>" \
  -H "Content-Type: application/json"
```

### 3. PUT 更新工作流內容

**⚠️ 關鍵規則：**
- `settings.executionOrder` 必須為 `"v1"`，否則 worker 崩潰（finished:false, nodeResults:{}）
- `webhookId` 放 **node 頂層**（非 parameters 裡），否則 webhook 不會註冊
- body **不可**包含 `pinData`（會回 400 additional properties）
- `staticData` 設為 `null`

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

### 4. 重新啟用工作流

**⚠️ MCP `activate_workflow` 有 415 bug，必須改用 curl：**

```bash
curl -s -X POST <n8n_base_url>/workflows/<workflow_id>/activate \
  -H "X-N8N-API-KEY: <api_key>" \
  -H "Content-Type: application/json" \
  -d "{}"
```

### 5. 驗證更新成功

```bash
curl -s <n8n_base_url>/workflows/<workflow_id> \
  -H "X-N8N-API-KEY: <api_key>" \
  | python -c "import sys,json; d=json.load(sys.stdin); print('active:', d['active'], '| versionId:', d['versionId'])"
```

確認輸出 `active: True` 且 `versionId` 已更新為新值。

## 輸出
- 工作流成功更新並重新啟用
- `active: true`，`versionId` 為最新版本

## 常見錯誤對照表

| 錯誤症狀 | 原因 | 解法 |
|---------|------|------|
| `400 must NOT have additional properties` | body 含 `pinData` | 移除 `pinData` 欄位 |
| worker 崩潰、`finished:false`、`nodeResults:{}` | 缺少 `settings.executionOrder:"v1"` | 補上 settings |
| webhook 回 404 | 重用舊 path，DB 留有舊 entry | 改用新 webhook path |
| activate 回 415 | MCP activate_workflow bug | 改用 curl POST |
| PUT 後仍執行舊版邏輯 | 未先 deactivate，activeVersion 未更新 | 先 deactivate → PUT → activate |
| Credential 無法更新 | PUT credential 不支援 | DELETE + POST 重建 credential |

## 注意事項

- **不要**在 POST /create body 裡省略 settings，POST 後再 PUT 不會更新 activeVersion
- **Webhook path 重用陷阱**：刪除舊 workflow 後再建同 path 的 webhook，DB 可能留有舊記錄，導致永遠 404
- Windows 環境若無 `jq`，改用 `python -c "import sys,json; ..."` 解析 JSON
