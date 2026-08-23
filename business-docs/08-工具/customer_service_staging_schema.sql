-- 客服 Excel staging 隔离表
--
-- 这不是 33-schema-v1-草案.sql 的内容发布 SoR，也不提供搜索/发布/公告 API。
-- 用途仅是承接 customer_service_staging_importer.py 的 prefill 输出，供人工
-- 校验、字段映射和后续正式导入前复核。默认不授予 app_runtime，不接入客服 Agent 在线主链。
-- 生产/正式导入前必须重新完成 Owner、来源、ACL、质量和 EVD 核验。

CREATE SCHEMA IF NOT EXISTS customer_service_staging;

CREATE TABLE IF NOT EXISTS customer_service_staging.import_batches (
  batch_id               TEXT PRIMARY KEY,
  data_status            TEXT NOT NULL CHECK (data_status IN ('prefill', 'official', 'rejected')),
  source_period_start    DATE,
  source_period_end      DATE,
  qa_record_count        INTEGER NOT NULL DEFAULT 0 CHECK (qa_record_count >= 0),
  campaign_record_count  INTEGER NOT NULL DEFAULT 0 CHECK (campaign_record_count >= 0),
  voc_record_count       INTEGER NOT NULL DEFAULT 0 CHECK (voc_record_count >= 0),
  postgresql_written     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT staging_batches_prefill_boundary CHECK (
    data_status <> 'prefill' OR postgresql_written = FALSE
  )
);

CREATE TABLE IF NOT EXISTS customer_service_staging.batch_sources (
  batch_id          TEXT NOT NULL REFERENCES customer_service_staging.import_batches(batch_id),
  source_file_name  TEXT NOT NULL,
  source_type       TEXT NOT NULL CHECK (source_type IN ('product_qa', 'campaign', 'voc')),
  source_sha256     TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_size_bytes BIGINT NOT NULL CHECK (source_size_bytes >= 0),
  sheet_count       INTEGER NOT NULL CHECK (sheet_count >= 0),
  raw_file_unchanged BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (batch_id, source_file_name)
);

CREATE TABLE IF NOT EXISTS customer_service_staging.qa_records (
  batch_id          TEXT NOT NULL REFERENCES customer_service_staging.import_batches(batch_id),
  record_id         TEXT NOT NULL,
  data_status       TEXT NOT NULL CHECK (data_status IN ('prefill', 'official', 'rejected')),
  record_date       TEXT,
  product_family    TEXT,
  product_name      TEXT,
  question_text     TEXT,
  internal_answer   TEXT,
  approved_script   TEXT,
  processing_status TEXT NOT NULL DEFAULT '待复核',
  review_evidence_id TEXT,
  source_file_name  TEXT NOT NULL,
  source_sheet_name TEXT NOT NULL,
  source_row_no     INTEGER NOT NULL CHECK (source_row_no > 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, record_id),
  CONSTRAINT qa_prefill_boundary CHECK (data_status <> 'prefill' OR review_evidence_id IS NULL)
);

CREATE TABLE IF NOT EXISTS customer_service_staging.campaign_records (
  batch_id          TEXT NOT NULL REFERENCES customer_service_staging.import_batches(batch_id),
  record_id         TEXT NOT NULL,
  data_status       TEXT NOT NULL CHECK (data_status IN ('prefill', 'official', 'rejected')),
  record_date       TEXT,
  group_name        TEXT,
  shortcut_code     TEXT,
  approved_script   TEXT,
  team_enabled      TEXT,
  processing_status TEXT NOT NULL DEFAULT '待复核',
  review_evidence_id TEXT,
  source_file_name  TEXT NOT NULL,
  source_sheet_name TEXT NOT NULL,
  source_row_no     INTEGER NOT NULL CHECK (source_row_no > 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, record_id),
  CONSTRAINT campaign_prefill_boundary CHECK (data_status <> 'prefill' OR review_evidence_id IS NULL)
);

CREATE TABLE IF NOT EXISTS customer_service_staging.voc_records (
  batch_id          TEXT NOT NULL REFERENCES customer_service_staging.import_batches(batch_id),
  record_id         TEXT NOT NULL,
  data_status       TEXT NOT NULL CHECK (data_status IN ('prefill', 'official', 'rejected')),
  record_date       TEXT,
  product_family    TEXT,
  product_name      TEXT,
  order_id          TEXT,
  category_l1       TEXT,
  category_l2       TEXT,
  category_l3       TEXT,
  category_l4       TEXT,
  primary_issue     TEXT NOT NULL,
  issue_tags        TEXT[] NOT NULL DEFAULT '{}',
  question_text     TEXT,
  batch_no          TEXT,
  description       TEXT,
  image_ref         TEXT,
  feedback_count    INTEGER NOT NULL DEFAULT 1 CHECK (feedback_count >= 0),
  escalation_level  TEXT CHECK (escalation_level IN ('紧急', '高', '中', '低')),
  processing_status TEXT NOT NULL DEFAULT '待分类',
  owner_team        TEXT,
  collaborating_teams TEXT[] NOT NULL DEFAULT '{}',
  reviewer_role     TEXT,
  review_evidence_id TEXT,
  source_file_name  TEXT NOT NULL,
  source_sheet_name TEXT NOT NULL,
  source_row_no     INTEGER NOT NULL CHECK (source_row_no > 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, record_id),
  CONSTRAINT voc_prefill_boundary CHECK (data_status <> 'prefill' OR review_evidence_id IS NULL),
  CONSTRAINT voc_issue_required CHECK (pg_catalog.btrim(primary_issue) <> '')
);

CREATE INDEX IF NOT EXISTS idx_cs_staging_qa_batch_status
  ON customer_service_staging.qa_records(batch_id, processing_status);
CREATE INDEX IF NOT EXISTS idx_cs_staging_campaign_batch_code
  ON customer_service_staging.campaign_records(batch_id, shortcut_code);
CREATE INDEX IF NOT EXISTS idx_cs_staging_voc_batch_product
  ON customer_service_staging.voc_records(batch_id, product_family, category_l1);

-- 明确不接入在线运行身份。正式环境若需读取，必须另行设计受控 reader 与审计合同。
REVOKE ALL ON SCHEMA customer_service_staging FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA customer_service_staging FROM PUBLIC;
