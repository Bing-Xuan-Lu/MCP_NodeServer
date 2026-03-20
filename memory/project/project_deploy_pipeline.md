---
name: project_deploy_pipeline
description: 部署流水線架構決策：remote_diff 安全閘 + full_deploy 四階段整合部署
type: project
---

部署流水線以「本機開發者檔案為主」，核心痛點是同事常直接 SFTP 改遠端檔案，部署時會覆蓋他人修改。

**Why:** 同事繞過版控直接改遠端 = shadow changes，部署前必須先偵測才能安全覆蓋。

**How to apply:**
- `/remote_diff` 是獨立 Skill，也是 `/full_deploy` 的強制第一步（安全閘）
- `/full_deploy` 四階段：Phase A remote_diff → Phase B sftp_deploy → Phase C DB migration → Phase D smoke test
- DB 存取分流：內部測試機用 `execute_sql` 直連，準測試機用 `/remote_db_exec`（SFTP+PHP 間接）
- 設定檔（config.php / .env）永不覆蓋，只報告差異
- 暫存目錄：`D:\tmp\{ProjectFolder}_remote\`（diff 用，不自動清理）
- 使用者環境：本機 `D:\Project\PG_dbox3` → 內部測試機 `/var/www/html_dbox3`（DB 可直連）→ 準測試機 `/var/www/html_dbox3`（DB 只能間接）
