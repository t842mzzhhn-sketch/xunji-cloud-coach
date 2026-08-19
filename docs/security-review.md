# 安全与隐私审查

审查日期：2026-08-04

审查范围：ChatGPT 账号 Skills、Cloudflare Worker OAuth/MCP、KV/D1/可选 R2 数据边界、训记写入流程、Apple Health 数据路径、Google Drive 可选镜像边界和公开发布风险。本文是源码与架构层面的审查记录，不代表某个个人部署已经完成或经过第三方渗透测试。

## 结论

- ✅ 架构边界已明确：用户从一个“训记云教练”App 进入三个云端工作流；可选 ChatGPT Skills 安装后由账号托管且不提供 MCP 能力；Worker 从 D1 读取运行时内容，不读取本地仓库文件。
- ✅ 入口失败保护已明确：首个 `xunji_workflow_context_get` 调用未成功或会话不支持 Developer MCP 时停止，不先生成无法保存的计划。
- ✅ Apple Health 原始数据只由 ChatGPT Health 读取，不进入 Worker、D1、R2、Google Drive 或训记。
- ✅ 长期计划与决策状态从 KV 分离：KV 仅用于 OAuth、确认、最佳努力状态、短期回执和缓存；D1 保存当前计划、证据版本、偏好快照、Google Docs 镜像状态/链接、强一致提交声明、历史索引和决策日志；显式配置 R2 后才额外保存私有 Markdown 归档。
- ✅ 总纲与训练写入都保留 `prepare -> 用户确认 -> commit` 流程；周/日调整写入要求 `decision_context` 匹配当前总纲与证据版本。
- ⚠️ 本项目仍是单用户自托管设计，不应被描述成经过第三方安全审计或适合多租户生产环境。

> [!CAUTION]
> 上线检查不能只依赖界面提示。`CONNECTOR_PASSWORD` 必须在服务端被验证为已配置、非空且足够长；缺失、空值或过短 Secret 都应视为严重配置错误。

## 数据会经过哪里

| 数据 | 传输路径 | 持久化位置 |
| --- | --- | --- |
| Apple Health 睡眠、HRV、心率、血压、活动等原始数据 | iPhone → ChatGPT Health | 不进入 Worker、D1、R2、Google Drive 或训记 |
| 训记训练、饮食、身体记录 | 训记 → Cloudflare Worker → ChatGPT | 训记是事实源；普通查询结果不作为长期云端记录 |
| 已激活工作流与证据版本 | 本地 `content/` 发布 → D1 `COACH_DB` | D1 |
| 已确认训练总纲 | ChatGPT → Worker → D1 / 可选 R2；经独立明确授权后 ChatGPT → Google Docs | D1 保存结构化当前计划、镜像状态和索引；配置 R2 后额外保存私有 Markdown；Drive 已连接且用户授权具体派生摘要类别时才尽力创建私人文档 |
| 偏好与约束快照 | ChatGPT → Worker → D1 | D1 `profile_snapshots` |
| 训练调整决策 | ChatGPT → Worker → 训记 / D1 / 可选 R2 | 训记保存实际训练；D1 保存决策日志；配置 R2 后额外保存私有 Markdown 归档 |
| 训练写入预览、确认、锁与回执 | ChatGPT → Worker KV → 训记 | KV 按 TTL 暂存 |
| 同一确认令牌的提交所有权 | Worker → D1 `training_commit_claims` | D1 唯一键；记录保留 7 天后清理 |
| OAuth 客户端、授权码、访问/刷新令牌 | ChatGPT ↔ Worker KV | KV 按实现中的 TTL 保存 |
| Google Docs 总纲镜像 | 已确认总纲 → ChatGPT Google Drive/Docs 连接 → 私人文档；结果元数据 → Worker → D1 | 每个计划版本一个文档；不能包含 Health 原始数据，也不能成为 Scheduled Tasks 硬依赖 |

OpenAI Health、Cloudflare、Google Drive 和训记的数据处理仍受各自账户、地区、工作区策略和用户授权范围影响。部署或公开推荐前应复核官方页面。

## 已验证的良好控制

- MCP 的只读与写入工具按 `xunji.read` / `xunji.write` scope 区分。
- `xunji_workflow_context_get` 明确返回 `local_files_used: false`，要求云端运行从 D1 读取已发布上下文；R2 如已配置，只保存私有长文本归档。
- `xunji_prepare_coaching_plan_upsert` 只预览总纲；`xunji_commit_coaching_plan_upsert` 需要用户确认。
- `xunji_prepare_training_upsert` 只预览训练写入，并校验 `decision_context`。
- `xunji_commit_training_upsert` 保存决策日志和短期回执，并对同一确认令牌做重复提交保护。
- `xunji_commit_coaching_plan_mirror` 只接受当前计划版本、匹配的 Google Docs ID/URL 或受限短错误码；成功记录后不允许覆盖或降级。
- 如启用 R2，归档 bucket 必须保持私有，不应作为公开下载源。
- Worker 默认关闭 observability，代码中不应输出请求体或凭据。
- 训记目标 URL 固定在代码中，没有把用户输入直接用作上游 URL，降低 SSRF 风险。

## 主要风险与建议

### 严重：连接口令配置错误

风险：部署者漏设、空置或使用过短 `CONNECTOR_PASSWORD` 时，授权边界会失效或被弱口令攻击。

建议：服务端拒绝缺失、空值和过短 Secret；部署检查中确认 Secret 存在但不显示值；使用密码管理器生成至少 32 字符独立随机口令。

### 高：动态客户端注册与回调域名

风险：公开注册端点若只要求 HTTPS 回调，可能被滥用来消耗 KV 写入额度，或配合钓鱼授权链接诱导用户输入连接口令。

建议：默认只允许 OpenAI/ChatGPT 的已知回调域名，或使用部署者配置的精确 allowlist；限制 URI 数量和长度，并对注册端点做去重和速率限制。

### 高：OAuth token 存储

风险：拥有 KV list/read 权限的人可能看到仍有效的 bearer 或刷新令牌。

建议：仅保存 token 摘要作为 KV key；刷新时轮换刷新令牌并删除旧值；提供明确的令牌撤销和全量失效步骤。

### 中：D1 与训记之间不是跨系统事务

风险：D1 唯一提交声明可以阻止同一确认令牌的并发请求同时写入训记，但 D1 和训记无法组成同一个事务。上游请求超时或 Worker 在写入后中断时，结果仍可能处于 `ambiguous` 状态。

建议：保留当前“先查目标日期、再决定是否写入”的对账路径；遇到 `ambiguous` 时不得用同一令牌盲目重试。若训记未来提供正式幂等键，应同时传递并验证服务端幂等结果。

### 中：D1/可选 R2 中的长期敏感状态

风险：D1 保存偏好、约束、计划和决策日志；如启用 R2，还会保存 Markdown 归档。它们不包含 Apple Health 原始数据，但仍可能包含个人训练目标、伤病限制和计划细节。

建议：使用独立 Cloudflare 资源；限制 Dashboard 和 API token 权限；如启用 R2，不要公开 bucket；导出、截图或日志前做脱敏。

### 中：Google Docs 镜像中的长期计划信息

风险：镜像包含目标、伤病/动作限制、偏好、训练安排，以及可能用于决策的睡眠/HRV/静息心率、体重体脂等派生摘要。虽然不含 Apple Health 原始时间序列，仍属于个人敏感训练资料。把总纲保存确认误当作 Google Docs 披露授权、错误分享或把文档当作运行时可编辑源都会造成暴露或版本漂移。

建议：在总纲保存摘要旁分别说明 Google Docs 目的地、私人权限和拟写入的派生摘要类别，并取得独立明确选择；两项授权可以在同一次回复中表达。未授权时不得向 Drive 发送内容。创建时保持私人默认权限；每个整体计划版本创建新文档；只把文档 ID、规范 URL 和状态写入 D1；不要自动共享，不要让周/日 Schedule 读取或改写文档。

### 中：上游错误正文可能扩大暴露面

风险：训记上游错误若包含请求片段或个人数据，直接返回或持久化完整错误正文会扩大暴露面。

建议：只保留稳定错误码、HTTP 状态与白名单短消息，不持久化完整上游响应正文。

### 中：公开请求体与注册字段大小

风险：`/register`、`/token` 和 `/mcp` 会解析请求体；过大的 JSON/form body 或字段可能造成 CPU、内存或 KV 写入消耗。

建议：限制 `Content-Length`、数组项数和字符串长度，并在 Cloudflare 侧配置适合单用户连接器的速率限制。

### 低：授权页安全响应头

风险：授权 HTML 若缺少常见安全响应头，容易受到嵌入、来源泄漏或缓存误用影响。

建议：补充 `Content-Security-Policy`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`，并让所有授权错误响应使用 `Cache-Control: no-store`。

### 低：scope 可读性

风险：授权页若不清晰列出请求的 scope，用户不易判断正在授权读取、写入还是离线访问。

建议：把请求 scope 与 allowlist 取交集，拒绝未知值，并在授权页明确显示读取、写入和离线权限。

## 截图与开源发布风险

公开截图前必须删除姓名、头像、账号 ID、精确健康指标、连续时间戳、训练地点、通知栏、Worker URL、OAuth 回调参数、Cloudflare account/KV/D1/R2 ID、Key、token 与二维码。完整清单见 [`assets/README.md`](assets/README.md)。

不要直接压缩整个工作目录上传。被 `.gitignore` 排除的 `wrangler.jsonc`、`.wrangler/`、`.dev.vars` 或本地工具状态仍可能进入 ZIP。优先通过 GitHub 推送已跟踪文件，或使用：

```bash
git archive --format=zip --output=xunji-cloud-coach-source.zip HEAD
```

## 上线前最低检查

- [ ] `CONNECTOR_PASSWORD` 已配置、非空、足够长，且没有出现在日志或文件中；
- [ ] Cloudflare Secrets 已设置，训记 Key 未写入仓库、命令历史或截图；
- [ ] `OAUTH_KV`、`COACH_DB` 是本项目独立资源；如启用 `COACH_ARCHIVE`，它也必须独立且保持私有；
- [ ] D1 migrations 已应用；
- [ ] `npm run content:publish` 已发布工作流和证据内容；
- [ ] `xunji_workflow_context_get` 可读取 `training_planner`、`weekly_adjustment` 和 `daily_adjustment`；
- [ ] `xunji_commit_coaching_plan_mirror` 可记录当前计划的匹配 Docs ID/URL，并拒绝覆盖已成功的镜像；
- [ ] 总纲 prepare 明确区分总纲保存确认与 Google Docs 派生摘要授权；未授权时不调用 Drive，且首周交接不被阻断；
- [ ] OAuth 回调 URI 已限制到实际客户端；
- [ ] 已验证 D1 提交声明生效，并理解跨系统超时仍需要查询训记后人工对账；
- [ ] Cloudflare observability 和其他日志没有记录请求体；
- [ ] Git 跟踪文件与提交历史通过密钥扫描；
- [ ] 截图经过独立复核，且使用演示数据或充分脱敏；
- [ ] 已手动测试“只读 → prepare → 人工确认 → commit”，并检查训记无重复记录。

## 审查边界

本文没有声明某个 Cloudflare 部署已经完成，也没有验证某个个人 Cloudflare 账户当前是否处于 Free 计划。第三方服务的产品资格、价格和数据政策会变化，应在部署或公开推荐前复核官方页面。
