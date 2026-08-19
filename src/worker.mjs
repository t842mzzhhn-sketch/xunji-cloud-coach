import {
  claimTrainingCommit,
  finalizeTrainingCommit,
  getCurrentPlan,
  getWorkflowContext,
  queryHistory,
  recordPlanMirror,
  saveConfirmedPlan,
  saveTrainingDecision,
  validatePlanEvidence,
} from "./cloud-state.mjs";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const ACCESS_TOKEN_TTL = 60 * 60;
const REFRESH_TOKEN_TTL = 90 * 24 * 60 * 60;
const AUTH_CODE_TTL = 5 * 60;
const CONFIRMATION_TTL = 30 * 60;
const COMMIT_RECEIPT_TTL = 24 * 60 * 60;
const MOVEMENT_CATALOG_CACHE_TTL = 6 * 60 * 60;
const SERVICE_VERSION = "1.5.1";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

const movementSearchOutputSchema = {
  type: "object",
  properties: {
    schema_version: { type: "string", const: "movement_catalog_search_v2" },
    catalog_count: { type: "integer" },
    source: { type: "string", enum: ["cache", "upstream"] },
    query: { type: "object" },
    count: { type: "integer" },
    identity_status: { type: "string", enum: ["exact_unique", "ambiguous", "filter_only", "no_match"] },
    identity_confidence: { type: "string", enum: ["high", "medium", "low", "none"] },
    recommended_name: { type: ["string", "null"] },
    requires_identity_confirmation: { type: "boolean" },
    suitability_status: { type: "string", const: "not_assessed" },
    matches: { type: "array", items: { type: "object" } },
    movements: { type: "array", items: { type: "object" } },
    selection_guidance: { type: "array", items: { type: "string" } },
  },
  required: [
    "schema_version", "catalog_count", "source", "query", "count", "identity_status",
    "identity_confidence", "recommended_name", "requires_identity_confirmation",
    "suitability_status", "matches", "movements", "selection_guidance",
  ],
  additionalProperties: false,
};

const planListOutputSchema = {
  type: "object",
  properties: {
    schema_version: { type: "string", const: "xunji_plan_list_v1" },
    count: { type: "integer" },
    plans: { type: "array", items: { type: "object" } },
  },
  required: ["schema_version", "count", "plans"],
  additionalProperties: false,
};

const planDetailOutputSchema = {
  type: "object",
  properties: {
    schema_version: { type: "string", const: "xunji_plan_detail_v1" },
    plan: { type: ["object", "null"] },
    date_range: { type: ["object", "null"] },
    days: { type: "array", items: { type: "object" } },
  },
  required: ["schema_version", "plan", "date_range", "days"],
  additionalProperties: false,
};

const tools = [
  {
    name: "xunji_training_query",
    title: "查询训记训练记录",
    description:
      "查询明确日期的一天训记训练记录。普通汇总使用 include_full_data=false；只有需要 RPE、备注、未完成组、心率等细节时才设为 true。",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD" },
        include_full_data: { type: "boolean", default: false },
      },
      required: ["date"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "xunji_movement_search",
    title: "搜索训记标准动作",
    description:
      "搜索训记当前可回写的标准动作名，并返回可解释的名称/别名匹配类型。此工具只确认动作身份与兼容性，不判断动作是否适合用户；还必须结合训练目的、器械、经验、伤病和动作变式做适用性判断。",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", maxLength: 50, description: "动作名称或别名关键词。" },
        body_part: { type: "string", maxLength: 30, description: "可选部位筛选，对应目录的 type 字段，如 胸、背、腿。" },
        exetype: { type: "string", maxLength: 30, description: "可选动作记录类型筛选。" },
        limit: { type: "integer", minimum: 1, maximum: 30, default: 10 },
      },
      additionalProperties: false,
    },
    outputSchema: movementSearchOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "xunji_training_plan_list",
    title: "列出训记官方训练计划",
    description: "列出当前账号可读取的训记官方训练计划及其 plan_ref。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: planListOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "xunji_training_plan_get",
    title: "读取训记官方训练计划",
    description: "按 plan_ref 和日期范围读取官方计划，范围最多 92 天。",
    inputSchema: {
      type: "object",
      properties: {
        plan_ref: { type: "string" },
        start_date: { type: "string", description: "YYYY-MM-DD" },
        end_date: { type: "string", description: "YYYY-MM-DD" },
        include_movements: { type: "boolean", default: true },
      },
      required: ["plan_ref", "start_date", "end_date"],
      additionalProperties: false,
    },
    outputSchema: planDetailOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "xunji_food_query",
    title: "查询训记饮食记录",
    description:
      "查询明确日期范围的饮食记录。范围只能在过去一年到未来三个月内；同一任务不要重复调用相同条件。",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "YYYY-MM-DD" },
        end_date: { type: "string", description: "YYYY-MM-DD" },
        include_detail: { type: "boolean", default: true },
      },
      required: ["start_date", "end_date"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "xunji_body_query",
    title: "查询训记身体数据",
    description: "查询明确日期范围内的体重、体脂率或身体围度。趋势说明不构成医疗诊断。",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "YYYY-MM-DD" },
        end_date: { type: "string", description: "YYYY-MM-DD" },
        types: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "weight", "bodyfat", "neck", "chest", "weist", "shoulder", "bot",
              "arm_left", "arm_right", "forearm_left", "forearm_right", "leg_left",
              "leg_right", "cav_left", "cav_right"
            ],
          },
        },
        include_latest: { type: "boolean", default: true },
        include_records: { type: "boolean", default: true },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 500 },
        offset: { type: "integer", minimum: 0, default: 0 },
      },
      required: ["start_date", "end_date"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "xunji_workflow_context_get",
    title: "启动云端教练工作流",
    description:
      "每次规划或调整的首个调用。根据用户意图选择 training_planner、weekly_adjustment 或 daily_adjustment，并从 Cloudflare D1 读取工作流、医学证据、当前总纲、偏好和历史索引；调用成功前不要生成计划，也不要读取本地 Skill 或仓库文件。",
    inputSchema: {
      type: "object",
      properties: {
        workflow: {
          type: "string",
          enum: ["training_planner", "weekly_adjustment", "daily_adjustment"],
        },
        history_limit: { type: "integer", minimum: 1, maximum: 20, default: 8 },
      },
      required: ["workflow"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "xunji_coaching_plan_get",
    title: "读取已确认的训练总纲",
    description: "读取保存在当前自托管 Worker 中的 1–2 个月训练总纲。周计划调整前必须先调用；不存在时不得用默认模板代替。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "xunji_coaching_history_query",
    title: "查询训练规划历史索引",
    description:
      "查询 D1 中的总纲版本和周/日调整记录索引。长文本归档位于私有 R2；实际训练完成记录仍以训记为准。",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["all", "plans", "training_decisions"], default: "all" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        include_detail: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "xunji_prepare_coaching_plan_upsert",
    title: "准备保存训练总纲",
    description:
      "只在 Worker 内部校验并预览总纲，不修改当前总纲。必须先与用户讨论目标、经验、器械、时间、伤病禁忌和偏好，并展示完整方案。",
    inputSchema: {
      type: "object",
      properties: {
        plan: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1 },
            start_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            end_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            goal: { type: "string", minLength: 1 },
            success_metrics: { type: "array", items: { type: "string" }, minItems: 1 },
            weekly_structure: { type: "array", items: { type: "string" }, minItems: 1 },
            progression_rules: { type: "array", items: { type: "string" }, minItems: 1 },
            recovery_rules: { type: "array", items: { type: "string" }, minItems: 1 },
            missed_session_rules: { type: "array", items: { type: "string" }, minItems: 1 },
            guardrails: { type: "array", items: { type: "string" }, minItems: 1 },
            evidence_version: { type: "string", minLength: 1 },
            evidence_refs: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  id: { type: "string", minLength: 1 },
                  title: { type: "string", minLength: 1 },
                  url: { type: "string", minLength: 1 },
                  applies_to: { type: "array", items: { type: "string" }, minItems: 1 },
                },
                required: ["id", "title", "url", "applies_to"],
                additionalProperties: false,
              },
            },
            baseline_window_days: { type: "integer", minimum: 14, maximum: 60 },
            decision_rules: { type: "array", items: { type: "string" }, minItems: 1 },
            data_quality_rules: { type: "array", items: { type: "string" } },
            constraints: { type: "array", items: { type: "string" } },
            review_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            profile_snapshot: {
              type: "object",
              description: "只保存制定计划所需的偏好与约束，不保存 Apple Health 原始时间序列。",
              properties: {
                training_experience: { type: "string", minLength: 1 },
                equipment: { type: "array", items: { type: "string" } },
                weekly_availability: { type: "array", items: { type: "string" }, minItems: 1 },
                session_duration_minutes: { type: "integer", minimum: 10, maximum: 300 },
                preferences: { type: "array", items: { type: "string" } },
                constraints: { type: "array", items: { type: "string" } },
                safety_constraints: { type: "array", items: { type: "string" } },
              },
              required: [
                "training_experience", "equipment", "weekly_availability",
                "session_duration_minutes", "preferences", "constraints", "safety_constraints"
              ],
              additionalProperties: false,
            },
            baseline_summary: {
              type: "object",
              description: "派生的趋势摘要，不得包含逐条 Apple Health 原始测量。",
              properties: {
                observed_window_days: { type: "integer", minimum: 14, maximum: 60 },
                training_summary: { type: "string" },
                body_trend_summary: { type: "string" },
                recovery_summary: { type: "string" },
                data_quality_notes: { type: "array", items: { type: "string" } },
              },
              required: [
                "observed_window_days", "training_summary", "body_trend_summary",
                "recovery_summary", "data_quality_notes"
              ],
              additionalProperties: false,
            },
            notes: { type: "string" },
          },
          required: [
            "title", "start_date", "end_date", "goal", "success_metrics", "weekly_structure",
            "progression_rules", "recovery_rules", "missed_session_rules", "guardrails",
            "evidence_version", "evidence_refs", "baseline_window_days", "decision_rules",
            "review_date", "profile_snapshot", "baseline_summary"
          ],
          additionalProperties: false,
        },
      },
      required: ["plan"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "xunji_commit_coaching_plan_upsert",
    title: "确认保存训练总纲",
    description:
      "保存此前预览的训练总纲。仅在用户已经看到完整方案并明确确认后调用；相同确认令牌重复调用只返回原结果。",
    inputSchema: {
      type: "object",
      properties: {
        confirmation_token: { type: "string" },
        user_confirmed: { type: "boolean", const: true },
      },
      required: ["confirmation_token", "user_confirmed"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "xunji_commit_coaching_plan_mirror",
    title: "记录训练总纲的 Google Docs 镜像",
    description:
      "在已确认总纲提交后，记录 Google Docs 尽力镜像的成功链接或稳定失败码。它不创建文档、不修改总纲，也不能记录 Apple Health 原始数据；同一计划已成功记录后不得覆盖。",
    inputSchema: {
      type: "object",
      properties: {
        plan_version: { type: "string", minLength: 1 },
        provider: { type: "string", const: "google_docs" },
        status: { type: "string", enum: ["stored", "failed"] },
        document_id: { type: "string", minLength: 20 },
        document_url: { type: "string", format: "uri" },
        error_code: {
          type: "string",
          pattern: "^[a-z0-9._-]{1,80}$",
          description: "失败时记录的稳定短错误码；不得写入原始错误正文、令牌或健康数据。",
        },
      },
      required: ["plan_version", "provider", "status"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "xunji_prepare_training_upsert",
    title: "准备训记训练变更",
    description:
      "只在 Worker 内部校验并生成变更摘要和确认令牌，不调用训记写入接口。调用后必须向用户展示日期、标题、动作、组数、重量/次数/时长及覆盖字段，并等待明确确认。更新已有 localid 前必须先完整读取原记录并保留未要求修改的字段。",
    inputSchema: {
      type: "object",
      properties: {
        trains: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            description: "符合训记 train_open_api_v2 的单条训练记录。规范字段为 datestr 和 movements。",
            properties: {
              datestr: {
                type: "string",
                pattern: "^\\d{4}-\\d{2}-\\d{2}$",
                description: "训练日期，YYYY-MM-DD。",
              },
              title: { type: "string", minLength: 1 },
              localid: { description: "更新已有训练时保留服务端返回的 localid。" },
              start: { type: "integer", description: "训练开始时间戳（毫秒），如有则保留。" },
              end: { type: "integer", description: "训练结束时间戳（毫秒），如有则保留。" },
              movements: {
                type: "array",
                maxItems: 15,
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string", minLength: 1, description: "训记官方中文动作名。" },
                    cardio: { type: "boolean" },
                    difficulty: { type: "string", enum: ["easy", "normal", "hard"] },
                    sets: {
                      type: "array",
                      maxItems: 20,
                      items: {
                        type: "object",
                        properties: {
                          done: { type: "boolean" },
                          weight: {},
                          weight_kg: {},
                          unit: { type: "string" },
                          reps: {},
                          time: {},
                          duration_s: {},
                          selfWeight: {},
                          rpe: {},
                        },
                        additionalProperties: true,
                      },
                    },
                    metrics: { type: "object", additionalProperties: true },
                  },
                  required: ["name"],
                  additionalProperties: true,
                },
              },
            },
            required: ["datestr", "title", "movements"],
            additionalProperties: true,
          },
        },
        decision_context: {
          type: "object",
          description: "用于长期归档的调整依据。只保存摘要，不保存 Apple Health 原始记录。",
          properties: {
            workflow: { type: "string", enum: ["manual_update", "weekly_adjustment", "daily_adjustment"] },
            plan_version: { type: "string" },
            evidence_version: { type: "string" },
            rationale: { type: "array", items: { type: "string" }, minItems: 1 },
            data_window: {
              type: "object",
              properties: {
                start_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
                end_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
              },
              required: ["start_date", "end_date"],
              additionalProperties: false,
            },
            data_quality: { type: "array", items: { type: "string" } },
          },
          required: ["workflow", "rationale"],
          additionalProperties: false,
        },
      },
      required: ["trains"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "xunji_commit_training_upsert",
    title: "确认写入训记训练变更",
    description:
      "真正写入此前本地预览的训练变更。仅在用户已经看过摘要并明确确认后调用；相同确认令牌重复调用会返回同一提交结果，不会再次写入。",
    inputSchema: {
      type: "object",
      properties: {
        confirmation_token: { type: "string" },
        user_confirmed: { type: "boolean", const: true },
      },
      required: ["confirmation_token", "user_confirmed"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

function responseJson(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { ...jsonHeaders, ...headers } });
}

function b64url(bytes) {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function randomToken(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function constantTimeEqual(left, right) {
  const [a, b] = await Promise.all([sha256(left), sha256(right)]);
  let diff = a.length ^ b.length;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

function assertDate(value, field) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "") || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${field} 必须是有效的 YYYY-MM-DD`);
  }
}

function dayNumber(value) {
  return Math.floor(Date.parse(`${value}T00:00:00Z`) / 86_400_000);
}

function assertDateRange(start, end, maximumDays) {
  assertDate(start, "start_date");
  assertDate(end, "end_date");
  const span = dayNumber(end) - dayNumber(start);
  if (span < 0) throw new Error("end_date 不能早于 start_date");
  if (maximumDays != null && span + 1 > maximumDays) throw new Error(`日期范围不能超过 ${maximumDays} 天`);
}

function normalizeTrainingRecords(trains) {
  if (!Array.isArray(trains)) return trains;
  return trains.map((rawTrain) => {
    if (!rawTrain || typeof rawTrain !== "object" || Array.isArray(rawTrain)) return rawTrain;
    if (rawTrain.datestr != null && rawTrain.date != null && rawTrain.datestr !== rawTrain.date) {
      throw new Error("trains[].date 与 trains[].datestr 不一致");
    }
    const { date, actions, ...train } = rawTrain;
    const rawMovements = train.movements ?? actions;
    const movements = Array.isArray(rawMovements)
      ? rawMovements.map((rawMovement) => {
        if (!rawMovement || typeof rawMovement !== "object" || Array.isArray(rawMovement)) return rawMovement;
        const movement = { ...rawMovement };
        if (Array.isArray(movement.sets)) {
          movement.sets = movement.sets.map((rawSet) => {
            if (!rawSet || typeof rawSet !== "object" || Array.isArray(rawSet)) return rawSet;
            const { duration_sec: durationSec, ...set } = rawSet;
            if (set.time == null && set.duration_s == null && durationSec != null) set.duration_s = durationSec;
            return set;
          });
        }
        return movement;
      })
      : rawMovements;
    return {
      ...train,
      datestr: train.datestr ?? date,
      movements,
    };
  });
}

function validateTrainingRecords(trains) {
  if (!Array.isArray(trains) || trains.length < 1 || trains.length > 4) {
    throw new Error("trains 必须包含 1 到 4 条记录");
  }
  const dates = new Set();
  for (const train of trains) {
    assertDate(train?.datestr, "trains[].datestr");
    dates.add(train.datestr);
    if (typeof train.title !== "string" || !train.title.trim()) throw new Error("每条训练必须有 title");
    if (!Array.isArray(train.movements) || train.movements.length > 15) {
      throw new Error("每条训练的 movements 必须是数组且最多 15 个动作");
    }
    for (const movement of train.movements) {
      if (typeof movement?.name !== "string" || !movement.name.trim()) throw new Error("每个动作必须有中文 name");
      if (movement.sets != null && (!Array.isArray(movement.sets) || movement.sets.length > 20)) {
        throw new Error("每个动作最多 20 组");
      }
    }
  }
  if (dates.size !== 1) throw new Error("单次写入的训练记录必须属于同一天");
}

function summarizeTraining(trains) {
  return trains.map((train) => ({
    date: train.datestr,
    operation: train.localid == null ? "create" : "update",
    localid: train.localid ?? null,
    title: train.title,
    start: train.start ?? null,
    end: train.end ?? null,
    movements: train.movements.map((movement) => ({
      name: movement.name,
      cardio: movement.cardio === true,
      difficulty: movement.difficulty ?? null,
      set_count: Array.isArray(movement.sets) ? movement.sets.length : 0,
      sets: (movement.sets || []).map((set) => ({
        done: set.done ?? null,
        weight: set.weight ?? set.weight_kg ?? null,
        unit: set.unit ?? null,
        reps: set.reps ?? null,
        duration_s: set.time ?? set.duration_s ?? null,
        rpe: set.rpe ?? null,
      })),
      metrics: movement.metrics ?? null,
    })),
  }));
}

function validateCoachingPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("plan 必须是对象");
  assertDateRange(plan.start_date, plan.end_date, 70);
  if (dayNumber(plan.end_date) - dayNumber(plan.start_date) + 1 < 28) {
    throw new Error("训练总纲必须覆盖 28 到 70 天");
  }
  for (const field of ["title", "goal"]) {
    if (typeof plan[field] !== "string" || !plan[field].trim()) throw new Error(`plan.${field} 不能为空`);
  }
  for (const field of ["success_metrics", "weekly_structure", "progression_rules", "recovery_rules", "missed_session_rules", "guardrails", "decision_rules"]) {
    if (!Array.isArray(plan[field]) || !plan[field].length || plan[field].some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`plan.${field} 必须是非空字符串数组`);
    }
  }
  if (typeof plan.evidence_version !== "string" || !plan.evidence_version.trim()) {
    throw new Error("plan.evidence_version 不能为空");
  }
  if (!Number.isInteger(plan.baseline_window_days) || plan.baseline_window_days < 14 || plan.baseline_window_days > 60) {
    throw new Error("plan.baseline_window_days 必须是 14 到 60 的整数");
  }
  if (!Array.isArray(plan.evidence_refs) || !plan.evidence_refs.length || plan.evidence_refs.some((ref) => (
    !ref || typeof ref !== "object" || Array.isArray(ref)
    || typeof ref.id !== "string" || !ref.id.trim()
    || typeof ref.title !== "string" || !ref.title.trim()
    || typeof ref.url !== "string" || !ref.url.trim()
    || !Array.isArray(ref.applies_to) || !ref.applies_to.length
    || ref.applies_to.some((item) => typeof item !== "string" || !item.trim())
  ))) {
    throw new Error("plan.evidence_refs 必须是非空的结构化证据数组");
  }
  if (plan.data_quality_rules != null && (!Array.isArray(plan.data_quality_rules) || plan.data_quality_rules.some((item) => typeof item !== "string"))) {
    throw new Error("plan.data_quality_rules 必须是字符串数组");
  }
  if (plan.constraints != null && (!Array.isArray(plan.constraints) || plan.constraints.some((item) => typeof item !== "string"))) {
    throw new Error("plan.constraints 必须是字符串数组");
  }
  assertDate(plan.review_date, "plan.review_date");
  if (dayNumber(plan.review_date) < dayNumber(plan.start_date) || dayNumber(plan.review_date) > dayNumber(plan.end_date)) {
    throw new Error("plan.review_date 必须位于训练总纲周期内");
  }
  const profile = plan.profile_snapshot;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error("plan.profile_snapshot 必须是对象");
  if (typeof profile.training_experience !== "string" || !profile.training_experience.trim()) {
    throw new Error("plan.profile_snapshot.training_experience 不能为空");
  }
  for (const field of ["equipment", "weekly_availability", "preferences", "constraints", "safety_constraints"]) {
    if (!Array.isArray(profile[field]) || profile[field].some((item) => typeof item !== "string")) {
      throw new Error(`plan.profile_snapshot.${field} 必须是字符串数组`);
    }
  }
  if (!profile.weekly_availability.length) throw new Error("plan.profile_snapshot.weekly_availability 不能为空");
  if (!Number.isInteger(profile.session_duration_minutes) || profile.session_duration_minutes < 10 || profile.session_duration_minutes > 300) {
    throw new Error("plan.profile_snapshot.session_duration_minutes 必须是 10 到 300 的整数");
  }
  const baseline = plan.baseline_summary;
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) throw new Error("plan.baseline_summary 必须是对象");
  if (!Number.isInteger(baseline.observed_window_days) || baseline.observed_window_days < 14 || baseline.observed_window_days > 60) {
    throw new Error("plan.baseline_summary.observed_window_days 必须是 14 到 60 的整数");
  }
  for (const field of ["training_summary", "body_trend_summary", "recovery_summary"]) {
    if (typeof baseline[field] !== "string") throw new Error(`plan.baseline_summary.${field} 必须是字符串`);
  }
  if (!Array.isArray(baseline.data_quality_notes) || baseline.data_quality_notes.some((item) => typeof item !== "string")) {
    throw new Error("plan.baseline_summary.data_quality_notes 必须是字符串数组");
  }
  if (plan.notes != null && typeof plan.notes !== "string") throw new Error("plan.notes 必须是字符串");
}

function validateDecisionContext(context, currentPlan) {
  if (context == null) return;
  if (!context || typeof context !== "object" || Array.isArray(context)) throw new Error("decision_context 必须是对象");
  if (!["manual_update", "weekly_adjustment", "daily_adjustment"].includes(context.workflow)) {
    throw new Error("decision_context.workflow 无效");
  }
  if (!Array.isArray(context.rationale) || !context.rationale.length || context.rationale.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("decision_context.rationale 必须是非空字符串数组");
  }
  if (context.data_quality != null && (!Array.isArray(context.data_quality) || context.data_quality.some((item) => typeof item !== "string"))) {
    throw new Error("decision_context.data_quality 必须是字符串数组");
  }
  if (context.data_window != null) assertDateRange(context.data_window.start_date, context.data_window.end_date);
  if (context.workflow !== "manual_update") {
    if (!currentPlan) throw new Error("周/日调整必须关联当前已确认的训练总纲");
    if (!context.plan_version || context.plan_version !== currentPlan.version) {
      throw new Error("decision_context.plan_version 必须匹配当前训练总纲版本");
    }
    if (!context.evidence_version || context.evidence_version !== currentPlan.evidence_version) {
      throw new Error("decision_context.evidence_version 必须匹配当前训练总纲证据版本");
    }
  }
}

function summarizeCoachingPlan(plan) {
  return {
    title: plan.title,
    start_date: plan.start_date,
    end_date: plan.end_date,
    goal: plan.goal,
    success_metrics: plan.success_metrics,
    weekly_structure: plan.weekly_structure,
    progression_rules: plan.progression_rules,
    recovery_rules: plan.recovery_rules,
    missed_session_rules: plan.missed_session_rules,
    guardrails: plan.guardrails,
    evidence_version: plan.evidence_version,
    evidence_refs: plan.evidence_refs,
    baseline_window_days: plan.baseline_window_days,
    decision_rules: plan.decision_rules,
    data_quality_rules: plan.data_quality_rules || [],
    constraints: plan.constraints || [],
    review_date: plan.review_date,
    profile_snapshot: plan.profile_snapshot,
    baseline_summary: plan.baseline_summary,
    notes: plan.notes || "",
  };
}

function comparableValue(value) {
  if (value == null || value === -1) return "";
  return String(value);
}

function trainingFingerprint(train) {
  return JSON.stringify({
    title: String(train?.title || "").trim(),
    start: comparableValue(train?.start),
    end: comparableValue(train?.end),
    movements: (train?.movements || []).map((movement) => ({
      name: String(movement?.name || "").trim(),
      cardio: movement?.cardio === true,
      recordPreset: comparableValue(movement?.recordPreset),
      difficulty: comparableValue(movement?.difficulty),
      sets: (movement?.sets || []).map((set) => ({
        done: set?.done === true,
        weight: comparableValue(set?.weight ?? set?.weight_kg),
        unit: comparableValue(set?.unit),
        reps: comparableValue(set?.reps),
        duration: comparableValue(set?.time ?? set?.duration_s ?? set?.duration_sec),
        selfWeight: set?.selfWeight === true,
        rpe: comparableValue(set?.rpe),
      })),
      metrics: movement?.metrics == null ? null : {
        distance: comparableValue(movement.metrics.distance),
        pace: comparableValue(movement.metrics.pace),
        cadence: comparableValue(movement.metrics.cadence),
        kcal: comparableValue(movement.metrics.kcal),
        bpm: comparableValue(movement.metrics.bpm),
      },
    })),
  });
}

async function partitionTrainingChanges(payload, env) {
  const requested = payload.res || [];
  const creates = requested.filter((train) => train.localid == null);
  if (!creates.length) return { toWrite: requested, deduplicated: [] };

  const queryResult = await xunjiPost(
    "https://trains.xunjiapp.cn/api_trains_for_llm_v2",
    env.XUNJI_TRAIN_API_KEY,
    {
      schema_version: "train_open_api_v2",
      datestr: creates[0].datestr,
      include_full_data: true,
    },
  );
  const existing = Array.isArray(queryResult?.res?.trains) ? queryResult.res.trains : [];
  const availableByFingerprint = new Map();
  for (const train of existing) {
    const fingerprint = trainingFingerprint(train);
    const matches = availableByFingerprint.get(fingerprint) || [];
    matches.push(train);
    availableByFingerprint.set(fingerprint, matches);
  }

  const toWrite = [];
  const deduplicated = [];
  for (const train of requested) {
    if (train.localid != null) {
      toWrite.push(train);
      continue;
    }
    const matches = availableByFingerprint.get(trainingFingerprint(train));
    if (matches?.length) deduplicated.push(matches.shift());
    else toWrite.push(train);
  }
  return { toWrite, deduplicated };
}

async function xunjiPost(url, token, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "accept-encoding": "gzip",
      "user-agent": "xunji-cloud-coach/1.0",
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`训记接口 HTTP ${response.status}: ${JSON.stringify(data)}`);
  if (data?.success === false) throw new Error(data.message || data.msg || JSON.stringify(data));
  return data;
}

async function saveTrainingDecisionSafely(env, confirmationToken, summary, decisionContext, result) {
  try {
    return await saveTrainingDecision(env, confirmationToken, summary, decisionContext, result);
  } catch (error) {
    return {
      id: null,
      replayed: false,
      archive: { key: null, status: "failed" },
      warning: `训记写入已成功，但云端决策归档失败: ${error.message || String(error)}`,
    };
  }
}

function normalizeSearchText(value) {
  return String(value ?? "").trim().toLocaleLowerCase("zh-CN");
}

function sanitizeMovementCatalog(rawMovements) {
  if (!Array.isArray(rawMovements)) throw new Error("训记动作目录响应缺少 res.movements");
  return rawMovements.flatMap((raw) => {
    const name = typeof raw?.name === "string" ? raw.name.trim() : "";
    if (!name) return [];
    const aliases = Array.isArray(raw.aliases)
      ? raw.aliases.filter((alias) => typeof alias === "string" && alias.trim()).map((alias) => alias.trim())
      : typeof raw.aliases === "string" && raw.aliases.trim()
        ? [raw.aliases.trim()]
        : [];
    return [{
      name,
      type: raw.type == null ? "" : String(raw.type),
      exetype: raw.exetype == null ? "" : String(raw.exetype),
      aliases,
    }];
  });
}

async function loadMovementCatalog(env) {
  const cacheKey = "cache:movement-catalog:v1";
  const cached = await env.OAUTH_KV.get(cacheKey, "json");
  if (Array.isArray(cached?.movements) && cached.movements.length) {
    return { movements: sanitizeMovementCatalog(cached.movements), source: "cache" };
  }
  const data = await xunjiPost(
    "https://trains.xunjiapp.cn/api_movement_catalog_for_llm_v2",
    env.XUNJI_TRAIN_API_KEY,
    { schema_version: "train_open_api_v2" },
  );
  const movements = sanitizeMovementCatalog(data?.res?.movements);
  await env.OAUTH_KV.put(cacheKey, JSON.stringify({ movements }), {
    expirationTtl: MOVEMENT_CATALOG_CACHE_TTL,
  });
  return { movements, source: "upstream" };
}

function movementMatch(movement, keyword) {
  if (!keyword) return { score: 6, match_type: "filter_only", matched_value: null };
  const name = normalizeSearchText(movement.name);
  const aliases = movement.aliases.map(normalizeSearchText);
  if (name === keyword) return { score: 0, match_type: "exact_name", matched_value: movement.name };
  const exactAliasIndex = aliases.findIndex((alias) => alias === keyword);
  if (exactAliasIndex >= 0) return { score: 1, match_type: "exact_alias", matched_value: movement.aliases[exactAliasIndex] };
  if (name.startsWith(keyword)) return { score: 2, match_type: "name_prefix", matched_value: movement.name };
  const aliasPrefixIndex = aliases.findIndex((alias) => alias.startsWith(keyword));
  if (aliasPrefixIndex >= 0) return { score: 3, match_type: "alias_prefix", matched_value: movement.aliases[aliasPrefixIndex] };
  if (name.includes(keyword)) return { score: 4, match_type: "name_contains", matched_value: movement.name };
  const aliasContainsIndex = aliases.findIndex((alias) => alias.includes(keyword));
  if (aliasContainsIndex >= 0) return { score: 5, match_type: "alias_contains", matched_value: movement.aliases[aliasContainsIndex] };
  return null;
}

async function callTool(name, args, env) {
  switch (name) {
    case "xunji_training_query": {
      assertDate(args.date, "date");
      return xunjiPost("https://trains.xunjiapp.cn/api_trains_for_llm_v2", env.XUNJI_TRAIN_API_KEY, {
        schema_version: "train_open_api_v2",
        datestr: args.date,
        include_full_data: args.include_full_data === true,
      });
    }
    case "xunji_movement_search": {
      for (const [field, maximum] of [["keyword", 50], ["body_part", 30], ["exetype", 30]]) {
        if (args[field] != null && typeof args[field] !== "string") throw new Error(`${field} 必须是字符串`);
        if (args[field]?.length > maximum) throw new Error(`${field} 过长`);
      }
      const rawKeyword = args.keyword?.trim() || "";
      const rawBodyPart = args.body_part?.trim() || "";
      const rawExetype = args.exetype?.trim() || "";
      const keyword = normalizeSearchText(rawKeyword);
      const bodyPart = normalizeSearchText(rawBodyPart);
      const exetype = normalizeSearchText(rawExetype);
      if (!keyword && !bodyPart && !exetype) throw new Error("keyword、body_part、exetype 至少提供一个");
      const limit = Number.isInteger(args.limit) ? args.limit : 10;
      if (limit < 1 || limit > 30) throw new Error("limit 必须是 1 到 30 的整数");
      const catalog = await loadMovementCatalog(env);
      const rankedMatches = catalog.movements
        .filter((movement) => !bodyPart || normalizeSearchText(movement.type) === bodyPart)
        .filter((movement) => !exetype || normalizeSearchText(movement.exetype) === exetype)
        .map((movement) => ({ movement, match: movementMatch(movement, keyword) }))
        .filter(({ match }) => match != null)
        .sort((left, right) => left.match.score - right.match.score || left.movement.name.localeCompare(right.movement.name, "zh-CN"));
      const bestScore = rankedMatches[0]?.match.score;
      const bestCount = rankedMatches.filter(({ match }) => match.score === bestScore).length;
      const exactUnique = Boolean(keyword && bestCount === 1 && bestScore <= 1);
      const identityStatus = !rankedMatches.length
        ? "no_match"
        : !keyword
          ? "filter_only"
          : exactUnique
            ? "exact_unique"
            : "ambiguous";
      const identityConfidence = identityStatus === "exact_unique"
        ? "high"
        : identityStatus === "ambiguous" && bestScore <= 1
          ? "medium"
          : identityStatus === "no_match"
            ? "none"
            : "low";
      const matches = rankedMatches.slice(0, limit).map(({ movement, match }, index) => ({
        rank: index + 1,
        standard_name: movement.name,
        type: movement.type,
        exetype: movement.exetype,
        aliases: movement.aliases,
        match_type: match.match_type,
        matched_value: match.matched_value,
      }));
      const movements = rankedMatches.slice(0, limit).map(({ movement }) => movement);
      return {
        schema_version: "movement_catalog_search_v2",
        catalog_count: catalog.movements.length,
        source: catalog.source,
        query: {
          keyword: rawKeyword,
          body_part: rawBodyPart,
          exetype: rawExetype,
          limit,
        },
        count: movements.length,
        identity_status: identityStatus,
        identity_confidence: identityConfidence,
        recommended_name: exactUnique ? rankedMatches[0].movement.name : null,
        requires_identity_confirmation: !exactUnique,
        suitability_status: "not_assessed",
        matches,
        movements,
        selection_guidance: [
          "exact_unique 只表示标准动作身份已唯一匹配，不表示该动作适合当前用户或训练目标。",
          "写入前核对目标动作模式、训练部位、器械、经验、伤病禁忌和具体变式；模糊或多候选结果必须让用户选择。",
          "目录不返回动画 URL；标准名可帮助 App 关联动作讲解，但不能保证存在动画。",
        ],
      };
    }
    case "xunji_training_plan_list": {
      const data = await xunjiPost("https://api.xunjiapp.cn/open/plan/query_gzip", env.XUNJI_TRAIN_API_KEY, {
        schema_version: "plan_open_api_v1", action: "list",
      });
      const plans = data?.res?.plans;
      if (!Array.isArray(plans)) throw new Error("训记官方计划响应缺少 res.plans");
      return { schema_version: "xunji_plan_list_v1", count: plans.length, plans };
    }
    case "xunji_training_plan_get": {
      assertDateRange(args.start_date, args.end_date, 92);
      if (!args.plan_ref) throw new Error("plan_ref 不能为空");
      const data = await xunjiPost("https://api.xunjiapp.cn/open/plan/query_gzip", env.XUNJI_TRAIN_API_KEY, {
        schema_version: "plan_open_api_v1",
        action: "get",
        plan_ref: args.plan_ref,
        start_date: args.start_date,
        end_date: args.end_date,
        include_movements: args.include_movements !== false,
      });
      const result = data?.res;
      if (!result || typeof result !== "object" || !Array.isArray(result.days)) {
        throw new Error("训记官方计划响应缺少 res.days");
      }
      return {
        schema_version: "xunji_plan_detail_v1",
        plan: result.plan ?? null,
        date_range: result.date_range ?? null,
        days: result.days,
      };
    }
    case "xunji_food_query": {
      assertDateRange(args.start_date, args.end_date);
      const today = Math.floor(Date.now() / 86_400_000);
      if (dayNumber(args.start_date) < today - 366 || dayNumber(args.end_date) > today + 93) {
        throw new Error("饮食查询范围只能是过去一年到未来三个月");
      }
      return xunjiPost("https://eatings.xunjiapp.cn/open/food/query_gzip", env.XUNJI_FOOD_API_KEY, {
        start_date: args.start_date,
        end_date: args.end_date,
        include_detail: args.include_detail !== false,
      });
    }
    case "xunji_body_query": {
      assertDateRange(args.start_date, args.end_date);
      return xunjiPost("https://api.xunjiapp.cn/open/body/query_gzip", env.XUNJI_BODY_API_KEY, {
        start_date: args.start_date,
        end_date: args.end_date,
        ...(Array.isArray(args.types) && args.types.length ? { types: args.types } : {}),
        include_latest: args.include_latest !== false,
        include_records: args.include_records !== false,
        limit: args.limit ?? 500,
        offset: args.offset ?? 0,
      });
    }
    case "xunji_workflow_context_get": {
      return getWorkflowContext(env, args.workflow, args.history_limit ?? 8);
    }
    case "xunji_coaching_plan_get": {
      const saved = await getCurrentPlan(env);
      return saved ? { exists: true, plan: saved } : { exists: false, plan: null };
    }
    case "xunji_coaching_history_query": {
      const type = args.type ?? "all";
      if (!["all", "plans", "training_decisions"].includes(type)) throw new Error("type 无效");
      const entries = await queryHistory(env, type, args.limit ?? 20, args.include_detail === true);
      return { schema_version: "xunji_coaching_history_v1", type, count: entries.length, entries };
    }
    case "xunji_prepare_coaching_plan_upsert": {
      validateCoachingPlan(args.plan);
      await validatePlanEvidence(env, args.plan);
      const confirmationToken = randomToken();
      const summary = summarizeCoachingPlan(args.plan);
      await env.OAUTH_KV.put(`coach-plan-confirm:${confirmationToken}`, JSON.stringify({
        status: "pending",
        plan: summary,
        created_at: Date.now(),
      }), { expirationTtl: CONFIRMATION_TTL });
      return {
        status: "awaiting_user_confirmation",
        expires_in_seconds: CONFIRMATION_TTL,
        confirmation_token: confirmationToken,
        summary,
        post_commit: {
          google_docs_mirror: {
            mode: "best_effort",
            visibility: "private_by_default",
            contains_health_raw_data: false,
            contains_sensitive_derived_data: true,
            sensitive_derived_data_categories: [
              "injury_and_safety_constraints",
              "sleep_hrv_resting_heart_rate_trends",
              "weight_and_body_fat_trends",
              "training_preferences",
              "medical_evidence_summary",
            ],
            requires_explicit_destination_authorization: true,
            plan_confirmation_implies_mirror_authorization: false,
            authorization_can_share_confirmation_message: true,
            not_authorized_error_code: "google_docs_not_authorized",
            failure_blocks_plan_or_schedule: false,
          },
          first_week_handoff: "requires_separate_training_confirmation",
        },
        validation: { valid: true, mode: "local_only", saved: false },
        instruction: "分别询问用户是否保存总纲，以及是否允许把列出的敏感派生摘要写入私人 Google Docs；两项可在同一次回复中分别确认，但只确认总纲不等于授权镜像。只有用户明确确认总纲后才能调用 xunji_commit_coaching_plan_upsert；未明确授权镜像时不得向 Drive 发送内容，也不得阻断总纲或首周交接。",
      };
    }
    case "xunji_commit_coaching_plan_upsert": {
      if (args.user_confirmed !== true) throw new Error("缺少用户明确确认");
      const token = args.confirmation_token || "";
      const pendingKey = `coach-plan-confirm:${token}`;
      const receiptKey = `coach-plan-receipt:${token}`;
      const receipt = await env.OAUTH_KV.get(receiptKey, "json");
      if (receipt?.status === "committed") {
        let result = receipt.result;
        if (result?.plan?.archive?.status !== "stored") {
          const repaired = await saveConfirmedPlan(env, result.plan, token);
          result = { ...result, plan: repaired.plan };
          await env.OAUTH_KV.put(receiptKey, JSON.stringify({ ...receipt, result }), { expirationTtl: COMMIT_RECEIPT_TTL });
        }
        return { ...result, replayed: true };
      }
      const pending = await env.OAUTH_KV.get(pendingKey, "json");
      if (!pending || pending.status !== "pending") {
        const existing = await getCurrentPlan(env);
        if (!existing) throw new Error("确认令牌无效或已过期；请重新预览训练总纲");
        throw new Error("确认令牌无效或已过期；当前总纲未被修改");
      }
      await validatePlanEvidence(env, pending.plan);
      const saved = await saveConfirmedPlan(env, pending.plan, token);
      const result = { status: "committed", replayed: saved.replayed, plan: saved.plan };
      await env.OAUTH_KV.put(receiptKey, JSON.stringify({
        status: "committed",
        committed_at: Date.now(),
        result,
      }), { expirationTtl: COMMIT_RECEIPT_TTL });
      await env.OAUTH_KV.delete(pendingKey);
      return result;
    }
    case "xunji_commit_coaching_plan_mirror": {
      return recordPlanMirror(env, args);
    }
    case "xunji_prepare_training_upsert": {
      const currentPlan = await getCurrentPlan(env);
      const normalizedTrains = normalizeTrainingRecords(args.trains);
      validateTrainingRecords(normalizedTrains);
      validateDecisionContext(args.decision_context, currentPlan);
      const confirmationToken = randomToken();
      const requestId = crypto.randomUUID();
      const payload = {
        schema_version: "train_open_api_v2",
        client_request_id: requestId,
        dry_run: false,
        include_full_data: true,
        res: normalizedTrains,
      };
      await env.OAUTH_KV.put(`confirm:${confirmationToken}`, JSON.stringify({
        status: "pending",
        payload,
        summary: summarizeTraining(normalizedTrains),
        decision_context: args.decision_context || null,
        created_at: Date.now(),
      }), { expirationTtl: CONFIRMATION_TTL });
      return {
        status: "awaiting_user_confirmation",
        expires_in_seconds: CONFIRMATION_TTL,
        confirmation_token: confirmationToken,
        summary: summarizeTraining(normalizedTrains),
        validation: { valid: true, mode: "local_only", upstream_called: false },
        instruction: "必须先向用户展示 summary 并取得明确确认，之后才能调用 xunji_commit_training_upsert。",
      };
    }
    case "xunji_commit_training_upsert": {
      if (args.user_confirmed !== true) throw new Error("缺少用户明确确认");
      const key = `confirm:${args.confirmation_token || ""}`;
      const lockKey = `confirm-lock:${args.confirmation_token || ""}`;
      const receiptKey = `confirm-receipt:${args.confirmation_token || ""}`;
      const pendingRaw = await env.OAUTH_KV.get(key);
      const receiptRaw = await env.OAUTH_KV.get(receiptKey);
      const receipt = receiptRaw ? JSON.parse(receiptRaw) : null;
      const pending = pendingRaw
        ? JSON.parse(pendingRaw)
        : receipt?.payload && receipt?.summary
          ? { status: "pending", payload: receipt.payload, summary: receipt.summary, decision_context: receipt.decision_context || null }
          : null;
      if (receipt?.status === "committed") {
        let decisionRecord = receipt.decision_record || null;
        if (decisionRecord?.archive?.status !== "stored") {
          decisionRecord = await saveTrainingDecisionSafely(
            env, args.confirmation_token, receipt.summary, receipt.decision_context, receipt.result,
          );
          await env.OAUTH_KV.put(receiptKey, JSON.stringify({
            ...receipt,
            decision_record: decisionRecord,
          }), { expirationTtl: COMMIT_RECEIPT_TTL });
        }
        return {
          status: "committed", replayed: true, summary: receipt.summary,
          result: receipt.result, decision_record: decisionRecord,
          commit_state_warning: receipt.commit_state_warning || null,
        };
      }
      if (!pending) throw new Error("确认令牌无效或已过期；请重新生成变更摘要");
      if (receiptRaw) {
        const reconciliation = await partitionTrainingChanges(pending.payload, env);
        if (!reconciliation.toWrite.length) {
          const result = { res: { trains: reconciliation.deduplicated }, deduplicated: true };
          let commitStateWarning = null;
          try {
            await finalizeTrainingCommit(env, args.confirmation_token || "", "committed");
          } catch (error) {
            commitStateWarning = `已通过训记记录确认写入成功，但 D1 提交状态更新失败: ${error.message || String(error)}`;
          }
          const decisionRecord = await saveTrainingDecisionSafely(
            env, args.confirmation_token, pending.summary, pending.decision_context, result,
          );
          await env.OAUTH_KV.put(receiptKey, JSON.stringify({
            status: "committed",
            committed_at: Date.now(),
            summary: pending.summary,
            decision_context: pending.decision_context,
            decision_record: decisionRecord,
            commit_state_warning: commitStateWarning,
            result,
          }), { expirationTtl: COMMIT_RECEIPT_TTL });
          return {
            status: "committed",
            replayed: true,
            reconciled: true,
            summary: pending.summary,
            result,
            decision_record: decisionRecord,
            commit_state_warning: commitStateWarning,
          };
        }
        throw new Error("上一次提交结果未知，且未能确认全部训练已经存在；为避免重复创建，请人工核对目标日期，不要直接重试");
      }

      const reconciliation = await partitionTrainingChanges(pending.payload, env);
      if (!reconciliation.toWrite.length) {
        const result = { res: { trains: reconciliation.deduplicated }, deduplicated: true };
        const decisionRecord = await saveTrainingDecisionSafely(
          env, args.confirmation_token, pending.summary, pending.decision_context, result,
        );
        await env.OAUTH_KV.put(receiptKey, JSON.stringify({
          status: "committed",
          committed_at: Date.now(),
          summary: pending.summary,
          decision_context: pending.decision_context,
          decision_record: decisionRecord,
          result,
        }), { expirationTtl: COMMIT_RECEIPT_TTL });
        return {
          status: "committed", replayed: false, deduplicated: true,
          summary: pending.summary, result, decision_record: decisionRecord,
        };
      }

      const claim = await claimTrainingCommit(env, args.confirmation_token || "");
      if (!claim.acquired) {
        if (claim.status === "ambiguous") {
          throw new Error("上一次提交结果未知；为避免重复创建，请先人工核对目标日期，不要直接重试");
        }
        return {
          status: "committing",
          replayed: true,
          summary: pending.summary,
          instruction: claim.status === "committed"
            ? "该确认令牌已完成上游提交但回执仍在恢复；不要重新写入，请先查询目标日期。"
            : "相同确认令牌正在提交；不要重新准备或再次写入，请稍后查询该日期的训练记录。",
        };
      }
      if (pending.status !== "pending") throw new Error("确认令牌状态无效");
      await env.OAUTH_KV.put(lockKey, JSON.stringify({
        status: "committing",
        committing_at: Date.now(),
      }), { expirationTtl: COMMIT_RECEIPT_TTL });

      let result;
      try {
        const upstreamResult = await xunjiPost(
          "https://trains.xunjiapp.cn/api_upsert_trains_for_llm_v2",
          env.XUNJI_TRAIN_API_KEY,
          { ...pending.payload, res: reconciliation.toWrite },
        );
        result = reconciliation.deduplicated.length
          ? { ...upstreamResult, deduplicated_existing: reconciliation.deduplicated }
          : upstreamResult;
      } catch (error) {
        try { await finalizeTrainingCommit(env, args.confirmation_token || "", "ambiguous"); } catch {}
        await env.OAUTH_KV.put(receiptKey, JSON.stringify({
          status: "ambiguous",
          failed_at: Date.now(),
          payload: pending.payload,
          summary: pending.summary,
          decision_context: pending.decision_context,
          error: error.message || String(error),
        }), { expirationTtl: COMMIT_RECEIPT_TTL });
        throw new Error(`训练提交未得到可确认的成功结果；为避免重复创建，本令牌已停止重试。请先查询 ${pending.summary?.[0]?.date || "目标日期"} 的训练记录`);
      }

      let commitStateWarning = null;
      try {
        await finalizeTrainingCommit(env, args.confirmation_token || "", "committed");
      } catch (error) {
        commitStateWarning = `训记写入已成功，但 D1 提交状态更新失败: ${error.message || String(error)}`;
      }
      const decisionRecord = await saveTrainingDecisionSafely(
        env, args.confirmation_token, pending.summary, pending.decision_context, result,
      );
      const completedReceipt = {
        status: "committed",
        committed_at: Date.now(),
        summary: pending.summary,
        decision_context: pending.decision_context,
        decision_record: decisionRecord,
        commit_state_warning: commitStateWarning,
        result,
      };
      await env.OAUTH_KV.put(receiptKey, JSON.stringify(completedReceipt), { expirationTtl: COMMIT_RECEIPT_TTL });
      return {
        status: "committed", replayed: false, summary: pending.summary, result,
        decision_record: decisionRecord, commit_state_warning: commitStateWarning,
      };
    }
    default:
      throw new Error(`未知工具: ${name}`);
  }
}

function oauthMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["openid", "offline_access", "xunji.read", "xunji.write"],
  };
}

function protectedResourceMetadata(origin) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["xunji.read", "xunji.write"],
  };
}

async function parseBody(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) return request.json();
  return Object.fromEntries((await request.formData()).entries());
}

async function registerClient(request, env) {
  const body = await request.json();
  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || !redirectUris.length || redirectUris.some((uri) => !/^https:\/\//.test(uri))) {
    return responseJson({ error: "invalid_redirect_uri" }, 400);
  }
  const clientId = randomToken(24);
  const client = {
    client_id: clientId,
    client_name: body.client_name || "ChatGPT",
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
  await env.OAUTH_KV.put(`client:${clientId}`, JSON.stringify(client));
  return responseJson(client, 201);
}

function authorizePage(params, error = "") {
  const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope"]
    .map((name) => `<input type="hidden" name="${name}" value="${escapeHtml(params[name] || "")}">`).join("");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
  <title>授权训记云教练</title><style>body{font-family:system-ui;background:#f6f7f8;margin:0;padding:24px}main{max-width:440px;margin:10vh auto;background:white;padding:28px;border-radius:18px;box-shadow:0 12px 40px #0001}input,button{box-sizing:border-box;width:100%;padding:13px;margin-top:12px;border-radius:10px;border:1px solid #ccd0d5}button{background:#111;color:#fff;font-weight:650}p{line-height:1.55;color:#4b5563}.error{color:#b91c1c}</style>
  <main><h1>授权训记云教练</h1><p>授权后，ChatGPT 可以读取你的训记训练、饮食和身体数据，并保存已确认的训练总纲。总纲与训练写入仍需逐次确认。</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}<form method="post" action="/authorize">${hidden}<label>连接口令<input name="password" type="password" autocomplete="current-password" required autofocus></label><button type="submit">授权连接</button></form></main></html>`;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function validateAuthorizeParams(params, env) {
  const clientRaw = await env.OAUTH_KV.get(`client:${params.client_id || ""}`);
  if (!clientRaw) throw new Error("未知 OAuth 客户端");
  const client = JSON.parse(clientRaw);
  if (!client.redirect_uris.includes(params.redirect_uri)) throw new Error("redirect_uri 不匹配");
  if (!params.code_challenge || params.code_challenge_method !== "S256") throw new Error("必须使用 PKCE S256");
  return client;
}

async function authorize(request, env) {
  if (request.method === "GET") {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try { await validateAuthorizeParams(params, env); } catch (error) { return new Response(error.message, { status: 400 }); }
    return new Response(authorizePage(params), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  const params = await parseBody(request);
  try {
    await validateAuthorizeParams(params, env);
    if (!await constantTimeEqual(String(params.password || ""), String(env.CONNECTOR_PASSWORD || ""))) {
      return new Response(authorizePage(params, "口令不正确"), { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    const code = randomToken();
    await env.OAUTH_KV.put(`code:${code}`, JSON.stringify({
      client_id: params.client_id,
      redirect_uri: params.redirect_uri,
      code_challenge: params.code_challenge,
      scope: params.scope || "xunji.read xunji.write offline_access",
    }), { expirationTtl: AUTH_CODE_TTL });
    const redirect = new URL(params.redirect_uri);
    redirect.searchParams.set("code", code);
    if (params.state) redirect.searchParams.set("state", params.state);
    return Response.redirect(redirect.toString(), 302);
  } catch (error) {
    return new Response(error.message, { status: 400 });
  }
}

async function issueTokens(env, clientId, scope, priorRefreshToken = null) {
  const accessToken = randomToken();
  const refreshToken = priorRefreshToken || randomToken();
  await env.OAUTH_KV.put(`token:${accessToken}`, JSON.stringify({ client_id: clientId, scope }), { expirationTtl: ACCESS_TOKEN_TTL });
  await env.OAUTH_KV.put(`refresh:${refreshToken}`, JSON.stringify({ client_id: clientId, scope }), { expirationTtl: REFRESH_TOKEN_TTL });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL,
    refresh_token: refreshToken,
    scope,
  };
}

async function token(request, env) {
  const body = await parseBody(request);
  if (body.grant_type === "authorization_code") {
    const codeKey = `code:${body.code || ""}`;
    const codeRaw = await env.OAUTH_KV.get(codeKey);
    if (!codeRaw) return responseJson({ error: "invalid_grant" }, 400);
    const grant = JSON.parse(codeRaw);
    if (grant.client_id !== body.client_id || grant.redirect_uri !== body.redirect_uri) {
      return responseJson({ error: "invalid_grant" }, 400);
    }
    const verifierHash = b64url(await sha256(String(body.code_verifier || "")));
    if (!await constantTimeEqual(verifierHash, grant.code_challenge)) return responseJson({ error: "invalid_grant" }, 400);
    await env.OAUTH_KV.delete(codeKey);
    return responseJson(await issueTokens(env, grant.client_id, grant.scope));
  }
  if (body.grant_type === "refresh_token") {
    const refreshRaw = await env.OAUTH_KV.get(`refresh:${body.refresh_token || ""}`);
    if (!refreshRaw) return responseJson({ error: "invalid_grant" }, 400);
    const grant = JSON.parse(refreshRaw);
    if (body.client_id && grant.client_id !== body.client_id) return responseJson({ error: "invalid_grant" }, 400);
    return responseJson(await issueTokens(env, grant.client_id, grant.scope, body.refresh_token));
  }
  return responseJson({ error: "unsupported_grant_type" }, 400);
}

async function authenticate(request, env, origin) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") || "");
  if (!match) return null;
  return env.OAUTH_KV.get(`token:${match[1]}`, "json");
}

async function mcp(request, env, origin) {
  const auth = await authenticate(request, env, origin);
  if (!auth) {
    return responseJson({ error: "unauthorized" }, 401, {
      "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    });
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  let rpc;
  try { rpc = await request.json(); } catch { return responseJson({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
  if (!rpc || rpc.jsonrpc !== "2.0") return responseJson({ jsonrpc: "2.0", id: rpc?.id ?? null, error: { code: -32600, message: "Invalid Request" } }, 400);
  if (rpc.method?.startsWith("notifications/")) return new Response(null, { status: 202 });
  let result;
  try {
    switch (rpc.method) {
      case "initialize":
        result = {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "xunji-cloud-coach", title: "训记云教练", version: SERVICE_VERSION },
          instructions: "这是一个 App、三个云端工作流。用户只需说“制定整体训练计划”“调整下周训练”或“今天怎么练”；分别选择 training_planner、weekly_adjustment 或 daily_adjustment，并把 xunji_workflow_context_get 作为首个工具调用。成功取得 workflow_version、evidence_version 且 local_files_used=false 后再分析或生成内容；调用失败时立即停止，不先草拟计划。新阶段总纲 prepare 后，必须分别询问是否保存总纲，以及是否允许把伤病/安全限制、睡眠/HRV/静息心率派生趋势、体重体脂趋势、训练偏好和医学证据摘要写入私人 Google Docs；两项可以在同一次回复中分别确认，但总纲确认不等于镜像授权。总纲保存成功后不要结束：只有镜像已明确授权时才使用已连接的 Google Drive/Docs 创建私人、人类可读镜像，再用 xunji_commit_coaching_plan_mirror 记录成功链接；未授权时不得向 Drive 发送内容，可记录 google_docs_not_authorized。镜像失败不得阻断计划、首周交接或 Schedule；未授权或仍待处理同样不得阻断，也不得复制 Apple Health 原始数据。随后立即加载 weekly_adjustment，在同一会话生成从 start_date 开始的第一周草案并核对训记标准动作名。保存总纲和写入首周是两次独立确认，前一次确认绝不授权后一次 commit。云端运行不得读取本地文件。任何总纲或训记训练写入必须先 prepare 并向用户展示完全相同的摘要，取得一次明确确认后才能 commit。身体与生理原始数据只由调用端 ChatGPT Health 提供，不保存到 Worker；训记仍是实际训练、饮食和身体记录的事实来源。",
        };
        break;
      case "ping": result = {}; break;
      case "tools/list": result = { tools }; break;
      case "tools/call": {
        const requiredScope = rpc.params?.name?.startsWith("xunji_commit_") ? "xunji.write" : "xunji.read";
        const grantedScopes = new Set(String(auth.scope || "").split(/\s+/).filter(Boolean));
        if (!grantedScopes.has(requiredScope)) throw new Error(`OAuth 令牌缺少 ${requiredScope} 权限`);
        const output = await callTool(rpc.params?.name, rpc.params?.arguments || {}, env);
        result = {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
          isError: false,
        };
        break;
      }
      default:
        return responseJson({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32601, message: "Method not found" } });
    }
    return responseJson({ jsonrpc: "2.0", id: rpc.id ?? null, result });
  } catch (error) {
    if (rpc.method === "tools/call") {
      return responseJson({ jsonrpc: "2.0", id: rpc.id ?? null, result: {
        content: [{ type: "text", text: error.message || String(error) }], isError: true,
      }});
    }
    return responseJson({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32603, message: error.message || String(error) } });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = url.origin;
    if (url.pathname === "/health") return responseJson({ ok: true, service: "xunji-cloud-coach", version: SERVICE_VERSION });
    if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration") {
      return responseJson(oauthMetadata(origin));
    }
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return responseJson(protectedResourceMetadata(origin));
    }
    if (url.pathname === "/register" && request.method === "POST") return registerClient(request, env);
    if (url.pathname === "/authorize" && (request.method === "GET" || request.method === "POST")) return authorize(request, env);
    if (url.pathname === "/token" && request.method === "POST") return token(request, env);
    if (url.pathname === "/mcp") return mcp(request, env, origin);
    return new Response("Not Found", { status: 404 });
  },
};
