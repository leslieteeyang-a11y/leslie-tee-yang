-- ============================================================
-- 为 HomeWorks 营运系统建立「只读」SQL 登入
-- 给 AutoCount 经销商 / IT 在 SERVER\A2006 上执行（SSMS 或 sqlcmd）
--
-- 这个帐号只能 SELECT，不能改任何资料；不影响 AutoCount 运作。
-- 执行前请把下面的密码换成自己的，然后把帐号密码告诉 HomeWorks。
-- ============================================================

USE [master];
GO
IF NOT EXISTS (SELECT 1 FROM sys.sql_logins WHERE name = N'homeworks_ro')
    CREATE LOGIN [homeworks_ro] WITH PASSWORD = N'请换成一个强密码', CHECK_POLICY = OFF;
GO

-- 需要读取的账套：每个各执行一次（不需要的可以删掉）
USE [AED_HOMEWORKS];
GO
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'homeworks_ro')
    CREATE USER [homeworks_ro] FOR LOGIN [homeworks_ro];
ALTER ROLE [db_datareader] ADD MEMBER [homeworks_ro];
GO

USE [AED_HOMESOLUTIONS];
GO
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'homeworks_ro')
    CREATE USER [homeworks_ro] FOR LOGIN [homeworks_ro];
ALTER ROLE [db_datareader] ADD MEMBER [homeworks_ro];
GO

USE [AED_HOMEGUARD];
GO
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'homeworks_ro')
    CREATE USER [homeworks_ro] FOR LOGIN [homeworks_ro];
ALTER ROLE [db_datareader] ADD MEMBER [homeworks_ro];
GO

-- 验证：应该回传 3 列，每列的 role 都是 db_datareader
SELECT DB_NAME() AS db, r.name AS role
FROM sys.database_role_members m
JOIN sys.database_principals r ON r.principal_id = m.role_principal_id
JOIN sys.database_principals u ON u.principal_id = m.member_principal_id
WHERE u.name = N'homeworks_ro';
GO
