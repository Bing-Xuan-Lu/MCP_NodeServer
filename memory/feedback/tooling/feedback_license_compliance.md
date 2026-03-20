---
name: feedback_license_compliance
description: 安裝第三方套件前必須確認授權合規，優先選用 MIT/Apache 2.0
type: feedback
---

安裝任何第三方套件（npm、Docker image、Python package 等）前，必須確認其授權合規。

**Why:** 使用者明確要求遵守著作權規範，避免盜用。

**How to apply:**
- 安裝前確認套件的 License 類型（MIT、Apache 2.0、GPL 等）
- 優先選用 MIT / Apache 2.0 等寬鬆授權的套件
- GPL 類授權需提醒使用者（有傳染性條款）
- 無授權聲明的套件視為「保留所有權利」，不應使用
- Docker image 需確認原始 GitHub repo 的 LICENSE 檔案
