#!/usr/bin/env node

import { readFile, unlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contentRoot = join(root, "content");

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function loadPacks() {
  const manifest = JSON.parse(await readFile(join(contentRoot, "manifest.json"), "utf8"));
  if (manifest.schema_version !== "xunji_content_manifest_v1" || !Array.isArray(manifest.packs)) {
    throw new Error("content/manifest.json 格式无效");
  }
  const seen = new Set();
  const packs = [];
  for (const item of manifest.packs) {
    if (!item.key || !item.version || !item.markdown || seen.has(item.key)) {
      throw new Error(`内容包定义无效或 key 重复: ${item.key || "<missing>"}`);
    }
    seen.add(item.key);
    const body = await readFile(join(contentRoot, item.markdown), "utf8");
    if (!body.trim()) throw new Error(`内容文件为空: ${item.markdown}`);
    const payload = item.json
      ? JSON.parse(await readFile(join(contentRoot, item.json), "utf8"))
      : { workflow: item.key, version: item.version };
    if (item.key === "evidence") {
      if (payload.version !== item.version) throw new Error("证据 JSON 版本与 manifest 不一致");
      if (!Array.isArray(payload.references) || !payload.references.length) throw new Error("证据 JSON 缺少 references");
      for (const reference of payload.references) {
        if (!reference.id || !reference.title || !reference.url) throw new Error("证据 reference 缺少 id/title/url");
      }
    }
    packs.push({ ...item, body, payload });
  }
  for (const required of ["training_planner", "weekly_adjustment", "daily_adjustment", "user_preferences", "evidence"]) {
    if (!seen.has(required)) throw new Error(`manifest 缺少内容包: ${required}`);
  }
  return packs;
}

function buildSql(packs) {
  const now = new Date().toISOString();
  const statements = [];
  for (const pack of packs) {
    statements.push(`UPDATE content_packs SET is_active = 0 WHERE content_key = ${sqlString(pack.key)};`);
    statements.push(
      `INSERT INTO content_packs (content_key, version, body_markdown, payload_json, is_active, created_at) VALUES (`+
      `${sqlString(pack.key)}, ${sqlString(pack.version)}, ${sqlString(pack.body)}, `+
      `${sqlString(JSON.stringify(pack.payload))}, 1, ${sqlString(now)}) `+
      `ON CONFLICT(content_key, version) DO UPDATE SET body_markdown = excluded.body_markdown, `+
      `payload_json = excluded.payload_json, is_active = 1, created_at = excluded.created_at;`,
    );
  }
  return `${statements.join("\n")}\n`;
}

async function main() {
  const mode = process.argv[2] || "--check";
  if (!["--check", "--local", "--remote"].includes(mode)) {
    throw new Error("用法: node scripts/publish-content.mjs [--check|--local|--remote]");
  }
  const packs = await loadPacks();
  if (mode === "--check") {
    console.log(`validated ${packs.length} cloud content packs`);
    return;
  }
  const tempFile = join(tmpdir(), `xunji-content-${crypto.randomUUID()}.sql`);
  try {
    await writeFile(tempFile, buildSql(packs), { encoding: "utf8", mode: 0o600 });
    const target = mode === "--remote" ? "--remote" : "--local";
    const result = spawnSync(
      "npx",
      ["wrangler@4", "d1", "execute", "COACH_DB", target, "--file", tempFile],
      { cwd: root, stdio: "inherit", shell: false },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Wrangler 退出码: ${result.status}`);
    console.log(`published ${packs.length} cloud content packs (${target})`);
  } finally {
    await unlink(tempFile).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
