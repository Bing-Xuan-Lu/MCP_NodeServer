---
name: Python 必須走 Docker，禁止 Bash 直接呼叫
description: Windows 無本機 Python，python3 會觸發 Microsoft Store stub，所有 Python 執行必須透過 MCP run_python_script（Docker 容器 python_runner）
type: feedback
---

禁止在 Bash 直接呼叫 `python`、`python3`、`pip`。

**Why:** Windows 上 `python3` 是 Microsoft Store stub，Git Bash 呼叫會開啟 Store 而非執行 Python。使用者不打算在本機安裝 Python，Python 環境完全由 Docker 提供。

**How to apply:**
- 所有 Python 執行一律透過 MCP 工具 `run_python_script`（Docker 容器 `python_runner`）
- 安裝套件用 `docker exec python_runner pip install 套件名`
- 此規則已寫入全域 CLAUDE.md 和專案 CLAUDE.md
