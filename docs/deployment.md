# Cloudflare 部署指南

本指南部署一个单用户远程 MCP Server。它让 ChatGPT 读取训记训练、饮食和身体数据，读取云端工作流上下文，并在用户明确确认后写入训练计划。

当前仓库版本：`1.5.1`。

## 前置条件

- Cloudflare 账号；
- Node.js 20 或更高版本；
- 从训记 App 申请的训练、饮食和身体数据 Open API Key；
- 一个仅用于连接器登录的高强度随机口令；
- 支持远程自定义 MCP 的 ChatGPT 账号；
- 如需使用恢复判断，还需要 iPhone、最新版 ChatGPT iOS App 和 ChatGPT Health。

Apple Health 连接在 iOS 端授权；本 Worker 不直接访问 HealthKit，也不保存 Apple Health 原始数据。

Cloudflare Workers、KV 和 D1 是必需运行资源；实际资格、价格和限制以 Cloudflare 当前页面为准。R2 是可选归档层，只有用户明确接受当前订阅与计费条件后才创建。本项目不会自动创建付费订阅，也不要求公网 IP、家用服务器或常开电脑。

## 1. 获取代码并运行本地检查

```bash
git clone https://github.com/<owner>/<repo>.git
cd <repo>
cp wrangler.example.jsonc wrangler.jsonc
npm test
npm run check
```

`wrangler.jsonc` 被 `.gitignore` 排除，因为它包含你自己的 Cloudflare 资源 ID。

## 2. 登录 Cloudflare

使用固定版本或你审核过的 Wrangler 版本：

```bash
npx wrangler@4 login
```

如果登录需要浏览器或账户选择，只确认现有账户；不要替用户升级、试用或绑定信用卡。

## 3. 创建云端资源

创建独立 KV namespace：

```bash
npx wrangler@4 kv namespace create OAUTH_KV
```

创建 D1 database：

```bash
npx wrangler@4 d1 create xunji-coach
```

如用户明确选择启用私有 Markdown 归档，再创建 R2 bucket：

```bash
npx wrangler@4 r2 bucket create xunji-coach-archive
```

把必需资源的 ID 填入 `wrangler.jsonc`。`r2_buckets` 整段是可选配置，未启用 R2 时删除该段：

```jsonc
{
  "kv_namespaces": [
    {
      "binding": "OAUTH_KV",
      "id": "<your-kv-namespace-id>"
    }
  ],
  "d1_databases": [
    {
      "binding": "COACH_DB",
      "database_name": "xunji-coach",
      "database_id": "<your-d1-database-id>",
      "migrations_dir": "migrations"
    }
  ],
  "r2_buckets": [
    {
      "binding": "COACH_ARCHIVE",
      "bucket_name": "xunji-coach-archive"
    }
  ]
}
```

资源用途：

- `OAUTH_KV`：OAuth 客户端、授权码、访问/刷新令牌、确认令牌、提交锁、短期回执和必要缓存。
- `COACH_DB`：已激活的工作流内容、证据版本、当前训练总纲、偏好约束快照、强一致提交声明、历史索引和训练决策日志。
- `COACH_ARCHIVE`（可选）：私有保存训练总纲与训练调整 Markdown 归档。未绑定时计划与决策仍完整保存在 D1，归档状态返回 `not_configured`。

不要在不同公开项目之间复用这些资源。

## 4. 设置 Worker Secrets

依次执行：

```bash
npx wrangler@4 secret put CONNECTOR_PASSWORD
npx wrangler@4 secret put XUNJI_TRAIN_API_KEY
npx wrangler@4 secret put XUNJI_FOOD_API_KEY
npx wrangler@4 secret put XUNJI_BODY_API_KEY
```

每条命令都会在终端中安全提示输入值。不要把 Key 放进 `wrangler.jsonc`、`.dev.vars`、命令历史、Issue、日志或截图。

建议为 `CONNECTOR_PASSWORD` 使用密码管理器生成的至少 32 字符独立随机口令。部署前必须确认该 Secret 已成功设置；缺失或空口令属于严重配置错误。

## 5. 应用 D1 migrations

先应用数据库结构，再发布内容和部署 Worker：

```bash
npx wrangler@4 d1 migrations apply COACH_DB --remote
```

该命令会依次应用 `migrations/0001_cloud_state.sql` 和 `migrations/0002_plan_mirrors.sql`，创建内容包、偏好快照、训练总纲、Google Docs 镜像状态和训练决策日志相关表。第二个 migration 会为已有总纲补一条 `pending` 镜像记录，不创建 Google 文档。

## 6. 发布云端内容

云端运行绝不读取本地文件。`content/` 是发布到 D1 的工作流、证据和偏好来源；`skills/` 是安装到 ChatGPT 账号的 Skill 源文件和版本备份；`docs/` 是人类可读文档。工作流和证据内容必须先发布到 D1。

```bash
npm run content:publish
```

发布成功后，`xunji_workflow_context_get` 才能读取：

- `training_planner`
- `weekly_adjustment`
- `daily_adjustment`
- `user_preferences`
- 当前证据版本

## 7. 部署 Worker 并检查

```bash
npx wrangler@4 deploy
curl https://<your-worker>.<your-subdomain>.workers.dev/health
```

健康检查应返回 `ok: true`、服务名 `xunji-cloud-coach` 和版本 `1.5.1`。健康检查不会验证训记 Key、ChatGPT OAuth、Google Drive 连接或内容包完整性。

MCP 地址为：

```text
https://<your-worker>.<your-subdomain>.workers.dev/mcp
```

## 8. 添加到 ChatGPT

ChatGPT 侧的必需入口只有一个：自定义 MCP 应用 **“训记云教练”**。它提供云端工具，并根据用户的一句短指令选择 `training_planner`、`weekly_adjustment` 或 `daily_adjustment`。ChatGPT 的菜单名称会随版本变化。

先配置自定义 MCP 应用：

1. 按当前套餐在 Workspace Settings 或 Settings 中启用 Apps / Developer mode；
2. 添加一个远程 MCP Server；
3. 输入上述 `/mcp` 地址并选择 OAuth；
4. 在授权页输入 `CONNECTOR_PASSWORD`；
5. 只授予工作流需要的 `xunji.read`、`xunji.write` 和 `offline_access` 权限。

如果当前套餐只允许自定义 MCP 读取，仍可生成建议和预览，但不能依赖 ChatGPT 自动执行写入工具。产品界面和权限仍在迭代，不应把某个菜单路径当作长期 API 合约。

Google Drive/Docs 是可选连接，不是部署完成条件。需要计划镜像时再连接；规划流程必须在总纲保存摘要旁单独披露拟写入私人文档的派生健康摘要类别并取得明确授权。只确认总纲、连接 Drive 或创建空白文档都不构成该披露授权。

账号级 Skills 是可选增强，不是连接器，也不能为普通会话补充 Developer MCP 能力。需要时再从仓库源文件创建或更新：

- `skills/xunji-training-planner/SKILL.md` → `xunji-training-planner`
- `skills/xunji-cloud-coach/SKILL.md` → `xunji-cloud-coach`

Skill 安装后保存在 ChatGPT 账号中。它们必须先调用“训记云教练”App；如工具不可见、连接失败或会话不支持 Developer MCP，应立即停止而不是先生成计划。

连接成功后，从“训记云教练”App 选择 **Try in chat** 新建会话，再做只读测试：

```text
读取 daily_adjustment 云端工作流，只展示版本、数据来源和当前总纲状态，不要写入。
```

再测试训记只读工具，例如读取一个明确日期范围内的训练记录。不得用真实写入作为连接测试。

## 9. 配置 ChatGPT Schedule

使用 [ChatGPT Schedule 模板](chatgpt-schedules.md)。建议先从“训记云教练”App 的 **Try in chat** 完成一次总纲对话，再启用每日与每周任务。

- 首次/阶段性总纲：`training_planner`，非定时任务；保存摘要旁分别取得总纲确认和可选 Google Docs 派生摘要授权。两项可在同一次回复中分别确认；未授权时不向 Drive 发送内容。保存后无论镜像状态如何都立即交接到 `weekly_adjustment` 生成第一周草案，首周写入仍需另行确认。
- 每日训练决策卡：`daily_adjustment`，每天 `Asia/Shanghai` 12:00。
- 每周计划微调：`weekly_adjustment`，每周日 `Asia/Shanghai` 20:00。

> [!NOTE]
> 完全云端是指 Worker 与 Schedule 的执行不依赖常开电脑。Apple Health 数据仍由 iPhone 采集并同步，因此手机需要定期联网，Health 授权也需要保持有效。

## 10. 更新与回滚

更新前先阅读变更并运行测试：

```bash
git pull --ff-only
npm test
npm run check
npx wrangler@4 d1 migrations apply COACH_DB --remote
npm run content:publish
npx wrangler@4 deploy
```

Cloudflare 会保留部署版本。出现问题时在 Dashboard 的 Workers & Pages 中选择已验证的旧版本回滚。回滚代码不会自动回滚 KV、D1 或已配置的 R2 数据；如工作流内容已经发布，需要单独决定是否重新发布旧内容包。

## 常见问题

### 电脑需要一直开机吗？

不需要。部署后 Worker、ChatGPT Skills 与 Schedule 都在云端或账号侧运行。只有本地开发、发布内容以及更新 Skill 源文件时需要当前电脑。

### 云端 Worker 会读取仓库里的 Skill 或文档吗？

不会。Worker 从 D1 读取已发布的 workflow context、证据版本、当前计划和历史索引；R2 如已配置，只保存索引所指向的私有长文本归档。ChatGPT Skills 安装后由账号托管，本地 `skills/` 只是可审阅源文件与版本备份。

### Google Drive 是必需的吗？

不是。若 ChatGPT 已连接 Google Drive/Docs，而且用户已在看到存储目的地和具体派生摘要类别后明确授权，规划工作流会在总纲提交后尽力创建一份私人、人类可读镜像，并调用 `xunji_commit_coaching_plan_mirror` 把成功链接或稳定失败码记录到 D1。只确认总纲不等于授权镜像；未授权时不向 Drive 发送内容。D1 始终是规范来源，Drive 不可用、未授权或写入失败都不会阻断总纲、第一周计划或 Scheduled Tasks。

### prepare 会写入训记吗？

不会。`xunji_prepare_coaching_plan_upsert` 和 `xunji_prepare_training_upsert` 只做 Worker 本地规范化、校验和摘要。只有用户确认后调用对应 `commit` 工具才会保存总纲或写入训记。

### 写入训练时为什么需要 decision_context？

`decision_context` 记录本次调整属于每日还是每周流程、依据的总纲版本与证据版本、数据窗口、数据质量和主要理由。它只对云教练的周/日调整强制关联当前总纲；普通人工训练写入仍可使用 `manual_update`。提交成功后，D1 保存决策日志和历史索引；如配置了 R2，再额外保存私有 Markdown 归档。

### ChatGPT 能直接读取 Apple Health 吗？

这取决于 ChatGPT 手机端是否已启用并授权 Health 连接器。本 Worker 不读取 Apple Health，也不能替代 iPhone 的健康数据授权。Apple Health 原始数据不进入 Worker、D1、R2 或 Google Drive。

## 删除部署

删除 Worker、KV namespace、D1 database、可选 R2 bucket 或 Secret 会中断连接，并可能永久删除 OAuth、计划、历史索引或归档。请先在 Cloudflare Dashboard 确认目标资源与数据保留需求，再执行删除。
