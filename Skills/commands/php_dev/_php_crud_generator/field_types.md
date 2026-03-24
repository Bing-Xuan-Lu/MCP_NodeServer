# 欄位類型 HTML 產生規則

> 由 `/php_crud_generator` Step 4 讀取使用。
> 每種 `html_col_datatype` 對應的表單 HTML 和列表顯示轉換。

---

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
