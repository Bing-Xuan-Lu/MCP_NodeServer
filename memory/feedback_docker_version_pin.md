---
name: feedback_docker_version_pin
description: Docker image 版本必須鎖定，不可用 latest，更不可未查證就修改 volume 路徑
type: feedback
---

Docker image 可以升級到最新版，但必須**先查證再改**，不可憑猜測調整。

**Why:** ChromaDB 升版時持久化路徑從 `/chroma/chroma` 改成 `/data`，volume mount 沒跟著改導致 `docker compose up -d` 後資料全部消失。

**How to apply:**
- docker-compose.yml image tag 一律指定具體版本號（如 `chromadb/chroma:1.5.5`），禁止用 `:latest`
- 升版前必須查證：持久化路徑、API 變更、環境變數變更（查官方文件 / GitHub release notes / `docker logs`）
- 修改 volume mount 路徑前，必須先用 `docker logs` 或 `docker exec` 確認容器內實際資料路徑
- 查證完畢、確認相容後才修改 docker-compose.yml 和相關程式碼
