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
| [project/project_deploy_pipeline.md](project/project_deploy_pipeline.md) | 部署流水線架構：remote_diff → sftp → DB migration → smoke test |

### Reference
| 檔案 | 說明 |
| --- | --- |
| [reference/reference_dept_mapping.md](reference/reference_dept_mapping.md) | commands/ 子資料夾對應部門表 |
| [reference/reference_live_server.md](reference/reference_live_server.md) | 本機開發用 VS Code Live Server，port 5500 |
| [reference/reference_known_issues.md](reference/reference_known_issues.md) | 已知問題：Playwright session、MCP 工具名參照、Skill 資訊洩漏 |
| [reference/reference_playwright_config.md](reference/reference_playwright_config.md) | Playwright --user-data-dir 持久化登入 session 設定 |
| [reference/reference_notion.md](reference/reference_notion.md) | Notion MCP 串接設定、Internal Integration 限制、筆記頁面用法 |
| [reference/reference_playwright_target_closed.md](reference/reference_playwright_target_closed.md) | Playwright Target page closed 復原步驟（browser_close → re-navigate） |

### Feedback — Playwright
| 檔案 | 說明 |
| --- | --- |
| [feedback/playwright/feedback_playwright_screenshot.md](feedback/playwright/feedback_playwright_screenshot.md) | 截圖存 screenshot/ 不放根目錄 |
| [feedback/playwright/feedback_playwright_ops.md](feedback/playwright/feedback_playwright_ops.md) | 快取清除、禁平行 Agent、卡住停止、禁 taskkill、動態連結展開、Background Agent 必須預授權所有 browser_* 工具 |
| [feedback/playwright/feedback_popup_screenshot.md](feedback/playwright/feedback_popup_screenshot.md) | 截 popup 用 browser_interact screenshot + hide_selectors 隱藏浮動客服/chat widget |

### Feedback — Deploy
| 檔案 | 說明 |
| --- | --- |
| [feedback/deploy/feedback_sftp_config_protect.md](feedback/deploy/feedback_sftp_config_protect.md) | SFTP 部署禁覆蓋環境設定檔（DB 連線、.env） |

### Feedback — Workflow
| 檔案 | 說明 |
| --- | --- |
| [feedback/workflow/feedback_skill_workflow.md](feedback/workflow/feedback_skill_workflow.md) | Skill 建立、修改、部署流程與 dashboard 更新規則 |
| [feedback/workflow/feedback_md_linting.md](feedback/workflow/feedback_md_linting.md) | MD lint pre-existing 警告批量修復，避免誤診 |
| [feedback/workflow/feedback_deploy_script_sync.md](feedback/workflow/feedback_deploy_script_sync.md) | 改 .bat 後必須同步更新 .sh（排除條件、目標目錄、說明訊息） |
| [feedback/workflow/feedback_skill_frontmatter.md](feedback/workflow/feedback_skill_frontmatter.md) | Skill frontmatter token 節省規則：何時加、description 只寫觸發詞一行 |
| [feedback/workflow/feedback_batch_replace.md](feedback/workflow/feedback_batch_replace.md) | 多檔相同替換用 sed/node 批次處理，不逐一 Edit |
| [feedback/workflow/feedback_ast_tools_priority.md](feedback/workflow/feedback_ast_tools_priority.md) | PHP 函式查詢必須用 AST 工具，禁 Grep 散搜（Hook L2.4 強制） |
| [feedback/workflow/feedback_popup_style_reuse.md](feedback/workflow/feedback_popup_style_reuse.md) | 改 popup/彈窗前必須 Grep 既有 class 沿用骨架，禁自刻 inline style |
| [feedback/workflow/feedback_batch_regex_php.md](feedback/workflow/feedback_batch_regex_php.md) | PHP 檔禁砍逗號 regex（誤切函式參數列），改走 Grep+apply_diff 或 AST |

### Feedback — Tooling
| 檔案 | 說明 |
| --- | --- |
| [feedback/tooling/feedback_bat_encoding.md](feedback/tooling/feedback_bat_encoding.md) | Windows .bat 禁含中文，UTF-8 無 BOM 會損毀 ASCII |
| [feedback/tooling/feedback_docker_ops.md](feedback/tooling/feedback_docker_ops.md) | Docker image 版本必須鎖定，升版前查證持久化路徑 |
| [feedback/tooling/feedback_license_compliance.md](feedback/tooling/feedback_license_compliance.md) | 安裝第三方套件前確認授權合規，優先 MIT/Apache 2.0 |
| [feedback/tooling/feedback_http_request_session.md](feedback/tooling/feedback_http_request_session.md) | send_http_request 不回傳 Set-Cookie，登入後測試需用 Playwright |
| [feedback/tooling/feedback_mcp_tool_priority.md](feedback/tooling/feedback_mcp_tool_priority.md) | DB/PHP/Python 操作必須用 MCP 工具，禁止 Bash docker exec |

### Feedback — QC
| 檔案 | 說明 |
| --- | --- |
| [feedback/qc/feedback_qc_methodology.md](feedback/qc/feedback_qc_methodology.md) | 規格書驅動測試、❓交叉驗證、孤兒清理、校稿單格式 |

### Feedback — General
| 檔案 | 說明 |
| --- | --- |
| [feedback/general/feedback_search_strategy.md](feedback/general/feedback_search_strategy.md) | 搜尋策略：3次找不到就問、文件缺失進系統確認、RAG vs Grep |
| [feedback/general/feedback_repetition_awareness.md](feedback/general/feedback_repetition_awareness.md) | 重複呼叫同類工具 3+ 次應自省，建議 batch 或新工具 |
| [feedback/general/feedback_test_user_perspective.md](feedback/general/feedback_test_user_perspective.md) | 修 bug 後必須從使用者視角用 Playwright 測試，不能只看 code |

> `_private/` 資料夾：機敏記憶（.gitignore 排除，僅本機）
