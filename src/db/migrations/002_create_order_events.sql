-- 상태 전이 이력 (append-only 감사 로그)
-- orders는 현재 상태만 덮어쓰므로 "왜 이렇게 됐는지" 답할 수 없음
-- 모든 상태 변화·위변조 의심을 여기 기록해 분쟁·디버깅·운영 근거로 사용
CREATE TABLE order_events (
  id          BIGSERIAL PRIMARY KEY,
  order_id    VARCHAR(64) NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  event_type  VARCHAR(50) NOT NULL,
  from_status order_status,
  to_status   order_status,
  reason      TEXT,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_order_events_order_id_created ON order_events(order_id, created_at);
