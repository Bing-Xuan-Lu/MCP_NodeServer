# Chrome 書籤整理 — 範例 Prompt 集

搭配 **Project Migration Assistant Pro** MCP Server 使用，讓 AI 自動整理你的 Chrome 書籤。

> 使用前請先關閉 Chrome，避免書籤檔案鎖定衝突。

---

## 一、完整三階段整理 SOP (推薦)

適合第一次大整理，從探索到分類到收尾一次完成。

```
請幫我整理 Chrome 書籤，目標資料夾是「書籤列」。
依照以下三階段 SOP 執行：

【Phase 1 — 探索】
1. 用 get_bookmark_structure 取得完整書籤樹狀結構
2. 用 get_folder_contents 讀取目標資料夾內的所有散落書籤
3. 根據書籤標題自動辨識主題，歸納出分類清單
4. 如果發現 3~5 個新主題，用 create_bookmark_folder 建立新資料夾

【Phase 2 — 分類】
第一輪「標題秒殺」：
- 根據標題關鍵字，用 move_specific_bookmarks 批次搬移到對應資料夾
- 每次最多 20 個，需分批執行

第二輪「深度判讀」：
- 對標題不明確的書籤，用 fetch_page_summary 讀取網頁摘要
- 根據摘要內容決定分類，無法判斷的放入「其他」資料夾

【Phase 3 — 收尾】
1. 用 sort_bookmarks 對每個資料夾排序
2. 用 remove_duplicates 移除重複書籤
3. 用 scan_and_clean_bookmarks 掃描無效連結 (checkLimit: 500)
4. 輸出整理報告（移動數量、新建資料夾、刪除數量）

整理過程中：
- 如果有 MCP 工具呼叫失敗，請停下來告訴我
- 不確定分類的書籤，先放「其他」資料夾，不要猜測
```

---

## 二、單一資料夾深度整理

針對某個已有大量書籤的資料夾做子分類。

```
請幫我整理「書籤列 > 教學/破解網站」資料夾：

1. 用 get_folder_contents 列出所有書籤
2. 根據標題分析，建立合理的子資料夾（例如：軟體/破解、文書教學、線上工具）
3. 用 move_specific_bookmarks 批次搬移到對應子資料夾
4. 明顯放錯位置的書籤（例如 SQL 教學），移回正確的根資料夾
5. 無法分類的放入「其他」
6. 完成後排序，並輸出整理報告
```

---

## 三、書籤健康檢查

只做清理，不動分類結構。

```
請幫我做書籤健康檢查：

1. 用 remove_duplicates 移除所有重複書籤
2. 用 scan_and_clean_bookmarks 掃描無效連結
   - checkLimit 設為 500
   - autoRemove 設為 true（自動刪除無效連結）
3. 完成後告訴我：移除了多少重複、多少無效連結
```

---

## 四、書籤置頂排序

把常用書籤固定在書籤列最前面。

```
請把以下書籤固定在「書籤列」最前面（在所有資料夾之前）：
Google、Facebook、Instagram、YouTube

其他散落的書籤都分類到資料夾內，無法分類的放入「其他」資料夾。
```

> 注意：置頂功能需要透過腳本直接修改 Bookmarks JSON 檔案，MCP 的 sort_bookmarks 預設是資料夾置頂。

---

## 五、重複資料夾合併

發現有多個名稱相似的資料夾時使用。

```
請檢查「書籤列」底下是否有重複或名稱相似的資料夾（例如 "SQL" 和 "【SQL】"），
如果有的話：
1. 用 move_bookmarks 把內容合併到主要資料夾
2. 用 delete_bookmark_folder 刪除空的重複資料夾
3. 告訴我合併了哪些資料夾
```

---

## 六、資料夾統一命名

批次重新命名資料夾，統一格式。

```
請把「書籤列 > 改CODE之路」底下所有沒有【】符號的資料夾都加上【】。
例如：SQL → 【SQL】、Git → 【GIT】

用 rename_bookmark_folder 逐一重新命名，完成後排序。
```

---

## 七、匯出備份

將整理好的書籤匯出為可匯入的格式。

```
請用 export_bookmarks_to_html 把目前的書籤匯出為 HTML 檔案，
檔名設為 bookmarks_backup_2025.html。
```

---

## 實用技巧

### 分批搬移
`move_specific_bookmarks` 每次最多 20 個 ID，大量書籤需要這樣分批：
```
第一批：move_specific_bookmarks (ids 1~20) → 目標資料夾
第二批：move_specific_bookmarks (ids 21~40) → 目標資料夾
...
```

### 關鍵字搬移
不想一個個找 ID？用 `move_bookmarks` 的關鍵字功能：
```
把「書籤列 > 未分類」裡面包含 "docker" 的書籤搬到「書籤列 > DevOps」
→ move_bookmarks(sourcePath, targetPath, keyword: "docker")
```

### 內網書籤
`scan_and_clean_bookmarks` 會自動跳過內網 IP (192.168.x / 10.x / localhost)，不用擔心誤刪公司內部系統的書籤。
