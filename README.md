# QueueStorm Investigator

Production-style Node.js + Express backend API for the SUST CSE Carnival 2026 Codex Community Hackathon preliminary round.

This service is a **digital finance support-ticket investigator**. It takes one support ticket, reads the complaint and the user's `transaction_history`, and returns a structured JSON response with a `case_type`, an `evidence_verdict`, severity, routing, and a safe customer reply. There is **no frontend** and **no database**.

---

## Quick start

```bash
npm install
cp .env.example .env       # optional, only if you want to set PORT or GROQ_API_KEY
npm run dev                # local development with nodemon
# or
npm start                  # production-style start (node server.js)
```

The server binds to `0.0.0.0:8000` by default (override with `PORT`).

```bash
curl http://localhost:8000/health
# => { "status": "ok" }
```

---

## Endpoints

### `GET /health`

Returns:

```json
{ "status": "ok" }
```

### `POST /analyze-ticket`

**Request body** (`Content-Type: application/json`):

```json
{
  "ticket_id": "TKT-001",
  "complaint": "I sent 5000 taka to the wrong number by mistake.",
  "language": "en",
  "channel": "in_app_chat",
  "user_type": "customer",
  "campaign_context": null,
  "transaction_history": [
    {
      "transaction_id": "TXN-9101",
      "timestamp": "2026-04-14T14:08:22Z",
      "type": "transfer",
      "amount": 5000,
      "counterparty": "+8801719876543",
      "status": "completed"
    }
  ],
  "metadata": {}
}
```

**Response body**:

```json
{
  "ticket_id": "TKT-001",
  "relevant_transaction_id": "TXN-9101",
  "evidence_verdict": "consistent",
  "case_type": "wrong_transfer",
  "severity": "high",
  "department": "dispute_resolution",
  "agent_summary": "Customer reports a transfer sent to the wrong recipient (likely txn TXN-9101).",
  "recommended_next_action": "Verify recipient history and refer to dispute_resolution for review.",
  "customer_reply": "We have received your complaint. Our team will review the transfer and take the appropriate steps. Any eligible amount will be returned through official channels only.",
  "human_review_required": true,
  "confidence": 0.8,
  "reason_codes": [
    "wrong_transfer_keywords",
    "single_transfer_present",
    "severity_high",
    "lang_en"
  ]
}
```

**Error responses**:

- `400` — missing required fields (`ticket_id`, `complaint`) or malformed JSON body.
- `422` — `complaint` is present but empty.
- `500` — generic internal error; never leaks stack traces or secrets.

---

## Project layout

```
server.js                 Express app, JSON parsing, /health, error handlers
routes/analyze.js         POST /analyze-ticket handler
services/ruleAnalyzer.js  Deterministic rule-based case + verdict detection
utils/constants.js        Enum whitelists and keyword sets
utils/validator.js        Request/response cleaning + final schema validator
utils/safety.js           Sanitizes unsafe phrases in customer_reply
utils/responseFactory.js  Safe default response scaffold
samples/                  sample-request.json, sample-output.json
scripts/smoke-test.js           Local smoke test (custom scenarios)
scripts/test-official-samples.js  Runs docs/SUST_Preli_Sample_Cases.json
.env.example              Optional environment template
```

---

## AI / model usage

The service is **deterministic by design**. The default path is the rule-based analyzer in `services/ruleAnalyzer.js`. It does **not** call any external AI service and works with no API keys.

If you want to plug in Groq later, drop `GROQ_API_KEY` into `.env` (and optionally `GROQ_MODEL`, default `llama-3.1-8b-instant`). The analyzer should still be treated as the source of truth for `case_type`, `evidence_verdict`, `relevant_transaction_id`, `severity`, `department`, and `human_review_required`. Any AI polish must be funneled through `utils/safety.js` and `utils/validator.js` before responding.

If the key is missing, expired, slow, or the model errors out, the API still returns a valid rule-based response.

---

## Safety logic

Before any response is returned, `utils/safety.js` runs a sanitizer:

1. Strips or rewrites phrases that promise a refund, reversal, or unblock:
   - `we will refund you` → `any eligible amount will be returned through official channels`
   - `we reversed it` → `our team will review the case`
   - `your money will be returned` → `any eligible amount will be returned through official channels`
2. Removes requests that ask the customer to share/send/provide a PIN, OTP, password, CVV, or card number.
3. Removes instructions that push the customer to a third-party phone number.
4. Appends a safe credential warning when the topic touches credentials or fraud:
   - EN: `Please do not share your PIN or OTP with anyone.`
   - BN: `অনুগ্রহ করে কারো সাথে আপনার পিন বা ওটিপি শেয়ার করবেন না।`

Adversarial instructions inside the complaint (`ignore previous instructions`, `system prompt`, `override`, `pretend`, `you are now`, etc.) are ignored — the analyzer only reads the complaint as user input.

Finally, `utils/validator.js` re-checks every field against the allowed enum lists and clamps values into a safe shape before sending.

---

## Detection rules (high-level)

- `phishing_or_social_engineering` — OTP / PIN / password / scam / fake support / account block threat keywords. `severity = critical`, `department = fraud_risk`, `human_review_required = true`.
- `wrong_transfer` — wrong number / sent by mistake / recipient not responding. Matches a transfer by amount and counterparty. Repeated transfers to the same counterparty mark `evidence_verdict = inconsistent`.
- `payment_failed` — failed recharge / bill / payment with claimed balance deduction. Matches a `payment` with `status = failed` or `pending`.
- `duplicate_payment` — paid twice / deducted twice / double charge. Detects two same-type same-amount payments to the same counterparty and points to the later one.
- `refund_request` — explicit refund wording. Targets a completed payment; never promises a refund.
- `merchant_settlement_delay` — settlement / payout delay, or `user_type = merchant` / `channel = merchant_portal`.
- `agent_cash_in_issue` — cash-in not reflected / agent did not deposit. Matches a `cash_in` and favors pending status.
- `other` — vague or uncategorized. Defaults to `customer_support` and `insufficient_data`.

`relevant_transaction_id` is set only when there is exactly one strong match. Multiple plausible matches return `null` and `evidence_verdict = insufficient_data`.

---

## Language behavior

If `language === "bn"` or the complaint is mostly Bangla, the `customer_reply` is produced in Bangla. `agent_summary` and `recommended_next_action` are kept in English for internal support agents.

---

## Assumptions

- `transaction_history` may be absent, empty, or contain partial entries; missing fields are normalized to `null`.
- `amount` may be supplied in either English digits or Bangla digits.
- Phone numbers in the complaint are matched against `counterparty` substrings; exact-match is not required.
- The customer is always redirected to **official** channels, never to a third party.

## Testing

The project ships with two offline test runners. They use Node's built-in `fetch`, so no extra dependencies are required.

Start the server first in one terminal:

```bash
npm run dev
# or
npm start
```

Then, in another terminal:

```bash
# Custom smoke tests — covers wrong transfer, repeated recipient, phishing,
# failed payment, duplicate payment, Bangla cash-in, merchant settlement,
# vague complaint, missing ticket_id, and empty complaint.
npm run smoke
```

Expected last line:

```
Smoke test: 11 passed, 0 failed (11 total)
```

```bash
# Official sample cases — runs every case in docs/SUST_Preli_Sample_Cases.json,
# hard-compares relevant_transaction_id / evidence_verdict / case_type /
# department, warns on adjacent severity tiers, and verifies customer_reply
# safety (no credential asks, no hard refund/reversal promises).
npm run samples
```

Expected last line (severity-tier warnings are non-fatal):

```
Official samples: 10 passed, 0 failed, 3 warning(s) (10 total)
```

Both runners exit non-zero on any hard failure, so they're safe to wire into CI. Override the base URL with `SMOKE_BASE_URL`, e.g. `SMOKE_BASE_URL=http://127.0.0.1:8000 npm run samples`.

Latest local run:

- `npm run smoke` → **11 passed, 0 failed**
- `npm run samples` → **10 passed, 0 failed**

---

## Limitations

- No database or persistent state. Every request is processed independently.
- No real payment-API integration; transaction matching is purely structural.
- The rule-based analyzer is intentionally conservative — ambiguous cases are marked `insufficient_data` and routed to human review rather than auto-decided.
- Groq, if configured, is treated as a polite-text polisher; it must not change the underlying classification.
