'use strict';

const express = require('express');
const router = express.Router();

const ruleAnalyzer = require('../services/ruleAnalyzer');
const { cleanRequest, validateAndFixResponse } = require('../utils/validator');
const { sanitizeResponse } = require('../utils/safety');
const { buildDefaultResponse } = require('../utils/responseFactory');

router.post('/analyze-ticket', (req, res) => {
  try {
    const parsed = cleanRequest(req.body || {});
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }
    const ticket = parsed.value;
    if (!ticket.complaint || !ticket.complaint.trim()) {
      return res.status(422).json({ error: 'complaint must not be empty.' });
    }

    let result;
    try {
      result = ruleAnalyzer.analyzeTicket(ticket);
    } catch (err) {
      // Defensive fallback: analyzer should never throw, but if it does,
      // return a safe default.
      result = buildDefaultResponse(ticket.ticket_id);
    }

    // Drop internal markers before validating.
    const language = result._language;
    const injectionNeutralized = ticket._complaint_injection_neutralized === true;
    delete result._language;
    delete ticket._complaint_injection_neutralized;

    const safe = sanitizeResponse({ ...result }, { language });
    const merged = { ...buildDefaultResponse(ticket.ticket_id), ...safe };
    if (injectionNeutralized && !merged.reason_codes.includes('prompt_injection_neutralized')) {
      merged.reason_codes = [...merged.reason_codes, 'prompt_injection_neutralized'];
    }
    const fixed = validateAndFixResponse(merged);
    return res.status(200).json(fixed);
  } catch (err) {
    return res.status(500).json({ error: 'Internal error.' });
  }
});

module.exports = router;
