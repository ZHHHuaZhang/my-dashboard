CREATE TABLE IF NOT EXISTS sync_records (
  uid         text        NOT NULL,
  module      text        NOT NULL,
  rec_id      text        NOT NULL,
  data        jsonb       NOT NULL,
  updated_at  bigint      NOT NULL,
  deleted     boolean     NOT NULL DEFAULT false,
  device_id   text,
  server_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (uid, module, rec_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_records_pull
  ON sync_records (uid, module, updated_at);
