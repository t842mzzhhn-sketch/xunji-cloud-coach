# 身体数据 API

## 端点与响应

- Base URL: `https://api.xunjiapp.cn`
- `body-query`: `POST /open/body/query_gzip`
- `body-upsert`: `POST /open/body/upsert_gzip`
- 成功条件：`success === true`；核心数据在 `res`。
- 同一 Key 同一 endpoint 15 秒一次。

## 查询

```json
{
  "start_date": "2026-01-01",
  "end_date": "2026-06-28",
  "types": ["weight", "bodyfat"],
  "include_latest": true,
  "include_records": true,
  "limit": 500,
  "offset": 0
}
```

- 不传 `types` 读取全部；只看体重用 `["weight"]`，只看体脂用 `["bodyfat"]`。
- `records[]` 按日期倒序，每条含 `datestr`、`type`、`value`、`unit`、`label`、`label_en`。
- `latest` 是每类最新记录；`by_type` 按类型归组本页记录。

## 写入协议

按 `datestr + type` upsert。必须先 dry run：

```json
{
  "schema_version": "body_open_api_v1",
  "client_request_id": "unique-id",
  "dry_run": true,
  "records": [
    {"datestr":"2026-06-28","type":"weight","value":72.4},
    {"datestr":"2026-06-28","type":"bodyfat","value":18.2}
  ]
}
```

向用户展示 `res.summary` 并获得确认后，用相同记录提交：

```json
{
  "schema_version": "body_open_api_v1",
  "client_request_id": "同一请求标识",
  "dry_run": false,
  "confirmed": true,
  "records": [{"datestr":"2026-06-28","type":"weight","value":72.4}]
}
```

## 指标类型

| 类型 | 含义 | 单位 |
| --- | --- | --- |
| `weight` | 体重 | kg |
| `bodyfat` | 体脂率 | % |
| `neck`, `chest`, `weist`, `shoulder`, `bot` | 脖围、胸围、腰围、肩宽、臀围 | cm |
| `arm_left`, `arm_right` | 左右臂围 | cm |
| `forearm_left`, `forearm_right` | 左右小臂围 | cm |
| `leg_left`, `leg_right` | 左右腿围 | cm |
| `cav_left`, `cav_right` | 左右小腿围 | cm |

腰围字段历史拼写固定为 `weist`，不得改为 `waist`。
