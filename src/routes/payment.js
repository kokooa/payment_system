const express = require('express');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();

// 상품 카탈로그 (학습용 하드코딩 — 실제는 products 테이블)
// image: public/images/ 폴더 기준 상대 경로
const PRODUCTS = {
  'prod_001': { name: '아메리카노', price: 4500, image: '/images/prod_001.jpg', description: '깊고 진한 원두의 향' },
  'prod_002': { name: '카페라떼',   price: 5000, image: '/images/prod_002.jpg', description: '부드러운 우유와 에스프레소' },
  'prod_003': { name: '에스프레소', price: 4000, image: '/images/prod_003.jpg', description: '진한 한 잔의 집중' },
  'prod_004': { name: '카푸치노',   price: 5000, image: '/images/prod_004.jpg', description: '풍성한 우유 거품' },
  'prod_005': { name: '녹차라떼',   price: 5500, image: '/images/prod_005.jpg', description: '은은한 녹차의 향기' },
  'prod_006': { name: '초코라떼',   price: 5500, image: '/images/prod_006.jpg', description: '달콤한 초콜릿' },
};

// 상품 목록 조회
router.get('/products', (req, res) => {
  const list = Object.entries(PRODUCTS).map(([id, p]) => ({ id, ...p }));
  res.json(list);
});

// 결제 결과 페이지 렌더러 (서버사이드 HTML)
function renderResult({ success, title, details }) {
  const icon = success ? '✅' : '❌';
  const detailHtml = Object.entries(details)
    .map(([k, v]) => `<div><strong>${k}</strong>${v}</div>`)
    .join('');
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="result-page">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <div class="detail">${detailHtml}</div>
    <a class="back" href="/">메뉴로 돌아가기</a>
  </div>
</body>
</html>`;
}

// 주문 생성
router.post('/orders', async (req, res) => {
  const { productId } = req.body;

  // 1. 상품 존재 확인 (서버가 가진 카탈로그 기준)
  const product = PRODUCTS[productId];
  if (!product) {
    return res.status(400).json({ error: '존재하지 않는 상품' });
  }

  // 2. orderId 발급 (서버가 만든다)
  const orderId = `ord_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

  // 3. 주문 INSERT + 이력 기록을 한 트랜잭션으로 (둘 중 하나만 성공하면 drift 발생)
  const order = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO orders (order_id, product_name, amount, status)
       VALUES ($1, $2, $3, 'PENDING')
       RETURNING order_id, product_name, amount, status`,
      [orderId, product.name, product.price]
    );
    await client.query(
      `INSERT INTO order_events (order_id, event_type, to_status, payload)
       VALUES ($1, 'ORDER_CREATED', 'PENDING', $2)`,
      [orderId, JSON.stringify({ productId, productName: product.name, amount: product.price })]
    );
    return rows[0];
  });

  res.status(201).json(order);
});

// 결제 승인 (Toss가 브라우저를 여기로 리다이렉트시킴)
router.get('/payments/success', async (req, res) => {
  const { paymentKey, orderId, amount } = req.query;

  // 1. DB에서 우리가 저장한 주문 조회
  const { rows } = await db.query(
    `SELECT order_id, product_name, amount, status FROM orders WHERE order_id = $1`,
    [orderId]
  );
  const order = rows[0];

  if (!order) {
    return res.status(404).send('주문을 찾을 수 없습니다');
  }

  // 2. 금액 위변조 검증 (URL의 amount vs DB의 amount)
  if (Number(amount) !== order.amount) {
    // 상태는 바꾸지 않지만 위변조 의심은 반드시 기록 (보안 로그의 핵심)
    await db.query(
      `INSERT INTO order_events (order_id, event_type, reason, payload)
       VALUES ($1, 'AMOUNT_MISMATCH', 'URL amount != DB amount', $2)`,
      [orderId, JSON.stringify({ urlAmount: Number(amount), dbAmount: order.amount })]
    );
    return res.status(400).send('금액이 일치하지 않습니다 (위변조 의심)');
  }

  // 3. 상태 검증: PENDING이 아니면 진행 불가
  if (order.status !== 'PENDING') {
    return res.status(409).send(`이미 처리된 주문입니다 (${order.status})`);
  }

  // 4. Toss에 승인 요청 (시크릿 키로 인증)
  const secretKey = process.env.TOSS_SECRET_KEY;
  const basicAuth = Buffer.from(secretKey + ':').toString('base64');

  const tossRes = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ paymentKey, orderId, amount: Number(amount) }),
  });

  const tossData = await tossRes.json();

  if (!tossRes.ok) {
    // Toss 거절 → PENDING→FAILED 전이 + 이력 기록을 트랜잭션으로 묶음
    await db.withTransaction(async (client) => {
      const updateResult = await client.query(
        `UPDATE orders SET status = 'FAILED', updated_at = NOW()
         WHERE order_id = $1 AND status = 'PENDING'
         RETURNING order_id`,
        [orderId]
      );
      if (updateResult.rowCount > 0) {
        await client.query(
          `INSERT INTO order_events (order_id, event_type, from_status, to_status, reason, payload)
           VALUES ($1, 'CONFIRM_REJECTED', 'PENDING', 'FAILED', $2, $3)`,
          [orderId, tossData.message || null, JSON.stringify(tossData)]
        );
      }
    });
    return res.status(400).send(renderResult({
      success: false,
      title: '결제에 실패했어요',
      details: { '사유': tossData.message, '주문번호': orderId },
    }));
  }

  // 5. Toss 응답의 금액도 다시 검증
  if (tossData.totalAmount !== order.amount) {
    // 상태 전이 없음. 위변조 의심 로그만 기록.
    await db.query(
      `INSERT INTO order_events (order_id, event_type, reason, payload)
       VALUES ($1, 'AMOUNT_MISMATCH', 'Toss response amount != DB amount', $2)`,
      [orderId, JSON.stringify({ tossAmount: tossData.totalAmount, dbAmount: order.amount })]
    );
    return res.status(400).send(renderResult({
      success: false,
      title: '금액 검증 실패',
      details: { '사유': 'Toss 응답 금액과 DB 금액이 일치하지 않습니다', '주문번호': orderId },
    }));
  }

  // 6. 상태 전이: PENDING → PAID + 이력 기록 (트랜잭션)
  const transitioned = await db.withTransaction(async (client) => {
    const updateResult = await client.query(
      `UPDATE orders
       SET status = 'PAID', payment_key = $2, updated_at = NOW()
       WHERE order_id = $1 AND status = 'PENDING'
       RETURNING order_id`,
      [orderId, paymentKey]
    );
    if (updateResult.rowCount === 0) return false;
    await client.query(
      `INSERT INTO order_events (order_id, event_type, from_status, to_status, payload)
       VALUES ($1, 'CONFIRM_APPROVED', 'PENDING', 'PAID', $2)`,
      [orderId, JSON.stringify(tossData)]
    );
    return true;
  });

  if (!transitioned) {
    // 동시에 다른 요청(webhook 등)이 이미 처리한 경우
    return res.status(409).send('이미 처리된 주문입니다');
  }

  res.send(renderResult({
    success: true,
    title: '결제가 완료됐어요',
    details: {
      '상품': order.product_name || '-',
      '주문번호': orderId,
      '결제금액': `${Number(amount).toLocaleString()}원`,
    },
  }));
});

// Toss webhook 수신 (리다이렉트가 유실될 때의 안전망)
// - 사용자가 결제 직후 창을 닫거나, 우리 DB UPDATE가 실패해 Toss는 DONE인데 우리는 PENDING인 경우 최종 상태를 맞춘다
// - body는 신뢰하지 않는다. paymentKey로 Toss에 역조회해 "진짜 상태"를 확인
// - 멱등: PENDING일 때만 전이하므로 같은 webhook이 여러 번 와도 안전
// - 항상 200 반환. non-2xx면 Toss가 무한 재시도하므로 에러는 로그로만 남긴다
router.post('/webhooks/toss', async (req, res) => {
  const { data } = req.body || {};
  const paymentKey = data && data.paymentKey;
  const orderId = data && data.orderId;

  if (!paymentKey || !orderId) {
    console.warn('[webhook] missing paymentKey or orderId', req.body);
    return res.status(200).json({ ok: true });
  }

  try {
    // 1) 우리가 아는 주문
    const { rows } = await db.query(
      `SELECT order_id, amount, status FROM orders WHERE order_id = $1`,
      [orderId]
    );
    const order = rows[0];
    if (!order) {
      console.warn('[webhook] unknown orderId', orderId);
      return res.status(200).json({ ok: true });
    }

    // 2) Toss에 실제 상태 역조회 (body를 믿지 않는 핵심 단계)
    const secretKey = process.env.TOSS_SECRET_KEY;
    const basicAuth = Buffer.from(secretKey + ':').toString('base64');
    const tossRes = await fetch(
      `https://api.tosspayments.com/v1/payments/${paymentKey}`,
      { headers: { 'Authorization': `Basic ${basicAuth}` } }
    );
    const toss = await tossRes.json();

    if (!tossRes.ok) {
      console.error('[webhook] toss lookup failed', toss);
      return res.status(200).json({ ok: true });
    }

    // 3) 금액 검증 (Toss 응답과 DB 비교)
    if (toss.totalAmount !== order.amount) {
      console.error('[webhook] amount mismatch', {
        orderId, toss: toss.totalAmount, db: order.amount,
      });
      return res.status(200).json({ ok: true });
    }

    // 4) Toss 상태 → 내부 상태 매핑 (중간 상태는 전이 안 함)
    const mapping = {
      DONE: 'PAID',
      CANCELED: 'CANCELLED',
      ABORTED: 'FAILED',
      EXPIRED: 'EXPIRED',
    };
    const nextStatus = mapping[toss.status];
    if (!nextStatus) {
      return res.status(200).json({ ok: true });
    }

    // 5) 조건부 UPDATE + 이력 기록 (트랜잭션). PENDING일 때만 전이 & 기록.
    const didTransition = await db.withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE orders
         SET status = $2,
             payment_key = COALESCE(payment_key, $3),
             updated_at = NOW()
         WHERE order_id = $1 AND status = 'PENDING'
         RETURNING order_id`,
        [orderId, nextStatus, paymentKey]
      );
      if (result.rowCount === 0) return false;
      await client.query(
        `INSERT INTO order_events (order_id, event_type, from_status, to_status, reason, payload)
         VALUES ($1, 'WEBHOOK_RECONCILED', 'PENDING', $2, $3, $4)`,
        [orderId, nextStatus, `Toss status: ${toss.status}`, JSON.stringify(toss)]
      );
      return true;
    });

    if (didTransition) {
      console.log('[webhook] transitioned', { orderId, to: nextStatus });
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[webhook] error', err);
    res.status(200).json({ ok: true });
  }
});

// 결제 실패 (Toss가 실패 시 여기로 리다이렉트)
router.get('/payments/fail', async (req, res) => {
  const { code, message, orderId } = req.query;

  if (orderId) {
    await db.withTransaction(async (client) => {
      const updateResult = await client.query(
        `UPDATE orders SET status = 'FAILED', updated_at = NOW()
         WHERE order_id = $1 AND status = 'PENDING'
         RETURNING order_id`,
        [orderId]
      );
      if (updateResult.rowCount > 0) {
        await client.query(
          `INSERT INTO order_events (order_id, event_type, from_status, to_status, reason, payload)
           VALUES ($1, 'FAIL_REDIRECT', 'PENDING', 'FAILED', $2, $3)`,
          [orderId, message || null, JSON.stringify({ code, message })]
        );
      }
    });
  }

  res.status(400).send(renderResult({
    success: false,
    title: '결제를 완료하지 못했어요',
    details: { '사유': message || '알 수 없는 오류', '에러코드': code || '-' },
  }));
});

// 환불 (PAID → REFUNDED, 전액 환불만 지원)
// - Toss cancel API 호출 → 성공 시에만 DB 상태 전이 (Toss가 진실의 원천)
// - 상태 전이 + 성공 이력은 트랜잭션으로 묶어 drift 방지
// - 요청/실패는 별도 이력(append-only)로 기록해 감사 로그로 사용
router.post('/orders/:orderId/refund', async (req, res) => {
  const { orderId } = req.params;
  const { reason } = req.body || {};

  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: '환불 사유(reason)가 필요합니다' });
  }

  // 1. 주문 조회
  const { rows } = await db.query(
    `SELECT order_id, product_name, amount, status, payment_key FROM orders WHERE order_id = $1`,
    [orderId]
  );
  const order = rows[0];
  if (!order) {
    return res.status(404).json({ error: '주문을 찾을 수 없습니다' });
  }

  // 2. 상태 검증 (PAID만 환불 가능)
  if (order.status === 'REFUNDED') {
    return res.status(409).json({ error: '이미 환불된 주문입니다' });
  }
  if (order.status !== 'PAID') {
    return res.status(400).json({ error: `환불 불가 상태입니다 (${order.status})` });
  }
  if (!order.payment_key) {
    return res.status(400).json({ error: 'paymentKey가 없어 환불할 수 없습니다' });
  }

  // 3. 환불 요청 기록 (Toss 호출 전 흔적 — 중간 실패 추적용)
  await db.query(
    `INSERT INTO order_events (order_id, event_type, reason, payload)
     VALUES ($1, 'REFUND_REQUESTED', $2, $3)`,
    [orderId, reason, JSON.stringify({ amount: order.amount })]
  );

  // 4. Toss cancel API 호출
  const secretKey = process.env.TOSS_SECRET_KEY;
  const basicAuth = Buffer.from(secretKey + ':').toString('base64');

  const tossRes = await fetch(
    `https://api.tosspayments.com/v1/payments/${order.payment_key}/cancel`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ cancelReason: reason }),
    }
  );

  const tossData = await tossRes.json();

  if (!tossRes.ok) {
    // Toss 거절 — 상태 전이 없음. 실패 이력만 기록.
    await db.query(
      `INSERT INTO order_events (order_id, event_type, reason, payload)
       VALUES ($1, 'REFUND_FAILED', $2, $3)`,
      [orderId, tossData.message || null, JSON.stringify(tossData)]
    );
    return res.status(400).json({ error: '환불 실패', message: tossData.message });
  }

  // 5. PAID → REFUNDED 전이 + 성공 이력 (트랜잭션)
  const transitioned = await db.withTransaction(async (client) => {
    const updateResult = await client.query(
      `UPDATE orders SET status = 'REFUNDED', updated_at = NOW()
       WHERE order_id = $1 AND status = 'PAID'
       RETURNING order_id`,
      [orderId]
    );
    if (updateResult.rowCount === 0) return false;
    await client.query(
      `INSERT INTO order_events (order_id, event_type, from_status, to_status, reason, payload)
       VALUES ($1, 'REFUND_SUCCEEDED', 'PAID', 'REFUNDED', $2, $3)`,
      [orderId, reason, JSON.stringify(tossData)]
    );
    return true;
  });

  if (!transitioned) {
    // 경쟁 조건: Toss는 환불됐는데 DB가 이미 다른 상태 (드물지만 로그로 남김)
    console.error('[refund] toss cancelled but db already transitioned', { orderId });
    return res.status(409).json({ error: '주문 상태가 이미 변경되어 있습니다' });
  }

  res.json({
    ok: true,
    orderId,
    status: 'REFUNDED',
    refundedAmount: order.amount,
  });
});

// 관리자 전용 단순 Bearer 토큰 가드
// ADMIN_TOKEN 미설정 시 전면 거부 (환경변수 누락을 보안 문제로 차단)
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// 만료 배치: 30분 이상 PENDING으로 남은 주문을 EXPIRED로 전이
// - 시간 기준만 사용 (Toss 역조회 없음, MVP 단순화)
// - UPDATE ... RETURNING 으로 전이된 order_id 목록을 받아 각각 이력 기록
// - 전체를 트랜잭션으로 묶어 UPDATE 성공 + 이력 누락 같은 drift 방지
// - 멱등: 반복 호출해도 이미 PENDING 아닌 주문은 조건에 안 걸림
router.post('/admin/expire-pending', requireAdmin, async (req, res) => {
  const expired = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE orders
       SET status = 'EXPIRED', updated_at = NOW()
       WHERE status = 'PENDING'
         AND created_at < NOW() - INTERVAL '30 minutes'
       RETURNING order_id`
    );
    for (const { order_id } of rows) {
      await client.query(
        `INSERT INTO order_events (order_id, event_type, from_status, to_status, reason)
         VALUES ($1, 'EXPIRED_BY_BATCH', 'PENDING', 'EXPIRED', $2)`,
        [order_id, 'created_at older than 30 minutes']
      );
    }
    return rows.map(r => r.order_id);
  });

  res.json({ ok: true, expiredCount: expired.length, orderIds: expired });
});

module.exports = router;
