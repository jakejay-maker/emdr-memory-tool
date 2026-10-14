<?php
// Payment + session tokens.  POST ?a=checkout | claim | refund | admin
// One $2 payment = one session token. Stripe only ever sees the payment, never session content.
require __DIR__ . '/lib.php';
$cfg = cfg(); $a = $_GET['a'] ?? ''; $b = jbody();
$price = (int)($cfg['price_cents'] ?? 200);

function stripe($method, $path, $params = [], $idem = null) {
  $key = cfg()['stripe_secret_key'] ?? '';
  if ($key === '') jout(['error' => 'server not configured'], 500);
  $ch = curl_init('https://api.stripe.com' . $path);
  $h = [];
  if ($idem) $h[] = 'Idempotency-Key: ' . $idem;
  curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 25, CURLOPT_USERPWD => $key . ':', CURLOPT_HTTPHEADER => $h]);
  if ($method === 'POST') { curl_setopt($ch, CURLOPT_POST, true); curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($params)); }
  $res = curl_exec($ch); $code = curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch);
  return [$code, json_decode((string)$res, true) ?: []];
}

if ($a === 'checkout') {
  $base = base_url();
  [$c, $j] = stripe('POST', '/v1/checkout/sessions', [
    'mode' => 'payment',
    'line_items' => [['quantity' => 1, 'price_data' => [
      'currency' => $cfg['currency'] ?? 'usd', 'unit_amount' => $price,
      // Shown on receipts and bank statements: keep it neutral.
      'product_data' => ['name' => $cfg['product_name'] ?? 'Guided session']]]],
    'success_url' => $base . '/?cs={CHECKOUT_SESSION_ID}',
    'cancel_url' => $base . '/',
  ]);
  if ($c !== 200 || empty($j['url'])) jout(['error' => 'checkout_failed'], 502);
  jout(['url' => $j['url']]);
}

if ($a === 'claim') {   // after Stripe redirects back with ?cs=... : verify with Stripe, mint the token
  $cs = (string)($b['cs'] ?? '');
  if (!preg_match('/^cs_[A-Za-z0-9_]{10,200}$/', $cs)) jout(['error' => 'bad request'], 400);
  $find = function () use ($cs) { $q = db()->prepare('SELECT id, exp FROM sess WHERE pay = ?'); $q->execute([$cs]); return $q->fetch(); };
  $row = $find();
  if (!$row) {
    [$c, $j] = stripe('GET', '/v1/checkout/sessions/' . $cs);
    if ($c !== 200 || ($j['payment_status'] ?? '') !== 'paid' || ($j['mode'] ?? '') !== 'payment' || (int)($j['amount_total'] ?? 0) < $price) jout(['error' => 'not_paid'], 402);
    try { $n = new_session(false, $cs, (string)($j['payment_intent'] ?? '')); jout(['token' => $n['token'], 'exp' => $n['exp']]); }
    catch (PDOException $e) { $row = $find(); if (!$row) jout(['error' => 'claim_failed'], 500); }   // double-click race: already minted
  }
  if ((int)$row['exp'] < time()) jout(['error' => 'session_expired'], 410);
  jout(['token' => make_token($row['id']), 'exp' => (int)$row['exp']]);   // refresh-safe until expiry
}

if ($a === 'refund') {  // only for screen-outs / not-ready, and only if the session barely used any generations
  $row = verify_token($_SERVER['HTTP_X_SESSION_TOKEN'] ?? '', 1800);
  if (!$row) jout(['error' => 'session_required'], 402);
  if (!in_array($b['reason'] ?? '', ['screen', 'not_ready'], true)) jout(['error' => 'bad request'], 400);
  if ((int)$row['test'] || $row['pi'] === '' || (int)$row['refunded'] || (int)$row['gens'] > (int)($cfg['refund_max_gens'] ?? 10)) jout(['ok' => false, 'error' => 'not_refundable'], 403);
  $mark = db()->prepare('UPDATE sess SET refunded = 1, exp = ? WHERE id = ? AND refunded = 0'); $mark->execute([time(), $row['id']]);
  if ($mark->rowCount() !== 1) jout(['ok' => false, 'error' => 'not_refundable'], 403);
  [$c] = stripe('POST', '/v1/refunds', ['payment_intent' => $row['pi'], 'reason' => 'requested_by_customer'], 'refund-' . $row['id']);
  if ($c !== 200) { db()->prepare('UPDATE sess SET refunded = 0, exp = ? WHERE id = ?')->execute([time() + 600, $row['id']]); jout(['ok' => false, 'error' => 'refund_failed'], 502); }
  jout(['ok' => true]);
}

if ($a === 'admin') {   // TEST ONLY: skips payment, nothing else. Safety logic is unchanged for test sessions.
  $k = (string)($cfg['test_bypass_key'] ?? '');
  if (($cfg['allow_test_bypass'] ?? false) !== true || strlen($k) < 16) jout(['error' => 'not found'], 404);   // off by default; looks absent
  if (limited('adm:' . ip_hash(), 8, 3600)) jout(['error' => 'too_many'], 429);
  if (!hash_equals($k, (string)($b['key'] ?? ''))) jout(['error' => 'not_allowed'], 403);
  $n = new_session(true, null, '');
  jout(['token' => $n['token'], 'exp' => $n['exp'], 'test' => true]);
}

jout(['error' => 'unknown action'], 400);
