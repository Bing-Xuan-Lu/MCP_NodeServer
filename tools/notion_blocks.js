// notion_blocks.js — 直接呼叫 Notion REST API，支援完整 block 類型

function formatBlockId(id) {
  const clean = id.replace(/-/g, "");
  if (clean.length !== 32) return id;
  return `${clean.slice(0,8)}-${clean.slice(8,12)}-${clean.slice(12,16)}-${clean.slice(16,20)}-${clean.slice(20)}`;
}

export const definitions = [
  {
    name: "notion_append_blocks",
    description: "Append blocks to a Notion page. Supports: paragraph, heading_1/2/3, code, divider, bulleted_list_item, numbered_list_item, toggle, quote, callout.",
    inputSchema: {
      type: "object",
      properties: {
        block_id: {
          type: "string",
          description: "Target page or block ID (dashes optional)",
        },
        children: {
          type: "array",
          description: "Array of Notion block objects (full block shape)",
          items: { type: "object" },
        },
      },
      required: ["block_id", "children"],
    },
  },
];

export async function handle(toolName, args) {
  if (toolName !== "notion_append_blocks") {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }

  const { block_id, children } = args;
  const apiKey = process.env.NOTION_API_KEY;

  if (!apiKey) {
    return { success: false, error: "NOTION_API_KEY not set in environment" };
  }
  if (!block_id || !Array.isArray(children) || children.length === 0) {
    return { success: false, error: "block_id and non-empty children array are required" };
  }

  const formattedId = formatBlockId(block_id);
  const url = `https://api.notion.com/v1/blocks/${formattedId}/children`;

  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ children }),
    });

    const data = await res.json();

    if (!res.ok) {
      return { success: false, error: data.message ?? JSON.stringify(data) };
    }

    return { success: true, results: data.results ?? [] };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
