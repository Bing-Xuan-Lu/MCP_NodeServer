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
| [feedback/playwright/feedback_playwright_ops.md](feedback/playwright/feedback_playwright_ops.md) | 快取清除、禁平行 Agent、卡住停止、禁 taskkill、動態連結展開、預授權、禁模擬呼叫、截圖驗證、完整畫面 |

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
| [feedback/tooling/feedback_python_docker_only.md](feedback/tooling/feedback_python_docker_only.md) | 禁止 Bash 呼叫 python/python3/pip，一律走 Docker run_python_script |

### Feedback — QC
| 檔案 | 說明 |
| --- | --- |
| [feedback/qc/feedback_qc_methodology.md](feedback/qc/feedback_qc_methodology.md) | 規格書驅動測試、❓交叉驗證、孤兒清理、校稿單格式 |

### Feedback — Deploy
| 檔案 | 說明 |
| --- | --- |
| [feedback/deploy/feedback_sftp_config_protect.md](feedback/deploy/feedback_sftp_config_protect.md) | SFTP 部署不可覆蓋 config DB 連線，本機與遠端設定不同 |

### Feedback — General
| 檔案 | 說明 |
| --- | --- |
| [feedback/general/feedback_search_strategy.md](feedback/general/feedback_search_strategy.md) | 搜尋策略：3次找不到就問、文件缺失進系統確認、RAG vs Grep |
| [feedback/general/feedback_css_computed_style.md](feedback/general/feedback_css_computed_style.md) | CSS 修改前用 getComputedStyle 確認現有值，避免規則疊加 |
| [feedback/general/feedback_test_user_perspective.md](feedback/general/feedback_test_user_perspective.md) | 修完 Bug 用 Playwright 從使用者角度實測驗證 |
| [feedback/general/feedback_php_long_page_split.md](feedback/general/feedback_php_long_page_split.md) | PHP 頁面超過 300-400 行主動切 include |
| [feedback/general/feedback_js_falsy_fallback.md](feedback/general/feedback_js_falsy_fallback.md) | JS `\|\|` falsy 陷阱，值可為 0 時用 `??` |

> `_private/` 資料夾：機敏記憶（.gitignore 排除，僅本機）
