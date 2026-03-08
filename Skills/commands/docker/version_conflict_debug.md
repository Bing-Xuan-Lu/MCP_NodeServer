---
name: version_conflict_debug
description: |
  系統性診斷並修復兩個服務整合後出現的版本相容性衝突。涵蓋：版本資訊收集、log 訊號分析、通訊測試、根因判斷、修復套用。適用 Docker+Traefik、PHP+MySQL、Node+npm 等任意組合。
  當使用者遇到「整合後連線失敗」「神秘 API 拒絕」「升版後壞掉」「版本不相容」時使用。
---

# /version_conflict_debug — 自動診斷並修復服務元件版本相容性衝突

## 背景

當兩個服務整合後出現神秘錯誤（連線失敗、協議不符、API 拒絕），
懷疑是版本相容性問題時使用。適用於任何服務組合：
Docker + Traefik、PHP + MySQL、Node + npm、nginx + upstream 等。

## 輸入

- 出錯的服務名稱（Component A 與 Component B）
- 錯誤症狀描述或 log 片段
- 環境（本機開發 / 測試主機 / 正式主機）

## 步驟

### 1. 收集雙方版本資訊

依服務類型取得版本：

| 服務類型 | 版本查詢指令 |
|---------|------------|
| Docker container | `docker exec {container} {cmd} --version` |
| Docker image | `docker inspect {image} \| grep -i version` |
| PHP | `php -v` 或 `docker exec {container} php -v` |
| MySQL / MariaDB | `mysql -V` 或 `SELECT VERSION();` |
| Node.js / npm | `node -v && npm -v` |
| nginx | `nginx -v` |
| 套件相依 | `npm ls {package}` / `composer show {package}` |

記錄格式：`Component A = {version}，Component B = {version}`

### 2. 分析 log 中的版本衝突訊號

從雙方服務的 log 中搜尋版本相關關鍵字：

```bash
docker logs {container_a} 2>&1 | grep -iE "version|too old|unsupported|deprecated|minimum|require|incompatible" | tail -20
docker logs {container_b} 2>&1 | grep -iE "version|too old|unsupported|deprecated|minimum|require|incompatible" | tail -20
```

**常見版本衝突訊號對照表**：

| 錯誤訊息關鍵字 | 衝突類型 | 診斷方向 |
|-------------|---------|---------|
| `client version X is too old. Minimum supported ... is Y` | API 版本過舊 | 升級 client 或調整協商起始版本 |
| `Error response from daemon: ""` | API 版本協商失敗（回應為空） | 檢查 client 協商起點 vs server 最低版本 |
| `Unsupported protocol version` | 協議層不相容 | 雙方 TLS/HTTP 版本對齊 |
| `deprecated function` / `removed in version X` | API 已棄用 | 升級 client 呼叫方式 |
| `peer dependency conflict` / `requires X but got Y` | 套件相依衝突 | 鎖版或升級至相容版本 |
| `Authentication protocol ... cannot be used` | 認證協議衝突 | 降級協議或升級 client |
| `SSL routines` / `certificate verify failed` | TLS 版本衝突 | 檢查 TLS 最低版本設定 |

### 3. 實際測試元件間通訊

**HTTP API（REST）：**

```bash
# 從 A 的容器內呼叫 B 的 API，觀察回應
docker exec {container_a} sh -c 'curl -sv http://{host_b}:{port}/version 2>&1 | head -30'
# 若回 400 → 測試 B 的最低版本
docker exec {container_a} sh -c 'curl -s http://{host_b}:{port}/v{min_version}/version'
```

**資料庫連線：**

```bash
docker exec {container_a} sh -c 'mysql -h {host_b} -u {user} -p{pass} -e "SELECT VERSION();"'
```

**TCP 端口連通性：**

```bash
docker exec {container_a} sh -c 'nc -zv {host_b} {port} 2>&1'
```

**套件相依（Node）：**

```bash
npm ls 2>&1 | grep -i "peer\|invalid\|unmet"
```

> **注意（Windows Git Bash）**：含 `/var/run/...` 等 Unix 路徑的指令需用 `sh -c '...'` 包裝，
> 否則 Git Bash 會自動轉譯為 Windows 路徑導致指令失敗。

### 4. 判斷衝突根因

根據步驟 1-3 的結果，套用以下決策樹：

```
A 能連到 B？
├── 否 → 網路/防火牆問題，非版本問題，跳出另行診斷
└── 是 → 繼續

B 回應 4xx/5xx？
├── 400 + "too old" → Client 版本過舊，升級 A（或調整 A 的協商起點）
├── 400 + 空訊息  → Client 協商起點低於 B 最低支援版本，查 B 的 MinVersion
├── 401/403 + 認證協議錯誤 → 認證協議不相容（MySQL caching_sha2 等）
└── 協議層錯誤  → TLS 版本衝突

版本差距判斷：
├── A 版本 < B 最低支援版本 → 升級 A（或查 B 是否有相容設定可降級）
└── B 版本 > A 最高相容版本 → 降級 B 或升級 A
```

### 5. 查詢已知相容矩陣

針對找到的版本組合，查詢官方文件或 GitHub Release Notes：

- 目標版本的 **Changelog / Breaking Changes**
- 官方 **Compatibility Matrix**（若有）
- GitHub Issues：搜尋 `"{error_keyword}" version:{A_version}`

若有 WebSearch 工具：

```
搜尋："{Component A} {version_A} {Component B} {version_B} compatibility issue"
搜尋："{error_message_keyword} minimum version {Component B}"
```

### 6. 套用修復方案

依診斷結果選擇修復策略：

| 策略 | 適用情境 | 執行方式 |
|------|---------|---------|
| **升級 A** | A 版本過舊，B 有新功能需求 | 更新 image tag / 套件版本號 |
| **降級 B** | B 破壞性升級，A 無法立即跟上 | 鎖定 B 的版本號 |
| **調整協商設定** | 雙方版本 OK 但協商起點錯誤 | 設定 env var / config 覆蓋預設值 |
| **啟用相容模式** | B 提供向下相容選項 | 修改 B 的設定（如 `mysql_native_password`） |
| **對齊協議版本** | TLS / HTTP 協議版本衝突 | 調整 `ssl_protocols` / `http_version` 設定 |

**套用後強制重建**（避免舊設定殘留）：

```bash
# Docker 環境（restart 不套用新的 volume/env 設定）
docker compose up -d --force-recreate {service}

# 套件環境
npm ci          # Node
composer install --no-cache   # PHP
```

### 7. 驗證修復

確認 log 中版本衝突訊息消失，雙方能正常通訊：

```bash
docker logs {container_a} 2>&1 | grep -iE "error|warn" | tail -10
# 預期：無版本相關錯誤
```

重複步驟 3 的通訊測試，確認回應正常（2xx）。

## 輸出

- 確認衝突根因（哪個元件版本過舊/過新）
- 套用的修復方案與指令
- 修復後的驗證截圖或 log 片段
- 建議：將衝突組合記錄到專案 `CLAUDE.md` 或規劃書，避免下次重蹈

## 常見組合速查

| 組合 | 常見衝突點 | 快速修復 |
|------|----------|---------|
| Traefik v3.x + Docker Desktop 4.x | Go client 從 v1.24 協商，Docker Desktop 最低 v1.44 | 升至 Traefik v3.6.2+；啟用 TCP 2375 |
| MySQL 8 + PHP PDO | `caching_sha2_password` 認證協議 | `ALTER USER ... IDENTIFIED WITH mysql_native_password` |
| npm v7+ + 舊套件 | peer dependency strict mode | `npm install --legacy-peer-deps` |
| nginx + upstream HTTP/2 | H2C 未啟用 | nginx 加 `grpc_pass` 或 `http2` directive |
| Docker Compose v2 + 舊 schema | `version:` 欄位已棄用 | 移除 compose file 中的 `version:` 行 |
| MariaDB 10.4+ + 舊 root 認證 | `unix_socket` plugin 預設啟用 | `ALTER USER root@localhost IDENTIFIED VIA mysql_native_password` |
