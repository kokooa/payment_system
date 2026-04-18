-- 결제 상태 enum (상태 머신의 상태 값들)
CREATE TYPE order_status AS ENUM (
  'PENDING',
  'PAID',
  'FAILED',
  'EXPIRED',
  'CANCELLED'
);

-- 주문 테이블
CREATE TABLE orders (
  order_id      VARCHAR(64) PRIMARY KEY,
  product_name  VARCHAR(200) NOT NULL,
  amount        INTEGER NOT NULL CHECK (amount > 0),
  status        order_status NOT NULL DEFAULT 'PENDING',
  payment_key   VARCHAR(200),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 조회 속도용 인덱스 (상태별 조회가 많을 것)
CREATE INDEX idx_orders_status ON orders(status);
