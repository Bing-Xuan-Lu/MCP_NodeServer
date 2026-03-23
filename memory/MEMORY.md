# MCP_NodeServer 專案 Memory

## 記憶索引

### User
| 檔案 | 說明 |
| --- | --- |
| [user/user_profile.md](user/user_profile.md) | 使用者角色、技術背景、溝通偏好 |

### Project
| 檔案 | 說明 |
| --- | --- |
| [project/project_mcp_server.md](project/project_mcp_server.md) | 專案基本資訊與路徑設定 |
| [project/decision_architecture.md](project/decision_architecture.md) | 架構決策記錄：batch 工具、RAG 選用、_internal 隔離、basePath、單一 server、Skill 上限 |

### Reference
| 檔案 | 說明 |
| --- | --- |
| [reference/reference_dept_mapping.md](reference/reference_dept_mapping.md) | commands/ 子資料夾對應部門表 |
| [reference/reference_live_server.md](reference/reference_live_server.md) | 本機開發用 VS Code Live Server，port 5500 |

### Feedback — Playwright
| 檔案 | 說明 |
| --- | --- |
| [feedback/playwright/feedback_playwright_screenshot.md](feedback/playwright/feedback_playwright_screenshot.md) | 截圖存 screenshot/ 不放根目錄 |
| [feedback/playwright/feedback_playwright_ops.md](feedback/playwright/feedback_playwright_ops.md) | 快取清除、禁平行 Agent、卡住停止、禁 taskkill、動態連結展開、Background Agent 必須預授權所有 browser_* 工具 |

### Feedback — Workflow
| 檔案 | 說明 |
| --- | --- |
| [feedback/workflow/feedback_skill_workflow.md](feedback/workflow/feedback_skill_workflow.md) | Skill 建立、修改、部署流程與 dashboard 更新規則 |
| [feedback/workflow/feedback_md_linting.md](feedback/workflow/feedback_md_linting.md) | MD lint pre-existing 警告批量修復，避免誤診 |

### Feedback — Tooling
| 檔案 | 說明 |
| --- | --- |
| [feedback/tooling/feedback_bat_encoding.md](feedback/tooling/feedback_bat_encoding.md) | Windows .bat 禁含中文，UTF-8 無 BOM 會損毀 ASCII |
| [feedback/tooling/feedback_docker_ops.md](feedback/tooling/feedback_docker_ops.md) | Docker image 版本必須鎖定，升版前查證持久化路徑 |
| [feedback/tooling/feedback_license_compliance.md](feedback/tooling/feedback_license_compliance.md) | 安裝第三方套件前確認授權合規，優先 MIT/Apache 2.0 |
| [feedback/tooling/feedback_http_request_session.md](feedback/tooling/feedback_http_request_session.md) | send_http_request 不回傳 Set-Cookie，登入後測試需用 Playwright |

### Feedback — QC
| 檔案 | 說明 |
| --- | --- |
| [feedback/qc/feedback_qc_methodology.md](feedback/qc/feedback_qc_methodology.md) | 規格書驅動測試、❓交叉驗證、孤兒清理、校稿單格式 |

### Feedback — General
| 檔案 | 說明 |
| --- | --- |
| [feedback/general/feedback_search_strategy.md](feedback/general/feedback_search_strategy.md) | 搜尋策略：3次找不到就問、文件缺失進系統確認、RAG vs Grep |

> `_private/` 資料夾：機敏記憶（.gitignore 排除，僅本機）
