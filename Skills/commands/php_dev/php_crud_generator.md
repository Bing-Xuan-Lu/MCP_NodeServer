# /php_crud_generator — PHP 後台 CRUD 模組產生器

## 🎯 你的角色與能力

你是專案的 PHP 後台開發 Agent。
你擁有 MCP 工具可以**直接操作專案目錄與資料庫**，不只是輸出程式碼，而是直接把檔案寫進專案。

---

## 🗂️ 專案目錄結構

Step 0 會自動偵測以下路徑（因專案而異）：

```
{ProjectFolder}/
├── {templateDir}/           ← Model + HTML 範本檔（Step 0d 偵測）
├── {modelDir}/              ← Model 類別存放位置
├── {adminDir}/{module}/     ← CRUD 頁面存放位置
├── config/                  ← 資料庫連線設定
└── layout/ or include/      ← header/footer
```

---

## 🔧 你擁有的 MCP 工具

| 工具 | 用途 |
|------|------|
| `get_db_schema` | 查詢單張資料表結構 |
| `get_db_schema_batch` | 一次取得多張表結構（多模組時優先使用） |
| `execute_sql` | 建立資料表、執行 DDL |
| `read_file` | 讀取單一檔案 |
| `read_files_batch` | 一次讀取多個範本檔（Step 3 優先使用） |
| `create_file` | 將產生的程式碼寫入專案目錄 |
| `apply_diff` | 修改既有檔案（局部替換）|
| `list_files` | 確認目錄結構與檔案是否存在 |
| `run_php_script` | 執行 PHP 驗證語法正確性 |
| `send_http_request` | 測試單一頁面回應 |
| `send_http_requests_batch` | 批次測試多個頁面（Step 7 驗證多個 CRUD 頁面） |
| `tail_log` | 查看 PHP error log 排查錯誤 |

---

## 📋 Schema 輸入格式

使用者提供以下任一格式，你都能處理：

### 格式 A：直接描述（最簡單）
```
資料表：tbl_product
說明：商品管理
欄位：name(商品名稱,VARCHAR100,必填,text顯示在列表)、price(價格,DECIMAL,必填,text)、status(狀態,TINYINT,select選項1啟用0停用顯示在列表)
```

### 格式 B：標準 Schema 定義
```
tableName: tbl_xxx
menuName: 模組中文說明
projectPath: {專案名稱}        ← 選填，指定寫入哪個專案目錄
uploadeName: 上傳資料夾        ← 選填
uploadsNumber: 0               ← 一筆資料幾張照片
type: 0                        ← 0=獨立模組, 1=子模組（有上層資料表）
  若 type=1：
    parentTableName: 上層資料表
    parentKeyName:   上層 key 欄位
    parentTitleName: 上層顯示欄位
    foreignName:     本表外來鍵欄位

欄位：
- db_col_name:      欄位英文名稱
  db_col_comments:  欄位說明（中文）
  db_col_datatype:  VARCHAR(100) / INT / DECIMAL / TEXT / DATETIME...
  db_col_not_null:  1=DB必填, 2=否
  html_show_in_edit: 1=出現在新增/編輯頁, 2=不出現
  html_show_in_list: 1=出現在列表頁, 2=不出現
  html_col_datatype: text/textarea/radio/checkbox/select/parents/password/time/html/file
  html_col_not_null: 1=頁面必填, 2=否
  html_col_options:  1:啟用,0:停用   （radio/checkbox/select 類型專用）
  parents_config:    table:資料表,key:key欄位,title:顯示欄位  （parents 類型專用）
```

### 格式 C：直接貼 SQL（最快）
```sql
CREATE TABLE tbl_product (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL COMMENT '商品名稱',
  price DECIMAL(10,2) COMMENT '價格',
  status TINYINT(1) DEFAULT 1 COMMENT '狀態'
);
```
→ 你會自動解析，推斷 html_col_datatype，列出確認清單請使用者確認

### 格式 D：查詢現有資料表（最懶）
```
幫我做 tbl_product 的後台模組
```
→ 你呼叫 `get_db_schema` 自動取得欄位，推斷設定後請使用者確認

---

## 🚀 執行流程（有 MCP 的完整流程）

收到 Schema 後，依序執行以下步驟：

### Step 0：確認專案環境（自動偵測）

**Step 0a — 專案路徑**

若使用者未指定路徑，依序探測：
1. 當前工作目錄是否為 PHP 專案（含 `config/` 或 `adminControl/`）
2. 掃描 basePath 下的子目錄
3. 若有多個符合，列出清單請使用者選擇

**Step 0b — AdminLTE 版本**

若使用者未指定版本，讀取後台 header 或現有模組頁面自動偵測：

| 特徵 | 版本 |
|------|------|
| `skin-blue` 或 `AdminLTE/2` | LTE2 |
| `AdminLTE/3` 或 v3 路徑 | LTE3 |
| `app-wrapper` 或 `AdminLTE/4` | LTE4 |
| 無法判斷 | 詢問使用者 |

**Step 0c — DB 連線方式**

讀取專案的 DB 連線類別（如 `db.class.php` 或 `config/database.php`）判斷驅動：

| 模式 | 偵測方式 | SQL 參數風格 |
|------|---------|-------------|
| ADOdb | 含 `adodb.inc.php` / `NewADOConnection` | 位置參數 `?` |
| PDO 包裝 | 含 `new PDO(` + 自訂 wrapper | 依 wrapper API 決定 |
| 原生 PDO | 直接 `$pdo->prepare()` | 命名 `:col` 或 `?` |
| MySQLi | 含 `mysqli_` | `?` + `bind_param()` |

**Step 0d — 範本目錄確認**

探測專案中是否有 Model 範本和 HTML 範本檔（目錄名因專案而異，如 `templates/`、`sample/`、`sample_html/` 等）。
若找到 PHP 8 版本範本目錄，優先使用。

偵測完成後告知：`✅ 專案：{PROJECT_ROOT}，LTE 版本：{LTE_VERSION}，DB 驅動：{DRIVER}`

### Step 1：確認目錄結構
```
list_files → 確認 Model 範本 + HTML 範本檔存在
→ 若缺少，告知使用者需要先建立哪些範本
```

### Step 2：取得或確認 Schema
```
若使用者提供資料表名稱但沒給欄位
→ get_db_schema(tableName)  取得現有 DB 結構

若使用者貼 SQL 或描述
→ 解析後列出欄位設定清單，請使用者確認：
  ✅ name (VARCHAR100) → text，顯示在表單✅，顯示在列表✅，必填✅
  ✅ price (DECIMAL) → text，顯示在表單✅，顯示在列表✅，必填✅
  ✅ status (TINYINT) → select(1:啟用,0:停用)，顯示在表單✅，顯示在列表✅
  確認無誤後繼續？
```

### Step 3：讀取所有範本檔（一次批次讀取）
```
read_files_batch([
  "skills/templates/class.tpl.php",
  "skills/templates/add.tpl.php",
  "skills/templates/add_.tpl.php",
  "skills/templates/update.tpl.php",
  "skills/templates/update_.tpl.php",
  "skills/templates/del.tpl.php",
  "skills/templates/list.tpl.php"
])
```

### Step 4：產生程式碼
根據範本 + Schema 進行替換與動態區塊生成：
- `{{TABLE_NAME}}` → 實際資料表名稱
- `{{CLASS_NAME}}` → 轉為 PascalCase 類別名（依表名規則轉換，如去掉前綴）
- `{{MODULE_DIR}}` → 目錄名（依專案命名規則轉換）
- `{{MENU_NAME}}` → 中文說明
- `{{FIELDS_INSERT}}` → 依 html_show_in_edit=1 的欄位產生 INSERT 欄位列表
- `{{FORM_FIELDS}}` → 依欄位設定產生表單 HTML
- `{{LIST_COLUMNS}}` → 依 html_show_in_list=1 的欄位產生 table th/td

### Step 5：寫入專案目錄
```
create_file("{projectPath}/{modelDir}/{className}.class.php", ...)
create_file("{projectPath}/{adminDir}/{module}/add.php", ...)
create_file("{projectPath}/{adminDir}/{module}/add_.php", ...)
create_file("{projectPath}/{adminDir}/{module}/update.php", ...)
create_file("{projectPath}/{adminDir}/{module}/update_.php", ...)
create_file("{projectPath}/{adminDir}/{module}/del.php", ...)
create_file("{projectPath}/{adminDir}/{module}/list.php", ...)
```

### Step 6：語法驗證
```
run_php_script("{projectPath}/{modelDir}/{className}.class.php")
→ 確認無 PHP 語法錯誤（CLI 模式解析）
```

### Step 7：回報結果
```
✅ 完成！已產生以下檔案：
├── {modelDir}/{className}.class.php
├── {adminDir}/{module}/add.php
├── {adminDir}/{module}/add_.php
├── {adminDir}/{module}/update.php
├── {adminDir}/{module}/update_.php
├── {adminDir}/{module}/del.php
└── {adminDir}/{module}/list.php

⚡ 語法驗證：全部通過
🔗 測試列表頁：http://localhost/project/product/list.php
```

---

## 🎨 頁面欄位類型處理規則

### 產生表單 HTML 的對應

```
text     → <input type="text" name="{col}" value="<?= h($row['{col}'] ?? '') ?>" class="form-control">
textarea → <textarea name="{col}" class="form-control"><?= h($row['{col}'] ?? '') ?></textarea>
time     → <input type="date" name="{col}" value="<?= h($row['{col}'] ?? '') ?>" class="form-control">
password → <input type="password" name="{col}" class="form-control" placeholder="留空則不修改">
number   → <input type="number" name="{col}" value="<?= h($row['{col}'] ?? '') ?>" class="form-control">

select   → <select name="{col}" class="form-control">
             <?php foreach([1=>'啟用',0=>'停用'] as $v=>$l): ?>
             <option value="<?= $v ?>" <?= ($row['{col}']??'')==$v?'selected':'' ?>><?= $l ?></option>
             <?php endforeach; ?>
           </select>

radio    → <?php foreach([1=>'啟用',0=>'停用'] as $v=>$l): ?>
           <div class="icheck-primary d-inline mr-2">
             <input type="radio" name="{col}" id="{col}_<?= $v ?>" value="<?= $v ?>"
               <?= ($row['{col}']??'')==$v?'checked':'' ?>>
             <label for="{col}_<?= $v ?>"><?= $l ?></label>
           </div>
           <?php endforeach; ?>

checkbox → (同 radio 但 type=checkbox，name="{col}[]"，儲存為逗號分隔)

parents  → <select name="{col}" class="form-control">
             <?php foreach($parentOptions as $opt): ?>
             <option value="<?= $opt['id'] ?>" <?= ($row['{col}']??'')==$opt['id']?'selected':'' ?>>
               <?= h($opt['title']) ?></option>
             <?php endforeach; ?>
           </select>
           ← list.php 頂部加：$parentOptions = $pdo->query("SELECT id, {title} FROM {parentTable}")->fetchAll();

html     → <textarea name="{col}" id="editor_{col}" class="form-control"><?= h($row['{col}']??'') ?></textarea>
           <script>CKEDITOR.replace('editor_{col}');</script>

file     → <input type="file" name="{col}" class="form-control-file">
           <?php if(!empty($row['{col}'])): ?>
           <div class="mt-1"><small>目前：<a href="/uploads/{uploadeName}/<?= $row['{col}'] ?>" target="_blank"><?= h($row['{col}']) ?></a></small></div>
           <?php endif; ?>
```

### 列表頁顯示轉換

```
select/radio → 顯示 label（用選項陣列轉換，不顯示原始數字）
parents      → JOIN 上層資料表取 title 欄位
file         → <img src="/uploads/.../<?= $row['col'] ?>" style="max-height:40px"> 或 連結
html         → strip_tags() 截斷顯示前 50 字
```

---

## 🔄 補充功能指令

### 修改現有模組（apply_diff）
```
使用者：「在 product/list.php 的搜尋加上狀態篩選下拉」
你：read_file → 找到搜尋區塊 → apply_diff 精準插入
```

### 查 Log 排查錯誤
```
使用者：「add_.php 存檔後一直轉白頁」
你：tail_log("php_error.log") → 找到錯誤 → read_file(add_.php) → 修正 → apply_diff
```

### 測試新頁面
```
send_http_request("http://localhost/{project}/{module}/list.php", "GET")
→ 確認 HTTP 200、回應包含預期 HTML 結構
```

---

## ⚙️ 程式碼共用規範（給範本製作參考）

範本檔使用以下 Placeholder，你在 Step 4 時進行替換：

| Placeholder | 說明 | 範例 |
|-------------|------|------|
| `{{TABLE_NAME}}` | 完整資料表名稱 | `product` |
| `{{CLASS_NAME}}` | PascalCase 類別名 | `Product` |
| `{{MODULE_DIR}}` | 目錄名 | `product` |
| `{{MENU_NAME}}` | 中文模組說明 | `商品管理` |
| `{{DB_NOT_NULL_FIELDS}}` | INSERT 欄位 | `name, price, status` |
| `{{PDO_PLACEHOLDERS}}` | PDO ? 佔位 | `?, ?, ?` |
| `{{FORM_FIELDS_HTML}}` | 表單欄位區塊 | （動態產生）|
| `{{LIST_TH}}` | 表格表頭 | `<th>商品名稱</th>...` |
| `{{LIST_TD}}` | 表格資料列 | `<td><?= h($row['name']) ?></td>...` |
| `{{SEARCH_FIELD}}` | 搜尋欄位名 | `name` |
| `{{PARENT_FK}}` | 外來鍵欄位 | `project_id`（type=1 時）|

---

## ✅ 完成後固定提醒

```
✅ 7 個檔案已全部寫入！

📌 請確認：
  1. config/db.php 連線設定
  2. layout/header.php、footer.php 的 include 路徑
  3. 若有 file 欄位：uploads/{uploadeName}/ 目錄需有寫入權限 (chmod 775)
  4. 若有 html 欄位：確認 CKEditor 已在 header 引入
  5. 子模組（type=1）：在上層 list.php 補上「查看子資料」連結

🧪 可用以下指令驗證：
  → send_http_request 測試 list.php 回應
  → tail_log 監控 PHP 錯誤
```

---

## 📁 範本檔準備清單（使用前確認）

第一次使用前，確認專案中有以下範本：

- **Model 範本**：一個 `.class.php` 或 `.tpl.php`（含 getOne/getList/insert/update/delete）
- **HTML 範本**：add / add_ / update / update_ / del / list（至少 6 個，部分專案有 change_order）

範本目錄位置因專案而異（如 `templates/`、`sample/`、`sample_html/`），Step 0d 會自動偵測。

若範本檔不存在，先詢問使用者 AdminLTE 版本和 layout include 方式，再用 `create_file` 建立預設範本。

---

## 🏗️ AdminLTE 版本差異

產生 HTML 時，依 Step 0b 偵測到的版本使用不同的 CSS class 和結構：

### 卡片 / Box 元件

| 元素 | LTE2 | LTE3 / LTE4 |
|------|------|-------------|
| 卡片容器 | `<div class="box">` | `<div class="card">` |
| 有色卡片 | `box box-primary` | `card card-primary` |
| 標題區 | `box-header with-border` | `card-header` |
| 標題 | `<h3 class="box-title">` | `<h3 class="card-title">` |
| 內容區 | `box-body` | `card-body` |
| 底部 | `box-footer` | `card-footer` |

### Grid / 表單

| 元素 | LTE2 | LTE3 / LTE4 |
|------|------|-------------|
| 12 欄 | `col-xs-12` | `col-12` |
| 表單群組 | `form-group` | `form-group` (LTE3) / `mb-3` (LTE4) |
| 取消按鈕 | `btn btn-default` | `btn btn-default` (LTE3) / `btn btn-secondary` (LTE4) |

### 資料迭代方式

| 元素 | LTE2（cursor） | LTE3 / LTE4（array） |
|------|---------------|---------------------|
| 迭代 | `while ($rs = $db->getNext())` | `foreach ($datas as $value):` |
| 欄位存取 | `$rs->field`（stdClass） | `$value['field']`（array） |
| 編輯頁 | `$data->field` | `$data['field']` |

---

## ⚙️ PHP 8.4 注意事項

產生的程式碼必須符合 PHP 8.4：

- `public function __construct(&$db)` 非 PHP4 風格
- `catch (\Throwable $e)` 非 `catch (Exception $e)`
- `$_GET['key'] ?? ''` 防 undefined key
- `implode(",", $array)` 非 `implode($array, ",")`
- `count($var ?? [])` 非 `count($var)`
- `is_string($value) ? addslashes($value) : $value`
