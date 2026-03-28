# Flyway — 資料庫版本控制

管理 MySQL / MariaDB / MSSQL 的 schema 遷移歷史，確保各環境 DB 結構一致。

---

## 目錄結構

```text
flyway/
├── docker-compose.yml          ← Flyway 服務
├── conf/
│   ├── pure_php_db.toml        ← 本機設定（gitignore，自行建立）
│   ├── pure_php_db.sample.toml ← 本機設定範本（進版控）
│   ├── staging.toml            ← 測試機設定（gitignore，自行建立）
│   ├── staging.sample.toml     ← 測試機設定範本（進版控）
│   ├── template_mysql.toml     ← MySQL/MariaDB 通用模板
│   └── template_mssql.toml     ← MSSQL 通用模板
└── sql/
    ├── example/                ← 語法參考（不加 V 前綴，不會被 Flyway 執行）
    │   ├── example_mysql.sql   ← MySQL/MariaDB 語法範例
    │   └── example_mssql.sql   ← MSSQL 語法範例
    └── {project_name}/         ← 每個專案建一個資料夾（自訂名稱）
        ├── V1__init.sql
        └── V2__add_column.sql
```

> `*.toml`（無 sample/template 前綴）均被 `.gitignore` 排除，內含真實帳密，不進版控。

---

## 新增專案流程（每個新專案做一次）

**以 MySQL/MariaDB 為例（MSSQL 換用 `template_mssql.toml`）：**

```bash
# 1. 建立 SQL 腳本資料夾（用專案名稱命名，如 crm、shop、erp）
mkdir flyway/sql/{project_name}

# 2. 建立 conf 設定檔（複製範本）
cp flyway/conf/pure_php_db.sample.toml flyway/conf/{project_name}.toml
```

編輯 `conf/{project_name}.toml`，填入三個地方：

```toml
[environments.default]
url      = "jdbc:mariadb://pure_php_db:3306/{資料庫名稱}"
password = "{密碼}"
schemas  = ["{資料庫名稱}"]

[flyway]
locations = ["filesystem:/flyway/sql/{project_name}"]
```

```bash
# 3. 在新資料夾建立第一個 migration 腳本
# 參考 sql/example/example_mysql.sql 的語法
```

之後在 Claude 對話中：

```text
flyway_info   config={project_name}    ← 確認連線
flyway_migrate config={project_name}   ← 執行 migration
```

---

## 環境一覽

| 環境 | 設定檔 | 連線方式 |
| --- | --- | --- |
| 本機 `pure_php_db` | `conf/pure_php_db.toml` | Docker 容器名直連（同網路） |
| 測試機 | `conf/staging.toml` | SSH Tunnel（見下方說明） |
| MSSQL | `conf/mssql_proj.toml` | 直連或 SSH Tunnel |

---

## 一、首次初始化

### 1. 建立本機設定檔

```bash
cp flyway/conf/pure_php_db.sample.toml flyway/conf/pure_php_db.toml
```

編輯 `conf/pure_php_db.toml`，填入真實 DB 名稱、密碼，以及專案資料夾名稱：

```toml
[environments.default]
url      = "jdbc:mariadb://pure_php_db:3306/{your_database}"
user     = "root"
password = "{your_password}"
schemas  = ["{your_database}"]

[flyway]
environment = "default"
locations   = ["filesystem:/flyway/sql/{your_project}"]
```

然後建立對應的 SQL 資料夾：

```bash
mkdir flyway/sql/{your_project}
```

### 2. 啟動 Flyway 容器

```bash
cd MCP_NodeServer/flyway
docker compose up -d
```

啟動後 `dev-flyway` 容器常駐待命，透過 MCP 工具或 `docker exec` 呼叫即可。

### 3. 確認連線

在 Claude 對話中呼叫：

```text
flyway_info
```

看到版本表格即代表連線成功。

---

## 二、日常開發流程（本機）

### 新增一個 Schema 變更

1. 在對應的專案資料夾（如 `sql/pure_php_db/`）新增 SQL 檔：

   ```text
   命名規則：V{版本號}__{說明}.sql（版本號遞增，雙底線分隔）

   範例：
     V2__add_user_status_column.sql
     V3__create_order_table.sql
     V4__add_index_on_email.sql
   ```

2. 預覽確認（不實際執行）：

   ```text
   flyway_migrate dry_run=true
   ```

3. 執行：

   ```text
   flyway_migrate
   ```

4. 確認結果：

   ```text
   flyway_info
   → 剛才的版本應從 Pending 變成 Success
   ```

---

## 三、部署到測試機（SSH Tunnel 流程）

測試機的 MySQL 跑在 Docker 裡，不對外開放 3306。
透過 SSH Tunnel，讓本機的 Flyway 容器借道 SSH 連進去。

### 架構圖

```text
本機 dev-flyway 容器
  ↓ 連到 host.docker.internal:13306
宿主機（你的 Windows）
  ↓ SSH Tunnel
測試機（Linux）
  ↓ 127.0.0.1:3306
測試機 MySQL Docker 容器
```

### 步驟一：確認測試機 MySQL 有對 host 暴露 port

SSH 進測試機執行：

```bash
docker ps --format "table {{.Names}}\t{{.Ports}}"
```

確認 MySQL 容器有 `0.0.0.0:3306->3306/tcp`。
若沒有，需在測試機的 docker-compose.yml 加入：

```yaml
ports:
  - "3306:3306"
```

### 步驟二：建立 staging.toml（僅首次需要）

```bash
cp flyway/conf/staging.sample.toml flyway/conf/staging.toml
```

編輯 `conf/staging.toml`，填入真實 DB 帳密：

```toml
[environments.default]
url      = "jdbc:mysql://host.docker.internal:13306/{your_database}"
user     = "{db_user}"
password = "{db_password}"
schemas  = ["{your_database}"]

[flyway]
environment = "default"
locations   = ["filesystem:/flyway/sql/pure_php_db"]
```

> `host.docker.internal` 是 Docker 容器連回宿主機的特殊 hostname，不需要改成 IP。
> `13306` 是 Tunnel 在本機佔用的 port（對應測試機的 3306）。

### 步驟三：每次部署前，開啟 SSH Tunnel

**Git Bash 執行：**

```bash
ssh -L 13306:127.0.0.1:3306 {user}@{testserver} -N &
```

參數說明：

| 參數 | 說明 |
| --- | --- |
| `-L 13306:127.0.0.1:3306` | 本機 13306 → 測試機 127.0.0.1:3306 |
| `{user}@{testserver}` | SSH 帳號與測試機 IP/hostname |
| `-N` | 不開 shell，純 tunnel |
| `&` | 背景執行，不佔終端機 |

確認 Tunnel 是否成功：

```bash
# 看到 13306 有在 LISTEN 即成功
netstat -an | grep 13306
```

### 步驟四：執行 Migration

```text
flyway_info   config=staging       ← 先確認版本狀態
flyway_migrate config=staging      ← 執行 Pending 腳本
```

### 步驟五：關閉 Tunnel（部署完畢後）

```bash
# 找到 tunnel 的 PID 並結束
kill $(lsof -ti:13306)

# 或直接關閉那個 Git Bash 視窗
```

---

## 四、MCP 工具說明

| 工具 | 參數 | 說明 |
| --- | --- | --- |
| `flyway_info` | `config` | 列出所有版本狀態（Pending / Success / Failed） |
| `flyway_migrate` | `config`, `dry_run` | 執行 Pending 腳本；`dry_run: true` 只預覽 |
| `flyway_validate` | `config` | 驗證 checksum 是否與 DB 記錄一致 |
| `flyway_repair` | `config` | 修復 Failed 記錄，重對齊 checksum |
| `flyway_baseline` | `config`, `baseline_version`, `baseline_description` | 為現有 DB 建立 baseline |

`config` 預設值為 `pure_php_db`，對應 `conf/pure_php_db.toml`。

**手動執行（不透過 MCP）：**

```bash
docker exec dev-flyway flyway -configFiles="/flyway/conf/pure_php_db.toml" info
docker exec dev-flyway flyway -configFiles="/flyway/conf/staging.toml" migrate
```

---

## 五、常見情境

### 情境 A：全新 DB，從零開始

1. 寫好 `V1__init.sql`（建表語句）
2. `flyway_migrate` → Flyway 自動建立 `flyway_schema_history` 並執行 V1

### 情境 B：現有 DB，首次引入 Flyway

1. 在 `conf/your_db.toml` 的 `[flyway]` 區塊設定 `baselineOnMigrate = true`
2. `flyway_baseline` → 標記現有狀態為 V1（不執行任何腳本）
3. 後續 migration 從 V2 開始

### 情境 C：腳本執行到一半失敗

1. 修復 SQL 腳本或資料問題
2. `flyway_repair` → 清除 Failed 記錄
3. `flyway_migrate` → 重新執行

### 情境 D：不小心修改了已執行的腳本

1. `flyway_validate` → 確認 checksum 不一致
2. 還原腳本為原始內容，或 `flyway_repair` 更新 checksum（不建議，會失去稽核記錄）

### 情境 E：要對測試機跑 migration 但忘記流程

**按順序執行：**

```text
1. Git Bash：ssh -L 13306:127.0.0.1:3306 {user}@{testserver} -N &
2. Claude：  flyway_info config=staging        ← 確認連線 + 版本狀態
3. Claude：  flyway_migrate config=staging     ← 執行
4. Git Bash：kill $(lsof -ti:13306)            ← 關閉 Tunnel
```

---

## 六、停止容器

```bash
cd MCP_NodeServer/flyway
docker compose down
```

> 停止不會刪除任何 DB 資料，`flyway_schema_history` 記錄完整保留。
