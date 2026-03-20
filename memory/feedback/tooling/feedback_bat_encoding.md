---
name: feedback_bat_encoding
description: Windows .bat 檔不可含中文，Write 工具儲存為 UTF-8 無 BOM 會導致 ASCII 損毀
type: feedback
---

Windows .bat 檔案**禁止包含中文字元**，一律純英文/ASCII。

**Why:** Write 工具儲存為 UTF-8 無 BOM。cmd.exe 用系統 codepage（950/Big5）解析 .bat，中文多位元組字元會「出血」到鄰近 ASCII，甚至把英文指令 `"until=48h"` 損毀成 `'?48h'`。`chcp 65001` 只改主控台*輸出* codepage，不改 cmd.exe *解析* .bat 的方式，無法解決問題。

**How to apply:** 產出 .bat 檔時，echo / REM 全部用英文。若確實需要中文輸出，改用 PowerShell 或另存 UTF-8 BOM 的 .ps1。
