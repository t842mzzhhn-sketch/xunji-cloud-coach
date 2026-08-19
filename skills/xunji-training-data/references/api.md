# 训练与官方计划 API

## 端点

| 操作 | URL | 限频 |
| --- | --- | --- |
| `train-query` | `POST https://trains.xunjiapp.cn/api_trains_for_llm_v2` | 同一日轻量读取 15 秒；完整读取 30 秒 |
| `movement-catalog` | `POST https://trains.xunjiapp.cn/api_movement_catalog_for_llm_v2` | 云端连接器缓存目录，避免连续请求 |
| `train-upsert` | `POST https://trains.xunjiapp.cn/api_upsert_trains_for_llm_v2` | 同一日写回 45 秒 |
| `plan-query` | `POST https://api.xunjiapp.cn/open/plan/query_gzip` | 同一操作与计划实例 15 秒 |

训练成功响应的核心数据在 `res`，不要强制要求 `success === true`。请求头为 Bearer 鉴权、`Content-Type: application/json`；计划接口可返回 gzip。

## 读取训练

```json
{
  "schema_version": "train_open_api_v2",
  "datestr": "2026-04-02",
  "include_full_data": false
}
```

- 普通读取用 `false`；未打勾组、RPE、备注、完成感受、左右侧重量、实练秒数、休息秒数、动作难度、历史颜色或心率用 `true`。
- 记录位于 `res.trains`。更新旧训练时保留 `localid`、`start`、`end`。
- 有氧、计时、Tabata、苹果健康等动作的摘要在 `sets[].metrics`。
- 整次训练心率在 `trains[].heartRate`；动作级摘要在 `sets[].metrics.avgHeartRate/maxHeartRate/minHeartRate`；压缩趋势在 `sets[].heartRate`。
- `sets[].heartRate` 含 `avg/max/min/duration/count/step/values/peak`；`values` 最多 50 个分桶平均 BPM，第 N 点约对应 `N * step` 秒。接口不返回原始心率数组。
- 超级组子动作在 `sets[].items[]`；完整模式的普通递减组在 `sets[].dropSets[]`。

## 搜索标准动作

```json
{"schema_version":"train_open_api_v2"}
```

- 动作位于 `res.movements`，当前字段包括 `name`、`aliases`、`type`、`exetype`。
- 云端连接器通过 `xunji_movement_search` 按名称、别名、部位或记录类型筛选，并将目录在 KV 中缓存 6 小时。响应 `movement_catalog_search_v2` 同时返回 `matches[].match_type`、`matched_value`、`identity_status`、`identity_confidence` 和 `requires_identity_confirmation`。
- 写回只使用搜索结果中的标准 `name`，不传内部 `key`。
- 目录不返回动画或视频 URL；使用标准名可让训记 App 匹配已有动作讲解，但不能据此保证每个动作都有动画。
- `exact_unique` 只说明中文标准名或别名唯一匹配，不说明动作适合当前用户。写回前还要核对目标动作模式、训练部位、器械、经验、伤病禁忌和具体变式。
- `ambiguous`、`filter_only` 或多个近似动作时，展示 2–3 个候选及 `type`、`exetype`、变式差异，让用户选择；不得因排序第一就静默采用。
- 如果动作来自官方计划且中文名精确、又符合用户约束，可以作为最高优先级身份来源；官方计划仍只是参考，不能替代用户总纲或个体适用性判断。

## 读取官方计划

先列出计划，再用返回的 `plan_ref` 查询。`platform:155` 与 `universal:155` 是不同实例。

```json
{"schema_version":"plan_open_api_v1","action":"list"}
```

```json
{
  "schema_version": "plan_open_api_v1",
  "action": "get",
  "plan_ref": "platform:155",
  "start_date": "2026-07-12",
  "end_date": "2026-08-12",
  "include_movements": true
}
```

- `list` 返回 `res.plans`；`get` 返回 `res.plan`、`res.date_range`、`res.days`。
- `get` 不传日期时默认今天前 7 天至后 30 天；自定义范围最多 92 天。
- 只需日历时用 `include_movements: false`。计划只读，不得尝试写入。

## 写回训练

> [!WARNING]
> 不要把训练接口的 `dry_run: true` 当作无副作用预览。用户确认前只运行请求器的 `--validate-only` 本地校验；确认后固定发送 `dry_run: false` 并传 `--confirmed`。任何自动化两阶段流程都应在本地生成预览，而不是调用上游 dry-run。

```json
{
  "schema_version": "train_open_api_v2",
  "client_request_id": "unique-id",
  "dry_run": false,
  "include_full_data": false,
  "res": [{
    "datestr": "2026-04-02",
    "localid": 123456,
    "title": "胸部训练",
    "start": 1744010000000,
    "end": 1744013600000,
    "movements": [{"name":"杠铃卧推","sets":[
      {"done":true,"weight":"60","unit":"kg","reps":"10"}
    ]}]
  }]
}
```

- `res` 可为数组或 `{ "trains": [...] }`；单次最多 4 条且属于同一天。
- 真实写入必须带稳定且唯一的 `client_request_id`；不确定上次请求是否成功时先查询目标日期对账，不要直接重试创建。
- 每条最多 15 个动作，每动作最多 20 组。
- 动作只传中文 `name`，不传内部 `key`。不确定时先调用实时动作搜索；GitHub 名单仅作为离线参考。
- 有 `localid` 更新，无 `localid` 新建。保留未要求修改的训练和 note 字段。
- 组至少包含 `weight`/`weight_kg`、`reps`、`time`/`duration_s`、`selfWeight` 之一。未完成组保留为 `done: false`。

### 原生有氧日

使用一个 `cardio: true` 的 movement，不传 `sets`，指标写在 movement 顶层 `metrics`。`recordPreset` 可用 `general`、`running`、`walking`、`cycling`、`swimming`、`jumpRope`、`hiit` 等。

```json
{"datestr":"2026-04-02","title":"跑步","start":1744010000000,"end":1744011800000,"movements":[{"name":"跑步","cardio":true,"recordPreset":"running","metrics":{"distance":"5","pace":"6:00","cadence":"170","kcal":"300","bpm":"140"}}]}
```

### RPE、难度与颜色

- 组 RPE 写在 `sets[].rpe`，只用字符串 `6`、`6.5`、`7`、`7.5`、`8`、`8.5`、`9`、`9.5`、`10`；清空用 `""`。
- 超级组/递减组子项 RPE 写在 `sets[].items[].set.rpe`。
- 动作难度写在 `movements[].difficulty`，只用 `easy`、`normal`、`hard`。
- 历史颜色位于 `note.trainColor`，使用 CSS 十六进制；清空用 `""`。合并 note，保留 `text`、`heartRate`、`customTitle`、`personalworkout_*` 等字段。
