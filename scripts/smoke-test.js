#!/usr/bin/env node
/* eslint-disable no-console */
// Local smoke test for QueueStorm Investigator.
// Assumes the server is already running on http://localhost:8000
// (start it in another terminal with `npm start` or `npm run dev`).

'use strict';

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:8000';

const ENUMS = {
  evidenceVerdict: ['consistent', 'inconsistent', 'insufficient_data'],
  caseType: [
    'wrong_transfer',
    'payment_failed',
    'refund_request',
    'duplicate_payment',
    'merchant_settlement_delay',
    'agent_cash_in_issue',
    'phishing_or_social_engineering',
    'other',
  ],
  severity: ['low', 'medium', 'high', 'critical'],
  department: [
    'customer_support',
    'dispute_resolution',
    'payments_ops',
    'merchant_operations',
    'agent_operations',
    'fraud_risk',
  ],
};

const RESPONSE_FIELDS = [
  'ticket_id',
  'relevant_transaction_id',
  'evidence_verdict',
  'case_type',
  'severity',
  'department',
  'agent_summary',
  'recommended_next_action',
  'customer_reply',
  'human_review_required',
  'confidence',
  'reason_codes',
];

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// Detects whether `text` imperatively asks the customer to share/send/provide/
// enter/verify/give/tell their credentials. Safe warnings such as "do not share
// your PIN" or "we never ask for your OTP" are NOT considered unsafe.
function asksForCredentials(text = '') {
  const lower = String(text || '').toLowerCase();

  const patterns = [
    /\b(?:please\s+|kindly\s+)?(?:share|send|provide|enter|verify|give)\s+(?:your|the|us|me)?\s*(?:pin|otp|password|passcode|cvv)\b/gi,
    /\btell\s+(?:us|me)\s+(?:your|the)?\s*(?:pin|otp|password|passcode|cvv)\b/gi,
    /\b(?:we\s+need|need|submit|confirm)\s+(?:your|the)?\s*(?:pin|otp|password|passcode|cvv)\b/gi,
    /\bask\s+for\s+(?:your|the)?\s*(?:pin|otp|password|passcode|cvv)\b/gi,
  ];

  const negationNearMatch = (index) => {
    const prefix = lower.slice(Math.max(0, index - 40), index);
    return /(do not|don't|never|not to|we never|will never)\s*$/.test(prefix);
  };

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(lower)) !== null) {
      if (!negationNearMatch(match.index)) {
        return true;
      }
    }
  }

  return false;
}

function assertShape(body) {
  for (const field of RESPONSE_FIELDS) {
    assert(field in body, `response is missing required field "${field}"`);
  }
  assert(
    body.relevant_transaction_id === null || typeof body.relevant_transaction_id === 'string',
    'relevant_transaction_id must be string or null'
  );
  assert(ENUMS.evidenceVerdict.includes(body.evidence_verdict), `invalid evidence_verdict: ${body.evidence_verdict}`);
  assert(ENUMS.caseType.includes(body.case_type), `invalid case_type: ${body.case_type}`);
  assert(ENUMS.severity.includes(body.severity), `invalid severity: ${body.severity}`);
  assert(ENUMS.department.includes(body.department), `invalid department: ${body.department}`);
  assert(typeof body.human_review_required === 'boolean', 'human_review_required must be boolean');
  assert(typeof body.confidence === 'number' && body.confidence >= 0 && body.confidence <= 1,
    `confidence must be 0..1, got ${body.confidence}`);
  assert(Array.isArray(body.reason_codes), 'reason_codes must be an array');
  assert(typeof body.agent_summary === 'string' && body.agent_summary.length > 0, 'agent_summary must be non-empty string');
  assert(typeof body.recommended_next_action === 'string' && body.recommended_next_action.length > 0,
    'recommended_next_action must be non-empty string');
  assert(typeof body.customer_reply === 'string' && body.customer_reply.length > 0,
    'customer_reply must be non-empty string');
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(path, body, expectStatus) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* may be empty */ }
  if (expectStatus != null) {
    assert(res.status === expectStatus, `expected status ${expectStatus}, got ${res.status}`);
  }
  return { status: res.status, body: json };
}

test('GET /health returns { status: ok }', async () => {
  const { status, body } = await get('/health');
  assert(status === 200, `health status ${status}`);
  assert(body && body.status === 'ok', 'health body must be {"status":"ok"}');
});

test('wrong transfer matches single transfer', async () => {
  const { status, body } = await post('/analyze-ticket', {
    ticket_id: 'SMK-1',
    complaint: 'I sent 5000 taka to the wrong number by mistake. Please reverse it.',
    language: 'en',
    channel: 'in_app_chat',
    user_type: 'customer',
    transaction_history: [
      {
        transaction_id: 'TXN-S1',
        timestamp: '2026-04-14T14:08:22Z',
        type: 'transfer',
        amount: 5000,
        counterparty: '+8801719876543',
        status: 'completed',
      },
    ],
    metadata: {},
  }, 200);
  assertShape(body);
  assert(body.case_type === 'wrong_transfer', `expected wrong_transfer, got ${body.case_type}`);
  assert(body.relevant_transaction_id === 'TXN-S1', `expected TXN-S1, got ${body.relevant_transaction_id}`);
  assert(body.evidence_verdict === 'consistent', `expected consistent, got ${body.evidence_verdict}`);
  assert(body.department === 'dispute_resolution', `expected dispute_resolution, got ${body.department}`);
  assert(body.human_review_required === true, 'human_review_required must be true');
  // Must not promise a refund.
  const lower = body.customer_reply.toLowerCase();
  assert(!lower.includes('we will refund'), 'customer_reply must not promise a refund');
  assert(!lower.includes('we reversed'), 'customer_reply must not claim a reversal');
});

test('repeated recipient -> inconsistent', async () => {
  const { body } = await post('/analyze-ticket', {
    ticket_id: 'SMK-2',
    complaint: 'I sent 5000 to the wrong number. Reverse it please.',
    language: 'en',
    channel: 'in_app_chat',
    user_type: 'customer',
    transaction_history: [
      { transaction_id: 'TXN-A', timestamp: '2026-04-10T10:00:00Z', type: 'transfer', amount: 5000, counterparty: '+8801719876543', status: 'completed' },
      { transaction_id: 'TXN-B', timestamp: '2026-04-13T10:00:00Z', type: 'transfer', amount: 5000, counterparty: '+8801719876543', status: 'completed' },
    ],
    metadata: {},
  }, 200);
  assertShape(body);
  assert(body.case_type === 'wrong_transfer', `expected wrong_transfer, got ${body.case_type}`);
  assert(body.evidence_verdict === 'inconsistent', `expected inconsistent, got ${body.evidence_verdict}`);
});

test('phishing -> fraud_risk + critical', async () => {
  const { body } = await post('/analyze-ticket', {
    ticket_id: 'SMK-3',
    complaint: 'Someone called and asked for my OTP and PIN and said my account will be blocked if I do not share.',
    language: 'en',
    channel: 'call_center',
    user_type: 'customer',
    transaction_history: [],
    metadata: {},
  }, 200);
  assertShape(body);
  assert(body.case_type === 'phishing_or_social_engineering', `got ${body.case_type}`);
  assert(body.department === 'fraud_risk', `got ${body.department}`);
  assert(body.severity === 'critical', `got ${body.severity}`);
  assert(body.human_review_required === true, 'human_review_required must be true');
  assert(!asksForCredentials(body.customer_reply), `customer_reply asks for credentials: "${body.customer_reply}"`);
});

test('failed payment -> payments_ops', async () => {
  const { body } = await post('/analyze-ticket', {
    ticket_id: 'SMK-4',
    complaint: 'My recharge failed but 200 taka was deducted from my balance.',
    language: 'en',
    channel: 'in_app_chat',
    user_type: 'customer',
    transaction_history: [
      { transaction_id: 'TXN-F1', timestamp: '2026-04-14T14:08:22Z', type: 'payment', amount: 200, counterparty: 'BILLER', status: 'failed' },
    ],
    metadata: {},
  }, 200);
  assertShape(body);
  assert(body.case_type === 'payment_failed', `got ${body.case_type}`);
  assert(body.department === 'payments_ops', `got ${body.department}`);
  assert(body.relevant_transaction_id === 'TXN-F1', `got ${body.relevant_transaction_id}`);
  const lower = body.customer_reply.toLowerCase();
  assert(!lower.includes('we will refund'), 'must not promise refund');
});

test('duplicate payment -> later txn', async () => {
  const { body } = await post('/analyze-ticket', {
    ticket_id: 'SMK-5',
    complaint: 'I was charged twice 750 taka for the same bill.',
    language: 'en',
    channel: 'in_app_chat',
    user_type: 'customer',
    transaction_history: [
      { transaction_id: 'TXN-D1', timestamp: '2026-04-14T10:00:00Z', type: 'payment', amount: 750, counterparty: 'BILLER', status: 'completed' },
      { transaction_id: 'TXN-D2', timestamp: '2026-04-14T10:00:30Z', type: 'payment', amount: 750, counterparty: 'BILLER', status: 'completed' },
    ],
    metadata: {},
  }, 200);
  assertShape(body);
  assert(body.case_type === 'duplicate_payment', `got ${body.case_type}`);
  assert(body.relevant_transaction_id === 'TXN-D2', `expected TXN-D2, got ${body.relevant_transaction_id}`);
  assert(body.department === 'payments_ops', `got ${body.department}`);
});

test('Bangla cash-in -> agent_operations', async () => {
  const { body } = await post('/analyze-ticket', {
    ticket_id: 'SMK-6',
    complaint: 'এজেন্ট ক্যাশ ইন ৩০০০ টাকা করেছে কিন্তু ব্যালেন্স আসছে না',
    language: 'bn',
    channel: 'in_app_chat',
    user_type: 'customer',
    transaction_history: [
      { transaction_id: 'TXN-C1', timestamp: '2026-04-14T11:00:00Z', type: 'cash_in', amount: 3000, counterparty: 'AGENT-77', status: 'pending' },
    ],
    metadata: {},
  }, 200);
  assertShape(body);
  assert(body.case_type === 'agent_cash_in_issue', `got ${body.case_type}`);
  assert(body.department === 'agent_operations', `got ${body.department}`);
});

test('merchant settlement -> merchant_operations', async () => {
  const { body } = await post('/analyze-ticket', {
    ticket_id: 'SMK-7',
    complaint: 'My merchant settlement for yesterday has not come yet.',
    language: 'en',
    channel: 'merchant_portal',
    user_type: 'merchant',
    transaction_history: [
      { transaction_id: 'TXN-MS1', timestamp: '2026-04-13T22:00:00Z', type: 'settlement', amount: 12000, counterparty: 'MERCHANT-001', status: 'pending' },
    ],
    metadata: {},
  }, 200);
  assertShape(body);
  assert(body.case_type === 'merchant_settlement_delay', `got ${body.case_type}`);
  assert(body.department === 'merchant_operations', `got ${body.department}`);
});

test('vague complaint -> other + customer_support', async () => {
  const { body } = await post('/analyze-ticket', {
    ticket_id: 'SMK-8',
    complaint: 'hello',
    language: 'en',
    channel: 'in_app_chat',
    user_type: 'customer',
    transaction_history: [],
    metadata: {},
  }, 200);
  assertShape(body);
  assert(body.case_type === 'other', `got ${body.case_type}`);
  assert(body.department === 'customer_support', `got ${body.department}`);
});

test('missing ticket_id -> 400', async () => {
  const { status } = await post('/analyze-ticket', {
    complaint: 'something happened',
  }, 400);
  assert(status === 400, `expected 400, got ${status}`);
});

test('empty complaint -> 422', async () => {
  const { status } = await post('/analyze-ticket', {
    ticket_id: 'SMK-9',
    complaint: '   ',
  }, 422);
  assert(status === 422, `expected 422, got ${status}`);
});

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`  PASS  ${t.name}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL  ${t.name}`);
      console.log(`        ${err.message}`);
    }
  }
  console.log('');
  console.log(`Smoke test: ${passed} passed, ${failed} failed (${tests.length} total)`);
  process.exit(failed === 0 ? 0 : 1);
})();