# /php_path_fix — 掃描並修正 PHP 專案中 Windows 混合斜線路徑問題

## 背景

PHP 在 Windows 開發環境下，`dirname()` 回傳反斜線 (`D:\Project\`)，而程式碼中的相對路徑用正斜線 (`uploads/file.xlsx`)。
兩者拼接後產生混合斜線路徑 (`D:\Project\PG/uploads/file.xlsx`)，導致 `file_exists()`、`readfile()`、`finfo_file()` 等函式可能失敗。
此問題在 Docker (Linux) 環境不會出現，只在 Windows 本機開發時觸發。

## 輸入

$ARGUMENTS

若未指定，掃描整個專案。可指定：
- 特定檔案：`download.php`
- 特定目錄：`adminControl/{module}/`
- 特定常數：`DOCUMENT_ROOT`

## 步驟

### 1. 識別路徑常數定義

搜尋 config.php 或全域設定檔，找出路徑常數的定義方式：

```
Grep pattern="define.*ROOT|define.*PATH|define.*DIR" glob="*.php"
```

常見問題模式：
```php
// ⚠️ dirname() 在 Windows 回傳反斜線，後面接正斜線
$root = dirname(dirname(__FILE__));      // D:\Project\MyApp
define("DOCUMENT_ROOT", $root . '/');    // D:\Project\MyApp/
```

### 2. 掃描路徑拼接點

搜尋所有使用路徑常數拼接相對路徑的位置：

```
Grep pattern="DOCUMENT_ROOT\s*\.\s*['\"]" glob="*.php"
Grep pattern="UPLOAD_ROOT\s*\.\s*['\"]" glob="*.php"
Grep pattern="WEB_ROOT\s*\.\s*['\"]" glob="*.php"
```

重點關注以下函式的參數（這些函式對斜線敏感）：
- `file_exists($path)` — 檢查檔案是否存在
- `readfile($path)` — 串流輸出檔案
- `move_uploaded_file($tmp, $dest)` — 上傳檔案搬移
- `unlink($path)` — 刪除檔案
- `is_dir($path)` / `mkdir($path)` — 目錄操作
- `finfo_file($finfo, $path)` — MIME 偵測
- `fopen()` / `file_get_contents()` — 讀取檔案

### 3. 判斷是否需要修正

**需要修正的情況**：
- 路徑常數來自 `dirname()` (Windows 產生反斜線) + 拼接正斜線相對路徑
- 拼接結果用於檔案系統操作函式

**不需修正的情況**：
- 路徑僅用於 URL 輸出（`<a href="...">`、`header("Location: ...")`）
- 路徑常數本身已做正規化處理
- 純 Linux 環境（Docker 內部）的程式碼

### 4. 修正方式

**方式 A — 在使用處正規化（推薦，最小修改）**：
```php
// 修正前：
$filePath = DOCUMENT_ROOT . 'uploads/module/' . $id . $ext;

// 修正後：
$filePath = str_replace(['/', '\\'], DIRECTORY_SEPARATOR, DOCUMENT_ROOT . 'uploads/module/' . $id . $ext);
```

**方式 B — 在常數定義處正規化（影響範圍大，需謹慎）**：
```php
// 修正前：
define("DOCUMENT_ROOT", $root . '/');

// 修正後：
define("DOCUMENT_ROOT", str_replace(['/', '\\'], DIRECTORY_SEPARATOR, $root . DIRECTORY_SEPARATOR));
```

> 方式 B 會影響所有使用該常數的檔案，需確認不會破壞 URL 拼接。
> 若常數同時用於檔案路徑和 URL，應拆分為兩個常數或只在使用處修正（方式 A）。

**方式 C — 搭配副檔名推算（修正舊資料相容問題）**：

當資料庫欄位（如 `SubName`）為空（舊系統遺留資料），從 `FileName` 推算：
```php
$subName = $row['SubName'] ?? '';
if (empty($subName) && !empty($row['FileName'])) {
    $ext = pathinfo($row['FileName'], PATHINFO_EXTENSION);
    if (!empty($ext)) {
        $subName = '.' . strtolower($ext);
    }
}
$filePath = str_replace(['/', '\\'], DIRECTORY_SEPARATOR, DOCUMENT_ROOT . 'uploads/module/' . $id . $subName);
```

### 5. 驗證修正

修正後，用以下方式驗證：

```php
// 臨時加入 debug 輸出確認路徑格式
echo $filePath; exit;
// 正確：D:\Project\MyApp\uploads\module\11.xlsx（Windows 全反斜線）
// 正確：/var/www/html/MyApp/uploads/module/11.xlsx（Linux 全正斜線）
// 錯誤：D:\Project\MyApp/uploads/module/11.xlsx（混合斜線）
```

或使用 MCP 工具測試：
```
send_http_request GET http://localhost:{port}/path/to/download.php?id={test_id}
→ 200 + 檔案內容 = 成功
→ 302 redirect to list.php = file_exists 失敗
```

## 輸出

```
📋 PHP 路徑斜線修正報告

🔍 掃描範圍：{掃描的目錄或檔案}

| # | 檔案 | 行號 | 問題 | 修正方式 |
|---|------|------|------|---------|
| 1 | download.php:31 | DOCUMENT_ROOT + 相對路徑混合斜線 | str_replace 正規化 |
| 2 | add_.php:45 | move_uploaded_file 目標路徑混合斜線 | str_replace 正規化 |

✅ 已修正 {N} 處
⚠️ 需人工確認 {M} 處（路徑同時用於 URL 和檔案系統）
```

## 注意事項

- `DIRECTORY_SEPARATOR` 在 Windows = `\`，Linux = `/`，確保跨平台相容
- 不要修改 URL 相關的路徑（`WEB_ROOT`、`<a href>`、`header("Location")`）
- 若專案同時有 Windows 本機開發 + Docker 部署，修正方式 A（使用處正規化）最安全
- `realpath()` 也能正規化路徑，但檔案不存在時回傳 `false`，不適合用在新建檔案的場景
