import type { Migration } from './schema';

/**
 * Forge SQL schema (MySQL/TiDB): one statement per migration, every statement IF NOT EXISTS, no foreign keys
 * (integrity is enforced in code). Append only: never edit or reorder a migration once it has been deployed.
 * Timestamps are UTC. Columns avoid reserved words (`cursor`, `rank`, `version`, `key`, `window`).
 */
export const MIGRATIONS: readonly Migration[] = [
  // App-wide key/value settings (JSON values), e.g. window_days, excluded_project_keys, excluded_space_keys.
  {
    name: 'v001_create_settings',
    statement: `CREATE TABLE IF NOT EXISTS settings (
      k VARCHAR(64) PRIMARY KEY,
      v JSON NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
  },
  // Named locks: 'job:<jobId>', 'analyze:<incidentKey>', 'demo'.
  {
    name: 'v002_create_app_locks',
    statement: `CREATE TABLE IF NOT EXISTS app_locks (
      name VARCHAR(128) PRIMARY KEY,
      until_at TIMESTAMP NULL
    )`,
  },
  // Teamwork Graph connector connections; the active one is status='active' ORDER BY updated_at DESC LIMIT 1.
  {
    name: 'v003_create_graph_connection',
    statement: `CREATE TABLE IF NOT EXISTS graph_connection (
      connection_id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NULL,
      connector_name VARCHAR(128) NULL,
      flow_name VARCHAR(255) NULL,
      last_action VARCHAR(16) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_graph_connection_status (status, updated_at)
    )`,
  },
  {
    name: 'v004_create_service_mappings',
    statement: `CREATE TABLE IF NOT EXISTS service_mappings (
      id VARCHAR(36) PRIMARY KEY,
      service_key VARCHAR(64) NOT NULL,
      display_name VARCHAR(255) NOT NULL,
      jira_project_keys JSON NOT NULL,
      jira_component_names JSON NOT NULL,
      confluence_space_keys JSON NOT NULL,
      aliases JSON NOT NULL,
      owner_team_id VARCHAR(255) NULL,
      owner_team_name VARCHAR(255) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_service_mappings_key (service_key)
    )`,
  },
  // started_at is the real Jira time; scenario_started_at is set by the demo seed only.
  {
    name: 'v005_create_incidents',
    statement: `CREATE TABLE IF NOT EXISTS incidents (
      issue_key VARCHAR(64) PRIMARY KEY,
      issue_id VARCHAR(32) NOT NULL,
      project_key VARCHAR(64) NOT NULL,
      summary VARCHAR(512) NOT NULL,
      severity VARCHAR(32) NULL,
      service_key VARCHAR(64) NULL,
      service_source VARCHAR(16) NULL,
      responder_team_id VARCHAR(255) NULL,
      responder_team_name VARCHAR(255) NULL,
      started_at TIMESTAMP NOT NULL,
      resolved_at TIMESTAMP NULL,
      scenario_started_at TIMESTAMP NULL,
      scenario_resolved_at TIMESTAMP NULL,
      keywords JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_incidents_service (service_key, started_at)
    )`,
  },
  // References and a hash only, never artifact text; comment_id='' for the parent artifact.
  {
    name: 'v006_create_events',
    statement: `CREATE TABLE IF NOT EXISTS events (
      id VARCHAR(36) PRIMARY KEY,
      source VARCHAR(16) NOT NULL,
      kind VARCHAR(32) NOT NULL,
      artifact_id VARCHAR(64) NOT NULL,
      comment_id VARCHAR(64) NOT NULL DEFAULT '',
      artifact_key VARCHAR(64) NULL,
      title VARCHAR(512) NOT NULL DEFAULT '',
      url VARCHAR(1024) NULL,
      project_key VARCHAR(64) NULL,
      space_key VARCHAR(255) NULL,
      component_names JSON NULL,
      labels JSON NULL,
      service_key VARCHAR(64) NULL,
      author_account_id VARCHAR(128) NULL,
      occurred_at TIMESTAMP NOT NULL,
      source_updated_at TIMESTAMP NULL,
      scenario_at TIMESTAMP NULL,
      text_hash CHAR(64) NULL,
      text_length INT NOT NULL DEFAULT 0,
      reply_count INT NULL,
      status_category VARCHAR(16) NULL,
      resolution_name VARCHAR(64) NULL,
      first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_events_ref (source, artifact_id, comment_id),
      KEY idx_events_service_time (service_key, occurred_at),
      KEY idx_events_time (occurred_at)
    )`,
  },
  // status: queued|collecting|filtering|scoring|reaching|proposing|done|failed
  {
    name: 'v007_create_analysis_jobs',
    statement: `CREATE TABLE IF NOT EXISTS analysis_jobs (
      id VARCHAR(36) PRIMARY KEY,
      incident_key VARCHAR(64) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'queued',
      window_days INT NOT NULL,
      window_from TIMESTAMP NOT NULL,
      window_to TIMESTAMP NOT NULL,
      scope_json JSON NOT NULL,
      cursor_json JSON NULL,
      progress_json JSON NOT NULL,
      scanned_count INT NOT NULL DEFAULT 0,
      stored_count INT NOT NULL DEFAULT 0,
      candidate_count INT NOT NULL DEFAULT 0,
      truncated_count INT NOT NULL DEFAULT 0,
      attempt INT NOT NULL DEFAULT 0,
      last_error VARCHAR(1024) NULL,
      requested_by VARCHAR(128) NULL,
      model_fast VARCHAR(64) NULL,
      model_strong VARCHAR(64) NULL,
      prompt_version VARCHAR(32) NULL,
      started_at TIMESTAMP NULL,
      finished_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_jobs_incident (incident_key, created_at),
      KEY idx_jobs_status (status)
    )`,
  },
  // status: kept|truncated|scored|score_failed
  {
    name: 'v008_create_signal_candidates',
    statement: `CREATE TABLE IF NOT EXISTS signal_candidates (
      id VARCHAR(36) PRIMARY KEY,
      job_id VARCHAR(36) NOT NULL,
      incident_key VARCHAR(64) NOT NULL,
      event_id VARCHAR(36) NOT NULL,
      filter_score INT NOT NULL,
      reasons JSON NOT NULL,
      matched_keywords JSON NOT NULL,
      hint_type VARCHAR(32) NULL,
      excerpt TEXT NULL,
      text_hash CHAR(64) NULL,
      days_before INT NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'kept',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_candidates_job_event (job_id, event_id),
      KEY idx_candidates_incident (incident_key, status),
      KEY idx_candidates_job_rank (job_id, filter_score, days_before)
    )`,
  },
];

/** Name of the newest migration. */
export const LATEST_MIGRATION = MIGRATIONS[MIGRATIONS.length - 1]?.name ?? '';
