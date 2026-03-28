-- ============================================================
-- V1 範例腳本：初始化示範
-- 說明：這是一個範例，展示 Flyway migration 腳本格式
-- 請依實際需求修改或刪除此檔，並建立你的第一個 migration
-- ============================================================

-- 範例：建立一個設定表
CREATE TABLE IF NOT EXISTS `app_settings` (
  `id`         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `key`        VARCHAR(100) NOT NULL UNIQUE COMMENT '設定鍵',
  `value`      TEXT NULL COMMENT '設定值',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='應用程式設定';
