'use strict';

const { ENUMS, DEFAULT_LANGUAGE } = require('./constants');

// Build a safe default response scaffold. Rule analyzer fills in fields.
function buildDefaultResponse(ticketId) {
  return {
    ticket_id: ticketId,
    relevant_transaction_id: null,
    evidence_verdict: 'insufficient_data',
    case_type: 'other',
    severity: 'low',
    department: 'customer_support',
    agent_summary: 'Case received and queued for review.',
    recommended_next_action: 'Assign to support queue for triage.',
    customer_reply: 'We have received your case and our team will review it shortly.',
    human_review_required: false,
    confidence: 0.4,
    reason_codes: ['fallback_default'],
  };
}

module.exports = {
  buildDefaultResponse,
  DEFAULT_LANGUAGE,
  ENUMS,
};
