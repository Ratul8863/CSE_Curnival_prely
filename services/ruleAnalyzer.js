'use strict';

// Deterministic rule-based analyzer. No network, no AI.
// Returns a partial response that responseFactory/validator will normalize.

const { KEYWORDS, SEVERITY_AMOUNT, ENUMS } = require('../utils/constants');
const { cleanString, toBoolean, toNumber, isPlainObject } = require('../utils/validator');

const BANGLA_DIGITS = { '০': 0, '১': 1, '২': 2, '৩': 3, '৪': 4, '৫': 5, '৬': 6, '৭': 7, '৮': 8, '৯': 9 };

function normalizeText(text) {
  if (typeof text !== 'string') return '';
  let s = text.toLowerCase();
  // Convert Bangla digits to ascii digits.
  s = s.replace(/[০-৯]/g, (d) => BANGLA_DIGITS[d]);
  // Common Bangla synonyms for the keyword groups. We replace with the
  // English keyword so the existing keyword lists can do the matching.
  const bnSynonyms = [
    [/টাকা|ট্াকা/g, 'taka'],
    [/ভুল\s*নম্বরে|ভুল\s*নাম্বারে|ভুল\s*ব্যক্তি/g, 'wrong number'],
    [/ভুল\s*মানুষ|ভুল\s*প্রাপক/g, 'wrong person'],
    [/ভুলে\s*পাঠিয়ে|ভুলে\s*পাঠাইছি|ভুলে\s*পাঠাইছিলাম/g, 'sent by mistake'],
    [/প্রাপক\s*রিসিভ\s*করছে\s*না|প্রাপক\s*পাচ্ছে\s*না|প্রাপক\s*প্রতিক্রিয়া\s*হচ্ছে\s*না|প্রাপক\s*সাড়া\s*দিচ্ছে\s*না/g, 'recipient not responding'],
    [/পেমেন্ট\s*ব্যর্থ|পেমেন্ট\s*ব্যার্থ|পেমেন্ট\s*ফেইল/g, 'payment failed'],
    [/ব্যালেন্স\s*কেটে\s*নেওয়া\s*হয়েছে|ব্যালেন্স\s*কাটা\s*হয়েছে|টাকা\s*কেটে\s*নিয়েছে|টাকা\s*কাটা\s*হয়েছে/g, 'balance deducted'],
    [/দুইবার\s*কেটে|দুইবার\s*কাটা|দুবার\s*কেটে|দুবার\s*কাটা/g, 'charged twice'],
    [/একই\s*পেমেন্ট\s*দুইবার|একই\s*পেমেন্ট\s*দুবার/g, 'paid twice'],
    [/রিফান্ড|ফেরত\s*দিন|ফেরত\s*চাই|টাকা\s*ফেরত/g, 'refund'],
    [/সেটেলমেন্ট|মারচেন্ট\s*সেটেলমেন্ট/g, 'settlement'],
    [/সেটেল\s*হয়নি|সেটেল\s*হয়\s*নি|সেটেলমেন্ট\s*হয়নি/g, 'not settled'],
    [/ক্যাশ\s*ইন|cash\s*in|cashin/g, 'cash in'],
    [/এজেন্ট/g, 'agent'],
    [/ব্যালেন্স\s*আসেনি|ব্যালেন্স\s*আসছে\s*না|ব্যালেন্স\s*দেখাচ্ছে\s*না/g, 'balance not reflected'],
    [/ওটিপি|ও\.টি\.পি/g, 'otp'],
    [/পিন|পি\.ইন/g, 'pin'],
    [/পাসওয়ার্ড/g, 'password'],
    [/স্ক্যাম|প্রতারণা|প্রতারক/g, 'scam'],
    [/ফ্রড|জালিয়াতি/g, 'fraud'],
    [/অ্যাকাউন্ট\s*ব্লক|অ্যাকাউন্ট\s*বন্ধ|অ্যাকাউন্ট\s*ব্লক\s*হবে/g, 'account block'],
  ];
  for (const [pattern, replacement] of bnSynonyms) {
    s = s.replace(pattern, replacement);
  }
  return s;
}

function hasAny(text, list) {
  if (!text) return false;
  for (const kw of list) {
    if (text.includes(kw)) return true;
  }
  return false;
}

function countMatches(text, list) {
  if (!text) return 0;
  let n = 0;
  for (const kw of list) {
    if (!kw) continue;
    let idx = text.indexOf(kw);
    while (idx !== -1) {
      n += 1;
      idx = text.indexOf(kw, idx + kw.length);
      if (n > 50) return n;
    }
  }
  return n;
}

function parseAmount(text) {
  if (!text) return null;
  const match = text.match(/\b(\d{2,9}(?:[.,]\d+)?)\b/);
  if (!match) return null;
  const raw = match[1].replace(/,/g, '');
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseCounterpartyHint(text) {
  if (!text) return null;
  // Match +880... or 01... patterns or @handles.
  const phone = text.match(/(?:\+?88)?01[3-9]\d{8}/);
  if (phone) return phone[0];
  const handle = text.match(/@[a-z0-9._-]{3,}/);
  if (handle) return handle[0];
  return null;
}

function txIs(txn, type, statuses = null) {
  if (!txn || txn.type !== type) return false;
  if (!statuses) return true;
  return statuses.includes(txn.status);
}

function findTxnByFields(history, predicate) {
  const matches = [];
  for (const t of history) {
    if (predicate(t)) matches.push(t);
  }
  return matches;
}

function highestAmount(history) {
  let best = 0;
  for (const t of history) {
    const a = Number(t.amount);
    if (Number.isFinite(a) && a > best) best = a;
  }
  return best;
}

function detectLanguage(req) {
  if (req.language === 'bn' || req.language === 'mixed') {
    // Mixed and explicit bn treated as Bangla-capable.
    if (req.language === 'bn') return 'bn';
    if (/[\u0980-\u09FF]/.test(req.complaint || '')) return 'bn';
  }
  if (/[\u0980-\u09FF]/.test(req.complaint || '')) return 'bn';
  return 'en';
}

// Decide severity based on case_type and amount.
function pickSeverity(caseType, amount, isPhishing) {
  if (isPhishing) return 'critical';
  if (amount >= SEVERITY_AMOUNT.criticalMin) return 'critical';
  if (caseType === 'wrong_transfer' || caseType === 'duplicate_payment' || caseType === 'agent_cash_in_issue') {
    if (amount >= SEVERITY_AMOUNT.highMin) return 'high';
    return 'high';
  }
  if (caseType === 'payment_failed') {
    return amount >= SEVERITY_AMOUNT.highMin ? 'high' : 'medium';
  }
  if (caseType === 'merchant_settlement_delay') {
    return amount >= SEVERITY_AMOUNT.mediumMin ? 'medium' : 'low';
  }
  if (caseType === 'refund_request') {
    if (amount >= SEVERITY_AMOUNT.highMin) return 'high';
    if (amount >= SEVERITY_AMOUNT.mediumMin) return 'medium';
    return 'low';
  }
  if (caseType === 'other') {
    if (amount >= SEVERITY_AMOUNT.mediumMin) return 'medium';
    return 'low';
  }
  return 'medium';
}

function defaultDepartment(caseType) {
  switch (caseType) {
    case 'phishing_or_social_engineering': return 'fraud_risk';
    case 'wrong_transfer': return 'dispute_resolution';
    case 'duplicate_payment': return 'payments_ops';
    case 'payment_failed': return 'payments_ops';
    case 'merchant_settlement_delay': return 'merchant_operations';
    case 'agent_cash_in_issue': return 'agent_operations';
    case 'refund_request': return 'customer_support';
    default: return 'customer_support';
  }
}

function humanReviewFor(caseType, severity, evidenceVerdict, amount) {
  const sev = severity;
  if (caseType === 'phishing_or_social_engineering') return true;
  if (caseType === 'wrong_transfer') return true;
  if (caseType === 'duplicate_payment') return true;
  if (caseType === 'agent_cash_in_issue') return true;
  if (evidenceVerdict === 'inconsistent') return true;
  if (sev === 'critical' || sev === 'high') return true;
  if (evidenceVerdict === 'insufficient_data' && (caseType === 'wrong_transfer' || caseType === 'duplicate_payment')) return true;
  if (Number.isFinite(amount) && amount >= SEVERITY_AMOUNT.highMin) return true;
  return false;
}

function pickCaseType(text, req, signals) {
  // Phishing is the highest priority signal.
  if (signals.phishingHits > 0) return 'phishing_or_social_engineering';
  if (signals.duplicateHits > 0) return 'duplicate_payment';
  if (signals.wrongTransferHits > 0) return 'wrong_transfer';
  if (signals.agentCashInHits > 0) return 'agent_cash_in_issue';
  if (signals.paymentFailedHits > 0) return 'payment_failed';
  if (signals.merchantSettlementHits > 0) return 'merchant_settlement_delay';
  if (signals.refundHits > 0) return 'refund_request';
  // Heuristic: merchant channel or user_type without clear keywords => settlement-like.
  if (req.user_type === 'merchant' || req.channel === 'merchant_portal') return 'merchant_settlement_delay';
  return 'other';
}

function detectSignals(text) {
  return {
    phishingHits: countMatches(text, KEYWORDS.phishing),
    wrongTransferHits: countMatches(text, KEYWORDS.wrongTransfer),
    paymentFailedHits: countMatches(text, KEYWORDS.paymentFailed),
    duplicateHits: countMatches(text, KEYWORDS.duplicatePayment),
    refundHits: countMatches(text, KEYWORDS.refund),
    merchantSettlementHits: countMatches(text, KEYWORDS.merchantSettlement),
    agentCashInHits: countMatches(text, KEYWORDS.agentCashIn),
  };
}

function matchRelevantTransaction(caseType, req, signals) {
  const history = req.transaction_history || [];
  if (history.length === 0) return { txnId: null, verdict: 'insufficient_data', extraReason: null };

  const counterpartyHint = parseCounterpartyHint(req.complaint);
  const amountHint = parseAmount(req.complaint);

  switch (caseType) {
    case 'phishing_or_social_engineering':
      return { txnId: null, verdict: 'insufficient_data', extraReason: 'phishing_evidence_unverified' };
    case 'wrong_transfer': {
      let candidates = findTxnByFields(history, (t) => txIs(t, 'transfer'));
      if (amountHint != null) {
        const byAmt = candidates.filter((t) => Number(t.amount) === amountHint);
        if (byAmt.length === 1) return { txnId: byAmt[0].transaction_id, verdict: 'consistent', extraReason: 'transfer_amount_match' };
        if (byAmt.length > 1) {
          const distinctCounterparties = new Set(byAmt.map((t) => t.counterparty).filter(Boolean));
          if (distinctCounterparties.size === 1) {
            return { txnId: byAmt[0].transaction_id, verdict: 'inconsistent', extraReason: 'repeated_recipient_pattern' };
          }
          return { txnId: null, verdict: 'insufficient_data', extraReason: 'multiple_transfer_matches' };
        }
      }
      if (counterpartyHint) {
        const byCp = candidates.filter((t) => t.counterparty && t.counterparty.includes(counterpartyHint));
        if (byCp.length === 1) return { txnId: byCp[0].transaction_id, verdict: 'consistent', extraReason: 'transfer_counterparty_match' };
        if (byCp.length > 1) {
          return { txnId: byCp[0].transaction_id, verdict: 'inconsistent', extraReason: 'repeated_recipient_pattern' };
        }
      }
      if (candidates.length === 1) return { txnId: candidates[0].transaction_id, verdict: 'consistent', extraReason: 'single_transfer_present' };
      if (candidates.length > 1) return { txnId: null, verdict: 'insufficient_data', extraReason: 'multiple_transfer_candidates' };
      return { txnId: null, verdict: 'insufficient_data', extraReason: 'no_transfer_history' };
    }
    case 'payment_failed': {
      const candidates = findTxnByFields(history, (t) => txIs(t, 'payment', ['failed', 'pending']));
      let filtered = candidates;
      if (amountHint != null) {
        const byAmt = candidates.filter((t) => Number(t.amount) === amountHint);
        if (byAmt.length >= 1) filtered = byAmt;
      }
      if (filtered.length === 1) return { txnId: filtered[0].transaction_id, verdict: 'consistent', extraReason: 'failed_payment_match' };
      if (filtered.length > 1) return { txnId: filtered[0].transaction_id, verdict: 'consistent', extraReason: 'failed_payment_first_match' };
      const anyFailed = findTxnByFields(history, (t) => t.status === 'failed');
      if (anyFailed.length === 1) return { txnId: anyFailed[0].transaction_id, verdict: 'consistent', extraReason: 'single_failed_txn' };
      if (anyFailed.length > 1) return { txnId: null, verdict: 'insufficient_data', extraReason: 'multiple_failed_txn' };
      return { txnId: null, verdict: 'insufficient_data', extraReason: 'no_failed_txn' };
    }
    case 'duplicate_payment': {
      const payments = findTxnByFields(history, (t) => txIs(t, 'payment'));
      let dupes = payments;
      if (amountHint != null) dupes = payments.filter((t) => Number(t.amount) === amountHint);
      // Sort by timestamp ascending when available so we can pick the latest.
      const sorted = dupes.slice().sort((a, b) => {
        const ta = Date.parse(a.timestamp || '') || 0;
        const tb = Date.parse(b.timestamp || '') || 0;
        return ta - tb;
      });
      const byAmtCount = new Map();
      for (const t of sorted) {
        const key = `${t.type}:${t.amount}:${t.counterparty || ''}`;
        byAmtCount.set(key, (byAmtCount.get(key) || 0) + 1);
      }
      // Find any duplicate key group and return the latest member of that group.
      const duplicateKeys = new Set();
      for (const [key, count] of byAmtCount.entries()) {
        if (count >= 2) duplicateKeys.add(key);
      }
      if (duplicateKeys.size > 0) {
        for (let i = sorted.length - 1; i >= 0; i -= 1) {
          const t = sorted[i];
          const key = `${t.type}:${t.amount}:${t.counterparty || ''}`;
          if (duplicateKeys.has(key)) {
            return { txnId: t.transaction_id, verdict: 'consistent', extraReason: 'duplicate_pair_detected' };
          }
        }
      }
      if (sorted.length >= 2) return { txnId: sorted[sorted.length - 1].transaction_id, verdict: 'consistent', extraReason: 'suspected_duplicate_latest' };
      return { txnId: null, verdict: 'insufficient_data', extraReason: 'no_duplicate_pair' };
    }
    case 'refund_request': {
      const payments = findTxnByFields(history, (t) => txIs(t, 'payment', ['completed']));
      let filtered = payments;
      if (amountHint != null) filtered = payments.filter((t) => Number(t.amount) === amountHint);
      if (filtered.length === 1) return { txnId: filtered[0].transaction_id, verdict: 'consistent', extraReason: 'refund_completed_payment' };
      if (filtered.length > 1) return { txnId: filtered[0].transaction_id, verdict: 'consistent', extraReason: 'refund_first_completed_payment' };
      if (payments.length === 0) return { txnId: null, verdict: 'insufficient_data', extraReason: 'no_completed_payment' };
      return { txnId: null, verdict: 'insufficient_data', extraReason: 'ambiguous_refund_target' };
    }
    case 'merchant_settlement_delay': {
      const settlements = findTxnByFields(history, (t) => txIs(t, 'settlement'));
      let filtered = settlements;
      if (amountHint != null) filtered = settlements.filter((t) => Number(t.amount) === amountHint);
      const pending = filtered.filter((t) => t.status === 'pending');
      if (pending.length >= 1) return { txnId: pending[0].transaction_id, verdict: 'consistent', extraReason: 'settlement_pending' };
      if (filtered.length === 1) return { txnId: filtered[0].transaction_id, verdict: 'consistent', extraReason: 'settlement_match' };
      if (settlements.length > 1) return { txnId: settlements[0].transaction_id, verdict: 'consistent', extraReason: 'settlement_first_match' };
      return { txnId: null, verdict: 'insufficient_data', extraReason: 'no_settlement_record' };
    }
    case 'agent_cash_in_issue': {
      const cashins = findTxnByFields(history, (t) => txIs(t, 'cash_in'));
      let filtered = cashins;
      if (amountHint != null) filtered = cashins.filter((t) => Number(t.amount) === amountHint);
      const pending = filtered.filter((t) => t.status === 'pending');
      if (pending.length >= 1) return { txnId: pending[0].transaction_id, verdict: 'consistent', extraReason: 'cash_in_pending' };
      if (filtered.length === 1) return { txnId: filtered[0].transaction_id, verdict: 'consistent', extraReason: 'cash_in_match' };
      if (cashins.length > 0) return { txnId: cashins[0].transaction_id, verdict: 'consistent', extraReason: 'cash_in_first_match' };
      return { txnId: null, verdict: 'insufficient_data', extraReason: 'no_cash_in_record' };
    }
    default:
      return { txnId: null, verdict: 'insufficient_data', extraReason: 'other_no_match' };
  }
}

function buildSummaryAndReply(caseType, req, language, severity, relevantTxnId) {
  const amount = parseAmount(req.complaint);
  const amountStr = amount != null ? `${amount}` : 'the mentioned';
  const isBn = language === 'bn';

  if (caseType === 'phishing_or_social_engineering') {
    if (isBn) {
      return {
        agent_summary: 'গ্রাহক সন্দেহজনক ক্রেডেনশিয়াল শেয়ারিং বা স্ক্যাম কলের কথা জানিয়েছেন। তাৎক্ষণিক ফ্রড রিস্ক রিভিউ প্রয়োজন।',
        recommended_next_action: 'অ্যাকাউন্ট অ্যাক্সেস ফ্ল্যাগ করুন এবং fraud_risk টিমে রেফার করুন; গ্রাহকের সাথে যোগাযোগ শুধুমাত্র অফিসিয়াল চ্যানেলে নিশ্চিত করুন।',
        customer_reply: 'আমরা আপনার রিপোর্ট পেয়েছি। নিরাপত্তার জন্য অনুগ্রহ করে কারো সাথে আপনার পিন, ওটিপি বা পাসওয়ার্ড শেয়ার করবেন না। আমাদের টিম শুধুমাত্র অফিসিয়াল চ্যানেল থেকে যোগাযোগ করবে।',
      };
    }
    return {
      agent_summary: 'Customer reports a possible credential-share or scam contact. Treat as urgent fraud risk and do not contact from unofficial channels.',
      recommended_next_action: 'Flag the account for fraud_risk review and verify any recent activity through official channels only.',
      customer_reply: 'We have received your report. Please do not share your PIN, OTP, or password with anyone. Our team will contact you only through official channels.',
    };
  }

  if (caseType === 'wrong_transfer') {
    if (isBn) {
      return {
        agent_summary: `গ্রাহক ভুল নম্বরে টাকা পাঠিয়ে ফেলেছেন বলে জানিয়েছেন${relevantTxnId ? ` (সম্ভাব্য লেনদেন ${relevantTxnId})` : ''}।`,
        recommended_next_action: 'প্রাপক ইতিহাস যাচাই করুন এবং dispute_resolution টিমে রেফার করুন।',
        customer_reply: 'আমরা আপনার অভিযোগ পেয়েছি। আমাদের টিম লেনদেনটি যাচাই করে প্রয়োজনীয় ব্যবস্থা নেবে। যেকোনো যোগ্য পরিমাণ শুধুমাত্র অফিসিয়াল চ্যানেলের মাধ্যমে ফেরত দেওয়া হবে।',
      };
    }
    return {
      agent_summary: `Customer reports a transfer sent to the wrong recipient${relevantTxnId ? ` (likely txn ${relevantTxnId})` : ''}.`,
      recommended_next_action: 'Verify recipient history and refer to dispute_resolution for review.',
      customer_reply: 'We have received your complaint. Our team will review the transfer and take the appropriate steps. Any eligible amount will be returned through official channels only.',
    };
  }

  if (caseType === 'payment_failed') {
    if (isBn) {
      return {
        agent_summary: `গ্রাহক জানিয়েছেন পেমেন্ট ব্যর্থ হয়েছে কিন্তু ব্যালেন্স থেকে ${amountStr} টাকা কেটে নেওয়া হয়েছে।`,
        recommended_next_action: 'payments_ops টিম নিশ্চিত করুক যে কোনো বকেয়া রিভার্সাল শুধুমাত্র অফিসিয়াল চ্যানেলে প্রসেস হবে।',
        customer_reply: 'আমরা আপনার পেমেন্ট সংক্রান্ত অভিযোগটি পেয়েছি। আমাদের টিম যাচাই করছে এবং যেকোনো যোগ্য পরিমাণ শুধুমাত্র অফিসিয়াল চ্যানেলের মাধ্যমে ফেরত দেওয়া হবে।',
      };
    }
    return {
      agent_summary: `Customer reports a failed payment of ${amountStr} with claimed balance deduction.`,
      recommended_next_action: 'Route to payments_ops to verify settlement status; any eligible reversal must be processed through official channels.',
      customer_reply: 'We have received your payment complaint. Our team is reviewing it and any eligible amount will be returned through official channels only.',
    };
  }

  if (caseType === 'duplicate_payment') {
    if (isBn) {
      return {
        agent_summary: `গ্রাহক একই পেমেন্ট দুবার কেটে যাওয়ার অভিযোগ করেছেন${relevantTxnId ? ` (সন্দেহভাজন লেনদেন ${relevantTxnId})` : ''}।`,
        recommended_next_action: 'payments_ops টিমকে দুটি লেনদেনের বিবরণ মিলিয়ে দেখুন এবং প্রয়োজনে রিভার্সাল শুধুমাত্র অফিসিয়াল চ্যানেলে প্রসেস করুন।',
        customer_reply: 'আমরা আপনার ডুপ্লিকেট পেমেন্টের অভিযোগ পেয়েছি। আমাদের টিম যাচাই করছে এবং যেকোনো যোগ্য পরিমাণ শুধুমাত্র অফিসিয়াল চ্যানেলের মাধ্যমে ফেরত দেওয়া হবে।',
      };
    }
    return {
      agent_summary: `Customer reports being charged twice${relevantTxnId ? ` (suspected txn ${relevantTxnId})` : ''}.`,
      recommended_next_action: 'Have payments_ops compare the two payments; any eligible reversal must be processed through official channels.',
      customer_reply: 'We have received your duplicate payment complaint. Our team is verifying it and any eligible amount will be returned through official channels only.',
    };
  }

  if (caseType === 'refund_request') {
    if (isBn) {
      return {
        agent_summary: `গ্রাহক একটি সম্পন্ন পেমেন্টের রিফান্ড চাইছেন${relevantTxnId ? ` (লেনদেন ${relevantTxnId})` : ''}।`,
        recommended_next_action: 'customer_support টিম যোগ্যতা যাচাই করুক; কোনো রিফান্ড শুধুমাত্র অফিসিয়াল চ্যানেলে প্রসেস হবে।',
        customer_reply: 'আমরা আপনার রিফান্ড অনুরোধ পেয়েছি। আমাদের টিম যাচাই করছে এবং যেকোনো যোগ্য পরিমাণ শুধুমাত্র অফিসিয়াল চ্যানেলের মাধ্যমে ফেরত দেওয়া হবে।',
      };
    }
    return {
      agent_summary: `Customer requests a refund for a completed payment${relevantTxnId ? ` (txn ${relevantTxnId})` : ''}.`,
      recommended_next_action: 'Route to customer_support for eligibility review; any refund must be processed through official channels only.',
      customer_reply: 'We have received your refund request. Our team is reviewing it and any eligible amount will be returned through official channels only.',
    };
  }

  if (caseType === 'merchant_settlement_delay') {
    if (isBn) {
      return {
        agent_summary: `মার্চেন্ট সেটেলমেন্টে বিলম্বের অভিযোগ${relevantTxnId ? ` (সেটেলমেন্ট ${relevantTxnId})` : ''}।`,
        recommended_next_action: 'merchant_operations টিমকে সেটেলমেন্ট স্ট্যাটাস যাচাই করতে দিন।',
        customer_reply: 'আমরা আপনার সেটেলমেন্ট সংক্রান্ত অভিযোগ পেয়েছি। আমাদের টিম যাচাই করছে এবং প্রয়োজনীয় ব্যবস্থা নেবে।',
      };
    }
    return {
      agent_summary: `Merchant reports a settlement delay${relevantTxnId ? ` (settlement ${relevantTxnId})` : ''}.`,
      recommended_next_action: 'Have merchant_operations verify the settlement status.',
      customer_reply: 'We have received your settlement complaint. Our team is reviewing it and will take the appropriate steps.',
    };
  }

  if (caseType === 'agent_cash_in_issue') {
    if (isBn) {
      return {
        agent_summary: `গ্রাহক এজেন্টের মাধ্যমে ক্যাশ-ইন সমস্যার কথা জানিয়েছেন${relevantTxnId ? ` (লেনদেন ${relevantTxnId})` : ''}।`,
        recommended_next_action: 'agent_operations টিমকে ক্যাশ-ইন রেকর্ড যাচাই করতে রেফার করুন।',
        customer_reply: 'আমরা আপনার ক্যাশ-ইন অভিযোগ পেয়েছি। আমাদের টিম এজেন্ট রেকর্ড যাচাই করে প্রয়োজনীয় ব্যবস্থা নেবে।',
      };
    }
    return {
      agent_summary: `Customer reports an agent cash-in issue${relevantTxnId ? ` (txn ${relevantTxnId})` : ''}.`,
      recommended_next_action: 'Refer to agent_operations to verify the cash-in record with the field agent.',
      customer_reply: 'We have received your cash-in complaint. Our team will verify the agent record and take the appropriate steps.',
    };
  }

  // other
  if (isBn) {
    return {
      agent_summary: 'গ্রাহকের অভিযোগ স্পষ্টভাবে কোনো নির্দিষ্ট কেস টাইপে পড়ছে না।',
      recommended_next_action: 'অতিরিক্ত তথ্য সংগ্রহ করে customer_support এ ট্রায়াজ করুন।',
      customer_reply: 'আমরা আপনার অভিযোগ পেয়েছি। আমাদের টিম যাচাই করে প্রয়োজনীয় ব্যবস্থা নেবে।',
    };
  }
  return {
    agent_summary: 'Customer complaint does not clearly fit a specific case type.',
    recommended_next_action: 'Collect more details and triage through customer_support.',
    customer_reply: 'We have received your complaint. Our team will review it and take the appropriate steps.',
  };
}

// Main entry: returns a partial response object.
function analyzeTicket(req) {
  const text = normalizeText(req.complaint || '');
  const signals = detectSignals(text);
  const caseType = pickCaseType(text, req, signals);
  const language = detectLanguage(req);

  const match = matchRelevantTransaction(caseType, req, signals);
  const txnId = match.txnId;
  let verdict = match.verdict;

  // Override verdict for phishing.
  if (caseType === 'phishing_or_social_engineering') {
    verdict = 'insufficient_data';
  }

  const maxAmount = Math.max(parseAmount(req.complaint) || 0, highestAmount(req.transaction_history || []));
  const severity = pickSeverity(caseType, maxAmount, caseType === 'phishing_or_social_engineering');
  const department = defaultDepartment(caseType);
  const humanReview = humanReviewFor(caseType, severity, verdict, maxAmount);

  const { agent_summary, recommended_next_action, customer_reply } = buildSummaryAndReply(
    caseType, req, language, severity, txnId
  );

  // Reason codes
  const reasonCodes = [];
  if (signals.phishingHits > 0) reasonCodes.push('phishing_keywords');
  if (signals.wrongTransferHits > 0) reasonCodes.push('wrong_transfer_keywords');
  if (signals.paymentFailedHits > 0) reasonCodes.push('payment_failed_keywords');
  if (signals.duplicateHits > 0) reasonCodes.push('duplicate_keywords');
  if (signals.refundHits > 0) reasonCodes.push('refund_keywords');
  if (signals.merchantSettlementHits > 0) reasonCodes.push('merchant_settlement_keywords');
  if (signals.agentCashInHits > 0) reasonCodes.push('agent_cash_in_keywords');
  if (match.extraReason) reasonCodes.push(match.extraReason);
  if (req.user_type === 'merchant') reasonCodes.push('user_type_merchant');
  if (req.channel === 'merchant_portal') reasonCodes.push('channel_merchant_portal');
  if (req.transaction_history && req.transaction_history.length === 0) reasonCodes.push('no_transaction_history');
  reasonCodes.push(`severity_${severity}`);
  reasonCodes.push(`lang_${language}`);

  // Confidence heuristic
  let confidence = 0.5;
  if (caseType === 'phishing_or_social_engineering') confidence = 0.85;
  else if (verdict === 'consistent') confidence = 0.8;
  else if (verdict === 'inconsistent') confidence = 0.7;
  else confidence = 0.4;
  if (req.transaction_history && req.transaction_history.length > 0) confidence = Math.min(0.95, confidence + 0.05);

  return {
    ticket_id: req.ticket_id,
    relevant_transaction_id: txnId,
    evidence_verdict: verdict,
    case_type: caseType,
    severity,
    department,
    agent_summary,
    recommended_next_action,
    customer_reply,
    human_review_required: humanReview,
    confidence,
    reason_codes: reasonCodes,
    _language: language,
  };
}

module.exports = {
  analyzeTicket,
  normalizeText,
  detectSignals,
  detectLanguage,
  pickSeverity,
  defaultDepartment,
  humanReviewFor,
  parseAmount,
  parseCounterpartyHint,
};
