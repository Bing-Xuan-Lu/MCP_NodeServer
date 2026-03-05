# /n8n_webhook_debug — 診斷並修復 n8n Webhook 節點不觸發問題

## 背景
當外部服務呼叫 n8n Webhook 但工作流沒有執行時，使用此技能逐步診斷根因。
常見原因：httpMethod 不符、webhook path 未註冊、工作流未啟用。

## 輸入
- `<workflow_name>` — 問題工作流名稱（例：網路監控）
- `<webhook_path>` — Webhook path（例：network-recovered）
- 觸發端 log 路徑（選填，若有的話）

## 步驟

### 步驟 1：確認觸發端 log

若有觸發端 log，讀取最近 50 行：
```
tail_log path="<log_path>" lines=50
```
找出：
- 是否有成功發送 HTTP 的記錄
- 是否有 `[WARN]` / `[ERROR]` 訊息（注意：HTTP 4xx 不一定會觸發 error handler）

### 步驟 2：查 n8n 執行記錄

```bash
curl -s "http://localhost:5678/api/v1/executions?limit=10&workflowId=<id>" \
  -H "X-N8N-API-KEY: <key>" | jq '.data[] | {id, status, startedAt}'
```
- 若 `data: []`：Webhook 從未被觸發（路由層就攔截了）
- 若有執行但 `status: error`：Webhook 進來了但工作流內部出錯

### 步驟 3：直接測試 Webhook

分別測試 GET 和 POST，比對回應：
```bash
# 測試 GET
curl -s -o /dev/null -w "%{http_code}" \
  "http://localhost:5678/webhook/<path>"

# 測試 POST
curl -s -o /dev/null -w "%{http_code}" -X POST \
  "http://localhost:5678/webhook/<path>" \
  -H "Content-Type: application/json" -d "{}"
```
- 200 → 該 method 有效
- 404 → 該 method 未註冊
- 找出觸發端實際使用的 method vs webhook 接受的 method

### 步驟 4：取得工作流結構

```
n8n_get_workflow id="<workflow_id>" mode="structure"
```
找出 Webhook 節點的 `parameters`，確認：
- `httpMethod` 是否設定（未設定時 n8n 預設為 GET）
- `path` 是否正確
- `responseMode` 是否合適

### 步驟 5：修復 httpMethod

若確認 method 不符，執行 deactivate → PUT → activate：

```bash
# 1. Deactivate
curl -X POST "http://localhost:5678/api/v1/workflows/<id>/deactivate" \
  -H "X-N8N-API-KEY: <key>" -H "Content-Type: application/json" -d "{}"

# 2. 取得完整工作流 JSON
curl -s "http://localhost:5678/api/v1/workflows/<id>" \
  -H "X-N8N-API-KEY: <key>" > /tmp/workflow.json

# 3. 修改 webhook 節點的 parameters.httpMethod，存為 /tmp/workflow_fix.json

# 4. PUT 回去
curl -X PUT "http://localhost:5678/api/v1/workflows/<id>" \
  -H "X-N8N-API-KEY: <key>" -H "Content-Type: application/json" \
  -d @/tmp/workflow_fix.json

# 5. Activate
curl -X POST "http://localhost:5678/api/v1/workflows/<id>/activate" \
  -H "X-N8N-API-KEY: <key>" -H "Content-Type: application/json" -d "{}"
```

> 注意：用 `n8n_update_partial_workflow` 的 `updateNode` 操作可直接修改節點參數，不需手動 GET/PUT 全量 JSON。

### 步驟 6：驗證修復

重新執行步驟 3 的 POST 測試，確認回傳 200。
再次查詢執行記錄（步驟 2），確認新的執行已出現。

## 常見根因對照

| 症狀 | 根因 | 修法 |
|------|------|------|
| curl GET=200, POST=404 | 節點 `httpMethod` 未設定（預設 GET） | 加 `"httpMethod": "POST"` |
| 兩者都 404 | 工作流未啟用 / webhook path 錯誤 | activate 工作流，確認 path |
| 兩者都 404（曾刪除重建） | 舊 DB entry 殘留 | 換一個新的 webhook path |
| 200 但無執行記錄 | 工作流 activeVersionId 過舊 | deactivate → PUT → activate 刷新 |
| log 有 `[WARN] 失敗:` 但訊息空白 | HTTP 連線成功但對方返回 4xx（node.js `http.request` 不自動 reject 4xx） | 在觸發端程式加 `if (res.statusCode >= 400) reject(...)` |

## 輸出

- 確認 webhook 接受正確的 HTTP method
- 工作流有新的執行記錄
- 觸發端 log 不再出現靜默失敗
