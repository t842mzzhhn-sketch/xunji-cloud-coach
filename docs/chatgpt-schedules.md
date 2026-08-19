# ChatGPT 云端工作流配置

所有任务时区统一设置为 `Asia/Shanghai`。先完成一次训练总纲，再启用每日与每周任务。

## 一个 App，三个工作流

用户只需要使用一个自定义 App：**训记云教练**。

| 用户意图 | 云端工作流 | 结果 |
| --- | --- | --- |
| 制定或重做阶段计划 | `training_planner` | 1–2 个月训练总纲 |
| 调整下一周 | `weekly_adjustment` | 总纲范围内的周计划 |
| 判断今天怎么练 | `daily_adjustment` | 正常、降量或恢复决策 |

`xunji-training-planner` 与 `xunji-cloud-coach` 两个 ChatGPT Skill 只是可选行为指导，不提供 MCP 能力，也不是推荐启动入口。仓库 `skills/` 只是它们的可审阅源文件和版本备份。

## 推荐入口

1. 在 ChatGPT 中打开 **训记云教练 App**。
2. 选择 **Try in chat**，从 App 新建会话。
3. 直接输入一句短指令，不需要 `@` Skill，也不需要粘贴完整工作流。

可用指令：

```text
帮我制定新的整体训练计划
```

```text
帮我调整下周训练
```

```text
我今天怎么练
```

App 根据意图选择工作流。详细的数据范围、医学证据、安全边界、输出结构和写入规则来自 `xunji_workflow_context_get` 返回的 D1 内容，而不是用户输入。

## 必须先通过的能力门槛

在追问、分析数据或生成计划前，首个动作必须是调用：

```text
xunji_workflow_context_get(workflow=<对应工作流>)
```

只有调用成功，并返回 `schema_version`、`workflow_version`、`evidence_version` 且 `local_files_used: false`，才能继续。

出现以下任一情况时必须立即停止，不先生成无法保存的计划：

- 工具不可见或 App 未加载；
- OAuth/MCP 连接失败；
- `FORBIDDEN: This conversation does not support developer MCPs`；
- 工作流或证据版本缺失。

发生上述情况时，从“训记云教练”App 的 **Try in chat** 新建会话后重试短指令。重新连接 App 不能把已经受限的旧会话改造成支持 Developer MCP 的会话。

## 首次或阶段性训练总纲

- 触发方式：手动，不是定时任务。
- 用户输入：`帮我制定新的整体训练计划`。
- 首个工具：`xunji_workflow_context_get`，`workflow: "training_planner"`。
- 云端规则源：[`content/workflows/training-planner.md`](../content/workflows/training-planner.md)。

系统会自行读取必要的 ChatGPT Health 趋势、训记训练与饮食记录、个人偏好、历史计划和当前医学证据。只追问会实质改变计划且现有数据无法回答的缺口。

先讨论草案。用户确认草案后，调用 `xunji_prepare_coaching_plan_upsert` 展示待保存摘要，并同时说明 Google Docs 是独立的私人存储目的地，拟写入伤病/安全限制、恢复指标派生趋势、体重体脂趋势、训练偏好和医学证据摘要，但不包含 Health 原始时间序列。分别询问是否保存总纲和是否授权 Google Docs；两项可以在同一次回复中分别确认，只确认总纲不等于授权镜像。

保存成功后不要结束会话：只有用户明确授权 Google Docs 时，才使用已连接的 Google Drive/Docs 为该计划版本创建私人、人类可读镜像，回读验证后调用 `xunji_commit_coaching_plan_mirror` 记录 `stored` 文档 ID/URL。未明确授权时不调用 Drive，可记录 `failed / google_docs_not_authorized`；连接、创建或验证失败只记录其他稳定错误码。无论镜像处于 `pending`、`stored` 或 `failed`，都立即加载 `weekly_adjustment`，按首周启动规则生成从总纲 `start_date` 开始的第一周草案并核对训记标准动作名。首周写入必须展示新的逐日预览并取得新的明确确认，后续周调整再由 Schedule 接管。

## 每日训练决策卡

- 任务名称：`今日训练决策卡`
- 时间：每天 `12:00`
- 用户可见目标：判断今天正常训练、降量训练或恢复休息。
- 云端规则源：[`content/workflows/cloud-coach-daily.md`](../content/workflows/cloud-coach-daily.md)。

任务提示词只需保留入口、能力门槛和确认边界：

```text
通过“训记云教练”执行 daily_adjustment。第一步调用 xunji_workflow_context_get；调用失败或当前会话不支持 Developer MCP 时立即停止，不生成训练建议。调用成功后严格遵循返回的云端工作流与证据，读取最小必要的 ChatGPT Health 和训记数据，生成今日训练决策卡。未经我明确确认，不写入或覆盖训记训练。
```

## 每周计划微调

- 任务名称：`下周训练计划微调`
- 时间：每周日 `20:00`
- 用户可见目标：在已确认总纲内生成下一周草案。
- 云端规则源：[`content/workflows/cloud-coach-weekly.md`](../content/workflows/cloud-coach-weekly.md)。

任务提示词：

```text
通过“训记云教练”执行 weekly_adjustment。第一步调用 xunji_workflow_context_get；调用失败、当前会话不支持 Developer MCP，或没有有效总纲时立即停止，不生成周计划。调用成功后严格遵循返回的云端工作流与证据，读取最小必要的 ChatGPT Health 和训记数据，生成下一周草案。未经我明确确认，不写入或覆盖训记训练。
```

## 保存位置与数据边界

- D1 `COACH_DB`：工作流、证据版本、当前总纲、偏好快照、Google Docs 镜像状态/链接和历史索引的规范状态。
- 训记：实际训练、饮食和身体记录的事实来源。
- ChatGPT Health：Apple Health 身体与生理数据的读取入口；原始时间序列不复制到 Worker、D1、R2、Google Drive 或训记。
- R2 `COACH_ARCHIVE`：仅在部署者明确启用后保存私有 Markdown 归档；未配置不影响主流程。
- Google Docs：经独立明确授权后创建的尽力、人类可读镜像；每个总纲版本创建新文档，周/日调整不自动改写。它可以包含用户已授权的最小派生健康摘要，但不得包含 Health 原始时间序列，也不是 Schedule 的硬依赖。

所有写入仍遵循 `讨论草案 → prepare 精确预览 → 用户明确确认 → commit`。账号 Skill、定时任务和普通对话都不能绕过这个边界。
