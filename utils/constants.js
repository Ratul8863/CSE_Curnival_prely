'use strict';

// Allowed enum values. Keep them aligned with the spec.

const ENUMS = Object.freeze({
  language: ['en', 'bn', 'mixed'],
  channel: ['in_app_chat', 'call_center', 'email', 'merchant_portal', 'field_agent'],
  userType: ['customer', 'merchant', 'agent', 'unknown'],
  transactionType: ['transfer', 'payment', 'cash_in', 'cash_out', 'settlement', 'refund'],
  transactionStatus: ['completed', 'failed', 'pending', 'reversed'],
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
});

// Keyword groups for rule detection. All lowercased; matching is case-insensitive.
const KEYWORDS = Object.freeze({
  phishing: [
    'otp', 'pin', 'password', 'passcode', 'cvv',
    'verification code', 'security code', 'one time password',
    'scam', 'fraud', 'fake support', 'fake agent', 'phishing',
    'account block', 'account blocked', 'account will be blocked',
    'suspicious call', 'suspicious message', 'share my', 'send my otp',
    'asking for pin', 'asked for pin', 'asking for otp', 'asked for otp',
    'social engineering',
  ],
  wrongTransfer: [
    'wrong number', 'wrong person', 'wrong recipient', 'wrong account',
    'sent by mistake', 'sent to wrong', 'transferred to wrong',
    'reverse transfer', 'reverse the transfer', 'reverse this',
    'not responding', 'recipient not responding', 'wrongly sent', 'accidentally sent',
  ],
  paymentFailed: [
    'payment failed', 'payment not successful', 'transaction failed',
    'recharge failed', 'recharge not successful', 'bill failed', 'bill pay failed',
    'balance deducted', 'money deducted', 'amount deducted',
    'deducted but not received', 'failed but money debited', 'failed but deducted',
  ],
  duplicatePayment: [
    'deducted twice', 'charged twice', 'paid twice', 'double charge',
    'duplicate charge', 'duplicate payment', 'two times', 'twice',
    'same payment twice',
  ],
  refund: [
    'refund', 'refund please', 'please refund', 'want my money back',
    'want refund', 'money back', 'return my money', 'cancel payment',
    'changed my mind',
  ],
  merchantSettlement: [
    'settlement', 'settle', 'not settled', 'settlement delay',
    'merchant settlement', 'sales not settled', 'payout delay', 'payout delayed',
    'merchant sales', 'settlement pending',
  ],
  agentCashIn: [
    'cash in', 'cash-in', 'cashin', 'agent cash in', 'agent did not',
    'agent not', 'agent did cash', 'balance not reflected', 'balance not updated',
    'not credited', 'agent took money', 'agent did not deposit',
  ],
});

// Severity caps by amount. Tunable.
const SEVERITY_AMOUNT = Object.freeze({
  criticalMin: 50000,
  highMin: 5000,
  mediumMin: 1000,
});

const DEFAULT_LANGUAGE = 'en';

module.exports = {
  ENUMS,
  KEYWORDS,
  SEVERITY_AMOUNT,
  DEFAULT_LANGUAGE,
};
