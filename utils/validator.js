'use strict';

const { ENUMS } = require('./constants');

// Whitelist of allowed fields per object type. Anything else is stripped.

const REQUEST_FIELDS = [
  'ticket_id',
  'complaint',
  'language',
  'channel',
  'user_type',
  'campaign_context',
  'transaction_history',
  'metadata',
];

const TXN_FIELDS = [
  'transaction_id',
  'timestamp',
  'type',
  'amount',
  'counterparty',
  'status',
];

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

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clampEnum(value, allowed, fallback) {
  if (value === null || value === undefined) return fallback;
  return allowed.includes(value) ? value : fallback;
}

function toBoolean(v) {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return false;
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampConfidence(v) {
  const n = toNumber(v, 0);
  if (n < 0) return 0;
  if (n > 1) return 1;
  return Math.round(n * 100) / 100;
}

function cleanString(v, maxLen = 1000) {
  if (typeof v !== 'string') return '';
  const trimmed = v.trim();
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

function cleanReasonCodes(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const code = item.trim().slice(0, 64);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
    if (out.length >= 32) break;
  }
  return out;
}

function cleanTransactionHistory(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input) {
    if (!isPlainObject(raw)) continue;
    const txn = {};
    for (const key of TXN_FIELDS) {
      if (key in raw) txn[key] = raw[key];
    }
    if (typeof txn.transaction_id !== 'string' || !txn.transaction_id.trim()) {
      continue;
    }
    txn.transaction_id = txn.transaction_id.trim().slice(0, 128);
    if (typeof txn.type === 'string') {
      txn.type = ENUMS.transactionType.includes(txn.type) ? txn.type : null;
    } else {
      txn.type = null;
    }
    if (typeof txn.status === 'string') {
      txn.status = ENUMS.transactionStatus.includes(txn.status) ? txn.status : null;
    } else {
      txn.status = null;
    }
    if (typeof txn.counterparty === 'string') {
      txn.counterparty = txn.counterparty.trim().slice(0, 64);
    } else {
      txn.counterparty = null;
    }
    txn.amount = toNumber(txn.amount, NaN);
    if (!Number.isFinite(txn.amount)) txn.amount = null;
    if (typeof txn.timestamp === 'string') {
      txn.timestamp = txn.timestamp.trim().slice(0, 64);
    } else {
      txn.timestamp = null;
    }
    out.push(txn);
    if (out.length >= 50) break;
  }
  return out;
}

function cleanRequest(raw) {
  if (!isPlainObject(raw)) return { ok: false, error: 'Request body must be a JSON object.' };
  const req = {};
  for (const key of REQUEST_FIELDS) {
    if (key in raw) req[key] = raw[key];
  }

  const errors = [];
  const ticketId = cleanString(req.ticket_id, 128);
  if (!ticketId) errors.push('ticket_id is required.');

  const complaintRaw = typeof req.complaint === 'string' ? req.complaint : '';
  if (typeof req.complaint !== 'string') {
    errors.push('complaint is required.');
  }

  req.ticket_id = ticketId;
  req.complaint = complaintRaw;
  req.language = clampEnum(req.language, ENUMS.language, null);
  req.channel = clampEnum(req.channel, ENUMS.channel, null);
  req.user_type = clampEnum(req.user_type, ENUMS.userType, 'unknown');
  req.campaign_context = typeof req.campaign_context === 'string'
    ? req.campaign_context.trim().slice(0, 128) : null;
  req.transaction_history = cleanTransactionHistory(req.transaction_history);
  req.metadata = isPlainObject(req.metadata) ? req.metadata : {};

  if (errors.length > 0) {
    return { ok: false, error: errors.join(' ') };
  }
  return { ok: true, value: req };
}

// Final validator + fixer for outgoing responses.
function validateAndFixResponse(resp) {
  if (!isPlainObject(resp)) {
    throw new Error('Response must be an object.');
  }
  const fixed = {};
  for (const key of RESPONSE_FIELDS) {
    if (key in resp) fixed[key] = resp[key];
  }

  fixed.ticket_id = cleanString(fixed.ticket_id, 128);
  fixed.relevant_transaction_id = typeof fixed.relevant_transaction_id === 'string'
    ? fixed.relevant_transaction_id.trim().slice(0, 128) : null;
  fixed.evidence_verdict = clampEnum(fixed.evidence_verdict, ENUMS.evidenceVerdict, 'insufficient_data');
  fixed.case_type = clampEnum(fixed.case_type, ENUMS.caseType, 'other');
  fixed.severity = clampEnum(fixed.severity, ENUMS.severity, 'low');
  fixed.department = clampEnum(fixed.department, ENUMS.department, 'customer_support');
  fixed.agent_summary = cleanString(fixed.agent_summary, 800) || 'Case received and queued for review.';
  fixed.recommended_next_action = cleanString(fixed.recommended_next_action, 400) || 'Assign to support queue.';
  fixed.customer_reply = cleanString(fixed.customer_reply, 1500) || 'We have received your case and our team will review it.';
  fixed.human_review_required = !!toBoolean(fixed.human_review_required);
  fixed.confidence = clampConfidence(fixed.confidence);
  fixed.reason_codes = cleanReasonCodes(fixed.reason_codes);

  return fixed;
}

module.exports = {
  REQUEST_FIELDS,
  RESPONSE_FIELDS,
  isPlainObject,
  clampEnum,
  toBoolean,
  toNumber,
  clampConfidence,
  cleanString,
  cleanReasonCodes,
  cleanRequest,
  validateAndFixResponse,
};
