# Calm Scenes

A guided, chat-style cartoon exercise inspired by EMDR. A user builds a safe place, turns something that bothers them into a silly cartoon creature, and gets to know it from a distance while following a moving dot (bilateral stimulation). A safety layer watches ratings, response behavior and language, and pauses or stops the session when needed.

> **Not therapy, not a medical device, not emergency help.** Nothing here has been clinically validated. All thresholds, screening questions and user-facing copy are drafts and must be reviewed by a qualified clinician (and by legal counsel for your jurisdiction) before real users touch it. Software cannot reliably detect dissociation or a distress flood. This project watches proxies and fails safe: when unsure, it pauses.

## What it does

One chat screen, one text box, and an animated scene pinned above the conversation.

1. **Consent and screening.** Six yes/no questions (18+, suicidality, psychosis, intoxication, dissociative disorder, current physical danger). Screen-outs never reach payment.
2. **Pay.** $2 per session through Stripe Checkout.
3. **Safe place.** The user describes a calm place and a calming figure. The app generates a cartoon scene and character.
4. **Assessment.** A few quick questions about impact: effect on daily life, the belief the memory brings up, where it's felt in the body, distress (0-10), a preferred positive belief, and how true it feels (1-7). The user gives a *headline*, never the story of what happened.
5. **Creature.** The headline becomes a symbolic, harmless cartoon creature with a funny name. The user controls how close it is.
6. **EMDR sets.** About 24 seconds of a moving dot with optional left/right audio (reduced-motion alternative included), then a check-in, a one-line "what do you notice?", and a short story chapter.
7. **Closure.** The creature goes into a chest, a body scan, a belief re-rating, and a final check-in. The summary shows distress and belief change.

## Safety design

All safety decisions live in `session.js`, a pure state machine with no DOM or network access, so they are unit-testable.

| Signal | Result |
|---|---|
| Screening flag, or under 18 | Excluded, automatic refund |
| Presence below 6 after grounding, twice | "Not ready", refund |
| Starting distress above 6 | Target declined (asks for something smaller; second decline closes) |
| Distress 8+, rise of 3+, presence 4 or below, rising streak, dissociation language, late reply, tab hidden 10 s+, invalid rating | **Amber**: stop stimulation, grounding, resume only when ratings recover |
| Second amber, self-harm language, or silence during grounding | **Red**: end session, crisis resources, server-side lock, 24 h cooldown |

Additional behavior:

- Every free-text input passes a risk check (server classifier plus a local English/Spanish lexicon, taking the max). If the check can't run, the flow does not continue.
- The creature steps far away automatically whenever the app pauses to ground.
- Stars reward showing up, never lower numbers, so ratings stay honest.
- The story prompt forbids depicting events or framing anything as a fight or confrontation.
- A Stop button and "Need help now" are always visible. Crisis resources default by time zone (Mexico, US, UK, Spain, plus a worldwide fallback) with a country picker.
- Safety checks are exempt from the generation cap and keep working briefly after a session token expires.

All thresholds are in the `CFG` object at the top of `session.js`.

## Architecture

```
index.html      Chat UI, scene animation, bilateral stimulation, all client logic
session.js      Safety state machine and risk ladder (pure logic; browser + Node)
proxy.php       Token-gated proxy to the AI provider; risk, story, image, vision modes
pay.php         Stripe Checkout, claim, refund, and an optional test bypass
lib.php         Config, SQLite session store, HMAC session tokens, spend caps
```

**Data handling.** The server stores only session bookkeeping in SQLite (id, expiry, counters, red-lock flag). It never stores anything the user writes. What the user types is sent to a third-party AI provider to generate text and images, and the consent screen says so. The only client-side persistence is the paid session token (`sessionStorage`) and the cooldown timestamp (`localStorage`). Stripe sees only the payment; keep the product name neutral because it appears on receipts.

**Payments.** One payment mints one signed session token. The proxy requires it on every call, which also caps cost per payment (default 40 generation credits; an image costs 2). Refunds are automatic only for screen-outs or "not ready", and only if the session used few generations.

## Requirements

- PHP 7.4+ with `curl` and `pdo_sqlite`
- A Stripe account (test keys are fine to start)
- An AI provider API key supporting text, image and moderation endpoints (endpoints are set in `proxy.php`)
- HTTPS in production

## Setup

```bash
cp config.sample.php config.php      # keep it above the web root in production
# fill in: ai_api_key, token_secret, stripe_secret_key, ...
php -r "echo bin2hex(random_bytes(32));"   # use this for token_secret
php -S localhost:8000
```

Open `http://localhost:8000/`.

### Configuration

| Key | Purpose |
|---|---|
| `ai_api_key`, `ai_model`, `risk_model`, `image_model`, `image_quality` | Provider key and models |
| `token_secret` | 32+ chars; signs session tokens (required) |
| `salt` | Anonymises IPs for rate limits |
| `stripe_secret_key`, `price_cents`, `currency`, `product_name` | Payment |
| `session_minutes`, `session_gen_cap`, `risk_cap`, `refund_max_gens` | Limits |
| `allow_test_bypass`, `test_bypass_key`, `test_gen_cap` | Test bypass (see below) |

### Test mode (skips payment only)

Set `allow_test_bypass => true` and a `test_bypass_key` of 16+ random characters, then open `http://localhost:8000/#test` and choose "Test mode" at the payment step. Screening, caps, the risk ladder and lockouts all still run on test sessions. The endpoint returns 404 when disabled, is rate-limited, and compares keys in constant time. **Never enable it in production, and never ship the key to the browser.**

## Testing

```bash
node session.test.js                         # 30 unit tests for the state machine

python3 -m http.server 8765 &                # 24 browser checks, server mocked
pip install playwright && playwright install chromium
python3 ui.e2e.py
```

The e2e suite covers the happy path, two ambers leading to red, silence leading to crisis, screen-out without payment, safety check unavailable, self-harm text with the server down, dissociation language, country defaults, and the target cap. It does not call Stripe or any AI provider. Test the real payment and generation flow manually with Stripe test keys (card `4242 4242 4242 4242`).

## Deployment checklist

- [ ] `config.php` above the web root, never committed
- [ ] Fresh `token_secret` and API keys (do not reuse local test values)
- [ ] `allow_test_bypass` is `false`
- [ ] Stripe live keys; webhook-free flow verified end to end
- [ ] `data/` is not web-accessible (an `.htaccess` is created for Apache; add an equivalent deny rule for nginx)
- [ ] HTTPS enforced
- [ ] Privacy notice naming your data processors, with sensitive-data consent that fits your jurisdiction (for example LFPDPPP in Mexico, GDPR, HIPAA where relevant)
- [ ] Clinician review of thresholds, screening questions, closure scripts and crisis copy
- [ ] Crisis numbers re-verified for every country you list

## Known limitations

- English-only UI (the risk lexicon is bilingual).
- Reloading mid-session resets in-memory state.
- The 24 h cooldown is client-side; clearing storage or paying again bypasses it.
- There is no clinician link yet. `session.js` already emits a `clinician_alert` effect and ratings-only summaries.
- Self-report ratings and behavioral signals are proxies; they will miss some episodes and over-trigger on others.

