---
name: xunji-training-data
description: 读取、整理、导出或经用户确认后写回训记训练记录，并读取训记官方训练计划。仅当用户明确要求处理训记训练数据、心率、RPE、动作难度、训练颜色、有氧记录或官方计划时使用。
---

# 训记训练数据

## 工作流

1. 只处理用户明确指定的训练日期、训练记录或官方计划；不要主动扫描其他日期。
2. 阅读 [references/api.md](references/api.md) 后构造请求。使用 `scripts/api.py`，不要把 Key 放进命令参数、请求 body、query、日志或回复。
3. 普通读取默认 `include_full_data: false`。涉及未完成组、RPE、备注、动作难度、颜色、左右重量、实练/休息秒数或心率时改为 `true`。
4. 按 `datestr + include_full_data` 缓存本轮读取结果，同一条件不要重复请求。写回成功后用服务端返回的标准化数据覆盖缓存。
5. 修改旧训练前读取完整原记录并保留未要求修改的字段。动作选择分两步：先确认标准动作身份，再判断训练适用性。优先采用与用户器械、经验、目标和伤病限制兼容的官方计划精确动作名；否则调用实时动作目录搜索。唯一精确名称/别名只表示身份匹配，前缀/包含匹配或多个候选必须展示差异并让用户选择。只从返回的官方中文标准名写回。
6. 写回前展示日期、训练标题、动作、组数、重量/次数/时长，以及所有被覆盖字段；等待用户明确确认。确认前只能用 `--validate-only` 做本地 JSON 校验，不得向训练写入端点发送任何请求。
7. 用户确认后，把 payload 固定为 `dry_run: false`，执行一次真实写回并传 `--confirmed`。训练上游的 `dry_run: true` 不视为无副作用预览，禁止发送。不要因读取结果缺项而删除旧数据。

## 请求器

```bash
python3 scripts/api.py train-query --payload /tmp/request.json
python3 scripts/api.py plan-query --payload /tmp/request.json
python3 scripts/api.py train-upsert --payload /tmp/request.json --validate-only
python3 scripts/api.py train-upsert --payload /tmp/request.json --confirmed
```

请求器从 `XUNJI_TRAIN_API_KEY` 或 `~/.codex/secrets/xunji-open-api.json` 的 `training` 字段读取凭据。它只输出服务端响应，不输出凭据。

`--validate-only` 在读取凭据和网络请求之前结束，只确认输入是 JSON 对象。它不是训记服务端 dry-run。

## 错误处理

- `too frequent`：读取 `retry_after_ms` 并等待后重试，不要提前重复请求。
- `apikey missing` / `apikey invalid`：让用户在 App 重新申请并提供最新版训练数据 Skill。
- `仅VIP可用`：说明当前账号需要会员权限。
- 训练没有任何训练级或动作级心率字段时，说明没有可导出的心率数据；不要因缺少原始数组判断接口失败。
