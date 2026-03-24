# 設計稿比對報告範本

> 由 `/design_diff` 步驟 5 讀取使用。
> Placeholder 以 `{...}` 標記。

```markdown
# 設計稿比對報告

比對時間：{date}
設計稿來源：{設計稿路徑}
實作網址：{base_url}

---

## 比對總覽

| # | 頁面 | 設計稿 | 實際截圖 | OK | NG | 符合率 |
|---|------|--------|---------|:--:|:--:|:------:|
| 1 | 首頁 | homepage.png | impl_homepage.png | 8 | 3 | 73% |
| 2 | 商品列表 | product_list.png | impl_product_list.png | 10 | 1 | 91% |

---

## 逐頁面比對

### 1. {頁面名稱}

**設計稿**：`{design_file}`
**實際截圖**：`screenshots/{fe|be}/diff/{live_file}`

#### 版面結構
{4a 比對表}

#### 顏色
{4b 比對表}

#### 字體
{4c 比對表}

#### 間距
{4d 比對表}

#### 元件完整性
{4e 比對表}

#### NG 項目修正建議

| # | 問題 | 建議修正 | 影響檔案 |
|---|------|---------|---------|
| 1 | 主按鈕顏色不符 | `.btn-primary { background: #E74C3C; }` | css/style.css |
| 2 | 購物車缺少 badge | 加入 `.cart-badge` 元件 | include/header.php + css/style.css |

---

## 統計

| 項目 | 數量 |
|------|:----:|
| 比對頁面 | N |
| 總檢查項 | N |
| OK | N |
| NG | N |
| 整體符合率 | N% |

---

## 修正建議 Checklist

- [ ] {NG 項目 1}：{修正描述}
- [ ] {NG 項目 2}：{修正描述}
- [ ] ...

---

## 建議下一步

- 前端開發修正 NG 項目 → 修正 NG 項目
- /rwd_scan {url} → 響應式檢查（若有多斷點設計稿）
- /spec_screenshot_diff {module} → 對照規格書確認功能正確性
- /design_diff {path} → 修正後重新比對
```
