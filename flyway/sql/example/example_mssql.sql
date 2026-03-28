-- ============================================================
-- V1 範例腳本：MSSQL 初始化示範
-- 說明：MSSQL 語法與 MySQL 有差異，注意型別與語法
-- ============================================================

-- 範例：建立設定表（MSSQL 語法）
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'app_settings')
BEGIN
  CREATE TABLE [dbo].[app_settings] (
    [id]         INT IDENTITY(1,1) PRIMARY KEY,
    [key]        NVARCHAR(100) NOT NULL,
    [value]      NVARCHAR(MAX) NULL,
    [created_at] DATETIME2 NOT NULL DEFAULT GETDATE(),
    [updated_at] DATETIME2 NOT NULL DEFAULT GETDATE(),
    CONSTRAINT UQ_app_settings_key UNIQUE ([key])
  );
END
