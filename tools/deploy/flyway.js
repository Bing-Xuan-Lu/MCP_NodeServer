import { execSync } from "child_process";

// ============================================
// Flyway — 資料庫 Migration 版本控制工具
// 透過 docker exec 呼叫 dev-flyway 容器執行 Flyway CLI
// 容器設定：flyway/docker-compose.yml
// ============================================

const FLYWAY_CONTAINER = "dev-flyway";

/** 組合 configFiles 參數（接受短名稱或完整路徑） */
function resolveConfig(config) {
  if (!config || config === "mysql" || config === "pure_php_db") {
    return "/flyway/conf/pure_php_db.toml";
  }
  if (config.startsWith("/")) return config;
  return `/flyway/conf/${config}.toml`;
}

/** 執行 docker exec 並回傳結果 */
function runFlyway(configPath, command, extraArgs = "") {
  const cmd = `docker exec ${FLYWAY_CONTAINER} flyway -configFiles="${configPath}" ${command} ${extraArgs}`.trim();
  try {
    const stdout = execSync(cmd, { encoding: "utf8", timeout: 120_000 });
    return { success: true, output: stdout };
  } catch (err) {
    const output = [err.stdout, err.stderr].filter(Boolean).join("\n") || err.message;
    return { success: false, output };
  }
}

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "flyway_info",
    description:
      "列出所有 migration 版本狀態（Pending / Success / Failed）。用於確認哪些腳本尚未執行。",
    inputSchema: {
      type: "object",
      properties: {
        config: {
          type: "string",
          description:
            "設定檔名（不含副檔名）或完整容器內路徑。可用值：pure_php_db、staging、mssql_xxx 等。預設：pure_php_db",
        },
      },
    },
  },
  {
    name: "flyway_migrate",
    description:
      "執行所有 Pending 的 migration 腳本，將資料庫 schema 升級至最新版本。",
    inputSchema: {
      type: "object",
      properties: {
        config: {
          type: "string",
          description: "設定檔名（不含副檔名），預設：pure_php_db",
        },
        dry_run: {
          type: "boolean",
          description:
            "設為 true 時只顯示 info（不實際執行），用於確認即將執行的腳本。預設：false",
        },
      },
    },
  },
  {
    name: "flyway_validate",
    description:
      "驗證 migration 腳本的 checksum 與資料庫記錄是否一致。腳本被修改後應立即執行此工具檢查。",
    inputSchema: {
      type: "object",
      properties: {
        config: {
          type: "string",
          description: "設定檔名（不含副檔名），預設：pure_php_db",
        },
      },
    },
  },
  {
    name: "flyway_repair",
    description:
      "修復 flyway_schema_history 中的 Failed 記錄，並重新對齊 checksum。validate 失敗後使用。",
    inputSchema: {
      type: "object",
      properties: {
        config: {
          type: "string",
          description: "設定檔名（不含副檔名），預設：pure_php_db",
        },
      },
    },
  },
  {
    name: "flyway_baseline",
    description:
      "對已存在的資料庫建立 Flyway baseline（標記當前狀態為 V1，後續 migration 從 V2 開始）。僅限首次將 Flyway 引入現有 DB 時使用。",
    inputSchema: {
      type: "object",
      properties: {
        config: {
          type: "string",
          description: "設定檔名（不含副檔名），預設：pure_php_db",
        },
        baseline_version: {
          type: "string",
          description: "baseline 版本號，預設：1",
        },
        baseline_description: {
          type: "string",
          description: "baseline 說明，預設：Initial baseline",
        },
      },
    },
  },
];

// ============================================
// 工具處理器
// ============================================
export async function handle(name, args) {
  const configPath = resolveConfig(args.config);

  // 先確認容器是否運行
  try {
    execSync(`docker inspect --format="{{.State.Running}}" ${FLYWAY_CONTAINER}`, {
      encoding: "utf8",
      timeout: 5_000,
    });
  } catch {
    return {
      content: [
        {
          type: "text",
          text: `❌ Flyway 容器 (${FLYWAY_CONTAINER}) 未運行\n\n請先啟動：\n  cd MCP_NodeServer/flyway && docker compose up -d`,
        },
      ],
      isError: true,
    };
  }

  let result;

  switch (name) {
    case "flyway_info": {
      result = runFlyway(configPath, "info");
      break;
    }

    case "flyway_migrate": {
      if (args.dry_run) {
        result = runFlyway(configPath, "info");
        if (result.success) {
          result.output = `[Dry Run] 以下為 Pending 狀態的 migrations，未實際執行：\n\n${result.output}`;
        }
      } else {
        result = runFlyway(configPath, "migrate");
      }
      break;
    }

    case "flyway_validate": {
      result = runFlyway(configPath, "validate");
      break;
    }

    case "flyway_repair": {
      result = runFlyway(configPath, "repair");
      break;
    }

    case "flyway_baseline": {
      const version = args.baseline_version || "1";
      const desc = args.baseline_description || "Initial baseline";
      result = runFlyway(
        configPath,
        "baseline",
        `-baselineVersion="${version}" -baselineDescription="${desc}"`
      );
      break;
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown flyway tool: ${name}` }],
        isError: true,
      };
  }

  return {
    content: [{ type: "text", text: result.output || "(no output)" }],
    isError: !result.success,
  };
}
