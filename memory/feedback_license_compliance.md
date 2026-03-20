---
name: feedback_license_compliance
description: 安裝第三方套件必須確認授權合規，不可盜用
type: feedback
---

安裝任何第三方套件（npm、Docker image、Python package 等）前，必須確認其授權合規。

**Why:** 使用者明確要求遵守著作權規範，避免盜用。

**How to apply:**
- 安裝前先確認套件的 License 類型（MIT、Apache 2.0、GPL 等）
- 優先選用 MIT / Apache 2.0 等寬鬆授權的套件
- GPL 類授權需特別提醒使用者（可能有傳染性條款）
- 無授權聲明的套件視為「保留所有權利」，不應使用
- 若為 Docker image，確認原始 GitHub repo 的 LICENSE 檔案
- 在 commit 或文件中標註所使用的第三方元件及其授權
