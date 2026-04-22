-- PAID 주문 환불 시 사용할 상태값 추가
-- ENUM은 값 추가는 가능하지만 삭제·순서변경이 어려우므로 신중히 추가
-- 주의: ALTER TYPE ... ADD VALUE 는 psql에서 하나의 문장으로 실행해야 함 (트랜잭션 블록 내 제한)
ALTER TYPE order_status ADD VALUE 'REFUNDED';
