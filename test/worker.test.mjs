import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/worker.mjs";

class MemoryKv {
  constructor() { this.values = new Map(); }
  async put(key, value) { this.values.set(key, value); }
  async get(key, type) {
    const value = this.values.get(key) ?? null;
    return type === "json" && value != null ? JSON.parse(value) : value;
  }
  async delete(key) { this.values.delete(key); }
}

class MemoryR2 {
  constructor() { this.objects = new Map(); this.failuresRemaining = 0; }
  async put(key, value, options) {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("temporary R2 failure");
    }
    this.objects.set(key, { value, options });
  }
}

class MemoryD1Statement {
  constructor(db, sql, bindings = []) { this.db = db; this.sql = sql.replaceAll(/\s+/g, " ").trim(); this.bindings = bindings; }
  bind(...bindings) { return new MemoryD1Statement(this.db, this.sql, bindings); }
  async first() {
    if (this.sql.includes("FROM content_packs")) {
      const [contentKey] = this.bindings;
      return this.db.contentPacks.find((row) => row.content_key === contentKey && row.is_active === 1) ?? null;
    }
    if (this.sql.includes("FROM coaching_plans") && this.sql.includes("confirmation_token = ?")) {
      const [token] = this.bindings;
      return this.db.plans.find((row) => row.confirmation_token === token) ?? null;
    }
    if (this.sql.includes("FROM coaching_plans") && this.sql.includes("is_active = 1")) {
      return this.db.plans.find((row) => row.is_active === 1) ?? null;
    }
    if (this.sql.includes("FROM coaching_plan_mirrors")) {
      const [planVersion, provider] = this.bindings;
      return this.db.mirrors.find((row) => row.plan_version === planVersion && row.provider === provider) ?? null;
    }
    if (this.sql.includes("FROM training_decisions") && this.sql.includes("confirmation_token = ?")) {
      const [token] = this.bindings;
      return this.db.decisions.find((row) => row.confirmation_token === token) ?? null;
    }
    if (this.sql.includes("FROM training_commit_claims")) {
      const [token] = this.bindings;
      return this.db.claims.get(token) ?? null;
    }
    throw new Error(`unsupported D1 first: ${this.sql}`);
  }
  async run() {
    if (this.sql.startsWith("DELETE FROM training_commit_claims")) {
      const [cutoff] = this.bindings;
      for (const [token, claim] of this.db.claims) {
        if (claim.updated_at < cutoff) this.db.claims.delete(token);
      }
      return { success: true };
    }
    if (this.sql.startsWith("UPDATE coaching_plans SET is_active = 0")) {
      for (const row of this.db.plans) row.is_active = 0;
      return { success: true };
    }
    if (this.sql.startsWith("INSERT INTO profile_snapshots")) {
      const [id, created_at, snapshot_json] = this.bindings;
      this.db.profiles.push({ id, created_at, snapshot_json });
      return { success: true };
    }
    if (this.sql.startsWith("INSERT INTO coaching_plans")) {
      const [version, confirmation_token, title, start_date, end_date, evidence_version, profile_snapshot_id, plan_json, archive_key, created_at] = this.bindings;
      this.db.plans.push({
        version, confirmation_token, title, start_date, end_date, evidence_version,
        profile_snapshot_id, plan_json, is_active: 1, archive_key,
        archive_status: "pending", created_at,
      });
      return { success: true };
    }
    if (this.sql.startsWith("UPDATE coaching_plans SET archive_key")) {
      const [archive_key, archive_status, version] = this.bindings;
      Object.assign(this.db.plans.find((row) => row.version === version), { archive_key, archive_status });
      return { success: true };
    }
    if (this.sql.startsWith("INSERT INTO coaching_plan_mirrors")) {
      const [plan_version] = this.bindings;
      let row = this.db.mirrors.find((item) => item.plan_version === plan_version && item.provider === "google_docs");
      if (this.bindings.length === 3) {
        const [, created_at, updated_at] = this.bindings;
        if (!row) {
          row = {
            plan_version, provider: "google_docs", status: "pending",
            document_id: null, document_url: null, error_code: null, created_at, updated_at,
          };
          this.db.mirrors.push(row);
        }
      } else {
        const [, status, document_id, document_url, error_code, created_at, updated_at] = this.bindings;
        if (!row) {
          row = { plan_version, provider: "google_docs", created_at };
          this.db.mirrors.push(row);
        }
        Object.assign(row, { status, document_id, document_url, error_code, updated_at });
      }
      return { success: true };
    }
    if (this.sql.startsWith("INSERT INTO training_decisions")) {
      const [id, confirmation_token, workflow, plan_version, training_date, summary_json, decision_context_json, result_refs_json, archive_key, created_at] = this.bindings;
      this.db.decisions.push({
        id, confirmation_token, workflow, plan_version, training_date, summary_json,
        decision_context_json, result_refs_json, archive_key,
        archive_status: "pending", created_at,
      });
      return { success: true };
    }
    if (this.sql.startsWith("INSERT INTO training_commit_claims")) {
      const [confirmation_token, created_at, updated_at] = this.bindings;
      if (this.db.claims.has(confirmation_token)) throw new Error("UNIQUE constraint failed");
      this.db.claims.set(confirmation_token, { status: "committing", created_at, updated_at });
      return { success: true };
    }
    if (this.sql.startsWith("UPDATE training_commit_claims SET status")) {
      const [status, updated_at, confirmation_token] = this.bindings;
      Object.assign(this.db.claims.get(confirmation_token), { status, updated_at });
      return { success: true };
    }
    if (this.sql.startsWith("UPDATE training_decisions SET archive_key")) {
      const [archive_key, archive_status, id] = this.bindings;
      Object.assign(this.db.decisions.find((row) => row.id === id), { archive_key, archive_status });
      return { success: true };
    }
    throw new Error(`unsupported D1 run: ${this.sql}`);
  }
  async all() {
    const [limit] = this.bindings;
    if (this.sql.includes("FROM coaching_plans")) {
      return { results: this.db.plans.slice().reverse().slice(0, limit) };
    }
    if (this.sql.includes("FROM training_decisions")) {
      return { results: this.db.decisions.slice().reverse().slice(0, limit) };
    }
    throw new Error(`unsupported D1 all: ${this.sql}`);
  }
}

class MemoryD1 {
  constructor() {
    const created_at = "2026-08-04T00:00:00.000Z";
    this.contentPacks = [
      {
        content_key: "evidence", version: "coach-evidence-2026-08-03", is_active: 1,
        body_markdown: "# 云端证据", created_at,
        payload_json: JSON.stringify({ references: [{
          id: "who-adult-activity-2020",
          title: "WHO Guidelines on physical activity and sedentary behaviour",
          url: "https://www.who.int/publications/i/item/9789240014886",
        }] }),
      },
      ...["training_planner", "weekly_adjustment", "daily_adjustment"].map((content_key) => ({
        content_key, version: `${content_key}-v1`, is_active: 1,
        body_markdown: `# ${content_key}`, payload_json: "{}", created_at,
      })),
      {
        content_key: "user_preferences", version: "user-preferences-template-2026-08-04", is_active: 1,
        body_markdown: "# 用户偏好", payload_json: "{}", created_at,
      },
    ];
    this.plans = [];
    this.profiles = [];
    this.decisions = [];
    this.mirrors = [];
    this.claims = new Map();
  }
  prepare(sql) { return new MemoryD1Statement(this, sql); }
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

function env() {
  return {
    OAUTH_KV: new MemoryKv(),
    COACH_DB: new MemoryD1(),
    COACH_ARCHIVE: new MemoryR2(),
    CONNECTOR_PASSWORD: "test-password",
    XUNJI_TRAIN_API_KEY: "test-train",
    XUNJI_FOOD_API_KEY: "test-food",
    XUNJI_BODY_API_KEY: "test-body",
  };
}

function validPlan(overrides = {}) {
  return {
    title: "8 周减脂与力量保持",
    start_date: "2026-08-03",
    end_date: "2026-09-27",
    goal: "在保持主要力量表现的同时稳定减脂",
    success_metrics: ["训练完成率达到 80%", "主要动作表现基本稳定"],
    weekly_structure: ["每周三次力量训练", "每周两次低强度有氧"],
    progression_rules: ["动作稳定后再增加负荷"],
    recovery_rules: ["睡眠和恢复明显下降时降量"],
    missed_session_rules: ["漏训后不叠加两天训练量"],
    guardrails: ["疼痛或异常生理指标时停止训练"],
    evidence_version: "coach-evidence-2026-08-03",
    evidence_refs: [{
      id: "who-adult-activity-2020",
      title: "WHO Guidelines on physical activity and sedentary behaviour",
      url: "https://www.who.int/publications/i/item/9789240014886",
      applies_to: ["weekly_structure"],
    }],
    baseline_window_days: 28,
    decision_rules: ["恢复决策使用多信号，不依据单次 HRV"],
    data_quality_rules: ["设备变化时降低趋势判断置信度"],
    constraints: ["工作日 19:00 后训练"],
    review_date: "2026-08-31",
    profile_snapshot: {
      training_experience: "规律训练两年",
      equipment: ["商业健身房"],
      weekly_availability: ["周一晚", "周三晚", "周六上午"],
      session_duration_minutes: 60,
      preferences: ["偏好自由重量"],
      constraints: ["工作日 19:00 后训练"],
      safety_constraints: ["疼痛时停止相关动作"],
    },
    baseline_summary: {
      observed_window_days: 28,
      training_summary: "过去四周平均每周完成三次训练",
      body_trend_summary: "体重趋势缓慢下降",
      recovery_summary: "恢复总体稳定",
      data_quality_notes: ["睡眠记录有少量缺失"],
    },
    ...overrides,
  };
}

test("health endpoint is public and contains no secret", async () => {
  const response = await worker.fetch(new Request("https://example.test/health"), env());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "xunji-cloud-coach", version: "1.5.1" });
});

test("MCP endpoint rejects unauthenticated requests with protected resource metadata", async () => {
  const response = await worker.fetch(new Request("https://example.test/mcp", { method: "POST", body: "{}" }), env());
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate"), /oauth-protected-resource/);
});

test("OAuth discovery advertises PKCE and refresh tokens", async () => {
  const response = await worker.fetch(new Request("https://example.test/.well-known/oauth-authorization-server"), env());
  const metadata = await response.json();
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.ok(metadata.grant_types_supported.includes("refresh_token"));
  assert.ok(metadata.scopes_supported.includes("offline_access"));
});

test("dynamic registration rejects non-HTTPS callbacks", async () => {
  const response = await worker.fetch(new Request("https://example.test/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://insecure.test/callback"] }),
  }), env());
  assert.equal(response.status, 400);
});

test("authenticated MCP client can initialize and list guarded tools", async () => {
  const testEnv = env();
  await testEnv.OAUTH_KV.put("token:good", JSON.stringify({ client_id: "client", scope: "xunji.read xunji.write" }));
  const call = async (body) => worker.fetch(new Request("https://example.test/mcp", {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify(body),
  }), testEnv);
  const initialized = await (await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).json();
  assert.equal(initialized.result.serverInfo.name, "xunji-cloud-coach");
  assert.match(initialized.result.instructions, /xunji_workflow_context_get/);
  assert.match(initialized.result.instructions, /training_planner/);
  assert.match(initialized.result.instructions, /weekly_adjustment/);
  assert.match(initialized.result.instructions, /daily_adjustment/);
  assert.match(initialized.result.instructions, /调用失败时立即停止/);
  assert.match(initialized.result.instructions, /总纲保存成功后不要结束/);
  assert.match(initialized.result.instructions, /Google Drive\/Docs/);
  assert.match(initialized.result.instructions, /镜像失败不得阻断/);
  assert.match(initialized.result.instructions, /总纲确认不等于镜像授权/);
  assert.match(initialized.result.instructions, /google_docs_not_authorized/);
  assert.match(initialized.result.instructions, /两次独立确认/);
  assert.match(initialized.result.instructions, /不得读取本地文件/);
  assert.match(initialized.result.instructions, /prepare/);
  const listed = await (await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).json();
  assert.ok(listed.result.tools.some((tool) => tool.name === "xunji_commit_training_upsert" && tool.annotations.destructiveHint));
  assert.ok(listed.result.tools.some((tool) => tool.name === "xunji_food_query" && tool.annotations.readOnlyHint));
  assert.ok(listed.result.tools.some((tool) => tool.name === "xunji_coaching_plan_get" && tool.annotations.readOnlyHint));
  assert.ok(listed.result.tools.some((tool) => tool.name === "xunji_commit_coaching_plan_upsert" && tool.annotations.destructiveHint));
  const mirrorTool = listed.result.tools.find((tool) => tool.name === "xunji_commit_coaching_plan_mirror");
  assert.equal(mirrorTool.annotations.idempotentHint, true);
  assert.equal(mirrorTool.annotations.destructiveHint, false);
  const workflowTool = listed.result.tools.find((tool) => tool.name === "xunji_workflow_context_get");
  assert.ok(workflowTool.annotations.readOnlyHint);
  assert.match(workflowTool.description, /首个调用/);
  assert.match(workflowTool.description, /调用成功前不要生成计划/);
  const movementTool = listed.result.tools.find((tool) => tool.name === "xunji_movement_search");
  assert.ok(movementTool.annotations.readOnlyHint);
  assert.equal(movementTool.outputSchema.properties.schema_version.const, "movement_catalog_search_v2");
  assert.equal(listed.result.tools.find((tool) => tool.name === "xunji_training_plan_list").outputSchema.properties.schema_version.const, "xunji_plan_list_v1");
  const prepareTool = listed.result.tools.find((tool) => tool.name === "xunji_prepare_training_upsert");
  const trainSchema = prepareTool.inputSchema.properties.trains.items;
  assert.deepEqual(trainSchema.required, ["datestr", "title", "movements"]);
  assert.equal(trainSchema.properties.datestr.pattern, "^\\d{4}-\\d{2}-\\d{2}$");
});

test("workflow context comes entirely from cloud content and exposes history indexes", async () => {
  const testEnv = env();
  await testEnv.OAUTH_KV.put("token:good", JSON.stringify({ client_id: "client", scope: "xunji.read" }));
  const response = await worker.fetch(new Request("https://example.test/mcp", {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 90, method: "tools/call",
      params: { name: "xunji_workflow_context_get", arguments: { workflow: "training_planner" } },
    }),
  }), testEnv);
  const data = await response.json();
  const context = data.result.structuredContent;
  assert.equal(context.schema_version, "xunji_workflow_context_v1");
  assert.equal(context.workflow_content.key, "training_planner");
  assert.equal(context.evidence.version, "coach-evidence-2026-08-03");
  assert.equal(context.workflow_version, "training_planner-v1");
  assert.equal(context.user_preferences.key, "user_preferences");
  assert.equal(context.local_files_used, false);
  assert.deepEqual(context.recent_history, []);
});

test("coaching plan prepare rejects stale or unregistered cloud evidence", async () => {
  const testEnv = env();
  await testEnv.OAUTH_KV.put("token:good", JSON.stringify({ client_id: "client", scope: "xunji.read xunji.write" }));
  const response = await worker.fetch(new Request("https://example.test/mcp", {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 91, method: "tools/call",
      params: {
        name: "xunji_prepare_coaching_plan_upsert",
        arguments: { plan: validPlan({ evidence_version: "stale-evidence" }) },
      },
    }),
  }), testEnv);
  const data = await response.json();
  assert.equal(data.result.isError, true);
  assert.match(data.result.content[0].text, /当前云端版本/);
});

test("weekly or daily adjustment cannot be prepared without the active plan version", async () => {
  const testEnv = env();
  await testEnv.OAUTH_KV.put("token:good", JSON.stringify({ client_id: "client", scope: "xunji.read xunji.write" }));
  const response = await worker.fetch(new Request("https://example.test/mcp", {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 92, method: "tools/call",
      params: {
        name: "xunji_prepare_training_upsert",
        arguments: {
          trains: [{ datestr: "2026-08-03", title: "测试", movements: [] }],
          decision_context: {
            workflow: "daily_adjustment",
            plan_version: "missing",
            evidence_version: "coach-evidence-2026-08-03",
            rationale: ["测试"],
          },
        },
      },
    }),
  }), testEnv);
  const data = await response.json();
  assert.equal(data.result.isError, true);
  assert.match(data.result.content[0].text, /当前已确认的训练总纲/);
});

test("movement search ranks exact names and reuses the cached catalog", async () => {
  const testEnv = env();
  await testEnv.OAUTH_KV.put("token:good", JSON.stringify({ client_id: "client", scope: "xunji.read" }));
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async (url, init) => {
    upstreamCalls += 1;
    assert.match(String(url), /api_movement_catalog_for_llm_v2$/);
    assert.deepEqual(JSON.parse(init.body), { schema_version: "train_open_api_v2" });
    return new Response(JSON.stringify({ res: { movements: [
      { name: "上斜杠铃卧推", type: "胸", exetype: "负重", aliases: [] },
      { name: "杠铃卧推", type: "胸", exetype: "负重", aliases: ["平板杠铃推胸"] },
      { name: "器械推胸", type: "胸", exetype: "负重", aliases: ["坐姿推胸"] },
      { name: "杠铃划船", type: "背", exetype: "负重", aliases: [] },
    ] } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const call = async (args, id) => {
    const response = await worker.fetch(new Request("https://example.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id, method: "tools/call",
        params: { name: "xunji_movement_search", arguments: args },
      }),
    }), testEnv);
    return response.json();
  };
  try {
    const first = await call({ keyword: "杠铃卧推", body_part: "胸", limit: 2 }, 30);
    assert.equal(first.result.isError, false);
    assert.equal(first.result.structuredContent.catalog_count, 4);
    assert.equal(first.result.structuredContent.source, "upstream");
    assert.equal(first.result.structuredContent.identity_status, "exact_unique");
    assert.equal(first.result.structuredContent.identity_confidence, "high");
    assert.equal(first.result.structuredContent.recommended_name, "杠铃卧推");
    assert.equal(first.result.structuredContent.requires_identity_confirmation, false);
    assert.equal(first.result.structuredContent.suitability_status, "not_assessed");
    assert.equal(first.result.structuredContent.matches[0].match_type, "exact_name");
    assert.deepEqual(first.result.structuredContent.movements.map((movement) => movement.name), ["杠铃卧推", "上斜杠铃卧推"]);

    const second = await call({ keyword: "坐姿推胸" }, 31);
    assert.equal(second.result.structuredContent.source, "cache");
    assert.equal(second.result.structuredContent.movements[0].name, "器械推胸");
    assert.equal(second.result.structuredContent.matches[0].match_type, "exact_alias");
    assert.equal(second.result.structuredContent.identity_status, "exact_unique");

    const fuzzy = await call({ keyword: "卧推", body_part: "胸" }, 32);
    assert.equal(fuzzy.result.structuredContent.identity_status, "ambiguous");
    assert.equal(fuzzy.result.structuredContent.identity_confidence, "low");
    assert.equal(fuzzy.result.structuredContent.recommended_name, null);
    assert.equal(fuzzy.result.structuredContent.requires_identity_confirmation, true);

    const filterOnly = await call({ body_part: "背" }, 33);
    assert.equal(filterOnly.result.structuredContent.identity_status, "filter_only");
    assert.equal(filterOnly.result.structuredContent.requires_identity_confirmation, true);
    assert.equal(filterOnly.result.structuredContent.movements[0].name, "杠铃划船");
    assert.equal(upstreamCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("official plan tools expose stable normalized outputs", async () => {
  const testEnv = env();
  await testEnv.OAUTH_KV.put("token:good", JSON.stringify({ client_id: "client", scope: "xunji.read" }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    if (payload.action === "list") {
      return new Response(JSON.stringify({ res: { plans: [{ plan_ref: "platform:155", title: "基础计划" }] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ res: {
      plan: { plan_ref: payload.plan_ref, title: "基础计划" },
      date_range: { start_date: payload.start_date, end_date: payload.end_date },
      days: [{ date: payload.start_date, movements: [{ name: "杠铃卧推" }] }],
    } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const call = async (name, args, id) => {
    const response = await worker.fetch(new Request("https://example.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    }), testEnv);
    return response.json();
  };
  try {
    const listed = await call("xunji_training_plan_list", {}, 40);
    assert.deepEqual(listed.result.structuredContent, {
      schema_version: "xunji_plan_list_v1",
      count: 1,
      plans: [{ plan_ref: "platform:155", title: "基础计划" }],
    });
    const detail = await call("xunji_training_plan_get", {
      plan_ref: "platform:155",
      start_date: "2026-08-03",
      end_date: "2026-08-09",
      include_movements: true,
    }, 41);
    assert.equal(detail.result.structuredContent.schema_version, "xunji_plan_detail_v1");
    assert.equal(detail.result.structuredContent.plan.plan_ref, "platform:155");
    assert.equal(detail.result.structuredContent.days[0].movements[0].name, "杠铃卧推");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("movement search requires at least one search condition", async () => {
  const testEnv = env();
  await testEnv.OAUTH_KV.put("token:good", JSON.stringify({ client_id: "client", scope: "xunji.read" }));
  const response = await worker.fetch(new Request("https://example.test/mcp", {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 32, method: "tools/call",
      params: { name: "xunji_movement_search", arguments: {} },
    }),
  }), testEnv);
  const data = await response.json();
  assert.equal(data.result.isError, true);
  assert.match(data.result.content[0].text, /至少提供一个/);
});

test("coaching plan is absent until a confirmed preview is committed and commit replay is safe", async () => {
  const testEnv = env();
  await testEnv.OAUTH_KV.put("token:good", JSON.stringify({ client_id: "client", scope: "xunji.read xunji.write" }));
  const call = async (name, args, id) => {
    const response = await worker.fetch(new Request("https://example.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    }), testEnv);
    return response.json();
  };
  const absent = await call("xunji_coaching_plan_get", {}, 20);
  assert.deepEqual(absent.result.structuredContent, { exists: false, plan: null });

  const plan = validPlan();
  const prepared = await call("xunji_prepare_coaching_plan_upsert", { plan }, 21);
  assert.equal(prepared.result.structuredContent.validation.saved, false);
  assert.equal(prepared.result.structuredContent.post_commit.google_docs_mirror.mode, "best_effort");
  assert.equal(prepared.result.structuredContent.post_commit.google_docs_mirror.contains_sensitive_derived_data, true);
  assert.deepEqual(
    prepared.result.structuredContent.post_commit.google_docs_mirror.sensitive_derived_data_categories,
    [
      "injury_and_safety_constraints",
      "sleep_hrv_resting_heart_rate_trends",
      "weight_and_body_fat_trends",
      "training_preferences",
      "medical_evidence_summary",
    ],
  );
  assert.equal(prepared.result.structuredContent.post_commit.google_docs_mirror.requires_explicit_destination_authorization, true);
  assert.equal(prepared.result.structuredContent.post_commit.google_docs_mirror.plan_confirmation_implies_mirror_authorization, false);
  assert.equal(prepared.result.structuredContent.post_commit.google_docs_mirror.not_authorized_error_code, "google_docs_not_authorized");
  assert.equal(prepared.result.structuredContent.post_commit.google_docs_mirror.failure_blocks_plan_or_schedule, false);
  assert.match(prepared.result.structuredContent.instruction, /只确认总纲不等于授权镜像/);
  assert.equal((await call("xunji_coaching_plan_get", {}, 22)).result.structuredContent.exists, false);
  const token = prepared.result.structuredContent.confirmation_token;
  const first = await call("xunji_commit_coaching_plan_upsert", { confirmation_token: token, user_confirmed: true }, 23);
  const second = await call("xunji_commit_coaching_plan_upsert", { confirmation_token: token, user_confirmed: true }, 24);
  assert.equal(first.result.structuredContent.status, "committed");
  assert.equal(first.result.structuredContent.replayed, false);
  assert.equal(second.result.structuredContent.replayed, true);
  assert.equal(second.result.structuredContent.plan.version, first.result.structuredContent.plan.version);
  const saved = await call("xunji_coaching_plan_get", {}, 25);
  assert.equal(saved.result.structuredContent.exists, true);
  assert.equal(saved.result.structuredContent.plan.goal, plan.goal);
  assert.equal(saved.result.structuredContent.plan.evidence_version, "coach-evidence-2026-08-03");
  assert.equal(saved.result.structuredContent.plan.baseline_window_days, 28);
  assert.equal(saved.result.structuredContent.plan.archive.status, "stored");
  assert.equal(saved.result.structuredContent.plan.mirrors.google_docs.status, "pending");
  assert.equal(testEnv.COACH_ARCHIVE.objects.size, 1);
  const history = await call("xunji_coaching_history_query", { type: "plans" }, 26);
  assert.equal(history.result.structuredContent.count, 1);
  assert.equal(history.result.structuredContent.entries[0].version, saved.result.structuredContent.plan.version);
});

test("Google Docs plan mirror metadata is guarded, canonical, and idempotent", async () => {
  const testEnv = env();
  await testEnv.OAUTH_KV.put("token:good", JSON.stringify({ client_id: "client", scope: "xunji.read xunji.write" }));
  const call = async (name, args, id) => {
    const response = await worker.fetch(new Request("https://example.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    }), testEnv);
    return response.json();
  };

  const prepared = await call("xunji_prepare_coaching_plan_upsert", { plan: validPlan() }, 120);
  const committed = await call("xunji_commit_coaching_plan_upsert", {
    confirmation_token: prepared.result.structuredContent.confirmation_token,
    user_confirmed: true,
  }, 121);
  const planVersion = committed.result.structuredContent.plan.version;
  const documentId = "1AbCdEfGhIjKlMnOpQrStUvWxYz_123456";
  const stored = await call("xunji_commit_coaching_plan_mirror", {
    plan_version: planVersion,
    provider: "google_docs",
    status: "stored",
    document_id: documentId,
    document_url: `https://docs.google.com/document/d/${documentId}/edit?usp=sharing`,
  }, 122);
  assert.equal(stored.result.structuredContent.replayed, false);
  assert.equal(stored.result.structuredContent.mirror.status, "stored");
  assert.equal(stored.result.structuredContent.mirror.document_url, `https://docs.google.com/document/d/${documentId}`);

  const replay = await call("xunji_commit_coaching_plan_mirror", {
    plan_version: planVersion,
    provider: "google_docs",
    status: "stored",
    document_id: documentId,
    document_url: `https://docs.google.com/document/d/${documentId}`,
  }, 123);
  assert.equal(replay.result.structuredContent.replayed, true);

  const downgrade = await call("xunji_commit_coaching_plan_mirror", {
    plan_version: planVersion,
    provider: "google_docs",
    status: "failed",
    error_code: "drive_unavailable",
  }, 124);
  assert.equal(downgrade.result.isError, true);
  assert.match(downgrade.result.content[0].text, /不能覆盖或降级/);

  const saved = await call("xunji_coaching_plan_get", {}, 125);
  assert.equal(saved.result.structuredContent.plan.mirrors.google_docs.document_id, documentId);
  const history = await call("xunji_coaching_history_query", { type: "plans" }, 126);
  assert.equal(history.result.structuredContent.entries[0].mirrors.google_docs.status, "stored");
});

test("failed Google Docs mirror status stores only a bounded code and can later recover", async () => {
  const testEnv = env();
  await testEnv.OAUTH_KV.put("token:good", JSON.stringify({ client_id: "client", scope: "xunji.read xunji.write" }));
  const call = async (name, args, id) => {
    const response = await worker.fetch(new Request("https://example.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    }), testEnv);
    return response.json();
  };
  const prepared = await call("xunji_prepare_coaching_plan_upsert", { plan: validPlan() }, 130);
  const committed = await call("xunji_commit_coaching_plan_upsert", {
    confirmation_token: prepared.result.structuredContent.confirmation_token,
    user_confirmed: true,
  }, 131);
  const planVersion = committed.result.structuredContent.plan.version;
  const failed = await call("xunji_commit_coaching_plan_mirror", {
    plan_version: planVersion,
    provider: "google_docs",
    status: "failed",
    error_code: "google_drive_not_connected",
  }, 132);
  assert.equal(failed.result.structuredContent.mirror.status, "failed");
  assert.equal(failed.result.structuredContent.mirror.error_code, "google_drive_not_connected");

  const unsafe = await call("xunji_commit_coaching_plan_mirror", {
    plan_version: planVersion,
    provider: "google_docs",
    status: "failed",
    error_code: "Bearer secret token",
  }, 133);
  assert.equal(unsafe.result.isError, true);
  assert.match(unsafe.result.content[0].text, /error_code/);

  const documentId = "1RecoverableGoogleDocument_123456789";
  const recovered = await call("xunji_commit_coaching_plan_mirror", {
    plan_version: planVersion,
    provider: "google_docs",
    status: "stored",
    document_id: documentId,
    document_url: `https://docs.google.com/document/d/${documentId}`,
  }, 134);
  assert.equal(recovered.result.structuredContent.mirror.status, "stored");
});

test("a replay repairs a failed plan archive without creating a second plan version", async () => {
  const testEnv = env();
  testEnv.COACH_ARCHIVE.failuresRemaining = 1;
  await testEnv.OAUTH_KV.put("token:good", JSON.stringify({ client_id: "client", scope: "xunji.read xunji.write" }));
  const call = async (name, args, id) => {
    const response = await worker.fetch(new Request("https://example.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    }), testEnv);
    return response.json();
  };
  const prepared = await call("xunji_prepare_coaching_plan_upsert", { plan: validPlan() }, 93);
  const confirmationToken = prepared.result.structuredContent.confirmation_token;
  const first = await call("xunji_commit_coaching_plan_upsert", {
    confirmation_token: confirmationToken,
    user_confirmed: true,
  }, 94);
  assert.equal(first.result.structuredContent.plan.archive.status, "failed");
  const version = first.result.structuredContent.plan.version;
  const replay = await call("xunji_commit_coaching_plan_upsert", {
    confirmation_token: confirmationToken,
    user_confirmed: true,
  }, 95);
  assert.equal(replay.result.structuredContent.replayed, true);
  assert.equal(replay.result.structuredContent.plan.version, version);
  assert.equal(replay.result.structuredContent.plan.archive.status, "stored");
  assert.equal(testEnv.COACH_DB.plans.length, 1);
});

test("prepare is local-only and normalizes legacy date, actions, and duration_sec aliases", async () => {
  const testEnv = env();
  await testEnv.OAUTH_KV.put("token:good", JSON.stringify({ client_id: "client", scope: "xunji.read xunji.write" }));
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("prepare must not call upstream"); };
  try {
    const response = await worker.fetch(new Request("https://example.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "xunji_prepare_training_upsert",
          arguments: {
            trains: [{
              date: "2026-08-03",
              title: "测试训练任务",
              actions: [{ name: "平板支撑", sets: [{ duration_sec: 60 }] }],
            }],
          },
        },
      }),
    }), testEnv);
    const data = await response.json();
    assert.equal(data.result.isError, false);
    assert.equal(upstreamCalls, 0);
    assert.deepEqual(data.result.structuredContent.validation, {
      valid: true,
      mode: "local_only",
      upstream_called: false,
    });
    const confirmationToken = data.result.structuredContent.confirmation_token;
    const pending = JSON.parse(await testEnv.OAUTH_KV.get(`confirm:${confirmationToken}`));
    const upstreamPayload = pending.payload;
    assert.equal(pending.status, "pending");
    assert.equal(upstreamPayload.dry_run, false);
    assert.equal(upstreamPayload.res[0].datestr, "2026-08-03");
    assert.equal(upstreamPayload.res[0].date, undefined);
    assert.equal(upstreamPayload.res[0].actions, undefined);
    assert.equal(upstreamPayload.res[0].movements[0].sets[0].duration_s, 60);
    assert.equal(data.result.structuredContent.summary[0].date, "2026-08-03");
    assert.equal(data.result.structuredContent.summary[0].movements[0].sets[0].duration_s, 60);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("commit writes once and replays the cached result for the same confirmation token", async () => {
  const testEnv = env();
  await testEnv.OAUTH_KV.put("token:good", JSON.stringify({ client_id: "client", scope: "xunji.read xunji.write" }));
  const call = async (name, args, id) => worker.fetch(new Request("https://example.test/mcp", {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  }), testEnv);
  const prepare = await (await call("xunji_prepare_training_upsert", {
    trains: [{ datestr: "2026-08-03", title: "测试训练任务", movements: [{ name: "平板支撑", sets: [{ duration_s: 60 }] }] }],
    decision_context: {
      workflow: "manual_update",
      rationale: ["近期恢复趋势支持正常训练"],
      data_window: { start_date: "2026-07-07", end_date: "2026-08-03" },
      data_quality: ["数据完整"],
    },
  }, 6)).json();
  const confirmationToken = prepare.result.structuredContent.confirmation_token;
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  let writeCalls = 0;
  globalThis.fetch = async (url, init) => {
    upstreamCalls += 1;
    const payload = JSON.parse(init.body);
    if (String(url).endsWith("/api_trains_for_llm_v2")) {
      return new Response(JSON.stringify({ res: { trains: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    writeCalls += 1;
    assert.equal(payload.dry_run, false);
    return new Response(JSON.stringify({ res: { trains: [{ localid: 123, ...payload.res[0] }] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const first = await (await call("xunji_commit_training_upsert", {
      confirmation_token: confirmationToken,
      user_confirmed: true,
    }, 7)).json();
    await testEnv.OAUTH_KV.delete(`confirm:${confirmationToken}`);
    const second = await (await call("xunji_commit_training_upsert", {
      confirmation_token: confirmationToken,
      user_confirmed: true,
    }, 8)).json();
    assert.equal(first.result.structuredContent.status, "committed");
    assert.equal(first.result.structuredContent.replayed, false);
    assert.equal(second.result.structuredContent.status, "committed");
    assert.equal(second.result.structuredContent.replayed, true);
    assert.deepEqual(second.result.structuredContent.result, first.result.structuredContent.result);
    assert.equal(first.result.structuredContent.decision_record.archive.status, "stored");
    assert.equal(testEnv.COACH_DB.decisions.length, 1);
    assert.equal(upstreamCalls, 2);
    assert.equal(writeCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("concurrent commits use the D1 claim so only one request reaches the Xunji write API", async () => {
  const testEnv = env();
  await testEnv.OAUTH_KV.put("token:good", JSON.stringify({ client_id: "client", scope: "xunji.read xunji.write" }));
  const call = async (name, args, id) => worker.fetch(new Request("https://example.test/mcp", {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  }), testEnv);
  const prepared = await (await call("xunji_prepare_training_upsert", {
    trains: [{ datestr: "2026-08-04", title: "并发测试", movements: [{ name: "平板支撑", sets: [{ duration_s: 30 }] }] }],
  }, 70)).json();
  const confirmationToken = prepared.result.structuredContent.confirmation_token;
  const originalFetch = globalThis.fetch;
  let writeCalls = 0;
  let releaseWrite;
  let markWriteStarted;
  const writeStarted = new Promise((resolve) => { markWriteStarted = resolve; });
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/api_trains_for_llm_v2")) {
      return new Response(JSON.stringify({ res: { trains: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    writeCalls += 1;
    markWriteStarted();
    await writeGate;
    const payload = JSON.parse(init.body);
    return new Response(JSON.stringify({ res: { trains: payload.res } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const firstPromise = call("xunji_commit_training_upsert", {
      confirmation_token: confirmationToken,
      user_confirmed: true,
    }, 71);
    await writeStarted;
    const second = await (await call("xunji_commit_training_upsert", {
      confirmation_token: confirmationToken,
      user_confirmed: true,
    }, 72)).json();
    assert.equal(second.result.structuredContent.status, "committing");
    releaseWrite();
    const first = await (await firstPromise).json();
    assert.equal(first.result.structuredContent.status, "committed");
    assert.equal(writeCalls, 1);
  } finally {
    releaseWrite();
    globalThis.fetch = originalFetch;
  }
});

test("an ambiguous commit failure is not retried with the same token", async () => {
  const testEnv = env();
  await testEnv.OAUTH_KV.put("token:good", JSON.stringify({ client_id: "client", scope: "xunji.read xunji.write" }));
  const call = async (name, args, id) => worker.fetch(new Request("https://example.test/mcp", {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  }), testEnv);
  const prepare = await (await call("xunji_prepare_training_upsert", {
    trains: [{ datestr: "2026-08-03", title: "测试训练任务", movements: [{ name: "平板支撑", sets: [{ duration_s: 60 }] }] }],
  }, 9)).json();
  const confirmationToken = prepare.result.structuredContent.confirmation_token;
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  let writeCalls = 0;
  let trainingExists = false;
  globalThis.fetch = async (url) => {
    upstreamCalls += 1;
    if (String(url).endsWith("/api_trains_for_llm_v2")) {
      return new Response(JSON.stringify({ res: { trains: trainingExists ? [{
        localid: 1785737496710002,
        datestr: "2026-08-03",
        title: "测试训练任务",
        start: -1,
        end: -1,
        movements: [{ name: "平板支撑", sets: [{ done: false, weight: "", unit: "", reps: "", time: 60, selfWeight: false, rpe: "" }] }],
      }] : [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    writeCalls += 1;
    throw new Error("network timeout");
  };
  try {
    const first = await (await call("xunji_commit_training_upsert", {
      confirmation_token: confirmationToken,
      user_confirmed: true,
    }, 10)).json();
    const second = await (await call("xunji_commit_training_upsert", {
      confirmation_token: confirmationToken,
      user_confirmed: true,
    }, 11)).json();
    assert.equal(first.result.isError, true);
    assert.equal(second.result.isError, true);
    assert.match(second.result.content[0].text, /不要直接重试|人工核对/);
    assert.equal(upstreamCalls, 3);
    assert.equal(writeCalls, 1);
    trainingExists = true;
    const reconciled = await (await call("xunji_commit_training_upsert", {
      confirmation_token: confirmationToken,
      user_confirmed: true,
    }, 14)).json();
    const replayed = await (await call("xunji_commit_training_upsert", {
      confirmation_token: confirmationToken,
      user_confirmed: true,
    }, 15)).json();
    assert.equal(reconciled.result.structuredContent.status, "committed");
    assert.equal(reconciled.result.structuredContent.reconciled, true);
    assert.equal(replayed.result.structuredContent.status, "committed");
    assert.equal(replayed.result.structuredContent.replayed, true);
    assert.equal(upstreamCalls, 4);
    assert.equal(writeCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("commit skips an identical training that already exists", async () => {
  const testEnv = env();
  await testEnv.OAUTH_KV.put("token:good", JSON.stringify({ client_id: "client", scope: "xunji.read xunji.write" }));
  const call = async (name, args, id) => worker.fetch(new Request("https://example.test/mcp", {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  }), testEnv);
  const prepare = await (await call("xunji_prepare_training_upsert", {
    trains: [{ datestr: "2026-08-03", title: "测试训练任务", movements: [{ name: "平板支撑", sets: [{ duration_s: 60 }] }] }],
  }, 12)).json();
  const confirmationToken = prepare.result.structuredContent.confirmation_token;
  const originalFetch = globalThis.fetch;
  let writeCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api_trains_for_llm_v2")) {
      return new Response(JSON.stringify({ res: { trains: [{
        localid: 1785737496710001,
        datestr: "2026-08-03",
        title: "测试训练任务",
        start: -1,
        end: -1,
        movements: [{ name: "平板支撑", sets: [{ done: false, weight: "", unit: "", reps: "", time: 60, selfWeight: false, rpe: "" }] }],
      }] } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    writeCalls += 1;
    throw new Error("duplicate write must not happen");
  };
  try {
    const committed = await (await call("xunji_commit_training_upsert", {
      confirmation_token: confirmationToken,
      user_confirmed: true,
    }, 13)).json();
    assert.equal(committed.result.isError, false);
    assert.equal(committed.result.structuredContent.status, "committed");
    assert.equal(committed.result.structuredContent.deduplicated, true);
    assert.equal(committed.result.structuredContent.result.res.trains[0].localid, 1785737496710001);
    assert.equal(writeCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("commit tool cannot run without a confirmation token", async () => {
  const testEnv = env();
  await testEnv.OAUTH_KV.put("token:good", JSON.stringify({ client_id: "client", scope: "xunji.read xunji.write" }));
  const response = await worker.fetch(new Request("https://example.test/mcp", {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "xunji_commit_training_upsert", arguments: { confirmation_token: "missing", user_confirmed: true } },
    }),
  }), testEnv);
  const data = await response.json();
  assert.equal(data.result.isError, true);
  assert.match(data.result.content[0].text, /无效|过期/);
});

test("read-only OAuth scope cannot invoke the commit tool", async () => {
  const testEnv = env();
  await testEnv.OAUTH_KV.put("token:read", JSON.stringify({ client_id: "client", scope: "xunji.read" }));
  const response = await worker.fetch(new Request("https://example.test/mcp", {
    method: "POST",
    headers: { authorization: "Bearer read", "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "xunji_commit_training_upsert", arguments: { confirmation_token: "missing", user_confirmed: true } },
    }),
  }), testEnv);
  const data = await response.json();
  assert.equal(data.result.isError, true);
  assert.match(data.result.content[0].text, /xunji.write/);
});
