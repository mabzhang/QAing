import type BetterSqlite3 from 'better-sqlite3'

interface Migration {
  readonly version: number
  readonly sql: string
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL CHECK(length(title) > 0),
        kind TEXT NOT NULL CHECK(kind IN ('text', 'markdown', 'front_transcript')),
        source_uri TEXT,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE UNIQUE INDEX documents_source_uri_unique
        ON documents(source_uri) WHERE source_uri IS NOT NULL;

      CREATE TABLE chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        content TEXT NOT NULL CHECK(length(content) > 0),
        content_hash TEXT NOT NULL,
        token_count INTEGER NOT NULL CHECK(token_count > 0 AND token_count <= 512),
        embedding BLOB,
        embedding_model_id TEXT,
        embedding_model_revision TEXT,
        embedding_dimension INTEGER CHECK(embedding_dimension IS NULL OR embedding_dimension > 0),
        embedding_normalized INTEGER NOT NULL DEFAULT 0 CHECK(embedding_normalized IN (0, 1)),
        embedded_at INTEGER,
        UNIQUE(document_id, ordinal),
        UNIQUE(document_id, content_hash),
        CHECK(
          (embedding IS NULL AND embedding_model_id IS NULL AND embedding_model_revision IS NULL
            AND embedding_dimension IS NULL AND embedding_normalized = 0 AND embedded_at IS NULL)
          OR
          (embedding IS NOT NULL AND embedding_model_id IS NOT NULL AND embedding_model_revision IS NOT NULL
            AND embedding_dimension IS NOT NULL AND embedding_normalized = 1 AND embedded_at IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX chunks_document_id_idx ON chunks(document_id);

      CREATE TABLE preset_qa (
        id TEXT PRIMARY KEY,
        question TEXT NOT NULL CHECK(length(question) > 0),
        normalized_question TEXT NOT NULL UNIQUE CHECK(length(normalized_question) > 0),
        answer TEXT NOT NULL CHECK(length(answer) > 0),
        content_hash TEXT NOT NULL UNIQUE,
        embedding BLOB,
        embedding_model_id TEXT,
        embedding_model_revision TEXT,
        embedding_dimension INTEGER CHECK(embedding_dimension IS NULL OR embedding_dimension > 0),
        embedding_normalized INTEGER NOT NULL DEFAULT 0 CHECK(embedding_normalized IN (0, 1)),
        embedded_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK(
          (embedding IS NULL AND embedding_model_id IS NULL AND embedding_model_revision IS NULL
            AND embedding_dimension IS NULL AND embedding_normalized = 0 AND embedded_at IS NULL)
          OR
          (embedding IS NOT NULL AND embedding_model_id IS NOT NULL AND embedding_model_revision IS NOT NULL
            AND embedding_dimension IS NOT NULL AND embedding_normalized = 1 AND embedded_at IS NOT NULL)
        )
      ) STRICT;

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK(mode IN ('front', 'qa')),
        audio_source TEXT NOT NULL CHECK(audio_source IN ('microphone', 'system')),
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      ) STRICT;

      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        question TEXT NOT NULL CHECK(length(question) > 0),
        answer TEXT NOT NULL CHECK(length(answer) > 0),
        source_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_ids_json)),
        created_at INTEGER NOT NULL,
        UNIQUE(session_id, ordinal)
      ) STRICT;

      CREATE INDEX turns_session_id_idx ON turns(session_id, ordinal DESC);

      CREATE TABLE index_jobs (
        id TEXT PRIMARY KEY,
        owner_type TEXT NOT NULL CHECK(owner_type IN ('chunk', 'preset_qa')),
        owner_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('upsert', 'delete')),
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'ready', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
        last_error_code TEXT,
        available_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(owner_type, owner_id, operation, content_hash)
      ) STRICT;

      CREATE INDEX index_jobs_runnable_idx ON index_jobs(status, available_at, created_at);

      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        content,
        content='chunks',
        content_rowid='rowid',
        tokenize='trigram'
      );

      CREATE TRIGGER chunks_fts_insert AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER chunks_fts_delete AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER chunks_fts_update AFTER UPDATE OF content ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE VIRTUAL TABLE preset_qa_fts USING fts5(
        question,
        answer,
        content='preset_qa',
        content_rowid='rowid',
        tokenize='trigram'
      );

      CREATE TRIGGER preset_qa_fts_insert AFTER INSERT ON preset_qa BEGIN
        INSERT INTO preset_qa_fts(rowid, question, answer) VALUES (new.rowid, new.question, new.answer);
      END;
      CREATE TRIGGER preset_qa_fts_delete AFTER DELETE ON preset_qa BEGIN
        INSERT INTO preset_qa_fts(preset_qa_fts, rowid, question, answer)
          VALUES ('delete', old.rowid, old.question, old.answer);
      END;
      CREATE TRIGGER preset_qa_fts_update AFTER UPDATE OF question, answer ON preset_qa BEGIN
        INSERT INTO preset_qa_fts(preset_qa_fts, rowid, question, answer)
          VALUES ('delete', old.rowid, old.question, old.answer);
        INSERT INTO preset_qa_fts(rowid, question, answer) VALUES (new.rowid, new.question, new.answer);
      END;

      CREATE TRIGGER chunks_delete_index_jobs AFTER DELETE ON chunks BEGIN
        DELETE FROM index_jobs WHERE owner_type = 'chunk' AND owner_id = old.id;
      END;
      CREATE TRIGGER preset_qa_delete_index_jobs AFTER DELETE ON preset_qa BEGIN
        DELETE FROM index_jobs WHERE owner_type = 'preset_qa' AND owner_id = old.id;
      END;
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE front_drafts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
        transcript TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        structured_markdown TEXT,
        status TEXT NOT NULL CHECK(status IN (
          'capturing', 'raw_ready', 'structuring', 'structured', 'complete', 'failed'
        )),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK(status NOT IN ('structured', 'complete') OR structured_markdown IS NOT NULL)
      ) STRICT;

      CREATE INDEX front_drafts_recovery_idx ON front_drafts(status, updated_at, id);
    `,
  },
  {
    version: 3,
    sql: `
      DROP TRIGGER chunks_fts_insert;
      DROP TRIGGER chunks_fts_delete;
      DROP TRIGGER chunks_fts_update;
      DROP TRIGGER chunks_delete_index_jobs;
      DROP TABLE chunks_fts;

      ALTER TABLE chunks RENAME TO chunks_before_v3;
      CREATE TABLE chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        content TEXT NOT NULL CHECK(length(content) > 0),
        content_hash TEXT NOT NULL,
        token_count INTEGER NOT NULL CHECK(token_count > 0 AND token_count <= 512),
        embedding BLOB,
        embedding_model_id TEXT,
        embedding_model_revision TEXT,
        embedding_dimension INTEGER CHECK(embedding_dimension IS NULL OR embedding_dimension > 0),
        embedding_normalized INTEGER NOT NULL DEFAULT 0 CHECK(embedding_normalized IN (0, 1)),
        embedded_at INTEGER,
        UNIQUE(document_id, ordinal),
        CHECK(
          (embedding IS NULL AND embedding_model_id IS NULL AND embedding_model_revision IS NULL
            AND embedding_dimension IS NULL AND embedding_normalized = 0 AND embedded_at IS NULL)
          OR
          (embedding IS NOT NULL AND embedding_model_id IS NOT NULL AND embedding_model_revision IS NOT NULL
            AND embedding_dimension IS NOT NULL AND embedding_normalized = 1 AND embedded_at IS NOT NULL)
        )
      ) STRICT;

      INSERT INTO chunks(
        id, document_id, ordinal, content, content_hash, token_count, embedding,
        embedding_model_id, embedding_model_revision, embedding_dimension,
        embedding_normalized, embedded_at
      )
      SELECT
        id, document_id, ordinal, content, content_hash, token_count, embedding,
        embedding_model_id, embedding_model_revision, embedding_dimension,
        embedding_normalized, embedded_at
      FROM chunks_before_v3;

      DROP TABLE chunks_before_v3;
      CREATE INDEX chunks_document_id_idx ON chunks(document_id);

      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        content,
        content='chunks',
        content_rowid='rowid',
        tokenize='trigram'
      );
      INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild');

      CREATE TRIGGER chunks_fts_insert AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER chunks_fts_delete AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER chunks_fts_update AFTER UPDATE OF content ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER chunks_delete_index_jobs AFTER DELETE ON chunks BEGIN
        DELETE FROM index_jobs WHERE owner_type = 'chunk' AND owner_id = old.id;
      END;
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE index_jobs ADD COLUMN last_model_id TEXT;
      ALTER TABLE index_jobs ADD COLUMN last_model_revision TEXT;
      ALTER TABLE index_jobs ADD COLUMN last_embedding_dimension INTEGER;
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE qa_workspace_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        data_revision INTEGER NOT NULL CHECK(data_revision >= 0)
      ) STRICT;
      INSERT INTO qa_workspace_state(singleton, data_revision) VALUES (1, 0);

      CREATE TABLE qa_rounds (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        status TEXT NOT NULL CHECK(status IN (
          'active', 'answer_locked', 'completed', 'skipped', 'cancelled', 'interrupted', 'failed'
        )),
        question_preview TEXT NOT NULL CHECK(length(question_preview) > 0),
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        selected_answer_version_id TEXT REFERENCES qa_answer_versions(id) DEFERRABLE INITIALLY DEFERRED,
        UNIQUE(session_id, ordinal),
        CHECK(
          (status IN ('active', 'answer_locked') AND completed_at IS NULL)
          OR (status NOT IN ('active', 'answer_locked') AND completed_at IS NOT NULL)
        ),
        CHECK(status != 'completed' OR selected_answer_version_id IS NOT NULL)
      ) STRICT;

      CREATE TABLE qa_answer_versions (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE CHECK(length(operation_id) > 0),
        round_id TEXT NOT NULL REFERENCES qa_rounds(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal < 9),
        stage TEXT NOT NULL CHECK(stage IN ('candidate', 'final', 'candidate_fallback', 'legacy_committed')),
        question_revision INTEGER NOT NULL CHECK(question_revision >= 0),
        question_snapshot TEXT NOT NULL CHECK(length(question_snapshot) > 0),
        question_identity TEXT NOT NULL CHECK(length(question_identity) > 0),
        answer TEXT NOT NULL CHECK(length(answer) > 0),
        retrieval_route TEXT NOT NULL CHECK(retrieval_route IN (
          'preset_qa_exact', 'preset_qa_semantic', 'source_document', 'legacy_unknown'
        )),
        sources_json TEXT NOT NULL CHECK(json_valid(sources_json)),
        elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms >= 0),
        created_at INTEGER NOT NULL,
        is_selected INTEGER NOT NULL DEFAULT 0 CHECK(is_selected IN (0, 1)),
        is_superseded INTEGER NOT NULL DEFAULT 0 CHECK(is_superseded IN (0, 1)),
        answer_unchanged INTEGER NOT NULL DEFAULT 0 CHECK(answer_unchanged IN (0, 1)),
        content_fingerprint TEXT NOT NULL,
        UNIQUE(round_id, ordinal),
        UNIQUE(round_id, content_fingerprint)
      ) STRICT;

      CREATE INDEX qa_rounds_workspace_idx ON qa_rounds(started_at DESC, id DESC);
      CREATE INDEX qa_rounds_session_idx ON qa_rounds(session_id, ordinal DESC);
      CREATE INDEX qa_answer_versions_round_idx ON qa_answer_versions(round_id, ordinal);
      CREATE INDEX preset_qa_exact_canonical_idx
        ON preset_qa(rtrim(normalized_question, ' ?？。.'));

      ALTER TABLE turns ADD COLUMN round_id TEXT REFERENCES qa_rounds(id);
      ALTER TABLE turns ADD COLUMN answer_origin TEXT
        CHECK(answer_origin IS NULL OR answer_origin IN ('final', 'candidate_fallback', 'legacy_committed'));
      ALTER TABLE turns ADD COLUMN selected_answer_version_id TEXT REFERENCES qa_answer_versions(id);

      INSERT INTO qa_rounds(
        id, session_id, ordinal, status, question_preview, started_at, completed_at,
        selected_answer_version_id
      )
      SELECT
        'legacy_round_' || id, session_id, ordinal, 'active', question, created_at, NULL, NULL
      FROM turns;

      INSERT INTO qa_answer_versions(
        id, operation_id, round_id, ordinal, stage, question_revision, question_snapshot,
        question_identity, answer, retrieval_route, sources_json, elapsed_ms, created_at,
        is_selected, is_superseded, answer_unchanged, content_fingerprint
      )
      SELECT
        'legacy_version_' || id, 'legacy_operation_' || id, 'legacy_round_' || id, 0, 'legacy_committed',
        0, question, question, answer, 'legacy_unknown', '[]', 0, created_at,
        1, 0, 0, 'legacy_fingerprint_' || id
      FROM turns;

      UPDATE qa_rounds
      SET selected_answer_version_id = 'legacy_version_' || substr(id, length('legacy_round_') + 1),
          status = 'completed',
          completed_at = started_at
      WHERE id LIKE 'legacy_round_%';

      UPDATE turns
      SET round_id = 'legacy_round_' || id,
          answer_origin = 'legacy_committed',
          selected_answer_version_id = 'legacy_version_' || id;

      UPDATE qa_workspace_state
      SET data_revision = (SELECT COUNT(*) FROM qa_rounds)
      WHERE singleton = 1;
    `,
  },
  {
    version: 6,
    sql: `
      DROP TRIGGER preset_qa_fts_insert;
      DROP TRIGGER preset_qa_fts_delete;
      DROP TRIGGER preset_qa_fts_update;
      DROP TRIGGER preset_qa_delete_index_jobs;
      DROP TABLE preset_qa_fts;
      DROP INDEX preset_qa_exact_canonical_idx;

      ALTER TABLE preset_qa RENAME TO preset_qa_before_v6;
      CREATE TABLE preset_qa (
        id TEXT PRIMARY KEY,
        question TEXT NOT NULL CHECK(length(question) > 0),
        normalized_question TEXT NOT NULL CHECK(length(normalized_question) > 0),
        answer TEXT NOT NULL CHECK(length(answer) > 0),
        content_hash TEXT NOT NULL,
        embedding BLOB,
        embedding_model_id TEXT,
        embedding_model_revision TEXT,
        embedding_dimension INTEGER CHECK(embedding_dimension IS NULL OR embedding_dimension > 0),
        embedding_normalized INTEGER NOT NULL DEFAULT 0 CHECK(embedding_normalized IN (0, 1)),
        embedded_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK(
          (embedding IS NULL AND embedding_model_id IS NULL AND embedding_model_revision IS NULL
            AND embedding_dimension IS NULL AND embedding_normalized = 0 AND embedded_at IS NULL)
          OR
          (embedding IS NOT NULL AND embedding_model_id IS NOT NULL AND embedding_model_revision IS NOT NULL
            AND embedding_dimension IS NOT NULL AND embedding_normalized = 1 AND embedded_at IS NOT NULL)
        )
      ) STRICT;

      INSERT INTO preset_qa(
        id, question, normalized_question, answer, content_hash, embedding,
        embedding_model_id, embedding_model_revision, embedding_dimension,
        embedding_normalized, embedded_at, created_at, updated_at
      )
      SELECT
        id, question, normalized_question, answer, content_hash, embedding,
        embedding_model_id, embedding_model_revision, embedding_dimension,
        embedding_normalized, embedded_at, created_at, updated_at
      FROM preset_qa_before_v6;
      DROP TABLE preset_qa_before_v6;

      CREATE INDEX preset_qa_normalized_idx ON preset_qa(normalized_question, updated_at DESC, id);
      CREATE INDEX preset_qa_content_hash_idx ON preset_qa(content_hash, id);
      CREATE INDEX preset_qa_exact_canonical_idx
        ON preset_qa(rtrim(normalized_question, ' ?？。.'));

      CREATE VIRTUAL TABLE preset_qa_fts USING fts5(
        question,
        answer,
        content='preset_qa',
        content_rowid='rowid',
        tokenize='trigram'
      );
      INSERT INTO preset_qa_fts(preset_qa_fts) VALUES ('rebuild');
      CREATE TRIGGER preset_qa_fts_insert AFTER INSERT ON preset_qa BEGIN
        INSERT INTO preset_qa_fts(rowid, question, answer) VALUES (new.rowid, new.question, new.answer);
      END;
      CREATE TRIGGER preset_qa_fts_delete AFTER DELETE ON preset_qa BEGIN
        INSERT INTO preset_qa_fts(preset_qa_fts, rowid, question, answer)
          VALUES ('delete', old.rowid, old.question, old.answer);
      END;
      CREATE TRIGGER preset_qa_fts_update AFTER UPDATE OF question, answer ON preset_qa BEGIN
        INSERT INTO preset_qa_fts(preset_qa_fts, rowid, question, answer)
          VALUES ('delete', old.rowid, old.question, old.answer);
        INSERT INTO preset_qa_fts(rowid, question, answer) VALUES (new.rowid, new.question, new.answer);
      END;
      CREATE TRIGGER preset_qa_delete_index_jobs AFTER DELETE ON preset_qa BEGIN
        DELETE FROM index_jobs WHERE owner_type = 'preset_qa' AND owner_id = old.id;
      END;

      CREATE TABLE legacy_document_entries (
        document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE
      ) STRICT;
      INSERT INTO legacy_document_entries(document_id) SELECT id FROM documents;

      CREATE TABLE legacy_qa_entries (
        preset_qa_id TEXT PRIMARY KEY REFERENCES preset_qa(id) ON DELETE CASCADE
      ) STRICT;
      INSERT INTO legacy_qa_entries(preset_qa_id) SELECT id FROM preset_qa;

      CREATE TABLE projects (
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
        display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),
        root_path TEXT NOT NULL UNIQUE CHECK(length(root_path) BETWEEN 1 AND 4096),
        root_identity TEXT NOT NULL UNIQUE CHECK(length(root_identity) BETWEEN 1 AND 512),
        schema_version INTEGER NOT NULL CHECK(schema_version > 0),
        sync_policy TEXT NOT NULL CHECK(sync_policy IN (
          'manual', 'auto_check_confirm', 'auto_check_apply'
        )),
        scan_generation INTEGER NOT NULL DEFAULT 0 CHECK(scan_generation >= 0),
        knowledge_version INTEGER NOT NULL DEFAULT 0 CHECK(knowledge_version >= 0),
        availability TEXT NOT NULL CHECK(availability IN (
          'available', 'unavailable', 'identity_changed'
        )),
        last_error_code TEXT,
        last_scan_at INTEGER,
        data_revision INTEGER NOT NULL DEFAULT 0 CHECK(data_revision >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE project_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        active_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        data_revision INTEGER NOT NULL DEFAULT 0 CHECK(data_revision >= 0)
      ) STRICT;
      INSERT INTO project_state(singleton, active_project_id, data_revision) VALUES (1, NULL, 0);

      CREATE TABLE source_files (
        source_id TEXT PRIMARY KEY CHECK(length(source_id) BETWEEN 1 AND 128),
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        trust_kind TEXT NOT NULL CHECK(trust_kind IN ('document', 'preset_qa')),
        display_relative_path TEXT NOT NULL CHECK(length(display_relative_path) BETWEEN 1 AND 4096),
        path_key TEXT NOT NULL CHECK(length(path_key) BETWEEN 1 AND 4096),
        category_hint TEXT CHECK(category_hint IS NULL OR category_hint IN ('brand', 'product', 'general')),
        size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
        mtime_ns TEXT NOT NULL CHECK(length(mtime_ns) BETWEEN 1 AND 32),
        device_id TEXT,
        inode TEXT,
        observed_raw_sha256 TEXT CHECK(observed_raw_sha256 IS NULL OR length(observed_raw_sha256) = 64),
        detected_type TEXT NOT NULL CHECK(length(detected_type) BETWEEN 1 AND 128),
        conversion_disposition TEXT NOT NULL DEFAULT 'local' CHECK(conversion_disposition IN (
          'local', 'external', 'unsupported', 'blocked'
        )),
        active_revision_id TEXT REFERENCES source_revisions(revision_id) DEFERRABLE INITIALLY DEFERRED,
        last_good_revision_id TEXT REFERENCES source_revisions(revision_id) DEFERRABLE INITIALLY DEFERRED,
        last_seen_generation INTEGER NOT NULL CHECK(last_seen_generation >= 0),
        state TEXT NOT NULL CHECK(state IN (
          'needs_conversion', 'converting', 'validating', 'artifact_staged', 'published_fs',
          'embedding_pending', 'ready', 'missing_grace', 'tombstoned', 'blocked',
          'conversion_failed', 'commit_failed', 'index_failed'
        )),
        error_code TEXT,
        missing_since_generation INTEGER CHECK(missing_since_generation IS NULL OR missing_since_generation >= 0),
        tombstoned_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_id, trust_kind, path_key)
      ) STRICT;

      CREATE INDEX source_files_project_state_idx
        ON source_files(project_id, state, updated_at DESC, source_id);
      CREATE INDEX source_files_rename_idx
        ON source_files(project_id, trust_kind, observed_raw_sha256, detected_type, last_seen_generation);

      CREATE TABLE source_revisions (
        revision_id TEXT PRIMARY KEY CHECK(length(revision_id) BETWEEN 1 AND 128),
        source_id TEXT NOT NULL REFERENCES source_files(source_id) ON DELETE CASCADE,
        raw_sha256 TEXT NOT NULL CHECK(length(raw_sha256) = 64),
        size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
        detected_type TEXT NOT NULL CHECK(length(detected_type) BETWEEN 1 AND 128),
        generation INTEGER NOT NULL CHECK(generation >= 0),
        state TEXT NOT NULL CHECK(state IN (
          'observed', 'prepared', 'staged', 'published_fs', 'committed', 'failed', 'superseded'
        )),
        conversion_mode TEXT CHECK(conversion_mode IS NULL OR conversion_mode IN (
          'local', 'llm', 'external', 'manual'
        )),
        converter_id TEXT,
        converter_version TEXT,
        artifact_schema_version INTEGER CHECK(artifact_schema_version IS NULL OR artifact_schema_version > 0),
        model_id TEXT,
        model_revision TEXT,
        prompt_config_hash TEXT,
        cache_key TEXT,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        activated_at INTEGER
      ) STRICT;

      CREATE INDEX source_revisions_source_idx
        ON source_revisions(source_id, created_at DESC, revision_id);

      CREATE TABLE conversion_artifacts (
        artifact_id TEXT PRIMARY KEY CHECK(length(artifact_id) BETWEEN 1 AND 128),
        revision_id TEXT NOT NULL REFERENCES source_revisions(revision_id) ON DELETE CASCADE,
        relative_output_path TEXT NOT NULL CHECK(length(relative_output_path) BETWEEN 1 AND 4096),
        output_sha256 TEXT NOT NULL CHECK(length(output_sha256) = 64),
        canonical_body_sha256 TEXT CHECK(canonical_body_sha256 IS NULL OR length(canonical_body_sha256) = 64),
        output_size_bytes INTEGER CHECK(output_size_bytes IS NULL OR output_size_bytes >= 0),
        output_mtime_ns TEXT,
        output_device_id TEXT,
        output_inode TEXT,
        content_kind TEXT NOT NULL CHECK(content_kind IN ('document', 'preset_qa')),
        warnings_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(warnings_json)),
        validation_state TEXT NOT NULL CHECK(validation_state IN (
          'staged', 'published_fs', 'committed', 'superseded', 'failed', 'modified'
        )),
        published_at INTEGER,
        committed_at INTEGER,
        manual_modified_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(revision_id, relative_output_path, output_sha256)
      ) STRICT;

      CREATE INDEX conversion_artifacts_revision_idx
        ON conversion_artifacts(revision_id, created_at DESC, artifact_id);

      CREATE TABLE conversion_jobs (
        operation_id TEXT PRIMARY KEY CHECK(length(operation_id) BETWEEN 1 AND 128),
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES source_files(source_id) ON DELETE CASCADE,
        revision_id TEXT NOT NULL REFERENCES source_revisions(revision_id) ON DELETE CASCADE,
        artifact_id TEXT REFERENCES conversion_artifacts(artifact_id),
        generation INTEGER NOT NULL CHECK(generation >= 0),
        state TEXT NOT NULL CHECK(state IN (
          'prepared', 'staged', 'published_fs', 'committed', 'failed', 'cancelled'
        )),
        input_sha256 TEXT NOT NULL CHECK(length(input_sha256) = 64),
        temp_relative_path TEXT NOT NULL CHECK(length(temp_relative_path) BETWEEN 1 AND 4096),
        final_relative_path TEXT NOT NULL CHECK(length(final_relative_path) BETWEEN 1 AND 4096),
        output_sha256 TEXT CHECK(output_sha256 IS NULL OR length(output_sha256) = 64),
        conversion_mode TEXT NOT NULL CHECK(conversion_mode IN ('local', 'llm', 'external', 'manual')),
        converter_id TEXT NOT NULL CHECK(length(converter_id) BETWEEN 1 AND 128),
        converter_version TEXT NOT NULL CHECK(length(converter_version) BETWEEN 1 AND 128),
        artifact_schema_version INTEGER NOT NULL CHECK(artifact_schema_version > 0),
        model_id TEXT,
        model_revision TEXT,
        prompt_config_hash TEXT,
        cache_key TEXT NOT NULL CHECK(length(cache_key) BETWEEN 1 AND 512),
        attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX conversion_jobs_recovery_idx
        ON conversion_jobs(state, updated_at, operation_id);
      CREATE INDEX conversion_jobs_project_idx
        ON conversion_jobs(project_id, generation, state, operation_id);

      CREATE TABLE sync_runs (
        run_id TEXT PRIMARY KEY CHECK(length(run_id) BETWEEN 1 AND 128),
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL CHECK(generation > 0),
        trigger TEXT NOT NULL CHECK(trigger IN ('manual', 'watch', 'startup')),
        state TEXT NOT NULL CHECK(state IN (
          'scanning', 'processing', 'completed', 'completed_with_errors', 'failed', 'cancelled'
        )),
        root_identity TEXT NOT NULL CHECK(length(root_identity) BETWEEN 1 AND 512),
        counts_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(counts_json)),
        error_code TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_id, generation),
        CHECK(
          (state IN ('scanning', 'processing') AND completed_at IS NULL)
          OR (state NOT IN ('scanning', 'processing') AND completed_at IS NOT NULL)
        )
      ) STRICT;

      CREATE UNIQUE INDEX sync_runs_one_active_project
        ON sync_runs(project_id) WHERE state IN ('scanning', 'processing');
      CREATE INDEX sync_runs_project_history_idx
        ON sync_runs(project_id, started_at DESC, run_id);

      CREATE TABLE project_document_links (
        source_id TEXT NOT NULL REFERENCES source_files(source_id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL REFERENCES conversion_artifacts(artifact_id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
        active INTEGER NOT NULL CHECK(active IN (0, 1)),
        linked_at INTEGER NOT NULL,
        PRIMARY KEY(source_id, artifact_id, document_id)
      ) STRICT;

      CREATE UNIQUE INDEX project_document_links_one_active_source
        ON project_document_links(source_id) WHERE active = 1;
      CREATE INDEX project_document_links_document_idx
        ON project_document_links(document_id, active, source_id);

      CREATE TABLE project_qa_links (
        source_id TEXT NOT NULL REFERENCES source_files(source_id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL REFERENCES conversion_artifacts(artifact_id) ON DELETE CASCADE,
        preset_qa_id TEXT NOT NULL REFERENCES preset_qa(id) ON DELETE RESTRICT,
        active INTEGER NOT NULL CHECK(active IN (0, 1)),
        linked_at INTEGER NOT NULL,
        PRIMARY KEY(source_id, artifact_id, preset_qa_id)
      ) STRICT;

      CREATE INDEX project_qa_links_source_active_idx
        ON project_qa_links(source_id, active, preset_qa_id);
      CREATE INDEX project_qa_links_qa_idx
        ON project_qa_links(preset_qa_id, active, source_id);
    `,
  },
  {
    version: 7,
    sql: `
      ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT;
      ALTER TABLE qa_rounds ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT;
      ALTER TABLE qa_answer_versions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT;
      ALTER TABLE turns ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT;

      CREATE TABLE qa_workspace_project_state (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
        data_revision INTEGER NOT NULL CHECK(data_revision >= 0)
      ) STRICT;
      INSERT INTO qa_workspace_project_state(project_id, data_revision)
      SELECT id, 0 FROM projects;

      CREATE TRIGGER projects_insert_workspace_state AFTER INSERT ON projects BEGIN
        INSERT INTO qa_workspace_project_state(project_id, data_revision) VALUES (new.id, 0);
      END;

      CREATE TRIGGER qa_rounds_project_guard BEFORE INSERT ON qa_rounds
      WHEN (SELECT project_id FROM sessions WHERE id = new.session_id) IS NOT new.project_id BEGIN
        SELECT RAISE(ABORT, 'QA_WORKSPACE_PROJECT_MISMATCH');
      END;
      CREATE TRIGGER qa_rounds_project_update_guard BEFORE UPDATE OF project_id, session_id ON qa_rounds
      WHEN (SELECT project_id FROM sessions WHERE id = new.session_id) IS NOT new.project_id BEGIN
        SELECT RAISE(ABORT, 'QA_WORKSPACE_PROJECT_MISMATCH');
      END;
      CREATE TRIGGER qa_answer_versions_project_guard BEFORE INSERT ON qa_answer_versions
      WHEN (SELECT project_id FROM qa_rounds WHERE id = new.round_id) IS NOT new.project_id BEGIN
        SELECT RAISE(ABORT, 'QA_WORKSPACE_PROJECT_MISMATCH');
      END;
      CREATE TRIGGER qa_answer_versions_project_update_guard
      BEFORE UPDATE OF project_id, round_id ON qa_answer_versions
      WHEN (SELECT project_id FROM qa_rounds WHERE id = new.round_id) IS NOT new.project_id BEGIN
        SELECT RAISE(ABORT, 'QA_WORKSPACE_PROJECT_MISMATCH');
      END;
      CREATE TRIGGER turns_project_guard BEFORE INSERT ON turns
      WHEN
        (SELECT project_id FROM sessions WHERE id = new.session_id) IS NOT new.project_id
        OR (new.round_id IS NOT NULL AND
          (SELECT project_id FROM qa_rounds WHERE id = new.round_id) IS NOT new.project_id)
      BEGIN
        SELECT RAISE(ABORT, 'QA_WORKSPACE_PROJECT_MISMATCH');
      END;
      CREATE TRIGGER turns_project_update_guard BEFORE UPDATE OF project_id, session_id, round_id ON turns
      WHEN
        (SELECT project_id FROM sessions WHERE id = new.session_id) IS NOT new.project_id
        OR (new.round_id IS NOT NULL AND
          (SELECT project_id FROM qa_rounds WHERE id = new.round_id) IS NOT new.project_id)
      BEGIN
        SELECT RAISE(ABORT, 'QA_WORKSPACE_PROJECT_MISMATCH');
      END;

      CREATE INDEX sessions_project_started_idx ON sessions(project_id, started_at DESC, id);
      CREATE INDEX qa_rounds_project_workspace_idx ON qa_rounds(project_id, started_at DESC, id DESC);
      CREATE INDEX turns_project_created_idx ON turns(project_id, created_at DESC, id);
      CREATE INDEX qa_answer_versions_project_created_idx
        ON qa_answer_versions(project_id, created_at DESC, id);
    `,
  },
  {
    version: 8,
    sql: `
      CREATE TABLE project_front_document_links (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        draft_id TEXT NOT NULL UNIQUE REFERENCES front_drafts(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
        document_content_hash TEXT NOT NULL,
        linked_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX project_front_document_links_project_idx
        ON project_front_document_links(project_id, linked_at DESC, session_id);
      CREATE INDEX project_front_document_links_document_idx
        ON project_front_document_links(document_id, project_id);

      CREATE TRIGGER project_front_document_links_guard
      BEFORE INSERT ON project_front_document_links
      WHEN
        (SELECT mode FROM sessions WHERE id = new.session_id) IS NOT 'front'
        OR (SELECT project_id FROM sessions WHERE id = new.session_id) IS NOT new.project_id
        OR (SELECT session_id FROM front_drafts WHERE id = new.draft_id) IS NOT new.session_id
        OR ((SELECT status FROM front_drafts WHERE id = new.draft_id) IS NOT 'structured'
          AND (SELECT status FROM front_drafts WHERE id = new.draft_id) IS NOT 'complete')
        OR (SELECT content_hash FROM documents WHERE id = new.document_id) IS NOT new.document_content_hash
      BEGIN
        SELECT RAISE(ABORT, 'PROJECT_FRONT_DOCUMENT_MISMATCH');
      END;

      CREATE TRIGGER project_front_document_links_update_guard
      BEFORE UPDATE OF session_id, project_id, draft_id, document_id, document_content_hash
      ON project_front_document_links
      WHEN
        old.session_id IS NOT new.session_id
        OR old.project_id IS NOT new.project_id
        OR old.draft_id IS NOT new.draft_id
        OR old.document_id IS NOT new.document_id
        OR old.document_content_hash IS NOT new.document_content_hash
      BEGIN
        SELECT RAISE(ABORT, 'PROJECT_FRONT_DOCUMENT_IMMUTABLE');
      END;
    `,
  },
  {
    version: 9,
    sql: `
      CREATE TABLE simulation_project_state (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        data_revision INTEGER NOT NULL DEFAULT 0 CHECK(data_revision >= 0)
      ) STRICT;
      INSERT INTO simulation_project_state(project_id, data_revision)
      SELECT id, 0 FROM projects;

      CREATE TRIGGER projects_insert_simulation_state AFTER INSERT ON projects BEGIN
        INSERT INTO simulation_project_state(project_id, data_revision) VALUES (new.id, 0);
      END;

      CREATE TABLE simulation_jobs (
        job_id TEXT PRIMARY KEY CHECK(length(job_id) BETWEEN 1 AND 128),
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        create_operation_id TEXT NOT NULL UNIQUE CHECK(length(create_operation_id) BETWEEN 1 AND 128),
        knowledge_version INTEGER NOT NULL CHECK(knowledge_version >= 0),
        project_data_revision INTEGER NOT NULL CHECK(project_data_revision >= 0),
        source_manifest_hash TEXT NOT NULL CHECK(length(source_manifest_hash) = 64),
        source_count INTEGER NOT NULL CHECK(source_count >= 0),
        target_count INTEGER NOT NULL CHECK(target_count BETWEEN 1 AND 10000),
        brief_json TEXT NOT NULL CHECK(json_valid(brief_json)),
        brief_fingerprint TEXT NOT NULL CHECK(length(brief_fingerprint) = 64),
        status TEXT NOT NULL CHECK(status IN (
          'draft', 'awaiting_large_run_confirmation', 'queued', 'running', 'paused',
          'completed', 'completed_with_gaps', 'failed', 'cancelled', 'stale'
        )),
        generation INTEGER NOT NULL DEFAULT 1 CHECK(generation >= 1),
        reliable_count INTEGER NOT NULL DEFAULT 0 CHECK(reliable_count >= 0),
        gap_count INTEGER NOT NULL DEFAULT 0 CHECK(gap_count >= 0),
        approved_count INTEGER NOT NULL DEFAULT 0 CHECK(approved_count >= 0),
        published_count INTEGER NOT NULL DEFAULT 0 CHECK(published_count >= 0),
        next_batch_ordinal INTEGER NOT NULL DEFAULT 0 CHECK(next_batch_ordinal >= 0),
        data_revision INTEGER NOT NULL DEFAULT 0 CHECK(data_revision >= 0),
        large_run_acknowledged_at INTEGER,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        CHECK(reliable_count + gap_count <= target_count),
        CHECK(approved_count <= reliable_count),
        CHECK(published_count <= approved_count),
        CHECK(
          (status IN ('completed', 'completed_with_gaps', 'failed', 'cancelled', 'stale') AND completed_at IS NOT NULL)
          OR (status NOT IN ('completed', 'completed_with_gaps', 'failed', 'cancelled', 'stale') AND completed_at IS NULL)
        )
      ) STRICT;

      CREATE INDEX simulation_jobs_project_page_idx
        ON simulation_jobs(project_id, created_at DESC, job_id DESC);
      CREATE INDEX simulation_jobs_recovery_idx
        ON simulation_jobs(status, updated_at, job_id);

      CREATE TABLE simulation_checkpoints (
        operation_id TEXT PRIMARY KEY CHECK(length(operation_id) BETWEEN 1 AND 128),
        job_id TEXT NOT NULL REFERENCES simulation_jobs(job_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN (
          'create', 'status', 'batch', 'item_update', 'review', 'publication_prepare',
          'publication_complete', 'publication_cancel', 'recovery'
        )),
        content_fingerprint TEXT NOT NULL CHECK(length(content_fingerprint) = 64),
        result_data_revision INTEGER NOT NULL CHECK(result_data_revision >= 0),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX simulation_checkpoints_job_idx
        ON simulation_checkpoints(job_id, created_at, operation_id);

      CREATE TABLE simulation_batches (
        batch_id TEXT PRIMARY KEY CHECK(length(batch_id) BETWEEN 1 AND 128),
        job_id TEXT NOT NULL REFERENCES simulation_jobs(job_id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL UNIQUE REFERENCES simulation_checkpoints(operation_id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        planned_count INTEGER NOT NULL CHECK(planned_count > 0),
        reliable_count INTEGER NOT NULL CHECK(reliable_count >= 0),
        gap_count INTEGER NOT NULL CHECK(gap_count >= 0),
        content_fingerprint TEXT NOT NULL CHECK(length(content_fingerprint) = 64),
        created_at INTEGER NOT NULL,
        UNIQUE(job_id, ordinal),
        CHECK(reliable_count + gap_count = planned_count)
      ) STRICT;

      CREATE TABLE simulation_items (
        item_id TEXT PRIMARY KEY CHECK(length(item_id) BETWEEN 1 AND 128),
        job_id TEXT NOT NULL REFERENCES simulation_jobs(job_id) ON DELETE CASCADE,
        batch_id TEXT NOT NULL REFERENCES simulation_batches(batch_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        question TEXT NOT NULL CHECK(length(question) BETWEEN 1 AND 4000),
        answer TEXT NOT NULL CHECK(length(answer) BETWEEN 1 AND 16000),
        category TEXT CHECK(category IS NULL OR length(category) BETWEEN 1 AND 200),
        review_state TEXT NOT NULL CHECK(review_state IN (
          'draft', 'approved', 'rejected', 'publishing', 'published', 'stale'
        )),
        content_fingerprint TEXT NOT NULL CHECK(length(content_fingerprint) = 64),
        edited_at INTEGER,
        reviewed_at INTEGER,
        published_at INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE(job_id, ordinal),
        UNIQUE(job_id, content_fingerprint)
      ) STRICT;
      CREATE INDEX simulation_items_job_review_idx
        ON simulation_items(job_id, review_state, ordinal, item_id);

      CREATE TRIGGER simulation_items_batch_guard BEFORE INSERT ON simulation_items
      WHEN (SELECT job_id FROM simulation_batches WHERE batch_id = new.batch_id) IS NOT new.job_id BEGIN
        SELECT RAISE(ABORT, 'SIMULATION_BATCH_JOB_MISMATCH');
      END;

      CREATE TABLE simulation_citations (
        citation_id TEXT PRIMARY KEY CHECK(length(citation_id) BETWEEN 1 AND 128),
        item_id TEXT NOT NULL REFERENCES simulation_items(item_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE RESTRICT,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 300),
        source_id TEXT REFERENCES source_files(source_id) ON DELETE RESTRICT,
        source_revision_id TEXT REFERENCES source_revisions(revision_id) ON DELETE RESTRICT,
        content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
        excerpt TEXT NOT NULL CHECK(length(excerpt) BETWEEN 1 AND 1600),
        UNIQUE(item_id, ordinal),
        UNIQUE(item_id, chunk_id, source_id)
      ) STRICT;
      CREATE INDEX simulation_citations_chunk_idx ON simulation_citations(chunk_id, item_id);

      CREATE TABLE simulation_gaps (
        gap_id TEXT PRIMARY KEY CHECK(length(gap_id) BETWEEN 1 AND 128),
        job_id TEXT NOT NULL REFERENCES simulation_jobs(job_id) ON DELETE CASCADE,
        batch_id TEXT NOT NULL REFERENCES simulation_batches(batch_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        topic TEXT NOT NULL CHECK(length(topic) BETWEEN 1 AND 1000),
        reason TEXT NOT NULL CHECK(reason IN (
          'NO_RELEVANT_EVIDENCE', 'INSUFFICIENT_DETAIL', 'CONFLICTING_SOURCES',
          'UNSUPPORTED_OR_UNCONVERTED_SOURCE', 'DUPLICATE_COVERAGE_ONLY', 'STALE_SOURCE'
        )),
        missing_count INTEGER NOT NULL CHECK(missing_count > 0),
        suggested_material TEXT NOT NULL CHECK(length(suggested_material) BETWEEN 1 AND 2000),
        checked_source_count INTEGER NOT NULL CHECK(checked_source_count >= 0),
        created_at INTEGER NOT NULL,
        UNIQUE(job_id, ordinal)
      ) STRICT;

      CREATE TRIGGER simulation_gaps_batch_guard BEFORE INSERT ON simulation_gaps
      WHEN (SELECT job_id FROM simulation_batches WHERE batch_id = new.batch_id) IS NOT new.job_id BEGIN
        SELECT RAISE(ABORT, 'SIMULATION_BATCH_JOB_MISMATCH');
      END;

      CREATE TABLE simulation_publications (
        publication_id TEXT PRIMARY KEY CHECK(length(publication_id) BETWEEN 1 AND 128),
        job_id TEXT NOT NULL REFERENCES simulation_jobs(job_id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL UNIQUE REFERENCES simulation_checkpoints(operation_id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK(status IN ('prepared', 'completed', 'cancelled')),
        content_fingerprint TEXT NOT NULL CHECK(length(content_fingerprint) = 64),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      ) STRICT;
      CREATE INDEX simulation_publications_job_idx
        ON simulation_publications(job_id, created_at, publication_id);

      CREATE TABLE simulation_publication_items (
        publication_id TEXT NOT NULL REFERENCES simulation_publications(publication_id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES simulation_items(item_id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        preset_qa_id TEXT REFERENCES preset_qa(id) ON DELETE RESTRICT,
        PRIMARY KEY(publication_id, item_id),
        UNIQUE(publication_id, ordinal)
      ) STRICT;

      CREATE TRIGGER simulation_publication_items_guard BEFORE INSERT ON simulation_publication_items
      WHEN
        (SELECT job_id FROM simulation_publications WHERE publication_id = new.publication_id)
          IS NOT (SELECT job_id FROM simulation_items WHERE item_id = new.item_id)
      BEGIN
        SELECT RAISE(ABORT, 'SIMULATION_PUBLICATION_JOB_MISMATCH');
      END;
    `,
  },
]

export function applyMigrations(
  database: BetterSqlite3.Database,
  now = Date.now(),
  maximumVersion = Number.POSITIVE_INFINITY,
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `)

  const applied = new Set(
    database
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => (row as { version: number }).version),
  )

  for (const migration of migrations) {
    if (migration.version > maximumVersion) continue
    if (applied.has(migration.version)) continue
    database.transaction(() => {
      database.exec(migration.sql)
      database
        .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(migration.version, now)
      database.pragma(`user_version = ${migration.version}`)
    })()
  }
}

export const latestSchemaVersion = migrations.at(-1)?.version ?? 0
