---
name: SFTP 部署不可覆蓋環境設定檔
description: SFTP 上傳含 DB 連線的設定檔到遠端時不可直接覆蓋，本機與遠端環境設定不同
type: feedback
---

SFTP 部署時，含 DB 連線設定的環境設定檔不可直接覆蓋，因為本機和遠端的 DB 連線設定不同。

**Why:** 曾因直接上傳設定檔導致遠端 DB 連線全部失敗（container 名稱和密碼不同）。

**How to apply:**
- 部署時若包含環境設定檔，上傳後必須用 `ssh_exec` + `sed` 修正 DB 連線設定
- 或直接跳過設定檔不上傳，只上傳業務邏輯檔案
- 同理其他含環境差異的設定檔（DB 連線、快取路徑、domain）上傳前先確認
- `/sftp_deploy` 和 `/full_deploy` 執行時應自動排除或提醒設定檔
