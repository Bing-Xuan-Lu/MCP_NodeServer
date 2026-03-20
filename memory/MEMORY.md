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
| [project/project_deploy_pipeline.md](project/project_deploy_pipeline.md) | 部署流水線架構：remote_diff 安全閘 + full_deploy 四階段 |
| [project/project_rag_chromadb.md](project/project_rag_chromadb.md) | RAG 架構：ChromaDB Docker、collection 策略、port 設定 |

### Reference
| 檔案 | 說明 |
| --- | --- |
| [reference/reference_dept_mapping.md](reference/reference_dept_mapping.md) | commands/ 子資料夾對應部門表 |
| [reference/reference_live_server.md](reference/reference_live_server.md) | 本機開發用 VS Code Live Server，port 5500 |
| [reference/reference_playwright_config.md](reference/reference_playwright_config.md) | Playwright MCP 啟動參數與 session 保持設定 |
| [reference/reference_known_issues.md](reference/reference_known_issues.md) | 已知問題速查（Playwright session、工具引用過時、Skill 洩漏） |

### Feedback — Playwright
| 檔案 | 說明 |
| --- | --- |
| [feedback/playwright/feedback_playwright_screenshot.md](feedback/playwright/feedback_playwright_screenshot.md) | 截圖存 screenshot/ 不放根目錄 |
| [feedback/playwright/feedback_playwright_ops.md](feedback/playwright/feedback_playwright_ops.md) | 快取清除、禁平行 Agent、卡住停止、禁 taskkill、動態連結展開 |

### Feedback — Workflow
| 檔案 | 說明 |
| --- | --- |
| [feedback/workflow/feedback_skill_workflow.md](feedback/workflow/feedback_skill_workflow.md) | Skill 流程、行為規則、sub-Agent 防衝突、MCP 工具文件同步 |
| [feedback/workflow/feedback_md_linting.md](feedback/workflow/feedback_md_linting.md) | MD lint pre-existing 警告批量修復，避免誤診 |

### Feedback — Tooling
| 檔案 | 說明 |
| --- | --- |
| [feedback/tooling/feedback_bat_encoding.md](feedback/tooling/feedback_bat_encoding.md) | Windows .bat 禁含中文，UTF-8 無 BOM 會損毀 ASCII |
| [feedback/tooling/feedback_docker_ops.md](feedback/tooling/feedback_docker_ops.md) | Docker image 版本必須鎖定，升版前查證持久化路徑 |
| [feedback/tooling/feedback_license_compliance.md](feedback/tooling/feedback_license_compliance.md) | 安裝第三方套件前確認授權合規，優先 MIT/Apache 2.0 |

### Feedback — QC
| 檔案 | 說明 |
| --- | --- |
| [feedback/qc/feedback_qc_methodology.md](feedback/qc/feedback_qc_methodology.md) | 規格書驅動測試、❓交叉驗證、孤兒清理、校稿單格式 |

### Feedback — General
| 檔案 | 說明 |
| --- | --- |
| [feedback/general/feedback_search_strategy.md](feedback/general/feedback_search_strategy.md) | 搜尋策略：3次找不到就問、文件缺失進系統確認、RAG vs Grep |

> `_private/` 資料夾：機敏記憶（.gitignore 排除，僅本機）
