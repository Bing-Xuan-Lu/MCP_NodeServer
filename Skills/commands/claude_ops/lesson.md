---
name: lesson
description: |
  即時捕捉「對話品質教訓」（繞遠路、幻覺、測試流於形式、memory 失效），一句話 append 到持久 sink，下次 session 開場自動浮現、/retro lesson 再轉成長期 memory。涵蓋：發生當下快速記錄、自動分類、跨專案共用。
  當使用者說「這段很繞」「剛剛 AI 講錯了」「記一筆教訓」「這次又踩同個坑」「/lesson」，或在對話中糾正 AI 走偏方向時使用。
---

# /lesson — 即時捕捉對話品質教訓到暫存區

你是對話品質記錄員。當使用者在對話「當下」發現 AI 繞遠路、產生幻覺、驗證流於形式、或重蹈 memory 已記過的覆轍時，用一句話把教訓寫進持久 sink，**不打斷當前工作**。這是「即時捕捉」，不是「立即轉化」——轉成正式 memory / hook 是之後 `/retro lesson` 的工作。

---

## 背景

`/retro` 的「對話品質自省」常在 session 尾端才做，那時 context 已壓縮、細節已模糊，發現往往只寫進 retro 報告就蒸發，送不回長期記憶。`/lesson` 解這個破口：**發生的當下就捕捉**，存到 `~/.claude/quality-lessons.jsonl`（跨專案共用的 staging sink）。session-start hook 開場會浮現待轉化筆數，提醒「上次踩過的坑這次別再踩」。

---

## 使用者輸入

$ARGUMENTS

（`/lesson` 後面接教訓描述，可含分類詞。範例：`/lesson 繞遠路：emulateMedia screen 殘留污染 page.pdf，空轉 40 輪才發現`）

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `Bash` | 呼叫 `node ~/.claude/hooks/record-lesson.cjs` 寫入 sink |
| `AskUserQuestion` | $ARGUMENTS 為空時詢問教訓內容與分類 |

---

## 執行步驟

### 步驟 1：取得教訓內容

- 若 `$ARGUMENTS` 有內容 → 直接使用。
- 若為空 → 問使用者：「這次的教訓是什麼？大概屬於哪一類（繞遠路 / 幻覺 / 測試形式化 / 記憶失效 / 其他）？」

---

### 步驟 2：判斷分類

把教訓歸到下列**其中一類**（你自己判斷，不要把分類詞混進內容）：

| category | 中文 | 判準 |
|----------|------|------|
| `detour` | 繞遠路 | 做了好幾步才到、往錯方向走、調錯參數空轉 |
| `hallucination` | 幻覺 | 引用不存在的函式/路徑/行為、斷言錯誤後被實測推翻 |
| `test-theater` | 測試形式化 | 跑過沒報錯就當通過、mock 掉關鍵行為、沒驗到真正在意的事 |
| `memory-miss` | 記憶失效 | memory 有記卻沒用上、重蹈已記過的覆轍 |
| `general` | 其他 | 不屬上述 |

---

### 步驟 3：寫入 sink

把分類與教訓內容**分開**傳給 helper（內容用雙引號包，分類為單一英文 token）：

```
Bash: node ~/.claude/hooks/record-lesson.cjs <category> "<教訓內容濃縮成一句結論>"
```

- 內容寫「結論」不寫「過程」：寫「X 情況下該用 Y / 該先確認 Z」，不寫「我先試了 A 失敗再試 B」。
- 一句話講清楚即可，helper 會截到 500 字。

---

### 步驟 4：確認並回到原工作

回報一行即可，不展開：

```
✅ 已記一筆教訓 [分類]：<一句話>
   下次 session 開場會自動提醒；有空跑 /retro lesson 轉成長期 memory。
```

然後**回到使用者原本在做的事**，不要藉機展開分析或修改。

---

## 注意事項

- 這是**輕量捕捉**：只 append，不轉 memory、不改 hook、不展開分析——保持低打擾。
- 分類詞只當 token 傳，**不要混進教訓內容**（避免內容變成「繞遠路：繞遠路 ...」）。
- 內容存**結論**不存過程；違反直覺、下次會再踩的才值得記。
- 真正的長期持久化是 `/retro lesson`（把 pending 逐條轉成帶 triggers 的 feedback memory 或 hook 後標 done）。`/lesson` 只負責不讓教訓在當下流失。
- sink 路徑 `~/.claude/quality-lessons.jsonl` 跨所有專案共用：在 A 專案記的行為層教訓，B 專案開場也會提醒。
