/**
 * Baseline schema SQL — extracted from src/db.ts so migrations/index.ts can
 * reference it without creating a circular import (db.ts imports the
 * migration runner, which imports the migration registry, which must
 * reference baseline SQL that lives in db.ts).
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    layer           TEXT NOT NULL DEFAULT 'episodic'
                    CHECK (layer IN ('working','episodic','procedural','semantic','partner')),
    title           TEXT NOT NULL,
    slug            TEXT NOT NULL,
    content         TEXT NOT NULL,
    project_id      TEXT NOT NULL DEFAULT '_global',
    category        TEXT,
    lifecycle       TEXT NOT NULL DEFAULT 'milestone'
                    CHECK (lifecycle IN ('permanent','milestone','ephemeral')),
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','superseded','archived','invalid')),
    confidence      REAL NOT NULL DEFAULT 1.0
                    CHECK (confidence >= 0 AND confidence <= 1),
    boost           REAL NOT NULL DEFAULT 0.0,
    summary         TEXT,
    session_id      TEXT,
    source          TEXT NOT NULL DEFAULT 'session'
                    CHECK (source IN ('session','import','manual','derived')),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    accessed_at     TEXT,
    access_count    INTEGER NOT NULL DEFAULT 0,
    importance_score REAL NOT NULL DEFAULT 1.0
                    CHECK (importance_score >= 0 AND importance_score <= 1),
    expires_at      TEXT,
    refresh_strategy TEXT
);

CREATE INDEX IF NOT EXISTS idx_mem_project      ON memories(project_id);
CREATE INDEX IF NOT EXISTS idx_mem_layer        ON memories(layer);
CREATE INDEX IF NOT EXISTS idx_mem_status       ON memories(status);
CREATE INDEX IF NOT EXISTS idx_mem_lifecycle    ON memories(lifecycle);
CREATE INDEX IF NOT EXISTS idx_mem_category     ON memories(category);
CREATE INDEX IF NOT EXISTS idx_mem_created      ON memories(created_at);
CREATE INDEX IF NOT EXISTS idx_mem_session      ON memories(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mem_project_title ON memories(project_id, title);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mem_project_slug  ON memories(project_id, slug);

CREATE TABLE IF NOT EXISTS synapses (
    source_id       INTEGER NOT NULL,
    target_id       INTEGER NOT NULL,
    connection_type TEXT NOT NULL
                    CHECK (connection_type IN ('wikilink','bm25_auto','parent_child')),
    weight          REAL NOT NULL DEFAULT 1.0
                    CHECK (weight >= 0.0 AND weight <= 5.0),
    access_count    INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (source_id, target_id, connection_type),
    FOREIGN KEY (source_id) REFERENCES memories(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_syn_source ON synapses(source_id);
CREATE INDEX IF NOT EXISTS idx_syn_target ON synapses(target_id);
CREATE INDEX IF NOT EXISTS idx_syn_weight ON synapses(weight);
CREATE INDEX IF NOT EXISTS idx_syn_type   ON synapses(connection_type);

CREATE TABLE IF NOT EXISTS memory_tag (
    memory_id INTEGER NOT NULL,
    tag       TEXT NOT NULL,
    PRIMARY KEY (memory_id, tag),
    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tag_tag ON memory_tag(tag);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    title, content, summary,
    content='memories', content_rowid='id',
    tokenize = "porter unicode61 remove_diacritics 1",
    prefix='2 3'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, title, content, summary)
    VALUES (new.id, new.title, new.content, COALESCE(new.summary, ''));
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, content, summary)
    VALUES('delete', old.id, old.title, old.content, COALESCE(old.summary, ''));
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, content, summary)
    VALUES('delete', old.id, old.title, old.content, COALESCE(old.summary, ''));
    INSERT INTO memories_fts(rowid, title, content, summary)
    VALUES (new.id, new.title, new.content, COALESCE(new.summary, ''));
END;

CREATE TABLE IF NOT EXISTS decay_matrix (
    source_layer    TEXT NOT NULL,
    target_layer    TEXT NOT NULL,
    connection_type TEXT NOT NULL,
    decay_rate      REAL NOT NULL,
    PRIMARY KEY (source_layer, target_layer, connection_type)
);
`;

export const DECAY_MATRIX_SEED = `
INSERT OR IGNORE INTO decay_matrix VALUES
    ('procedural', 'procedural', 'wikilink',  0.995),
    ('procedural', 'procedural', 'bm25_auto', 0.98),
    ('procedural', 'semantic',   'wikilink',  0.99),
    ('procedural', 'semantic',   'bm25_auto', 0.94),
    ('procedural', 'episodic',   'wikilink',  0.97),
    ('procedural', 'episodic',   'bm25_auto', 0.92),
    ('procedural', 'partner',    'wikilink',  0.99),
    ('procedural', 'partner',    'bm25_auto', 0.96),
    ('semantic',   'semantic',   'wikilink',  0.99),
    ('semantic',   'semantic',   'bm25_auto', 0.93),
    ('semantic',   '*',          'wikilink',  0.95),
    ('semantic',   '*',          'bm25_auto', 0.85),
    ('episodic',   'episodic',   'wikilink',  0.95),
    ('episodic',   'episodic',   'bm25_auto', 0.88),
    ('episodic',   'working',    'wikilink',  0.80),
    ('episodic',   'working',    'bm25_auto', 0.60),
    ('working',    'working',    'wikilink',  0.70),
    ('working',    'working',    'bm25_auto', 0.40),
    ('partner',    'partner',    'wikilink',  0.999),
    ('partner',    'partner',    'bm25_auto', 0.97);
`;
