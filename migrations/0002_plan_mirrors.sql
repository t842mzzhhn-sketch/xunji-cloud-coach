PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS coaching_plan_mirrors (
  plan_version TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'stored', 'failed')),
  document_id TEXT,
  document_url TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plan_version, provider),
  FOREIGN KEY (plan_version) REFERENCES coaching_plans(version)
);

CREATE INDEX IF NOT EXISTS coaching_plan_mirrors_updated_at
  ON coaching_plan_mirrors(updated_at DESC);

INSERT OR IGNORE INTO coaching_plan_mirrors
  (plan_version, provider, status, document_id, document_url, error_code, created_at, updated_at)
SELECT version, 'google_docs', 'pending', NULL, NULL, NULL, created_at, created_at
  FROM coaching_plans;
