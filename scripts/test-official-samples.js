#!/usr/bin/env node
/* eslint-disable no-console */
// Official sample-case test runner.
// Reads docs/SUST_Preli_Sample_Cases.json, POSTs each input to /analyze-ticket,
// and compares the response against the documented expected_output.

'use strict';

const fs = require('fs');
const path = require('path');

const BASE = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:8000';
const SAMPLES_PATH = path.join(__dirname, '..', 'docs', 'SUST_Preli_Sample_Cases.json');

const REQUIRED_FIELDS = [
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

const ENUMS = {
  evidence_verdict: ['consistent', 'inconsistent', 'insufficient_data'],
  case_type: [
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

// Adjacent severity tiers. Adjacent => warn, skip-past => hard fail.
const SEVERITY_TIERS = ['low', 'medium', 'high', 'critical'];
const SEVERITY_DIFF_WARN = 1;

// Phrases that imply a hard promise. Only flag when present as an imperative
// or definitive statement — safe hedging language is allowed.
const PROMISE_PATTERNS = [
  /\bwe\s+(?:will\s+)?refund(?:\s+you)?\b/i,
  /\bwe\s+will\s+reverse\b/i,
  /\bwe\s+have\s+refunded\b/i,
  /\bwe\s+have\s+reversed\b/i,
  /\bwe\s+unblocked?\s+your\s+account\b/i,
  /\bwe\s+guarantee\s+(?:a\s+)?refund\b/i,
  /\bguaranteed\s+(?:refund|recovery|return)\b/i,
  /\bwe\s+will\s+(?:fully\s+)?return\s+(?:your|the)\s+money\b/i,
];

// Detects whether `text` imperatively asks the customer to share/send/provide/
// enter/verify/give/tell their credentials. Safe warnings such as "do not share
// your PIN" or "we never ask for your OTP" are NOT considered unsafe.
function asksForCredentials(text = '') {
  const lower = String(text || '').toLowerCase();

  const patterns = [
    /\b(?:please\s+|kindly\s+)?(?:share|send|provide|enter|verify|give)\s+(?:your|the|us|me)?\s*(?:pin|otp|password|passcode|cvv|card\s*number)\b/gi,
    /\btell\s+(?:us|me)\s+(?:your|the)?\s*(?:pin|otp|password|passcode|cvv|card\s*number)\b/gi,
    /\b(?:we\s+need|need|submit|confirm)\s+(?:your|the)?\s*(?:pin|otp|password|passcode|cvv|card\s*number)\b/gi,
    /\bask\s+for\s+(?:your|the)?\s*(?:pin|otp|password|passcode|cvv|card\s*number)\b/gi,
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

function promisesHard(text = '') {
  const lower = String(text || '').toLowerCase();
  return PROMISE_PATTERNS.some((re) => re.test(lower));
}

function hardFails(notes) { return notes.filter((n) => n.level === 'fail'); }

function compareCase(actual, expected) {
  const notes = [];

  // Schema presence.
  for (const f of REQUIRED_FIELDS) {
    if (!(f in actual)) notes.push({ level: 'fail', msg: `missing required field "${f}"` });
  }

  // Enum validity.
  if (actual.evidence_verdict && !ENUMS.evidence_verdict.includes(actual.evidence_verdict)) {
    notes.push({ level: 'fail', msg: `invalid evidence_verdict "${actual.evidence_verdict}"` });
  }
  if (actual.case_type && !ENUMS.case_type.includes(actual.case_type)) {
    notes.push({ level: 'fail', msg: `invalid case_type "${actual.case_type}"` });
  }
  if (actual.severity && !ENUMS.severity.includes(actual.severity)) {
    notes.push({ level: 'fail', msg: `invalid severity "${actual.severity}"` });
  }
  if (actual.department && !ENUMS.department.includes(actual.department)) {
    notes.push({ level: 'fail', msg: `invalid department "${actual.department}"` });
  }

  // Hard-comparison fields.
  if ('relevant_transaction_id' in expected) {
    if (actual.relevant_transaction_id !== expected.relevant_transaction_id) {
      notes.push({
        level: 'fail',
        msg: `relevant_transaction_id: expected "${expected.relevant_transaction_id}", got "${actual.relevant_transaction_id}"`,
      });
    }
  }
  if ('evidence_verdict' in expected) {
    if (actual.evidence_verdict !== expected.evidence_verdict) {
      notes.push({
        level: 'fail',
        msg: `evidence_verdict: expected "${expected.evidence_verdict}", got "${actual.evidence_verdict}"`,
      });
    }
  }
  if ('case_type' in expected) {
    if (actual.case_type !== expected.case_type) {
      notes.push({
        level: 'fail',
        msg: `case_type: expected "${expected.case_type}", got "${actual.case_type}"`,
      });
    }
  }
  if ('department' in expected) {
    if (actual.department !== expected.department) {
      notes.push({
        level: 'fail',
        msg: `department: expected "${expected.department}", got "${actual.department}"`,
      });
    }
  }

  // Severity: warn if tier differs by more than 1; hard-fail if very off.
  if ('severity' in expected && actual.severity) {
    const a = SEVERITY_TIERS.indexOf(actual.severity);
    const e = SEVERITY_TIERS.indexOf(expected.severity);
    if (a !== -1 && e !== -1) {
      const diff = Math.abs(a - e);
      if (diff === 0) {
        // exact match, no note
      } else if (diff <= SEVERITY_DIFF_WARN) {
        notes.push({
          level: 'warn',
          msg: `severity differs slightly: expected "${expected.severity}", got "${actual.severity}"`,
        });
      } else {
        notes.push({
          level: 'fail',
          msg: `severity off by ${diff} tiers: expected "${expected.severity}", got "${actual.severity}"`,
        });
      }
    }
  }

  // Safety: customer_reply must not ask for credentials, must not hard-promise refund/reversal.
  if (typeof actual.customer_reply === 'string') {
    if (asksForCredentials(actual.customer_reply)) {
      notes.push({
        level: 'fail',
        msg: `customer_reply asks for credentials: "${actual.customer_reply}"`,
      });
    }
    if (promisesHard(actual.customer_reply)) {
      notes.push({
        level: 'fail',
        msg: `customer_reply hard-promises refund/reversal/recovery: "${actual.customer_reply}"`,
      });
    }
  } else {
    notes.push({ level: 'fail', msg: 'customer_reply missing or not a string' });
  }

  return notes;
}

async function postCase(input) {
  const res = await fetch(`${BASE}/analyze-ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* tolerate empty body */ }
  return { status: res.status, body: json };
}

(async () => {
  let raw;
  try {
    raw = fs.readFileSync(SAMPLES_PATH, 'utf8');
  } catch (err) {
    console.error(`ERROR: cannot read ${SAMPLES_PATH}: ${err.message}`);
    process.exit(2);
  }

  let samples;
  try {
    samples = JSON.parse(raw);
  } catch (err) {
    console.error(`ERROR: invalid JSON in ${SAMPLES_PATH}: ${err.message}`);
    process.exit(2);
  }

  const cases = Array.isArray(samples.cases) ? samples.cases : [];
  if (cases.length === 0) {
    console.error('ERROR: no cases found in sample pack');
    process.exit(2);
  }

  console.log(`Loaded ${cases.length} official sample case(s) from ${path.basename(SAMPLES_PATH)}`);
  console.log(`Base URL: ${BASE}`);
  console.log('');

  let passed = 0;
  let warned = 0;
  let failed = 0;

  for (const c of cases) {
    const id = c.id || '?';
    const label = c.label || '';
    let notes = [];

    try {
      const { status, body } = await postCase(c.input);
      if (status !== 200) {
        notes.push({ level: 'fail', msg: `HTTP status ${status} (expected 200)` });
        console.log(`  FAIL  ${id}  ${label}`);
        if (body) console.log(`        body: ${JSON.stringify(body).slice(0, 300)}`);
        failed += 1;
        continue;
      }
      if (!body || typeof body !== 'object') {
        notes.push({ level: 'fail', msg: 'empty / non-object response body' });
        console.log(`  FAIL  ${id}  ${label}`);
        failed += 1;
        continue;
      }

      notes = compareCase(body, c.expected_output || {});
    } catch (err) {
      notes = [{ level: 'fail', msg: `request error: ${err.message}` }];
    }

    const hard = hardFails(notes);
    if (hard.length === 0) {
      passed += 1;
      console.log(`  PASS  ${id}  ${label}`);
    } else {
      failed += 1;
      console.log(`  FAIL  ${id}  ${label}`);
      for (const n of hard) console.log(`        - ${n.msg}`);
    }
    for (const n of notes.filter((x) => x.level === 'warn')) {
      warned += 1;
      console.log(`        ~ warn: ${n.msg}`);
    }
  }

  console.log('');
  console.log(`Official samples: ${passed} passed, ${failed} failed, ${warned} warning(s) (${cases.length} total)`);
  process.exit(failed === 0 ? 0 : 1);
})();