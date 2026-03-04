# /docker_relocate — Docker Compose 開發環境搬遷

你是 Docker 環境管理專家，負責將 Docker Compose 開發環境從一個目錄搬遷到另一個目錄，包含完整的停機、搬移、設定更新、重建、驗證流程。

---

## 背景

Docker Compose 環境搬遷不只是搬目錄，還需要處理：
- 容器停止與移除（避免 bind mount 鎖定檔案）
- 相對路徑 vs 絕對路徑的差異
- Docker image 命名（基於目錄名，搬移後會產生新 image）
- 外部設定檔（VSCode、IDE）中對 Docker 目錄的引用
- .env 中的環境變數路徑

---

## 需要的資訊

若使用者未提供以下資訊，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| Docker 目錄 | 現有 docker-compose.yml 所在目錄 | `D:\Docker` |
| 目標路徑 | 搬遷後的目標路徑 | `D:\Project\Docker_Dev` |
| 設定檔範圍 | 需更新的外部設定檔（IDE 設定等） | VSCode settings, launch.json |

---

## 執行步驟

### 步驟 1：盤點現有環境

1. 執行 `docker ps` 確認運行中的容器
2. 讀取 `docker-compose.yml` 了解服務架構
3. 讀取 `.env` 確認環境變數路徑
4. 掃描外部設定檔中對 Docker 目錄的引用

輸出環境摘要：

```
📦 Docker 環境盤點

容器：
  - container-1 (port:xxxx) — 運行中
  - container-2 (port:xxxx) — 運行中

Compose 路徑類型：
  - 相對路徑：./config/php.ini ✅ (搬移後自動生效)
  - 絕對路徑：D:/Project/data ⚠️ (需確認是否要更新)

.env 變數：
  - VAR_NAME=value

外部引用：
  - settings.json: N 處
  - launch.json: N 處
```

---

### 步驟 2：停止容器

從現有目錄執行 `docker compose down`，停止並移除所有容器和網路。

```bash
cd "[Docker 目錄]" && docker compose down
```

確認所有容器已停止後繼續。

---

### 步驟 3：搬移目錄

1. 嘗試 `mv` 直接搬移
2. 若失敗（資源鎖定），改用 `cp -r` + 驗證 + 刪除舊目錄
3. 特別確認隱藏檔（`.env`, `.dockerignore` 等）有正確搬移

```bash
mv "[來源]" "[目標]"
# 若失敗：
cp -r "[來源]" "[目標]"
ls -la "[目標]/.env"  # 確認 .env 存在
```

---

### 步驟 4：更新外部路徑引用

對所有引用 Docker 目錄的外部設定檔（VSCode settings、launch.json 等），批次更新路徑：

- `D:\\來源目錄` → `D:\\目標目錄`（JSON 跳脫格式）
- `D:/來源目錄` → `D:/目標目錄`（正斜線格式）

使用 `Edit` 工具的 `replace_all` 進行替換。

---

### 步驟 5：從新位置重建並啟動

從新目錄執行 `docker compose up`，使用 `--build` 重建 image：

```bash
cd "[目標路徑]" && docker compose up -d --build
```

Docker Compose 的 project name 會根據目錄名改變（例：`docker` → `docker_dev`），
因此會產生新的 image 名稱（例：`docker_dev-php84` 取代 `docker-php84`）。

---

### 步驟 6：驗證容器正常運作

1. `docker ps` — 確認所有容器 Up
2. 對每個容器執行版本/功能檢查：
   - PHP 容器：`docker exec [name] php -v` + 確認擴充套件
   - DB 容器：確認可連線
   - 其他服務：確認 port 可存取
3. 確認 bind mount 的檔案可正確讀取

---

### 步驟 7：清理舊資源

1. 刪除舊目錄（若使用 cp 方式且使用者同意）
2. 清除舊的 Docker images（搬移後 project name 改變，舊 image 成為孤兒）

```bash
# 列出舊 image
docker images | grep "[舊project名稱]"

# 刪除舊 image
docker rmi [舊image名稱列表]
```

---

### 步驟 8：產出報告

```
✅ Docker 環境搬遷完成！

📊 統計：
  搬遷路徑：[來源] → [目標]
  容器數量：N 個（全部正常運行）
  更新設定檔：N 個
  清除舊 image：N 個（釋放 X GB）

📦 容器狀態：
  - container-1: ✅ Up (port xxxx)
  - container-2: ✅ Up (port xxxx)

📝 已更新的設定：
  - settings.json: N 處
  - launch.json: N 處

⚠️ 提醒：
  - Docker Compose project name 已從 [舊名] 改為 [新名]
  - 日後操作請從新目錄執行 docker compose 指令
```

---

## 輸出

- Docker 環境已搬遷至新位置並正常運行
- 所有外部設定檔路徑已更新
- 舊 image 已清理
- 搬遷報告

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| mv: Device or resource busy | 容器未停止，bind mount 鎖定檔案 | 確認 `docker compose down` 已完成 |
| 新容器啟動失敗 | .env 檔案未搬移 | 檢查 `.env` 是否存在於新目錄 |
| bind mount 路徑錯誤 | compose 中使用了絕對路徑 | 檢查 .env 和 docker-compose.yml 中的絕對路徑 |
| port already in use | 舊容器未完全移除 | `docker compose down` 或 `docker rm -f [container]` |
| 舊 image 無法刪除 | 有 container 仍在使用 | 先移除 container 再刪 image |

---

## 注意事項

- 搬移前必須先 `docker compose down`，否則 bind mount 會鎖定檔案
- Docker Compose project name 基於目錄名，搬移後 image 名稱會改變
- `.env` 是隱藏檔，務必確認有跟著搬移
- docker-compose.yml 中的相對路徑（`./config/`）搬移後自動生效，無需修改
- docker-compose.yml 中的絕對路徑（.env 變數引用的）需要逐一確認
- 若 Docker 目錄搬入 PROJECT_PATH 的掛載範圍內，Docker 設定檔會出現在容器的 /var/www/html 中（通常無害但需留意）
