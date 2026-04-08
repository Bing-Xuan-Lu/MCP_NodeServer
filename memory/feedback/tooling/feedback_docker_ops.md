---
name: feedback_docker_ops
description: Docker image 版本必須鎖定具體號碼；升版前必須查證持久化路徑與 API 變更
type: feedback
---

docker-compose.yml 的 image tag 一律指定具體版本號，禁止用 `:latest`。

**Why:** 曾因升版時持久化路徑變更，volume mount 沒跟著改導致資料消失。

**How to apply:**
- 升版前必須查證：持久化路徑、API endpoint 變更、環境變數變更（查官方文件 / GitHub release notes / `docker logs`）
- 修改 volume mount 路徑前，先用 `docker logs` 或 `docker exec` 確認容器內實際資料路徑
- 查證完畢、確認相容後才修改 docker-compose.yml 和相關程式碼
