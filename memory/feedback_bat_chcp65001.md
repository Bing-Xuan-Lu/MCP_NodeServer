---
name: BAT files must avoid Chinese or use BOM
description: Windows .bat files saved as UTF-8 (no BOM) by Write tool will corrupt Chinese AND surrounding ASCII — safest to use English only
type: feedback
---

Windows .bat files must NOT contain Chinese characters.

**Why:** Write tool saves UTF-8 without BOM. Windows cmd.exe parses .bat files using the system codepage (950/Big5), not UTF-8. Multi-byte Chinese characters bleed into adjacent ASCII, corrupting even English commands like `"until=48h"` → `'?48h'`. `chcp 65001` only changes console *output* codepage, it does NOT change how cmd *parses* the .bat file itself.

**How to apply:** When generating .bat files, write ALL text in English/ASCII. No Chinese characters anywhere — not in echo, not in REM comments. If Chinese output is truly needed, use a separate UTF-8 BOM file or PowerShell instead.
