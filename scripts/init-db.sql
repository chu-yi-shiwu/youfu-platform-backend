-- 以 postgres 执行：建库 + 建应用角色
CREATE DATABASE youfu;
CREATE ROLE youfu_app LOGIN PASSWORD 'change_me' NOSUPERUSER;
GRANT ALL ON DATABASE youfu TO youfu_app;
\c youfu
GRANT ALL ON SCHEMA public TO youfu_app;
