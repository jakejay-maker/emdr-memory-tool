<?php
// LOCAL TESTING ONLY. Rename to config.php to use. Never deploy this file or reuse these values in production.
return [
  'ai_api_key'      => '',
  'ai_model'        => 'gpt-5.4-mini',
  'risk_model'      => 'gpt-5.4-mini',
  'image_model'     => 'gpt-image-1',
  'image_quality'   => 'low',

  'token_secret'    => 'cc8b297952b9a2427d381c58b9a95a2a45db615f5a9518ac03c163a443ac4c9d',
  'salt'            => '38b841dc8563ac01',

  'stripe_secret_key' => 'sk_test_PASTE-FROM-STRIPE-DASHBOARD',
  'price_cents'     => 200,
  'currency'        => 'usd',
  'product_name'    => 'Guided session',

  'session_minutes' => 120,
  'session_gen_cap' => 15,      // low on purpose: keeps test runs cheap
  'risk_cap'        => 300,
  'refund_max_gens' => 10,

  'allow_test_bypass' => true,
  'test_bypass_key'   => 'zWPlkxfk82w8aFqU3KXx9PBU',
  'test_gen_cap'      => 40,
];
