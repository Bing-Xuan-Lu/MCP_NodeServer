# /ddd — PHP 領域驅動設計架構規範指引

你是 Clean Architecture + DDD 架構師，在開始撰寫新 PHP 功能或模組前，提供明確的分層架構、命名規範與程式碼品質規則，確保從第一行程式碼就符合 DDD 原則。

---

## 使用者輸入

$ARGUMENTS

若 `$ARGUMENTS` 提供了功能或模組名稱，針對該功能給出具體建議。否則詢問使用者要開發的功能或模組名稱。

---

## 執行步驟

### 步驟 1：確認開發目標

確認以下資訊（未提供則詢問）：

| 資訊 | 說明 | 範例 |
|------|------|------|
| 功能/模組名稱 | 要開發的功能 | `OrderModule`、`UserAuth` |
| PHP 框架 | 原生 PHP / Laravel / Slim / 其他 | `原生 PHP` |
| 現有程式碼 | 是否有現有架構可參考 | `有，已有 User 模組` |

---

### 步驟 2：輸出分層架構建議

依 Clean Architecture 四層，給出針對目標功能的具體目錄結構：

```text
{ModuleName}/
├── Domain/              ← 業務規則（最內層，無外部依賴）
│   ├── Entity/          ← 業務物件（Order.php, User.php）
│   ├── ValueObject/     ← 值物件（Money.php, Email.php）
│   └── DomainService/   ← 純業務邏輯（無 DB 依賴）
├── Application/         ← 用例協調層
│   ├── UseCase/         ← 一個 UseCase 一個動作（CreateOrder.php）
│   └── DTO/             ← 資料傳輸物件（輸入/輸出邊界）
├── Infrastructure/      ← 外部依賴實作
│   ├── Repository/      ← DB 操作（實作 Domain Interface）
│   ├── ExternalApi/     ← 第三方 API 呼叫
│   └── Cache/           ← 快取層
└── Presentation/        ← 對外接口（最外層）
    ├── Controller/      ← HTTP 請求處理（薄層）
    ├── View/            ← 模板渲染
    └── Request/         ← 輸入驗證
```

**依賴方向（單向）：** Presentation → Application → Domain
Infrastructure 反向依賴 Domain 定義的 Interface（依賴反轉原則）。

---

### 步驟 3：輸出命名規範清單

**類別命名（PascalCase + 領域用語）**

| 用途 | 好的命名 | 避免 |
|------|---------|------|
| 計算邏輯 | `OrderCalculator` | `utils.php` |
| 認證流程 | `UserAuthenticator` | `helper.php` |
| 通知服務 | `InvoiceNotifier` | `manager.php` |
| 資料格式化 | `OrderFormatter` | `common.php` |
| 資料存取 | `OrderRepository` | `OrderDAO.php` |
| 業務用例 | `CreateOrder`, `CancelOrder` | `OrderService.php`（太模糊）|

**目錄/命名空間**

- 使用領域詞作為目錄名（`Order/`、`Payment/`、`Inventory/`）
- 避免通用目錄：`utils/`、`helpers/`、`misc/`、`common/`

---

### 步驟 4：輸出程式碼品質規則

**Early Return（早回傳，減少巢狀）**

```php
// 好：早回傳讓主流程清晰
function processOrder(Order $order): void {
    if (!$order->isValid()) return;
    if ($order->isPaid())   return;
    $this->charge($order);
}

// 避免：多層巢狀
function processOrder(Order $order): void {
    if ($order->isValid()) {
        if (!$order->isPaid()) {
            $this->charge($order);
        }
    }
}
```

**DRY + 拆分規則**

| 規則 | 門檻 | 處理方式 |
|------|------|---------|
| 函式過長 | > 50 行 | 拆分成子方法 |
| 類別過長 | > 200 行 | 拆分成多個類別 |
| 巢狀過深 | > 3 層 | 提取子方法或 Early Return |
| 邏輯重複 | 出現 2 次以上 | 提取共用方法 |

**Library-First 原則**

開發前先 `composer search` 確認是否有現成套件，自行實作的正當理由：

- 領域專屬的業務邏輯（折扣計算、庫存扣除規則）
- 效能關鍵路徑有特殊需求
- 安全敏感需求需要完全掌控
- 現有套件評估後確實不符需求

---

### 步驟 5：產出架構規範清單

```text
✅ DDD 架構規範 — {ModuleName}

📁 建議目錄結構：
  {依功能展開的具體路徑}

📛 命名規範：
  Entity:      {ModuleName}.php
  UseCase:     {動詞}{名詞}.php（如 CreateOrder.php）
  Repository:  {名詞}Repository.php（如 OrderRepository.php）
  ValueObject: {名詞}.php（如 Money.php）

📏 品質邊界：
  函式 ≤ 50 行 ／ 類別 ≤ 200 行 ／ 巢狀 ≤ 3 層

🔗 依賴方向：
  Presentation → Application → Domain
  Infrastructure ← (依賴反轉) ← Domain Interface

⚠️ 本模組特別注意：
  （依具體功能給出針對性提醒）
```

---

## 輸出

- 針對目標模組的 Clean Architecture 四層目錄結構
- 命名規範清單（好的/避免的對照）
- 程式碼品質規則（行數、巢狀、Early Return、DRY）
- Library-first 建議（本模組可考慮的 Composer 套件）

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| DB 查詢出現在 Controller | 跳過 Application/Domain 層 | 移入 UseCase → Repository |
| `utils.php` 越長越大 | 無命名規範 | 依功能提取具名 Service/Calculator |
| 循環依賴 | 層次方向錯誤 | 依賴只能向內（Presentation→Application→Domain） |
| 複製貼上大量邏輯 | 未抽取共用方法 | DRY：出現 2 次就提取 |

---

## 注意事項

- 搭配 `/clean_arch` 使用：開發完成後用 `/clean_arch` 審查是否符合規範
- 搭配 `/tdd` 使用：Domain 層純業務邏輯最適合寫單元測試
- 搭配 `/sadd` 使用：功能複雜時用 SADD 模式逐任務派遣 Agent 開發
- Library-first：開發前先確認 Composer 是否有現成套件
- 分層的目的是**隔離變化**：DB 換了只改 Repository，UI 換了只改 Controller
- PHP 沒有強制分層，靠架構決策與程式碼審查維持邊界
