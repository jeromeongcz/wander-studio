import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,
    settings_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE TABLE project_languages (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    lang_code TEXT NOT NULL,
    PRIMARY KEY (project_id, lang_code)
  );
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    lang_code TEXT,
    format TEXT,
    scene_id TEXT,
    label TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'not_started'
      CHECK (state IN ('not_started','in_progress','awaiting_review','approved','needs_revision','rejected','failed')),
    current_version_id TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_artifacts_project ON artifacts(project_id, kind);
  CREATE TABLE versions (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    content_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    approved_at TEXT,
    UNIQUE (artifact_id, seq)
  );
  CREATE TABLE artifact_deps (
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    depends_on_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    PRIMARY KEY (artifact_id, depends_on_id),
    CHECK (artifact_id <> depends_on_id)
  );
  CREATE INDEX idx_deps_upstream ON artifact_deps(depends_on_id);
  CREATE TABLE approval_events (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    version_id TEXT,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    actor TEXT NOT NULL,
    note TEXT,
    cause_artifact_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_events_artifact ON approval_events(artifact_id, created_at);
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued',
    progress REAL NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // v2: measured speech samples used to calibrate words-per-minute per language
  `
  CREATE TABLE speech_calibration (
    id TEXT PRIMARY KEY,
    lang_code TEXT NOT NULL,
    words INTEGER NOT NULL CHECK (words > 0),
    seconds REAL NOT NULL CHECK (seconds > 0),
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_calibration_lang ON speech_calibration(lang_code);
  `,
  // v3: extensible locale registry and per-project pronunciation lexicon (TTS-only, never shown in captions)
  `
  CREATE TABLE locales (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    bcp47 TEXT NOT NULL,
    default_wpm INTEGER NOT NULL CHECK (default_wpm BETWEEN 60 AND 300),
    builtin INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO locales (code, name, bcp47, default_wpm, builtin) VALUES
    ('en', 'English', 'en', 150, 1),
    ('tl', 'Tagalog', 'fil-PH', 135, 1),
    ('taglish', 'Taglish', 'fil-PH', 145, 1);
  CREATE TABLE pronunciation_entries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    lang_code TEXT NOT NULL,
    term TEXT NOT NULL COLLATE NOCASE,
    respelling TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (project_id, lang_code, term)
  );
  `,
];

export function openDb(path: string = ':memory:'): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}
