# 云端账号接入：Supabase

本目录记录 AeroAtlas 从“本地 JSON 文件账号”迁移到“Supabase 云数据库”的配置。

当前状态：

- 项目：`map`，ref `pinfvtiqssfzwaxnpfxa`
- 项目 URL：`https://pinfvtiqssfzwaxnpfxa.supabase.co`
- 已执行 `supabase-schema.sql`（`profiles`、RLS、注册触发器）
- 前端已通过 `data/cloud-config.js` 接入
- 登录方式：邮箱 + 密码，显示名称可自定义
- 注册后默认需要邮箱确认

下面的 4 步保留为重建 / 迁移时的参考。

## 为什么用 Supabase

- **Postgres 云数据库**：账号资料、收藏保存在云数据库。
- **托管 Auth**：密码由 Supabase Auth 以哈希形式保存，前端永远拿不到密码哈希；不需要自己写密码存储。
- **RLS**：每个登录用户只能读写自己的 `profiles` 行。
- **静态站可用**：GitHub Pages 直接调用 Supabase，不需要本地 `server.py`。
- **免费额度**：个人使用足够。

## 需要你做的 4 步

### 1. 创建项目

打开 <https://supabase.com/dashboard>，用 GitHub 登录，点 **New project**：

- Name：`aeroatlas`
- Database Password：自己生成并保存好（这是数据库密码，不是网站登录密码）
- Region：选离你最近的，例如 `Southeast Asia (Singapore)`
- Plan：Free

创建后等 1–2 分钟初始化完成。

### 2. 打开邮箱登录

左侧 **Authentication → Providers → Email**：

- 确认 Email 已启用。
- 测试阶段可以把 **Confirm email** 关掉，这样注册后能立即登录。
- 正式使用时可以再打开邮箱确认。

### 3. 建表

左侧 **SQL Editor → New query**，把 [`supabase-schema.sql`](supabase-schema.sql) 全部粘贴进去并运行。

它会创建：

- `public.profiles`：`display_name`、`favorites`（JSONB 数组）、创建/更新时间。
- RLS 策略：登录用户只能 select/insert/update 自己的行。
- 注册触发器：新用户注册时自动创建 profile。

### 4. 给我两个值

**Project Settings → API Keys**：

- `Project URL`，形如 `https://xxxx.supabase.co`
- `Publishable key`（`sb_publishable_...`）或旧版 `anon` key（`eyJ...`）

把这两个发给我即可。**publishable / anon key 是设计给浏览器用的公开 key，可以发**；RLS 会限制权限。

> 绝对不要把 `service_role` / `secret` key 发给我，也不要放进网页或 GitHub。它绕过 RLS，只能保存在服务端。

### 5. 设置确认邮件跳转（建议）

**Authentication → URL Configuration**：

- Site URL：`https://cxdxd.github.io/map/`
- Redirect URLs：
  - `https://cxdxd.github.io/map/**`
  - `http://127.0.0.1:8000/**`

这样用户点击确认邮件后会回到网站；否则会跳到 Supabase 默认 Site URL，账号虽然已确认，但需要手动回来登录。

## 密码和旧账号怎么办

- Supabase Auth 只支持 **邮箱 + 密码** 登录（侧栏显示名仍可以是你的用户名）。如果你想继续用“用户名 + 密码”登录，需要自建云后端 + 云 Postgres，部署会复杂很多；需要的话告诉我。
- 本地账号的密码是 PBKDF2 哈希，**无法导出/迁移**，云端需要重新注册并设置密码。
- 本地账号的收藏可以迁移：先在本地版侧栏「备份 → 导出收藏」保存 JSON；云端注册后「备份 → 导入收藏」。
- 本地 `storage/` 数据仍然保留，不会因为接云而删除。

## 已接入内容

1. Supabase JS SDK 在 `vendor/supabase.js`，公开配置在 `data/cloud-config.js`（Project URL + publishable key）。
2. 登录/注册改为邮箱 + 密码，显示名保留用户名。
3. 注册/登录后从 `profiles` 读取收藏，收藏改动防抖写回 JSONB。
4. 保留游客模式；未登录时仍用 localStorage。
5. GitHub Pages 上直接可用，账号栏在公开站点显示。
6. 本地 `server.py` 保留为旧账号 / 离线兜底，不再作为云端账号的主路径。

## 上线前检查

- [x] 云端注册、邮箱确认、登录、收藏写入、退出、重新登录、刷新恢复已通过测试。
- [ ] 在 Supabase **Authentication → URL Configuration** 设置 Site URL 和 Redirect URLs。
- [ ] 在 GitHub Pages 打开站点，注册一个正式账号并完成邮箱确认。
- [ ] 登录后收藏几座机场，刷新页面确认收藏仍在。
- [ ] 确认 `profiles` 表里只有当前用户的行可读写。
- [ ] 删除测试账号 `AeroTest`（Authentication → Users）。
