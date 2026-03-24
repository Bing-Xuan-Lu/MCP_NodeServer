# PHP 7.x → 8.4 升級規則參考

> 本檔由 `/php_upgrade` 主 Skill 引用。每條規則含 before/after 範例。

---

### Rule 1：移除 `get_magic_quotes_gpc()`

PHP 7.4 廢棄、PHP 8.0 移除。

```php
// ❌ 修改前
if (!get_magic_quotes_gpc()) {
    $value = addslashes($value);
}

// ✅ 修改後（直接保留 addslashes，移除整個 if 包裝）
$value = addslashes($value);
```

**變體處理：**
- `if(get_magic_quotes_gpc())` → 移除整個 if/else 區塊，只保留 else 內容
- `function_exists('get_magic_quotes_gpc')` → 移除整個判斷區塊，保留 addslashes 邏輯
- 包含 `stripslashes` 的分支也一併移除

---

### Rule 2：PHP4 建構子 → `__construct`

PHP 8.0 完全移除 PHP4 風格建構子。

```php
// ❌ 修改前
class Editor {
    function Editor(&$db) {
        $this->db = $db;
    }
}

// ✅ 修改後
class Editor {
    function __construct(&$db) {
        $this->db = $db;
    }
}
```

**判斷方式：** 方法名與類別名相同（不區分大小寫），且沒有已存在的 `__construct`。

---

### Rule 3：`var` → 屬性可見性修飾詞

PHP4 的 `var` 等同 `public`，但在嚴格模式下應明確宣告。

```php
// ❌ 修改前
var $db;
var $table = "tbl_data";

// ✅ 修改後
public $db;
public $table = "tbl_data";
```

---

### Rule 4：移除 `session_register()` 相關程式碼

PHP 7.0 已移除。通常包在 `function_exists` 裡。

```php
// ❌ 修改前
if (function_exists('session_register')) {
    session_register('user_id');
}

// ✅ 修改後（整個區塊移除，因為現代 PHP 用 $_SESSION）
// 移除整個 if 區塊
```

---

### Rule 5：花括號陣列/屬性存取 → 方括號或箭頭

PHP 8.0 移除花括號存取語法。

```php
// ❌ 修改前
$str{0}
$rs->{'field_name'}
$arr{'key'}

// ✅ 修改後
$str[0]
$rs->field_name
$arr['key']
```

**注意：** `$obj->{'dynamic_'.$var}` → `$obj->{'dynamic_'.$var}` 保持不變（動態屬性需保留）。
只改固定字串的花括號存取。

---

### Rule 6：`Array()` → `[]`

非語法錯誤，但統一為現代寫法提高可讀性。

```php
// ❌ 修改前
$data = Array();
$list = Array("a", "b", "c");

// ✅ 修改後
$data = [];
$list = ["a", "b", "c"];
```

**注意：** 大小寫不敏感替換 `Array(` → `[`，對應的 `)` → `]`。
巢狀 Array() 需從最內層開始替換。

---

### Rule 7：移除 PHP 結尾標籤 `?>`

PSR-12 規範：純 PHP 檔案應省略結尾 `?>`。

```php
// ❌ 修改前
}
?>

// ✅ 修改後
}
```

**僅適用於**檔案最末尾的 `?>`，不要移除混合 HTML 中的 `?>`。

---

### Rule 8：`類別名::method()` 靜態呼叫修正

非靜態方法用 `ClassName::method()` 呼叫在 PHP 8.0+ 會產生 Deprecation。

```php
// ❌ 修改前（在類別內部）
main::getClientIp()

// ✅ 修改後
self::getClientIp()    // 同類別內呼叫
// 或
$this->getClientIp()   // 若方法非 static
```

**判斷邏輯：**
- 在類別內部呼叫自己的類別名 → 改 `self::` 或 `$this->`
- 確認方法是否有 `static` 修飾詞來決定用 `self::` 還是 `$this->`

---

### Rule 9：`each()` 函式替換

PHP 8.0 移除。

```php
// ❌ 修改前
while (list($key, $val) = each($arr)) { ... }

// ✅ 修改後
foreach ($arr as $key => $val) { ... }
```

---

### Rule 10：`create_function()` → 匿名函式

PHP 8.0 移除。

```php
// ❌ 修改前
$func = create_function('$a,$b', 'return $a + $b;');

// ✅ 修改後
$func = function($a, $b) { return $a + $b; };
```

---

### Rule 11：`mysql_*` 函式 → `mysqli_*` 或 PDO

PHP 7.0 已移除。若專案已使用 PDO 或 mysqli，則移除殘留的 `mysql_*` 呼叫。

```php
// ❌ 修改前
mysql_real_escape_string($str)

// ✅ 修改後（依專案現有連線方式）
mysqli_real_escape_string($conn, $str)
// 或
$pdo->quote($str)
```

---

### Rule 12：`is_null()` 搭配已移除函式

移除呼叫已不存在函式的判斷。

---

### Rule 13：網站根路徑定義 — `WEB_ROOT` 安全配置

改善常數名有單引號，提高跨環境相容性與安全性。

```php
// ❌ 修改前（常數名缺引號）
define(WEB_ROOT, 'http://example.com/');
define(WEB_ROOT, 'http://localhost/myproject/');

// ✅ 修改後（加上引號）
define('WEB_ROOT', 'http://' . $_SERVER['HTTP_HOST'] . '/');
```

**說明：**
- 常數名必須用單引號包裹 `define('CONSTANT_NAME', ...)`（PHP 最佳實踐）

**檢測規則：**
- `define(WEB_ROOT,` → `define('WEB_ROOT',`

---

### Rule 14：裸鍵名陣列 `[key=>$val]` → `['key'=>$val]`

PHP 8.0 將未定義常數視為 Error（PHP 7 自動降級為字串 Notice）。

```php
// ❌ 修改前
$result = [price=>$price, subtotal=>$subprice, volume=>$v];

// ✅ 修改後
$result = ['price'=>$price, 'subtotal'=>$subprice, 'volume'=>$v];
```

**陷阱：** 若被 `catch(Throwable)` 包裹，函式靜默回傳 null，API 回傳 `{"result":"1","data":null}` — 看似成功但資料為空。

**掃描命令：**
```bash
grep -rnP '\[\w+=>' --include='*.php' {TARGET_DIR} | grep -v "'\w+=>"
```
