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

  // 3. DB 저장 (금액도 서버가 정한 값)
  const result = await db.query(
    `INSERT INTO orders (order_id, product_name, amount, status)
     VALUES ($1, $2, $3, 'PENDING')
     RETURNING order_id, product_name, amount, status`,
    [orderId, product.name, product.price]
  );

  res.status(201).json(result.rows[0]);
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
    // Toss가 거절 → FAILED로 전이 (PENDING → FAILED만 허용)
    await db.query(
      `UPDATE orders SET status = 'FAILED', updated_at = NOW()
       WHERE order_id = $1 AND status = 'PENDING'`,
      [orderId]
    );
    return res.status(400).send(renderResult({
      success: false,
      title: '결제에 실패했어요',
      details: { '사유': tossData.message, '주문번호': orderId },
    }));
  }

  // 5. Toss 응답의 금액도 다시 검증
  if (tossData.totalAmount !== order.amount) {
    return res.status(400).send(renderResult({
      success: false,
      title: '금액 검증 실패',
      details: { '사유': 'Toss 응답 금액과 DB 금액이 일치하지 않습니다', '주문번호': orderId },
    }));
  }

  // 6. 상태 전이: PENDING → PAID (조건부 UPDATE)
  const updateResult = await db.query(
    `UPDATE orders
     SET status = 'PAID', payment_key = $2, updated_at = NOW()
     WHERE order_id = $1 AND status = 'PENDING'
     RETURNING order_id`,
    [orderId, paymentKey]
  );

  if (updateResult.rowCount === 0) {
    // 동시에 다른 요청이 이미 처리한 경우
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

    // 5) 조건부 UPDATE: PENDING일 때만 전이 (리다이렉트 핸들러가 이미 처리했으면 no-op)
    const result = await db.query(
      `UPDATE orders
       SET status = $2,
           payment_key = COALESCE(payment_key, $3),
           updated_at = NOW()
       WHERE order_id = $1 AND status = 'PENDING'
       RETURNING order_id`,
      [orderId, nextStatus, paymentKey]
    );

    if (result.rowCount > 0) {
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
    await db.query(
      `UPDATE orders SET status = 'FAILED', updated_at = NOW()
       WHERE order_id = $1 AND status = 'PENDING'`,
      [orderId]
    );
  }

  res.status(400).send(renderResult({
    success: false,
    title: '결제를 완료하지 못했어요',
    details: { '사유': message || '알 수 없는 오류', '에러코드': code || '-' },
  }));
});

module.exports = router;
