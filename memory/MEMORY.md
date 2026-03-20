# MCP_NodeServer 專案 Memory

## 記憶索引

| 檔案 | 類型 | 說明 |
|------|------|------|
| [user_profile.md](user_profile.md) | user | 使用者角色、技術背景、溝通偏好 |
| [feedback_skill_workflow.md](feedback_skill_workflow.md) | feedback | Skill 建立流程規範與行為規則 |
| [project_mcp_server.md](project_mcp_server.md) | project | 專案基本資訊與路徑設定 |
| [reference_dept_mapping.md](reference_dept_mapping.md) | reference | commands/ 子資料夾對應部門表 |
| [feedback_md_linting.md](feedback_md_linting.md) | feedback | MD lint 問題批量修復，避免誤診 pre-existing 警告 |
| [project_rag_chromadb.md](project_rag_chromadb.md) | project | RAG 架構決策：ChromaDB Docker port 8010、collection 策略 |
| [feedback_license_compliance.md](feedback_license_compliance.md) | feedback | 第三方套件必須確認授權合規，不可盜用 |
| [feedback_bat_chcp65001.md](feedback_bat_chcp65001.md) | feedback | Windows .bat 含中文必須加 `chcp 65001 >nul` |
| [feedback_docker_version_pin.md](feedback_docker_version_pin.md) | feedback | Docker image 必須鎖版本號，不可用 latest，修改 volume 前必須查證 |
| [project_deploy_pipeline.md](project_deploy_pipeline.md) | project | 部署流水線：remote_diff 安全閘 + full_deploy 四階段，兩台測試機 DB 存取分流 |

> `_private/` 資料夾：機敏記憶（.gitignore 排除，僅本機）
