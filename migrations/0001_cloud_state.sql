PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS content_packs (
  content_key TEXT NOT NULL,
  version TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (content_key, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS content_packs_one_active
  ON content_packs(content_key)
  WHERE is_active = 1;

CREATE TABLE IF NOT EXISTS profile_snapshots (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coaching_plans (
  version TEXT PRIMARY KEY,
  confirmation_token TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  evidence_version TEXT NOT NULL,
  profile_snapshot_id TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  archive_key TEXT,
  archive_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  FOREIGN KEY (profile_snapshot_id) REFERENCES profile_snapshots(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS coaching_plans_one_active
  ON coaching_plans(is_active)
  WHERE is_active = 1;

CREATE INDEX IF NOT EXISTS coaching_plans_created_at
  ON coaching_plans(created_at DESC);

CREATE TABLE IF NOT EXISTS training_decisions (
  id TEXT PRIMARY KEY,
  confirmation_token TEXT NOT NULL UNIQUE,
  workflow TEXT NOT NULL,
  plan_version TEXT,
  training_date TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  decision_context_json TEXT NOT NULL,
  result_refs_json TEXT NOT NULL,
  archive_key TEXT,
  archive_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS training_decisions_created_at
  ON training_decisions(created_at DESC);

CREATE TABLE IF NOT EXISTS training_commit_claims (
  confirmation_token TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('committing', 'committed', 'ambiguous')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
