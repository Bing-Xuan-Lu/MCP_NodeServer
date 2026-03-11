@echo off
chcp 65001 > nul
docker exec -i python_runner python %*