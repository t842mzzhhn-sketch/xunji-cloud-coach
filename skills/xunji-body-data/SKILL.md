---
name: xunji-body-data
description: 读取、导出、总结、对比或经用户确认后写入训记体重、体脂率和身体围度数据。仅当用户明确要求处理训记身体指标或身体趋势时使用；分析仅作谨慎的数据说明，不作医疗诊断。
---

# 训记身体数据

## 工作流

1. 只读取用户明确指定的日期范围和指标类型。按日期范围、类型、分页条件缓存本轮结果，相同条件不要重复请求。
2. 阅读 [references/api.md](references/api.md) 后构造请求。使用 `scripts/api.py`，不要把 Key 放进命令参数、请求 body、query、日志或回复。
3. 总结趋势时说明数据覆盖范围和缺失值，不作医疗诊断。
4. 写入前先发送 `dry_run: true`，且不得传 `confirmed: true` 或命令行 `--confirmed`。
5. 把服务端 `res.summary` 整理为日期、指标、数值、单位、新建/覆盖状态的清晰摘要，等待用户明确确认。
6. 用户确认后，使用相同记录发送 `dry_run: false`、`confirmed: true`，同时传命令行 `--confirmed`。成功后用服务端返回数据覆盖缓存。

## 请求器

```bash
python3 scripts/api.py body-query --payload /tmp/request.json
python3 scripts/api.py body-upsert --payload /tmp/request.json
python3 scripts/api.py body-upsert --payload /tmp/confirmed-request.json --confirmed
```

请求器从 `XUNJI_BODY_API_KEY` 或 `~/.codex/secrets/xunji-open-api.json` 的 `body` 字段读取凭据。真实写入同时缺少 CLI 确认或 payload 的 `confirmed: true` 时会在本地拒绝。

## 错误处理

- `too frequent`：按 `retry_after_ms` 等待后重试。
- `user confirmation required`：重新展示摘要，等待确认后再提交。
- `apikey missing` / `apikey invalid`：让用户在 App 重新申请并提供最新版身体数据 Skill。
- `仅VIP可用`：说明当前账号需要会员权限。
