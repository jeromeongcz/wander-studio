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
  // v4: measured narration length per scene and language. Kept outside the storyboard so that
  // audio changes never invalidate the storyboard itself (they feed composition instead).
  `
  CREATE TABLE scene_timing (
    scene_id TEXT NOT NULL,
    lang_code TEXT NOT NULL,
    audio_seconds REAL NOT NULL CHECK (audio_seconds > 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scene_id, lang_code)
  );
  `,
  // v5: asset library. project_id NULL means the shared cross-project library.
  `
  CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN ('project','shared')),
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    media_kind TEXT NOT NULL CHECK (media_kind IN ('image','video')),
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    duration_seconds REAL,
    aspect_ratio REAL NOT NULL,
    focal_x REAL NOT NULL DEFAULT 0.5 CHECK (focal_x BETWEEN 0 AND 1),
    focal_y REAL NOT NULL DEFAULT 0.5 CHECK (focal_y BETWEEN 0 AND 1),
    prompt TEXT,
    provider TEXT NOT NULL,
    params_json TEXT NOT NULL DEFAULT '{}',
    license_json TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending','approved','rejected')),
    approved_at TEXT,
    source_asset_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_assets_project ON assets(project_id, type);
  CREATE INDEX idx_assets_hash ON assets(sha256);
  `,
  // v6: audio clips (narration, music, sfx) and verified renders
  `
  CREATE TABLE audio_clips (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    lang_code TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('narration','music','sfx')),
    name TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    duration_seconds REAL NOT NULL CHECK (duration_seconds > 0),
    sample_rate INTEGER,
    channels INTEGER,
    provider TEXT NOT NULL,
    voice TEXT,
    params_json TEXT NOT NULL DEFAULT '{}',
    license_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_audio_project ON audio_clips(project_id, kind, lang_code);
  CREATE TABLE renders (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    lang_code TEXT NOT NULL,
    format TEXT NOT NULL,
    variant TEXT NOT NULL CHECK (variant IN ('captioned','clean')),
    rel_path TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    fps REAL NOT NULL,
    duration_seconds REAL NOT NULL,
    bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    has_audio INTEGER NOT NULL,
    timeline_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_renders_project ON renders(project_id, lang_code, format);
  `,
  // v7: publishing kits, thumbnails, reusable templates, and a real job queue
  `
  CREATE TABLE publishing_kits (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    lang_code TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, lang_code)
  );
  CREATE TABLE thumbnails (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    lang_code TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    text TEXT,
    source_asset_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE templates (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('caption_style','script_outline')),
    name TEXT NOT NULL,
    content_json TEXT NOT NULL,
    builtin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE (kind, name)
  );
  ALTER TABLE jobs ADD COLUMN params_json TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE jobs ADD COLUMN result_json TEXT;
  ALTER TABLE jobs ADD COLUMN log_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE jobs ADD COLUMN started_at TEXT;
  ALTER TABLE jobs ADD COLUMN finished_at TEXT;
  ALTER TABLE jobs ADD COLUMN retry_of TEXT;
  ALTER TABLE jobs ADD COLUMN message TEXT;
  `,
  // v8: AI topic research. Ideas are suggestions, not approved work, so they live outside the artifact graph.
  `
  CREATE TABLE topic_batches (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    category TEXT,
    focus TEXT,
    notes TEXT,
    requested_count INTEGER NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('claude-code','manual')),
    state TEXT NOT NULL CHECK (state IN ('queued','running','done','partial','failed','cancelled')),
    message TEXT,
    rejected_json TEXT NOT NULL DEFAULT '[]',
    job_id TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE TABLE topic_ideas (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    batch_id TEXT NOT NULL REFERENCES topic_batches(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    hook TEXT NOT NULL,
    confidence TEXT NOT NULL CHECK (confidence IN ('well-documented','disputed','legend')),
    note TEXT,
    facts_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','used','dismissed')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_topic_ideas_project ON topic_ideas(project_id, status);
  `,
  // v9: Research Studio. Topic research no longer needs a project, so project_id becomes optional; ideas can be approved before any project exists.
  `
  CREATE TABLE topic_batches_new (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    category TEXT,
    focus TEXT,
    notes TEXT,
    requested_count INTEGER NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('claude-code','manual')),
    state TEXT NOT NULL CHECK (state IN ('queued','running','done','partial','failed','cancelled')),
    message TEXT,
    rejected_json TEXT NOT NULL DEFAULT '[]',
    job_id TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  );
  INSERT INTO topic_batches_new SELECT id, project_id, category, focus, notes, requested_count, source, state, message, rejected_json, job_id, created_at, finished_at FROM topic_batches;
  CREATE TABLE topic_ideas_new (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    batch_id TEXT NOT NULL REFERENCES topic_batches_new(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    hook TEXT NOT NULL,
    confidence TEXT NOT NULL CHECK (confidence IN ('well-documented','disputed','legend')),
    note TEXT,
    facts_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','approved','used','dismissed')),
    approved_at TEXT,
    created_at TEXT NOT NULL
  );
  INSERT INTO topic_ideas_new SELECT id, project_id, batch_id, title, hook, confidence, note, facts_json, status, NULL, created_at FROM topic_ideas;
  DROP TABLE topic_ideas;
  DROP TABLE topic_batches;
  ALTER TABLE topic_batches_new RENAME TO topic_batches;
  ALTER TABLE topic_ideas_new RENAME TO topic_ideas;
  CREATE INDEX idx_topic_ideas_project ON topic_ideas(project_id, status);
  `,
  // v10: remember which video was started from a Research Studio topic, so the topic stays visible and links to it.
  `
  ALTER TABLE topic_ideas ADD COLUMN video_project_id TEXT;
  UPDATE topic_ideas SET video_project_id = (SELECT p.id FROM projects p WHERE p.name = substr(topic_ideas.title, 1, 120) ORDER BY p.id DESC LIMIT 1)
    WHERE status = 'used' AND project_id IS NULL;
  `,
  // v11: opt-in animated illustration packages and explicitly promoted immutable vector layers.
  `
  CREATE TABLE animated_svg_scenes (
    storyboard_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    scene_id TEXT NOT NULL,
    package_json TEXT NOT NULL,
    PRIMARY KEY(storyboard_id, scene_id)
  );
  CREATE TABLE animated_svg_library (
    id TEXT PRIMARY KEY,
    revision TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    groupId TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    svg TEXT NOT NULL,
    UNIQUE(revision,groupId)
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
