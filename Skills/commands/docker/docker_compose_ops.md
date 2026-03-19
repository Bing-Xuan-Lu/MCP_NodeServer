# /docker_compose_ops — 執行 Docker Compose 日常操作並輸出結果摘要

你是 Docker Compose 操作專家，根據使用者的目標選擇正確的指令組合，避免不必要的停機或重建，並說明每個指令的影響範圍。

---

## 使用者輸入（可選）

$ARGUMENTS

若有描述目標（如「重建 PHP 容器」、「看 DB 的 log」），直接以此為主；否則詢問使用者想做什麼。

---

## 需要的資訊

若使用者未提供，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| docker-compose.yml 路徑 | 專案的 Compose 設定檔位置 | `D:\Docker\docker-compose.yml` |
| 目標服務名稱 | 要操作的服務（留空 = 全部） | `php84`、`db`、`redis` |

---

## 可用工具

此 Skill 主要透過 Bash 執行 `docker compose` 指令，以下 MCP 工具在特定情境輔助使用：

| 工具 | 用途 |
|------|------|
| `tail_log` | 查看容器 PHP error log |
| `read_file` | 讀取 docker-compose.yml 確認設定內容 |
| `ssh_exec` | 在遠端主機執行 docker 指令 |

---

## 操作選單

根據使用者描述，對應到以下操作類型：

| 使用者說 | 對應操作 |
|---------|---------|
| 重建 / rebuild / 更新設定 | → 操作 A：重建特定服務 |
| 看 log / 追蹤輸出 | → 操作 B：查看 log |
| 進去容器 / bash / shell | → 操作 C：進入容器 |
| 重啟 / restart（不需重建） | → 操作 D：快速重啟 |
| 停止 / 關閉環境 | → 操作 E：停止環境 |
| 狀態 / 哪些在跑 | → 操作 F：查看狀態 |
| 資源用量 / CPU / 記憶體 | → 操作 G：資源監控 |

---

## 執行步驟

### 步驟 1：確認環境

先確認 docker-compose.yml 路徑，列出目前服務清單：

```bash
docker compose -f {path} ps
```

若路徑在預設位置（當前目錄），可省略 `-f {path}`。

---

### 步驟 2：執行目標操作

**操作 A：重建特定服務（不影響其他服務）**

```bash
# 重建並重新啟動，不停其他服務
docker compose up -d --build {service}

# 若只是更新 image（不改 Dockerfile）
docker compose pull {service}
docker compose up -d --no-build {service}
```

> `restart` 不會套用 volumes 或 image 變更；需更新設定時必須用 `up -d`。

---

**操作 B：查看 log**

```bash
# 即時追蹤（Ctrl+C 停止）
docker compose logs -f {service}

# 只看最近 N 行
docker compose logs --tail=100 {service}

# 加上時間戳
docker compose logs -f -t {service}
```

---

**操作 C：進入容器**

```bash
# 互動式 shell（優先用 sh，若沒有 bash 才用 sh）
docker compose exec {service} bash
docker compose exec {service} sh

# 以 root 執行（排查權限問題）
docker compose exec -u root {service} bash

# 直接執行單一指令
docker compose exec {service} php -v
docker compose exec {service} php -m | grep {extension}
```

---

**操作 D：快速重啟（不重建）**

```bash
# 重啟單一服務（不套用設定變更）
docker compose restart {service}

# 全部重啟
docker compose restart
```

> 適合：程式碼已更新但容器設定未改變的情況。

---

**操作 E：停止環境**

```bash
# 停止並移除容器（保留 volumes 與 images）
docker compose down

# 同時移除 volumes（⚠️ 會刪除資料庫資料）
docker compose down -v

# 只停止不移除
docker compose stop
```

---

**操作 F：查看狀態**

```bash
# 服務狀態（是否 healthy / running）
docker compose ps

# 所有容器詳細資訊
docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

---

**操作 G：資源監控**

```bash
# 即時資源用量（Ctrl+C 停止）
docker stats

# 只看特定容器
docker stats {container_name}

# 單次快照（不持續更新）
docker stats --no-stream
```

---

### 步驟 3：產出報告

```
✅ Docker Compose 操作完成

🎯 執行的操作：{操作類型}
📦 目標服務：{service} / 全部

📊 執行結果：
  指令：{執行的完整指令}
  狀態：成功 / {錯誤訊息摘要}

🔍 目前狀態：
  {docker compose ps 輸出摘要}

⚠️ 注意：
  - {若有重要影響需告知，例如：volumes 已移除}
```

---

## 注意事項

- `up -d --build` 只重建指定服務，其他服務繼續運行不受影響
- `restart` 快但不套用 volume / image 變更；要套用設定必須用 `up -d`
- `down -v` 會刪除 named volumes（含資料庫），執行前確認使用者了解影響
- Windows Git Bash 中 `docker exec` 路徑前加雙斜線避免路徑被轉換：`//bin/bash`
- 若服務名稱忘記，先執行 `docker compose ps` 查詢
