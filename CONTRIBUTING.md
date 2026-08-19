# Contributing

感谢你改进 Xunji Cloud Coach。这个项目处理训练和身体健康数据，因此对写入安全、隐私与可验证性要求高于普通示例项目。

## 开发流程

1. Fork 仓库并从 `main` 创建分支；
2. 保持改动小而聚焦；
3. 不提交真实 API Key、Worker URL、KV ID、健康数据或用户记录；
4. 运行 `npm test` 和 `npm run check`；
5. 在 Pull Request 中说明安全边界是否变化，以及哪些行为经过测试。

## 写入路径的硬性要求

- 用户确认前不得调用训记写入接口；
- `prepare` 必须是纯本地预览，不能转发上游 dry-run；
- 训练总纲必须先展示并确认，再保存到自托管 KV；周计划不得在总纲缺失时自行生成方向；
- commit 必须可安全重放，重复请求不得重复创建训练；
- 结果不明时必须先查询对账，不能盲目重试；
- 新增或修改写入逻辑时，必须添加失败、重放与重复记录测试；
- 不能把健康指标解释为医疗诊断。

## Skill 约定

每个 Skill 保持自包含：

```text
skill-name/
├── SKILL.md
├── agents/openai.yaml
├── references/api.md
└── scripts/api.py
```

`SKILL.md` 只保留工作流和决策规则，详细字段放进 `references/`，可重复执行的网络请求放进 `scripts/`。凭据只能来自环境变量或用户本地凭据文件。

## Pull Request 检查表

- [ ] 没有真实凭据、个人 URL、KV ID 或用户数据；
- [ ] 测试覆盖新增行为；
- [ ] `npm test` 通过；
- [ ] `npm run check` 通过；
- [ ] 文档与实际工具 schema 一致；
- [ ] 没有把预览描述成可能触发上游写入的 dry-run。

安全漏洞请不要提交公开 Issue，按 [SECURITY.md](SECURITY.md) 处理。
