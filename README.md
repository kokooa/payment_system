# Payment System

Toss Payments 연동 결제 시스템을 **보안·멱등성·상태 관리 관점에서 직접 설계**하며 학습한 프로젝트입니다. 위변조·중복 결제·동시성 공격 시나리오를 실제로 시도하고, 각 공격을 3층 방어로 차단하는 구조를 검증했습니다.

🔗 **Live Demo**: https://payment-system-zp5q.onrender.com

> Toss Payments 테스트 모드로 실제 돈은 빠져나가지 않습니다. 테스트 카드번호(예: `4330123412341234`) + 미래 유효기간 + 임의 CVC로 결제 가능.
> 간편 결제의 경우 실제 돈은 빠져나가지 않지만 결제 금액 이상의 돈이 있어야 테스트 결제 실행됨.
> 무료 티어 특성상 15분 유휴 후 첫 접속이 ~30초 느릴 수 있습니다.

## 기술 스택

- **Backend**: Node.js, Express
- **Database**: PostgreSQL (ENUM, CHECK 제약, 파라미터 바인딩)
- **PG 연동**: Toss Payments (테스트 모드)

## 주요 기능

| 메서드 | 경로 | 설명 |
|---|---|---|
| `POST` | `/api/orders` | 주문 생성, `orderId` 발급 (금액은 서버가 결정) |
| `GET` | `/api/payments/success` | Toss 리다이렉트 수신 → 검증 → 승인 → `PAID` |
| `GET` | `/api/payments/fail` | 결제 실패 → `FAILED` 전이 |
| `POST` | `/api/webhooks/toss` | Toss webhook 수신, 역조회 기반 상태 재동기화 |
| `POST` | `/api/orders/:orderId/refund` | 전액 환불 (`PAID → REFUNDED`), Toss cancel API 호출 |
| `POST` | `/api/admin/expire-pending` | 관리자용 배치: 30분 경과 PENDING → EXPIRED (Bearer 토큰) |
| `GET` | `/api/config` | 프론트용 클라이언트 키 전달 |
| `GET` | `/health` | 서버·DB 헬스체크 |

## 핵심 설계

### 1. 3중 금액 검증
클라이언트 위변조를 차단하기 위해 결제 금액을 세 지점에서 교차 검증합니다.

1. **서버 카탈로그 기반 결정** — 클라이언트가 보낸 `amount`는 무시
2. **리다이렉트 URL 검증** — Toss가 넘긴 쿼리 `amount` vs DB 값
3. **Toss 승인 응답 재검증** — `totalAmount` vs DB 값

### 2. 멱등성
네트워크 재시도·더블클릭·웹훅 재전송 등 동일 요청 중복에서 이중 결제를 방지합니다.

- `order_id` **PRIMARY KEY**로 DB 레벨 중복 삽입 차단
- 상태 전이 시 **조건부 UPDATE** (`WHERE status = 'PENDING'`)로 동시성 환경에서 단일 처리 보장

### 3. 상태 머신
주문 수명주기를 PostgreSQL ENUM으로 타입 제한하고, 조건부 UPDATE로 허용된 전이만 수행합니다.

```
        ┌─ PAID ──> REFUNDED
PENDING ┼─ FAILED
        ├─ EXPIRED
        └─ CANCELLED
```

역방향 전이(`FAILED → PAID` 등)는 원천 차단됩니다.

### 4. Webhook (리다이렉트 유실 안전망)
사용자가 결제 직후 창을 닫거나 `success` 리다이렉트가 유실돼도 최종 상태를 맞추는 장치.

- **body를 신뢰하지 않음** — `paymentKey`로 Toss에 역조회해 "진짜 상태" 확인
- Toss 응답의 `totalAmount`를 DB와 재검증 후 상태 매핑 (DONE→PAID, ABORTED→FAILED, EXPIRED→EXPIRED, CANCELED→CANCELLED)
- **항상 200 반환** — non-2xx면 Toss가 무한 재시도하므로 에러는 서버 로그로만 남김
- 조건부 UPDATE(`WHERE status='PENDING'`)로 `success` 핸들러와의 경쟁에서도 한 번만 전이

### 5. 감사 로그 (order_events)
`orders`는 현재 상태만 덮어쓰므로 "왜 이렇게 됐는지" 답할 수 없음. 별도 append-only 테이블에 모든 상태 변화와 위변조 의심을 기록.

- 상태 전이 이벤트: `ORDER_CREATED`, `CONFIRM_APPROVED`, `CONFIRM_REJECTED`, `FAIL_REDIRECT`, `WEBHOOK_RECONCILED`, `REFUND_REQUESTED`, `REFUND_SUCCEEDED`, `REFUND_FAILED`, `EXPIRED_BY_BATCH`
- 보안 로그: `AMOUNT_MISMATCH` (상태 변경 없이 의심 기록만)
- 상태 전이(UPDATE) + 이벤트 기록(INSERT)은 **트랜잭션으로 묶어** 둘 중 하나만 성공하는 drift 방지

## 검증한 공격 시나리오

| 공격 | 시도 | 차단 지점 |
|---|---|---|
| 금액 위변조 | URL `amount=1`로 조작 | 2차 금액 검증 |
| 중복 승인 | `PAID` 주문 재승인 요청 | 상태 머신 조건부 UPDATE |
| 위조 콜백 | 가짜 `paymentKey`로 success URL 호출 | Toss 승인 API 호출 실패 |

## 실행 방법

### 1. 의존성 설치
```bash
npm install
```

### 2. 환경 변수
```bash
cp .env.example .env
# .env 파일을 열어서 실제 값으로 채우기
```

Toss 테스트 키는 [Toss 개발자센터](https://developers.tosspayments.com)에서 발급받을 수 있습니다.

### 3. DB 마이그레이션
순서대로 적용 (번호 순서가 의존성 순서):
```bash
psql -U <사용자> -d <DB명> -f src/db/migrations/001_create_orders.sql
psql -U <사용자> -d <DB명> -f src/db/migrations/002_create_order_events.sql
psql -U <사용자> -d <DB명> -f src/db/migrations/003_add_refunded_status.sql
```

### 4. 실행
```bash
npm run dev   # nodemon (개발)
npm start     # 운영
```

### 5. 테스트
브라우저에서 `http://localhost:3000` 접속 → 상품 선택 → 결제하기

**테스트 카드 정보** (실제 결제 아님):
- 카드번호: 임의의 16자리
- 유효기간: 미래 날짜 아무거나
- CVC: 123

## 프로젝트 구조

```
payment_system/
├── src/
│   ├── app.js                                    # Express 진입점
│   ├── db/
│   │   ├── index.js                              # PostgreSQL Pool + withTransaction 헬퍼
│   │   └── migrations/
│   │       ├── 001_create_orders.sql             # orders 테이블 + order_status enum
│   │       ├── 002_create_order_events.sql       # 상태 전이 감사 로그
│   │       └── 003_add_refunded_status.sql       # ENUM에 REFUNDED 추가
│   └── routes/
│       └── payment.js                            # 주문/승인/실패/webhook/환불/관리자 라우트
├── public/
│   └── checkout.html                             # Toss SDK 결제창
├── .env.example                                  # 환경변수 템플릿
└── package.json
```

## 향후 계획

- [x] Webhook 수신 (리다이렉트 유실 안전망)
- [x] 전액 환불 (`PAID → REFUNDED` 전이, Toss cancel 연동)
- [x] 상태 전이 감사 로그 (`order_events`)
- [x] PENDING 주문 만료 처리 (관리자 엔드포인트로 수동 트리거)
- [ ] Webhook HMAC 서명 검증
- [ ] 만료 배치 스케줄링 (외부 cron으로 주기 호출)
- [ ] 부분 환불 지원
- [ ] Toss 승인 성공 + 내부 DB 실패 케이스 복구 로직

## 학습한 개념

- 결제 플로우 3단계 (요청 / 승인 / 검증)의 분리 이유
- 클라이언트(브라우저·JS·HTTP 요청)를 신뢰할 수 없는 이유와 위변조 공격 패턴
- 분산 시스템에서 멱등성 필요성 — 네트워크 재시도가 만드는 이중 결제
- 도메인 상태 머신 모델링과 DB 스키마로 강제하는 방법
- Webhook 설계 원칙 — body 비신뢰 / 역조회 / 항상 200 / 조건부 UPDATE로 멱등
- 현재 상태 테이블(덮어쓰기) vs 이벤트 로그(append-only)의 역할 분담
- 상태 전이와 이력 기록을 트랜잭션으로 묶어 drift 방지
- 외부 API 성공 + 내부 DB 실패 시 필요한 보상(compensation) 문제
