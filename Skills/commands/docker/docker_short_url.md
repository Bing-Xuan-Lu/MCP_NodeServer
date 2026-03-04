# /docker_short_url — 設定 Docker Apache 短路徑映射

你是 Docker + Apache 設定專家，幫助使用者解決 Docker 容器中 URL 路徑過長的問題。當 Docker 掛載父目錄作為 DocumentRoot 時，URL 需要完整子目錄路徑（如 `/project/sub/adminControl/`），此技能會設定 Apache RewriteRule，讓使用者可用短路徑存取（如 `/adminControl/`）。

---

## 背景

Docker 開發環境常將一個父目錄（如 `D:\Projects\`）掛載為 `/var/www/html`，好處是一個容器能同時存取多個專案。但缺點是 URL 必須包含完整子目錄路徑。

透過 Apache `mod_rewrite` 的 `<Directory>` 設定，可在不影響其他專案的情況下，讓指定專案的短路徑自動映射到完整路徑。

---

## 需要的資訊

若使用者未提供，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| Docker Compose 路徑 | docker-compose.yml 位置 | `D:\Docker\docker-compose.yml` |
| 掛載路徑 | 容器內 DocumentRoot | `/var/www/html` |
| 專案子目錄 | 相對於掛載路徑的專案位置 | `myapp/backend` |
| PHP 容器名稱 | 要設定的容器（可多個） | `dev-php84` |

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `read_file` | 讀取 docker-compose.yml 和現有設定 |
| `create_file` | 建立 Apache 設定檔 |
| `apply_diff` | 修改 docker-compose.yml 加入 volume |
| `send_http_request` | 驗證設定是否生效 |

---

## 執行步驟

### 步驟 1：分析 Docker 環境

```
read_file("docker-compose.yml")
```

確認：
- PHP 容器使用的映像（需含 `mod_rewrite`）
- 現有的 volume 掛載（找出 DocumentRoot 路徑）
- 容器的 port 對應
- 是否有 `config/` 目錄可放設定檔

---

### 步驟 2：建立 Apache RewriteRule 設定檔

在 Docker Compose 目錄下建立設定檔（如 `config/project-aliases.conf`）：

```apache
# ====================================
# 專案短路徑映射設定
# ====================================
# 修改 PROJECT_PATH 即可切換專案（只需改下面這一行）
#
# 改完後重新載入：docker exec {容器名} apache2ctl graceful
# ====================================

Define PROJECT_PATH {專案子目錄}

<Directory /var/www/html>
    RewriteEngine On

    # 防止迴圈：已是完整路徑就不再改寫
    RewriteCond %{REQUEST_URI} !^/${PROJECT_PATH}/

    # 條件 1：路徑在 DocumentRoot 下不存在（不影響其他專案）
    RewriteCond %{DOCUMENT_ROOT}%{REQUEST_URI} !-f
    RewriteCond %{DOCUMENT_ROOT}%{REQUEST_URI} !-d

    # 條件 2：路徑在專案子目錄下存在
    RewriteCond %{DOCUMENT_ROOT}/${PROJECT_PATH}%{REQUEST_URI} -f [OR]
    RewriteCond %{DOCUMENT_ROOT}/${PROJECT_PATH}%{REQUEST_URI} -d

    RewriteRule ^(.*)$ /${PROJECT_PATH}/$1 [L]
</Directory>
```

> 重要：必須用 `<Directory>` 包裹，不能放在 server context。VirtualHost 不會繼承 server-level 的 RewriteEngine，但會繼承 `<Directory>` 設定。

---

### 步驟 3：掛載設定檔到容器

修改 `docker-compose.yml`，在每個需要短路徑的 PHP 容器的 `volumes` 中加入：

```yaml
volumes:
  - "./config/project-aliases.conf:/etc/apache2/conf-enabled/project-aliases.conf"
```

> 注意：檔案放在 `conf-enabled/` 目錄下，Apache 啟動時會自動載入。

---

### 步驟 4：重建容器並驗證

```bash
# 必須用 up -d，不能用 restart（restart 不會套用新的 volume 掛載）
docker compose up -d

# 驗證設定檔已掛載
docker exec {容器名} cat /etc/apache2/conf-enabled/project-aliases.conf

# 驗證 mod_rewrite 已啟用
docker exec {容器名} apache2ctl -M | grep rewrite
```

```
send_http_request GET http://localhost:{port}/{短路徑頁面}
→ 200 = 成功 | 404 = RewriteRule 未生效 | 403 = 權限問題
```

---

### 步驟 5：產出報告

```
✅ Docker Apache 短路徑映射設定完成

📊 設定結果：
  專案路徑：{PROJECT_PATH}
  設定檔：config/project-aliases.conf
  容器：{已設定的容器清單}

🌐 URL 對照：
  短路徑：http://localhost:{port}/adminControl/
  完整路徑：http://localhost:{port}/{PROJECT_PATH}/adminControl/
  → 兩者皆可用，短路徑透過 RewriteRule 自動映射

📝 切換專案：
  1. 修改 config/project-aliases.conf 中的 PROJECT_PATH
  2. 執行 docker exec {容器名} apache2ctl graceful
```

---

## 輸出

- Apache 設定檔（`config/project-aliases.conf`）已建立
- docker-compose.yml 已加入 volume 掛載
- 短路徑存取已驗證通過

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| 404 Not Found | RewriteRule 放在 server context，VirtualHost 沒繼承 | 用 `<Directory>` 包裹，不要直接放在 conf 檔頂層 |
| 403 Forbidden | 用了 Apache `Alias` 指令 | 改用 RewriteRule，Alias 會影響 `$_SERVER` 變數 |
| 設定檔沒出現在容器 | 用了 `docker compose restart` | 必須用 `docker compose up -d` 重建容器 |
| RewriteRule 無限迴圈 | 缺少迴圈防止條件 | 加 `RewriteCond %{REQUEST_URI} !^/${PROJECT_PATH}/` |
| 其他專案被影響 | RewriteCond 條件不足 | 加 `!-f` 和 `!-d` 條件，只改寫不存在的路徑 |
| mod_rewrite 沒啟用 | Docker 映像沒裝 | Dockerfile 加 `RUN a2enmod rewrite` |
| Git Bash 路徑轉換 | `docker exec` 中的 Linux 路徑被 Git Bash 轉換 | 路徑前加雙斜線：`//etc/apache2/...` |

---

## 注意事項

- 使用 `Define` 變數讓專案路徑可一行切換，不需改 RewriteRule
- `<Directory>` 會被 VirtualHost 繼承，但 server-level 的 `RewriteEngine On` 不會
- `docker compose restart` 只重啟現有容器，不會套用 docker-compose.yml 的新 volume；必須用 `up -d`
- 此設定不影響完整路徑的存取，兩種路徑並存
- PHP 的 `$_SERVER` 變數（SCRIPT_NAME、REQUEST_URI 等）在 RewriteRule 下完全正確
- 若容器 Dockerfile 沒有 `a2enmod rewrite`，需先確認已啟用
