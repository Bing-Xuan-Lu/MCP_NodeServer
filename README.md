# MCP NodeServer — 程式設計師的私人 AI 助理員工

Node.js MCP Server，為 Claude Code 提供 **41 個 Skill 指令** 與 **38 個 MCP 工具**，讓 AI 直接讀寫檔案、操作 DB、執行 PHP、部署 SFTP。

> 📊 **[查看技能儀表板 →](https://bing-xuan-lu.github.io/MCP_NodeServer/dashboard.html)**

---

## 前置條件

| 工具 | 版本 | 說明 |
|------|------|------|
| [Node.js](https://nodejs.org/) | 18+ | 執行 MCP Server 必需 |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | 最新版 | Python 容器（`run_python_script` 工具） |
| [Git](https://git-scm.com/) | 任意版 | Clone 專案 |

---

## 快速開始

```bash
git clone https://github.com/Bing-Xuan-Lu/MCP_NodeServer.git
cd MCP_NodeServer
setup.bat          # 一鍵初始化（npm install + Python 容器 + 部署 Skills）
```

設定 `~/.claude/mcp_settings.json` 或專案根目錄的 `.mcp.json`：

```json
{
  "mcpServers": {
    "project-migration-assistant-pro": {
      "type": "stdio",
      "command": "node",
      "args": ["{YourProjectPath}\\index.js"]  // 請填入 index.js 的絕對路徑
    }
  }
}
```

重啟 Claude Code 後，在對話輸入 `/skill-name` 即可觸發 Skill。

---

## 目錄結構

```text
MCP_NodeServer/
├── index.js             ← MCP Server 主程式
├── config.js            ← resolveSecurePath (預設 basePath 為 D:\Project\)
├── tools/               ← MCP 工具模組
│   ├── filesystem.js    ← list_files, read_file, create_file, apply_diff, *_batch
│   ├── php.js           ← run_php_script, run_php_test, send_http_request, tail_log, *_batch
│   ├── database.js      ← set_database, load_db_connection, get_db_schema, execute_sql, *_batch
│   ├── excel.js         ← get_excel_values_batch, trace_excel_logic, simulate_excel_change
│   ├── bookmarks.js     ← Chrome 書籤管理 (12 工具)
│   ├── sftp.js          ← sftp_connect/upload/download/list/delete, sftp_list_batch
│   ├── python.js        ← run_python_script (via Docker python_runner)
│   ├── git.js           ← git_status, git_diff, git_log, git_stash_ops
│   └── skill_factory.js ← save/list/delete_claude_skill, grant/list/revoke_path_access
├── skills/index.js      ← MCP Prompts 路由
├── Skills/commands/     ← Skill MD 檔（12 個部門子資料夾）
├── python/              ← Python Docker 環境（python_runner 容器）
├── docs/                ← 技能儀表板 (dashboard.html / style.css / script.js)
├── setup.bat            ← 一鍵環境初始化
└── deploy-commands.bat  ← 部署所有 Skills 到 ~/.claude/commands/
```

詳細開發規範見 [CLAUDE.md](CLAUDE.md)。
