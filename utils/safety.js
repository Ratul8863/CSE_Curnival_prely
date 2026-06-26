'use strict';

// Safety sanitizer for outgoing responses, especially customer_reply.

const FORBIDDEN_PHRASES = [
  'we will refund',
  'we will return your money',
  'we will reverse',
  'we reversed',
  'refund confirmed',
  'refund approved',
  'your money will be returned',
  'we will unblock',
  'account unblocked',
  'we will credit your account',
  'guaranteed refund',
];

const SENSITIVE_REQUEST_PATTERNS = [
  /\bshare\s+(?:your|the|my)?\s*(?:pin|otp|password|passcode|cvv|card\s*number|card\s*details)\b/i,
  /\b(?:send|provide|enter|type|verify)\s+(?:your|the|my)?\s*(?:pin|otp|password|passcode|cvv)\b/i,
  /\b(?:give|tell)\s+me\s+(?:your|the)?\s*(?:pin|otp|password|passcode)\b/i,
];

const SUSPICIOUS_THIRD_PARTY = [
  /\bcall\s+(?:this\s+)?(?:\+?88)?01[3-9]\d{8}\b/i,
  /\bcontact\s+(?:this\s+)?(?:\+?88)?01[3-9]\d{8}\b/i,
  /\bcall\s+\+?\d{10,}\b/i,
];

const SAFE_PIN_WARNING_EN = 'Please do not share your PIN or OTP with anyone.';
const SAFE_PIN_WARNING_BN = 'অনুগ্রহ করে কারো সাথে আপনার পিন বা ওটিপি শেয়ার করবেন না।';

// Safe replacements for risky promises.
function neutralizeRefundLanguage(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  const replacements = [
    [/\bwe\s+will\s+refund\s+you\b/gi, 'any eligible amount will be returned through official channels'],
    [/\bwe\s+will\s+return\s+your\s+money\b/gi, 'any eligible amount will be returned through official channels'],
    [/\bwe\s+will\s+reverse\s+(?:the|this)?\s*(?:payment|transfer|transaction)\b/gi, 'our team will review the case for any eligible reversal through official channels'],
    [/\bwe\s+reversed\s+(?:the|this)?\s*(?:payment|transfer|transaction)\b/gi, 'our team will review the case for any eligible reversal through official channels'],
    [/\brefund\s+confirmed\b/gi, 'refund status will be confirmed by our team after review'],
    [/\brefund\s+approved\b/gi, 'refund status will be confirmed by our team after review'],
    [/\byour\s+money\s+will\s+be\s+returned\b/gi, 'any eligible amount will be returned through official channels'],
    [/\bguaranteed\s+refund\b/gi, 'a refund review through official channels'],
    [/\bwe\s+will\s+unblock\s+your\s+account\b/gi, 'our team will review any account access through official channels'],
    [/\baccount\s+unblocked\b/gi, 'account access will be reviewed through official channels'],
    [/\bwe\s+will\s+credit\s+your\s+account\b/gi, 'any eligible credit will be processed through official channels'],
  ];
  for (const [pattern, replacement] of replacements) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function stripSensitiveAsk(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  // Only rewrite if the sentence is clearly addressing the customer (imperative).
  // Descriptive narration about what a third party did is left intact.
  const safePatterns = [
    /\byou\s+should\s+(?:share|send|provide|enter|verify|give|tell)\s+(?:your|the)?\s*(?:pin|otp|password|passcode|cvv)\b[^.!?\n]*/gi,
    /\bplease\s+(?:share|send|provide|enter|verify|give|tell)\s+(?:your|the)?\s*(?:pin|otp|password|passcode|cvv)\b[^.!?\n]*/gi,
    /\bkindly\s+(?:share|send|provide|enter|verify|give|tell)\s+(?:your|the)?\s*(?:pin|otp|password|passcode|cvv)\b[^.!?\n]*/gi,
  ];
  for (const pat of safePatterns) {
    out = out.replace(pat, 'please do not share sensitive credentials with anyone');
  }
  return out;
}

function stripSuspiciousThirdParty(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const pat of SUSPICIOUS_THIRD_PARTY) {
    out = out.replace(pat, 'contact official support channels only');
  }
  return out;
}

function containsForbidden(text) {
  if (typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return FORBIDDEN_PHRASES.some((p) => lower.includes(p));
}

// Ensure a safe PIN/OTP warning is present in customer-facing text.
// Always appends the language-appropriate reminder if a safe warning is not
// already present. This guarantees every customer_reply carries the guardrail,
// regardless of whether the topic explicitly mentions credentials.
function ensureSafeWarning(text, opts = {}) {
  if (typeof text !== 'string' || !text) return text;
  const lang = opts.language === 'bn' ? 'bn' : 'en';
  const warning = lang === 'bn' ? SAFE_PIN_WARNING_BN : SAFE_PIN_WARNING_EN;
  const lower = text.toLowerCase();
  const alreadyHasWarning =
    lower.includes('do not share your pin') ||
    lower.includes('do not share your otp') ||
    text.includes('শেয়ার করবেন না');
  if (alreadyHasWarning) return text;
  return `${text} ${warning}`;
}

// Final sanitizer for the whole response.
function sanitizeResponse(resp, opts = {}) {
  if (!resp || typeof resp !== 'object') return resp;
  const language = opts.language || 'en';

  // Refund-promise neutralization is safe across all fields.
  const refundFields = ['customer_reply', 'agent_summary', 'recommended_next_action'];
  for (const f of refundFields) {
    if (typeof resp[f] === 'string') {
      resp[f] = neutralizeRefundLanguage(resp[f]);
    }
  }

  // The remaining sanitizers are customer-facing only. We intentionally do NOT
  // rewrite internal agent summaries because they describe the incident in
  // third person (e.g. "asked for my OTP"), which is descriptive and safe.
  if (typeof resp.customer_reply === 'string') {
    let v = resp.customer_reply;
    v = stripSensitiveAsk(v);
    v = stripSuspiciousThirdParty(v);
    v = ensureSafeWarning(v, { language });
    resp.customer_reply = v;
  }

  return resp;
}

module.exports = {
  FORBIDDEN_PHRASES,
  SAFE_PIN_WARNING_EN,
  SAFE_PIN_WARNING_BN,
  containsForbidden,
  neutralizeRefundLanguage,
  stripSensitiveAsk,
  stripSuspiciousThirdParty,
  ensureSafeWarning,
  sanitizeResponse,
};
