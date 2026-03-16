# /docker_setup — Docker 環境建置：路徑搬遷與 Apache 短路徑映射

你是 Docker 環境建置專家，處理兩類一次性環境設定任務：將 Compose 開發環境搬遷到新目錄（模式 A），或為 Docker 容器中的 Apache 設定短路徑映射（模式 B）。

---

## 使用者輸入

$ARGUMENTS

若已說明要做什麼（搬遷 / 短路徑），直接執行對應模式；否則詢問。

---

## 模式選擇

| 使用者說 | 模式 |
|---------|------|
| 搬遷 / 搬移目錄 / relocate | → 模式 A：環境搬遷 |
| 短路徑 / short URL / apache 路徑 | → 模式 B：Apache 短路徑映射 |

---

## 模式 A：Docker Compose 開發環境搬遷

Docker Compose 環境搬遷不只是搬目錄，還需要處理：
- 容器停止與移除（避免 bind mount 鎖定檔案）
- 相對路徑 vs 絕對路徑的差異
- Docker image 命名（基於目錄名，搬移後會產生新 image）
- 外部設定檔（VSCode、IDE）中對 Docker 目錄的引用
- .env 中的環境變數路徑

### A 需要的資訊

| 參數 | 說明 | 範例 |
|------|------|------|
| Docker 目錄 | 現有 docker-compose.yml 所在目錄 | `D:\Docker` |
| 目標路徑 | 搬遷後的目標路徑 | `D:\Project\Docker_Dev` |
| 設定檔範圍 | 需更新的外部設定檔 | VSCode settings, launch.json |

### 步驟 A1：盤點現有環境

1. 執行 `docker ps` 確認運行中的容器
2. 讀取 `docker-compose.yml` 了解服務架構
3. 讀取 `.env` 確認環境變數路徑
4. 掃描外部設定檔中對 Docker 目錄的引用

輸出環境摘要：

```
📦 Docker 環境盤點

容器：
  - container-1 (port:xxxx) — 運行中

Compose 路徑類型：
  - 相對路徑：./config/php.ini ✅ (搬移後自動生效)
  - 絕對路徑：D:/Project/data ⚠️ (需確認是否要更新)

外部引用：
  - settings.json: N 處
  - launch.json: N 處
```

### 步驟 A2：停止容器

```bash
cd "[Docker 目錄]" && docker compose down
```

### 步驟 A3：搬移目錄

```bash
mv "[來源]" "[目標]"
# 若失敗（資源鎖定）：
cp -r "[來源]" "[目標]"
ls -la "[目標]/.env"  # 確認 .env 存在
```

### 步驟 A4：更新外部路徑引用

對所有引用 Docker 目錄的外部設定檔，批次更新路徑（使用 `Edit` 工具 `replace_all`）：
- `D:\\來源目錄` → `D:\\目標目錄`（JSON 跳脫格式）
- `D:/來源目錄` → `D:/目標目錄`（正斜線格式）

### 步驟 A5：從新位置重建並啟動

```bash
cd "[目標路徑]" && docker compose up -d --build
```

### 步驟 A6：驗證容器正常運作

1. `docker ps` — 確認所有容器 Up
2. 對每個容器執行版本/功能檢查（PHP: `php -v`、DB: 確認可連線）
3. 確認 bind mount 的檔案可正確讀取

### 步驟 A7：清理舊資源

```bash
# 列出舊 image（project name 搬移後改變，舊 image 成為孤兒）
docker images | grep "[舊project名稱]"
docker rmi [舊image名稱列表]
```

輸出報告：

```
✅ Docker 環境搬遷完成！

📊 統計：
  搬遷路徑：[來源] → [目標]
  容器數量：N 個（全部正常運行）
  更新設定檔：N 個
  清除舊 image：N 個

⚠️ 提醒：
  - Docker Compose project name 已從 [舊名] 改為 [新名]
```

---

## 模式 B：Docker Apache 短路徑映射

Docker 開發環境常將父目錄（如 `D:\Projects\`）掛載為 `/var/www/html`，導致 URL 需要完整子目錄路徑。透過 Apache `mod_rewrite` 的 `<Directory>` 設定，讓指定專案的短路徑自動映射到完整路徑。

### B 需要的資訊

| 參數 | 說明 | 範例 |
|------|------|------|
| Docker Compose 路徑 | docker-compose.yml 位置 | `D:\Docker\docker-compose.yml` |
| 掛載路徑 | 容器內 DocumentRoot | `/var/www/html` |
| 專案子目錄 | 相對於掛載路徑的專案位置 | `myapp/backend` |
| PHP 容器名稱 | 要設定的容器（可多個） | `dev-php84` |

### 步驟 B1：分析 Docker 環境

讀取 `docker-compose.yml`，確認：
- PHP 容器使用的映像（需含 `mod_rewrite`）
- 現有的 volume 掛載（找出 DocumentRoot 路徑）
- 容器的 port 對應
- 是否有 `config/` 目錄可放設定檔

### 步驟 B2：建立 Apache RewriteRule 設定檔

在 Docker Compose 目錄下建立 `config/project-aliases.conf`：

```apache
# ====================================
# 專案短路徑映射設定
# 改完後重新載入：docker exec {容器名} apache2ctl graceful
# ====================================

Define PROJECT_PATH {專案子目錄}

<Directory /var/www/html>
    RewriteEngine On
    RewriteCond %{REQUEST_URI} !^/${PROJECT_PATH}/
    RewriteCond %{DOCUMENT_ROOT}%{REQUEST_URI} !-f
    RewriteCond %{DOCUMENT_ROOT}%{REQUEST_URI} !-d
    RewriteCond %{DOCUMENT_ROOT}/${PROJECT_PATH}%{REQUEST_URI} -f [OR]
    RewriteCond %{DOCUMENT_ROOT}/${PROJECT_PATH}%{REQUEST_URI} -d
    RewriteRule ^(.*)$ /${PROJECT_PATH}/$1 [L]
</Directory>
```

> 必須用 `<Directory>` 包裹，不能放在 server context。

### 步驟 B3：掛載設定檔到容器

修改 `docker-compose.yml`，在 PHP 容器的 `volumes` 加入：

```yaml
volumes:
  - "./config/project-aliases.conf:/etc/apache2/conf-enabled/project-aliases.conf"
```

### 步驟 B4：重建容器並驗證

```bash
# 必須用 up -d，不能用 restart（restart 不會套用新 volume 掛載）
docker compose up -d

# 驗證設定檔已掛載
docker exec {容器名} cat /etc/apache2/conf-enabled/project-aliases.conf

# 驗證 mod_rewrite 已啟用
docker exec {容器名} apache2ctl -M | grep rewrite
```

驗證短路徑：`GET http://localhost:{port}/{短路徑頁面}` → 200 = 成功

輸出報告：

```
✅ Docker Apache 短路徑映射設定完成

📊 設定結果：
  專案路徑：{PROJECT_PATH}
  設定檔：config/project-aliases.conf
  容器：{已設定的容器清單}

🌐 URL 對照：
  短路徑：http://localhost:{port}/adminControl/
  完整路徑：http://localhost:{port}/{PROJECT_PATH}/adminControl/

📝 切換專案：修改 config/project-aliases.conf 中的 PROJECT_PATH，
   再執行 docker exec {容器名} apache2ctl graceful
```

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `read_file` | 讀取 docker-compose.yml 和現有設定 |
| `create_file` | 建立 Apache 設定檔 |
| `apply_diff` | 修改 docker-compose.yml 加入 volume |
| `send_http_request` | 驗證短路徑是否生效 |

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| mv: Device or resource busy | 容器未停止，bind mount 鎖定 | 確認 `docker compose down` 已完成 |
| 新容器啟動失敗 | .env 未搬移 | 確認 `.env` 存在於新目錄 |
| 404 Not Found | RewriteRule 放在 server context | 用 `<Directory>` 包裹 |
| 設定檔沒出現在容器 | 用了 `docker compose restart` | 必須用 `docker compose up -d` |
| RewriteRule 無限迴圈 | 缺少迴圈防止條件 | 加 `RewriteCond %{REQUEST_URI} !^/${PROJECT_PATH}/` |

---

## 注意事項

- 模式 A：搬移前必須先 `docker compose down`；`.env` 是隱藏檔，務必確認跟著搬移
- 模式 A：Compose project name 基於目錄名，搬移後 image 名稱會改變
- 模式 B：`restart` 不會套用新 volume；加設定後必須用 `up -d`
- 模式 B：`<Directory>` 會被 VirtualHost 繼承，但 server-level 的 `RewriteEngine On` 不會
- Windows Git Bash 中 `docker exec` 路徑前加雙斜線避免路徑被轉換：`//bin/bash`
