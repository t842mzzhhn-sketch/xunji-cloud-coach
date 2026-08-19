const WORKFLOW_CONTENT_KEYS = Object.freeze({
  training_planner: "training_planner",
  weekly_adjustment: "weekly_adjustment",
  daily_adjustment: "daily_adjustment",
});

function requireD1(env) {
  if (!env.COACH_DB?.prepare) {
    throw new Error("COACH_DB 未配置；云端计划、证据和历史不可用");
  }
  return env.COACH_DB;
}

function parseJson(value, fallback = null) {
  if (value == null || value === "") return fallback;
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function first(db, sql, ...bindings) {
  return db.prepare(sql).bind(...bindings).first();
}

async function run(db, sql, ...bindings) {
  return db.prepare(sql).bind(...bindings).run();
}

export async function getActiveContentPack(env, contentKey) {
  const row = await first(
    requireD1(env),
    `SELECT content_key, version, body_markdown, payload_json, created_at
       FROM content_packs
      WHERE content_key = ? AND is_active = 1
      LIMIT 1`,
    contentKey,
  );
  if (!row) return null;
  return {
    key: row.content_key,
    version: row.version,
    body_markdown: row.body_markdown,
    payload: parseJson(row.payload_json, {}),
    published_at: row.created_at,
  };
}

function planFromRow(row) {
  if (!row) return null;
  const plan = parseJson(row.plan_json, {});
  return {
    ...plan,
    version: row.version,
    updated_at: row.created_at,
    archive: {
      key: row.archive_key ?? null,
      status: row.archive_status,
    },
  };
}

function mirrorFromRow(row) {
  if (!row) {
    return {
      provider: "google_docs",
      status: "not_requested",
      document_id: null,
      document_url: null,
      error_code: null,
      updated_at: null,
    };
  }
  return {
    provider: row.provider,
    status: row.status,
    document_id: row.document_id ?? null,
    document_url: row.document_url ?? null,
    error_code: row.error_code ?? null,
    updated_at: row.updated_at,
  };
}

export async function getPlanMirror(env, planVersion, provider = "google_docs") {
  const row = await first(
    requireD1(env),
    `SELECT provider, status, document_id, document_url, error_code, updated_at
       FROM coaching_plan_mirrors
      WHERE plan_version = ? AND provider = ?
      LIMIT 1`,
    planVersion,
    provider,
  );
  return mirrorFromRow(row);
}

async function attachPlanMirror(env, row) {
  const plan = planFromRow(row);
  if (!plan) return null;
  plan.mirrors = { google_docs: await getPlanMirror(env, plan.version) };
  return plan;
}

export async function getCurrentPlan(env) {
  const row = await first(
    requireD1(env),
    `SELECT version, plan_json, archive_key, archive_status, created_at
       FROM coaching_plans
      WHERE is_active = 1
      ORDER BY created_at DESC
      LIMIT 1`,
  );
  return attachPlanMirror(env, row);
}

export async function getPlanByConfirmationToken(env, confirmationToken) {
  const row = await first(
    requireD1(env),
    `SELECT version, plan_json, archive_key, archive_status, created_at
       FROM coaching_plans
      WHERE confirmation_token = ?
      LIMIT 1`,
    confirmationToken,
  );
  return attachPlanMirror(env, row);
}

function canonicalGoogleDocReference(documentId, documentUrl) {
  if (typeof documentId !== "string" || !/^[A-Za-z0-9_-]{20,}$/.test(documentId)) {
    throw new Error("document_id 不是有效的 Google Docs 文档 ID");
  }
  let url;
  try { url = new URL(documentUrl); } catch { throw new Error("document_url 不是有效 URL"); }
  const match = /^\/document\/d\/([A-Za-z0-9_-]{20,})(?:\/.*)?$/.exec(url.pathname);
  if (url.protocol !== "https:" || url.hostname !== "docs.google.com" || !match || match[1] !== documentId) {
    throw new Error("document_url 必须是与 document_id 匹配的 Google Docs URL");
  }
  return {
    document_id: documentId,
    document_url: `https://docs.google.com/document/d/${documentId}`,
  };
}

export async function recordPlanMirror(env, input) {
  const db = requireD1(env);
  if (input?.provider !== "google_docs") throw new Error("provider 目前只支持 google_docs");
  if (!input.plan_version || typeof input.plan_version !== "string") throw new Error("plan_version 不能为空");
  if (!["stored", "failed"].includes(input.status)) throw new Error("status 必须是 stored 或 failed");

  const currentPlan = await getCurrentPlan(env);
  if (!currentPlan || currentPlan.version !== input.plan_version) {
    throw new Error("plan_version 必须匹配当前已确认的训练总纲");
  }
  const existing = currentPlan.mirrors.google_docs;
  if (existing.status === "stored") {
    if (input.status === "stored" && input.document_id === existing.document_id) {
      return { mirror: existing, replayed: true };
    }
    throw new Error("当前计划已记录 Google Docs 镜像，不能覆盖或降级");
  }

  let documentId = null;
  let documentUrl = null;
  let errorCode = null;
  if (input.status === "stored") {
    const reference = canonicalGoogleDocReference(input.document_id, input.document_url);
    documentId = reference.document_id;
    documentUrl = reference.document_url;
  } else {
    errorCode = input.error_code || "google_docs_unavailable";
    if (typeof errorCode !== "string" || !/^[a-z0-9._-]{1,80}$/.test(errorCode)) {
      throw new Error("error_code 只能是小写字母、数字、点、下划线或连字符，且不超过 80 字符");
    }
  }

  const now = new Date().toISOString();
  await run(
    db,
    `INSERT INTO coaching_plan_mirrors
      (plan_version, provider, status, document_id, document_url, error_code, created_at, updated_at)
      VALUES (?, 'google_docs', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(plan_version, provider) DO UPDATE SET
        status = excluded.status,
        document_id = excluded.document_id,
        document_url = excluded.document_url,
        error_code = excluded.error_code,
        updated_at = excluded.updated_at`,
    input.plan_version,
    input.status,
    documentId,
    documentUrl,
    errorCode,
    now,
    now,
  );
  return { mirror: await getPlanMirror(env, input.plan_version), replayed: false };
}

export async function validatePlanEvidence(env, plan) {
  const pack = await getActiveContentPack(env, "evidence");
  if (!pack) throw new Error("云端医学证据包尚未发布，不能保存训练总纲");
  if (plan.evidence_version !== pack.version) {
    throw new Error(`plan.evidence_version 必须使用当前云端版本 ${pack.version}`);
  }
  const known = new Map((pack.payload?.references || []).map((reference) => [reference.id, reference]));
  for (const reference of plan.evidence_refs) {
    const expected = known.get(reference.id);
    if (!expected) throw new Error(`未知证据引用: ${reference.id}`);
    if (reference.title !== expected.title || reference.url !== expected.url) {
      throw new Error(`证据引用 ${reference.id} 的标题或链接与云端版本不一致`);
    }
  }
  return pack;
}

export async function getWorkflowContext(env, workflow, historyLimit = 8) {
  const contentKey = WORKFLOW_CONTENT_KEYS[workflow];
  if (!contentKey) throw new Error("workflow 必须是 training_planner、weekly_adjustment 或 daily_adjustment");
  const [workflowPack, evidencePack, preferencesPack, currentPlan, history] = await Promise.all([
    getActiveContentPack(env, contentKey),
    getActiveContentPack(env, "evidence"),
    getActiveContentPack(env, "user_preferences"),
    getCurrentPlan(env),
    queryHistory(env, "all", historyLimit, false),
  ]);
  if (!workflowPack) throw new Error(`云端工作流内容尚未发布: ${contentKey}`);
  if (!evidencePack) throw new Error("云端医学证据包尚未发布");
  return {
    schema_version: "xunji_workflow_context_v1",
    workflow,
    workflow_version: workflowPack.version,
    evidence_version: evidencePack.version,
    workflow_content: workflowPack,
    evidence: evidencePack,
    user_preferences: preferencesPack,
    current_plan: currentPlan,
    recent_history: history,
    runtime_sources: ["cloudflare_d1", "cloudflare_r2_index", "xunji_api", "chatgpt_health"],
    local_files_used: false,
  };
}

function safeSegment(value) {
  return String(value).replaceAll(/[^A-Za-z0-9._-]/g, "-");
}

function markdownList(items) {
  return (items || []).map((item) => `- ${typeof item === "string" ? item : JSON.stringify(item)}`).join("\n") || "- 无";
}

function planMarkdown(plan) {
  return `# ${plan.title}\n\n`+
    `- 版本：${plan.version}\n- 周期：${plan.start_date} 至 ${plan.end_date}\n- 目标：${plan.goal}\n`+
    `- 证据版本：${plan.evidence_version}\n- 保存时间：${plan.updated_at}\n\n`+
    `## 成功指标\n\n${markdownList(plan.success_metrics)}\n\n`+
    `## 周结构\n\n${markdownList(plan.weekly_structure)}\n\n`+
    `## 渐进规则\n\n${markdownList(plan.progression_rules)}\n\n`+
    `## 恢复与漏训\n\n${markdownList([...(plan.recovery_rules || []), ...(plan.missed_session_rules || [])])}\n\n`+
    `## 安全边界\n\n${markdownList(plan.guardrails)}\n\n`+
    `## 个性化快照\n\n\`\`\`json\n${JSON.stringify(plan.profile_snapshot, null, 2)}\n\`\`\`\n\n`+
    `## 基线摘要\n\n\`\`\`json\n${JSON.stringify(plan.baseline_summary, null, 2)}\n\`\`\`\n\n`+
    `## 完整结构化计划\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n`;
}

async function putArchive(env, key, body, metadata) {
  if (!env.COACH_ARCHIVE?.put) return { key: null, status: "not_configured" };
  try {
    await env.COACH_ARCHIVE.put(key, body, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: metadata,
    });
    return { key, status: "stored" };
  } catch {
    return { key, status: "failed" };
  }
}

export async function saveConfirmedPlan(env, plan, confirmationToken) {
  const db = requireD1(env);
  const existing = await getPlanByConfirmationToken(env, confirmationToken);
  if (existing) {
    if (existing.archive.status !== "stored") {
      const archive = await putArchive(env, existing.archive.key, planMarkdown(existing), {
        kind: "coaching_plan",
        version: existing.version,
        evidence_version: existing.evidence_version,
      });
      await run(
        db,
        "UPDATE coaching_plans SET archive_key = ?, archive_status = ? WHERE version = ?",
        archive.key,
        archive.status,
        existing.version,
      );
      existing.archive = archive;
    }
    return { plan: existing, replayed: true };
  }

  const version = crypto.randomUUID();
  const profileSnapshotId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const saved = { ...plan, version, updated_at: createdAt };
  const datePrefix = createdAt.slice(0, 7).replace("-", "/");
  const archiveKey = `plans/${datePrefix}/${safeSegment(plan.start_date)}-${version}.md`;
  try {
    await db.batch([
      db.prepare("UPDATE coaching_plans SET is_active = 0 WHERE is_active = 1"),
      db.prepare("INSERT INTO profile_snapshots (id, created_at, snapshot_json) VALUES (?, ?, ?)")
        .bind(profileSnapshotId, createdAt, JSON.stringify(plan.profile_snapshot)),
      db.prepare(`INSERT INTO coaching_plans
        (version, confirmation_token, title, start_date, end_date, evidence_version,
         profile_snapshot_id, plan_json, is_active, archive_key, archive_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'pending', ?)`)
        .bind(
          version, confirmationToken, plan.title, plan.start_date, plan.end_date,
          plan.evidence_version, profileSnapshotId, JSON.stringify(plan), archiveKey, createdAt,
        ),
      db.prepare(`INSERT INTO coaching_plan_mirrors
        (plan_version, provider, status, document_id, document_url, error_code, created_at, updated_at)
        VALUES (?, 'google_docs', 'pending', NULL, NULL, NULL, ?, ?)`)
        .bind(version, createdAt, createdAt),
    ]);
  } catch (error) {
    const recovered = await getPlanByConfirmationToken(env, confirmationToken);
    if (recovered) return saveConfirmedPlan(env, plan, confirmationToken);
    throw error;
  }

  const archive = await putArchive(env, archiveKey, planMarkdown(saved), {
    kind: "coaching_plan",
    version,
    evidence_version: plan.evidence_version,
  });
  await run(
    db,
    "UPDATE coaching_plans SET archive_key = ?, archive_status = ? WHERE version = ?",
    archive.key,
    archive.status,
    version,
  );
  saved.archive = archive;
  saved.mirrors = { google_docs: await getPlanMirror(env, version) };
  return { plan: saved, replayed: false };
}

function trainingDecisionMarkdown(record) {
  return `# 训记训练调整记录\n\n`+
    `- 决策 ID：${record.id}\n- 类型：${record.workflow}\n- 训练日期：${record.training_date}\n`+
    `- 总纲版本：${record.plan_version || "未关联"}\n- 保存时间：${record.created_at}\n\n`+
    `## 调整依据\n\n${markdownList(record.decision_context?.rationale)}\n\n`+
    `## 数据窗口与质量\n\n\`\`\`json\n${JSON.stringify({
      data_window: record.decision_context?.data_window || null,
      data_quality: record.decision_context?.data_quality || [],
    }, null, 2)}\n\`\`\`\n\n`+
    `## 已确认的训记变更\n\n\`\`\`json\n${JSON.stringify(record.summary, null, 2)}\n\`\`\`\n`;
}

export async function saveTrainingDecision(env, confirmationToken, summary, decisionContext, result) {
  const db = requireD1(env);
  const existing = await first(
    db,
    `SELECT id, workflow, plan_version, training_date, summary_json, decision_context_json,
            result_refs_json, archive_key, archive_status, created_at
       FROM training_decisions WHERE confirmation_token = ? LIMIT 1`,
    confirmationToken,
  );
  if (existing) {
    const archive = { key: existing.archive_key, status: existing.archive_status };
    if (archive.status !== "stored") {
      const record = {
        id: existing.id,
        workflow: existing.workflow,
        plan_version: existing.plan_version,
        training_date: existing.training_date,
        summary: parseJson(existing.summary_json, []),
        decision_context: parseJson(existing.decision_context_json, {}),
        result_refs: parseJson(existing.result_refs_json, []),
        created_at: existing.created_at,
      };
      const retried = await putArchive(env, archive.key, trainingDecisionMarkdown(record), {
        kind: "training_decision",
        workflow: record.workflow,
        training_date: record.training_date,
      });
      await run(
        db,
        "UPDATE training_decisions SET archive_key = ?, archive_status = ? WHERE id = ?",
        retried.key,
        retried.status,
        existing.id,
      );
      return { id: existing.id, archive: retried, replayed: true };
    }
    return { id: existing.id, archive, replayed: true };
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const context = decisionContext || { workflow: "manual_update", rationale: [], data_quality: [] };
  const workflow = context.workflow || "manual_update";
  const trainingDate = summary?.[0]?.date || createdAt.slice(0, 10);
  const datePrefix = createdAt.slice(0, 7).replace("-", "/");
  const archiveKey = `training-decisions/${datePrefix}/${trainingDate}-${id}.md`;
  const resultRefs = (result?.res?.trains || []).map((train) => ({
    localid: train.localid ?? null,
    datestr: train.datestr ?? trainingDate,
    title: train.title ?? null,
  }));
  await run(
    db,
    `INSERT INTO training_decisions
      (id, confirmation_token, workflow, plan_version, training_date, summary_json,
       decision_context_json, result_refs_json, archive_key, archive_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    id,
    confirmationToken,
    workflow,
    context.plan_version || null,
    trainingDate,
    JSON.stringify(summary),
    JSON.stringify(context),
    JSON.stringify(resultRefs),
    archiveKey,
    createdAt,
  );
  const record = {
    id,
    workflow,
    plan_version: context.plan_version || null,
    training_date: trainingDate,
    summary,
    decision_context: context,
    result_refs: resultRefs,
    created_at: createdAt,
  };
  const archive = await putArchive(env, archiveKey, trainingDecisionMarkdown(record), {
    kind: "training_decision",
    workflow,
    training_date: trainingDate,
  });
  await run(
    db,
    "UPDATE training_decisions SET archive_key = ?, archive_status = ? WHERE id = ?",
    archive.key,
    archive.status,
    id,
  );
  return { id, archive, replayed: false };
}

export async function claimTrainingCommit(env, confirmationToken) {
  const db = requireD1(env);
  const now = new Date().toISOString();
  const retentionCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  await run(db, "DELETE FROM training_commit_claims WHERE updated_at < ?", retentionCutoff);
  try {
    await run(
      db,
      `INSERT INTO training_commit_claims
        (confirmation_token, status, created_at, updated_at)
        VALUES (?, 'committing', ?, ?)`,
      confirmationToken,
      now,
      now,
    );
    return { acquired: true, status: "committing" };
  } catch (error) {
    const existing = await first(
      db,
      "SELECT status, created_at, updated_at FROM training_commit_claims WHERE confirmation_token = ? LIMIT 1",
      confirmationToken,
    );
    if (!existing) throw error;
    return { acquired: false, ...existing };
  }
}

export async function finalizeTrainingCommit(env, confirmationToken, status) {
  if (!["committed", "ambiguous"].includes(status)) throw new Error("训练提交状态无效");
  await run(
    requireD1(env),
    "UPDATE training_commit_claims SET status = ?, updated_at = ? WHERE confirmation_token = ?",
    status,
    new Date().toISOString(),
    confirmationToken,
  );
}

export async function queryHistory(env, type = "all", limit = 20, includeDetail = false) {
  const db = requireD1(env);
  const boundedLimit = Math.max(1, Math.min(50, Number.isInteger(limit) ? limit : 20));
  const entries = [];
  if (type === "all" || type === "plans") {
    const result = await db.prepare(
      `SELECT version, title, start_date, end_date, evidence_version, is_active,
              plan_json, archive_key, archive_status, created_at
         FROM coaching_plans ORDER BY created_at DESC LIMIT ?`,
    ).bind(boundedLimit).all();
    for (const row of result.results || []) entries.push({
      kind: "plan",
      version: row.version,
      title: row.title,
      start_date: row.start_date,
      end_date: row.end_date,
      evidence_version: row.evidence_version,
      is_active: row.is_active === 1,
      ...(includeDetail ? { plan: parseJson(row.plan_json, {}) } : {}),
      archive_key: row.archive_key,
      archive_status: row.archive_status,
      mirrors: { google_docs: await getPlanMirror(env, row.version) },
      created_at: row.created_at,
    });
  }
  if (type === "all" || type === "training_decisions") {
    const result = await db.prepare(
      `SELECT id, workflow, plan_version, training_date, summary_json,
              decision_context_json, archive_key, archive_status, created_at
         FROM training_decisions ORDER BY created_at DESC LIMIT ?`,
    ).bind(boundedLimit).all();
    for (const row of result.results || []) {
      entries.push({
        kind: "training_decision",
        id: row.id,
        workflow: row.workflow,
        plan_version: row.plan_version,
        training_date: row.training_date,
        ...(includeDetail ? {
          summary: parseJson(row.summary_json, []),
          decision_context: parseJson(row.decision_context_json, {}),
        } : {}),
        archive_key: row.archive_key,
        archive_status: row.archive_status,
        created_at: row.created_at,
      });
    }
  }
  return entries
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
    .slice(0, boundedLimit);
}
