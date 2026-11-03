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
  // Demo seed bookkeeping: one row per artifact slot (idempotent Load, Remove only deletes created_by_app=1).
  // role: container|incident|signal|context|distractor; comment rows carry the parent id in artifact_id.
  {
    name: 'v009_create_demo_artifacts',
    statement: `CREATE TABLE IF NOT EXISTS demo_artifacts (
      slot VARCHAR(64) PRIMARY KEY,
      role VARCHAR(16) NOT NULL,
      source VARCHAR(16) NOT NULL,
      artifact_id VARCHAR(64) NOT NULL,
      comment_id VARCHAR(64) NOT NULL DEFAULT '',
      artifact_key VARCHAR(64) NULL,
      url VARCHAR(1024) NULL,
      scenario_at TIMESTAMP NULL,
      created_by_app TINYINT NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_demo_artifacts_ref (source, artifact_id)
    )`,
  },
  // One signal per (incident, event) across analyses; status: proposed|confirmed|rejected. A re-analysis only
  // refreshes proposed rows. signal_type: technical_warning|customer_complaint|external_change|unanswered_question.
  {
    name: 'v010_create_signals',
    statement: `CREATE TABLE IF NOT EXISTS signals (
      id VARCHAR(36) PRIMARY KEY,
      job_id VARCHAR(36) NOT NULL,
      incident_key VARCHAR(64) NOT NULL,
      event_id VARCHAR(36) NOT NULL,
      candidate_id VARCHAR(36) NOT NULL,
      signal_type VARCHAR(32) NOT NULL,
      quote TEXT NOT NULL,
      reason VARCHAR(255) NOT NULL,
      confidence DOUBLE NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'proposed',
      days_before INT NOT NULL,
      text_hash CHAR(64) NULL,
      model VARCHAR(64) NOT NULL,
      prompt_version VARCHAR(32) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_signals_incident_event (incident_key, event_id),
      KEY idx_signals_incident_status (incident_key, status),
      KEY idx_signals_job (job_id)
    )`,
  },
  // Audit trail of confirm/reject/undo; decided_by (accountId) is never sent to the UI or Rovo.
  {
    name: 'v011_create_signal_decisions',
    statement: `CREATE TABLE IF NOT EXISTS signal_decisions (
      id VARCHAR(36) PRIMARY KEY,
      signal_id VARCHAR(36) NOT NULL,
      incident_key VARCHAR(64) NOT NULL,
      decision VARCHAR(16) NOT NULL,
      decided_by VARCHAR(128) NOT NULL,
      reason VARCHAR(255) NULL,
      decided_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_signal_decisions_signal (signal_id, decided_at),
      KEY idx_signal_decisions_incident (incident_key)
    )`,
  },
  // Why scoring failed for a candidate: quote_not_found | llm_invalid_output.
  {
    name: 'v012_add_signal_candidates_score_error',
    statement: 'ALTER TABLE signal_candidates ADD COLUMN IF NOT EXISTS score_error VARCHAR(32) NULL',
  },
  // Who a confirmed signal reached, one row per signal. steps_json/stop_point_json hold team names and roles only,
  // never account ids. graph_state: ok|unknown|pending; via: resolver|action|mcp.
  {
    name: 'v013_create_reach_paths',
    statement: `CREATE TABLE IF NOT EXISTS reach_paths (
      id VARCHAR(36) PRIMARY KEY,
      signal_id VARCHAR(36) NOT NULL,
      incident_key VARCHAR(64) NOT NULL,
      reached TINYINT NULL,
      hop_count INT NOT NULL DEFAULT 0,
      steps_json JSON NOT NULL,
      stop_point_json JSON NULL,
      graph_state VARCHAR(16) NOT NULL,
      responder_team_id VARCHAR(255) NULL,
      via VARCHAR(16) NOT NULL,
      computed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_reach_signal (signal_id),
      KEY idx_reach_incident (incident_key)
    )`,
  },
  // Proposed routing rules per (origin incident, source); status: proposed|active|dismissed. A recompute never
  // demotes an active route. decided_by (accountId) is never sent to the UI or Rovo.
  {
    name: 'v014_create_routes',
    statement: `CREATE TABLE IF NOT EXISTS routes (
      id VARCHAR(36) PRIMARY KEY,
      origin_incident_key VARCHAR(64) NOT NULL,
      source_type VARCHAR(32) NOT NULL,
      source_key VARCHAR(255) NOT NULL,
      spec_json JSON NOT NULL,
      reason TEXT NOT NULL,
      estimated_days_saved DECIMAL(6,1) NOT NULL,
      max_days_before INT NOT NULL,
      signal_ids JSON NOT NULL,
      score DECIMAL(8,2) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'proposed',
      rank_no INT NOT NULL,
      decided_by VARCHAR(128) NULL,
      activated_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_route_origin_source (origin_incident_key, source_type, source_key),
      KEY idx_routes_status (status)
    )`,
  },
  // Demo incident only: the LLM verdict per (incident, event, text hash, prompt version), relevant or not, so
  // "Analyze again" replays it instead of asking the model again (stable recordings). Cleared by Reset / Remove.
  {
    name: 'v015_create_score_cache',
    statement: `CREATE TABLE IF NOT EXISTS score_cache (
      incident_key VARCHAR(64) NOT NULL,
      event_id VARCHAR(36) NOT NULL,
      text_hash CHAR(64) NOT NULL,
      prompt_version VARCHAR(32) NOT NULL,
      relevant TINYINT NOT NULL,
      signal_type VARCHAR(32) NULL,
      quote TEXT NULL,
      reason VARCHAR(255) NULL,
      confidence DOUBLE NOT NULL DEFAULT 0,
      model VARCHAR(64) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (incident_key, event_id, text_hash, prompt_version)
    )`,
  },
  // Sentinel alerts: one row per (active route, new artifact) the Sentinel matched. status: posted|skipped|failed;
  // reason: weekly_cap|api_error|rate_limited; feedback: useful|not_useful. No account ids are stored.
  {
    name: 'v016_create_alerts',
    statement: `CREATE TABLE IF NOT EXISTS alerts (
      id VARCHAR(36) PRIMARY KEY,
      route_id VARCHAR(36) NOT NULL,
      incident_key VARCHAR(64) NOT NULL,
      source VARCHAR(32) NOT NULL,
      artifact_kind VARCHAR(16) NOT NULL,
      artifact_id VARCHAR(64) NOT NULL,
      comment_id VARCHAR(64) NOT NULL DEFAULT '',
      artifact_url VARCHAR(512) NULL,
      artifact_title VARCHAR(512) NULL,
      matched_keywords JSON NOT NULL,
      target_team_id VARCHAR(64) NULL,
      target_team_name VARCHAR(255) NULL,
      posted_comment_id VARCHAR(64) NULL,
      status VARCHAR(16) NOT NULL,
      reason VARCHAR(64) NULL,
      feedback VARCHAR(16) NULL,
      error TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_alerts_route_artifact (route_id, artifact_id, created_at),
      KEY idx_alerts_team_created (target_team_id, created_at),
      KEY idx_alerts_incident (incident_key, created_at)
    )`,
  },
];

/** Name of the newest migration. */
export const LATEST_MIGRATION = MIGRATIONS[MIGRATIONS.length - 1]?.name ?? '';
