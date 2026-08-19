---
name: xunji-food-data
description: 读取、搜索、整理或经用户确认后写回训记饮食记录，搜索官方食物，管理自定义食物与饮食模板。仅当用户明确要求处理训记饮食、营养、食物、餐次或模板数据时使用。
---

# 训记饮食数据

## 工作流

1. 只读取用户明确需要的日期和食物；默认范围限制为过去一年至未来三个月，不要为模糊问题扫描全量。
2. 阅读 [references/api.md](references/api.md) 后构造请求。使用 `scripts/api.py`，不要把 Key 放进命令参数、请求 body、query、日志或回复。
3. 按完整查询条件缓存本轮结果，并按日期、餐次、食物名和记录 id 索引；同一条件不要重复请求。
4. 记录官方食物前先搜索，优先使用 `res.foods` 的 `uniquekey`、`ntr`、`units`。食物匹配、单位或份量不确定时先让用户确认。
5. 只有官方搜索无合适结果或用户明确要求私有食物时，才研究公开营养信息并提议创建自定义食物。不得估算营养值。
6. 写回、创建/更新自定义食物或套用模板前，展示日期、餐次、食物、数量、单位、营养来源和会被覆盖的记录；等待用户明确确认。确认前不得传 `--confirmed`。
7. 用户确认后执行真实写回并传 `--confirmed`。创建自定义食物后，用服务端返回的 `res.food` 再写饮食记录。写回成功后覆盖缓存；不要因查询缺项而删除旧记录。

## 请求器

```bash
python3 scripts/api.py food-query --payload /tmp/request.json
python3 scripts/api.py food-search --payload /tmp/request.json
python3 scripts/api.py template-list --payload /tmp/request.json
python3 scripts/api.py food-upsert --payload /tmp/request.json --confirmed
python3 scripts/api.py custom-food-upsert --payload /tmp/request.json --confirmed
python3 scripts/api.py template-apply --payload /tmp/request.json --confirmed
```

请求器从 `XUNJI_FOOD_API_KEY`、`XUNJI_FOOD_SEARCH_API_KEY`，或 `~/.codex/secrets/xunji-open-api.json` 的 `food`、`food_search` 字段读取凭据。

## 错误处理

- `too frequent`：按 `retry_after_ms` 等待；饮食记录与食物搜索分别限频，不要立即重复请求。
- `apikey missing` / `apikey invalid`：让用户在 App 重新申请并提供最新版饮食数据 Skill。
- `仅VIP可用`：说明当前账号需要会员权限。
