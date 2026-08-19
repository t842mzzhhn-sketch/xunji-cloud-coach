# 饮食、食物与模板 API

## 端点

饮食 Base URL 为 `https://eatings.xunjiapp.cn`：

- `food-query`: `POST /open/food/query_gzip`
- `food-upsert`: `POST /open/food/upsert_gzip`
- `custom-food-upsert`: `POST /open/food/custom/upsert_gzip`
- `template-list`: `POST /open/food/templates/list_gzip`
- `template-apply`: `POST /open/food/templates/apply_gzip`

官方食物搜索为 `food-search`: `POST https://api.xunjiapp.cn/open_agent/food/search_gzip`。成功时 `success === true`，核心数据在 `res`。同一用户同类 endpoint 15 秒一次。

## 查询饮食

```json
{"start_date":"2025-08-02","end_date":"2026-09-12","include_detail":true}
```

日期不得早于当前日期前一年，不得晚于未来三个月。用户要求更大范围时解释限制，只请求允许范围。

## 搜索官方食物

```json
{"keyword":"鸡蛋","limit":8}
```

- 优先使用 `res.foods`；`ntr` 是每 100g 营养，`units` 是单位换算，`uniquekey` 写回时必须保留。
- `res.d` 格式为 `[id, name, cal, carb, fat, protein, foodpic, uniquekey, units]`。
- 不得凭相似名称自动写回；让用户确认食物、单位和份量。

## 自定义食物

仅在没有合适官方食物或用户明确要求私有食物时使用。创建前展示公开来源或包装标签，并确认名称及每 100g 的热量、蛋白质、脂肪、碳水；不得估算。

```json
{
  "client_request_id": "unique-id",
  "dry_run": false,
  "food": {
    "name": "用户确认的食物名",
    "ntr": {
      "cal": 165,
      "protein": 31,
      "fat": 3.6,
      "carb": 0,
      "foodpic": "",
      "foodUnit": [{"unit":"份","count":"1","gram":100}]
    },
    "units": [{"unit":"份","count":"1","gram":100}]
  }
}
```

`units` 与 `ntr.foodUnit` 必须一致。没有明确份量单位时两者传空数组，默认按克。创建成功后使用 `res.food` 的 `name`、`uniquekey`、`unit/units`、`ntr` 写饮食记录。

## 写回饮食

```json
{
  "client_request_id": "unique-id",
  "dry_run": false,
  "foods": [{
    "date": "2026-06-12",
    "meal_type": "lunch",
    "name": "鸡胸肉",
    "amount": 150,
    "unit": "g",
    "uniquekey": "搜索或创建返回值",
    "ntr": {"cal":165,"protein":31,"fat":3.6,"carb":0}
  }]
}
```

- 写回前必须有用户确认过的 `ntr`；接口不会搜索或猜营养。
- 有记录 id 时更新，无 id 时新建。除非用户明确要求，不得删除旧记录。
- 查询模板无需写回确认；套用模板属于写回，必须展示模板、日期和将创建的记录后确认。
