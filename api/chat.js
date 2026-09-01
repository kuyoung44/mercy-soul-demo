import crypto from 'node:crypto';
import { checkRateLimit } from '@vercel/firewall';
import { validateChatRequest, validateMessage, validateOrigin, securityHeaders } from '../src/api-security.js';

const configuredModel = process.env.GEMINI_MODEL?.trim();
const MODEL = configuredModel || 'gemini-2.5-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const VERCEL_RATE_LIMIT_ID = process.env.VERCEL_RATE_LIMIT_ID?.trim();

const BUSINESS_CONTEXT = `
Business Name: Ayodele's Suya Spot
Operating Hours: 4 PM - 11 PM
Special: Spicy Beef Suya (₦2,000)
Chicken Suya (₦2,500)
Delivery: Only within Oyan, ₦500 delivery fee.
Message: If a customer asks about anything else, say: 'Please call us directly to place your order.'
`;

const SYSTEM_PROMPT = `You are the customer service chatbot for Ayodele's Suya Spot.

${BUSINESS_CONTEXT}

Answer customer questions using only the business information above. Be concise and helpful. If a customer asks about anything else not covered by the business information, respond exactly: "Please call us directly to place your order."`;

async function enforceVercelRateLimit(req, context) {
  if (!VERCEL_RATE_LIMIT_ID) return true;
  try {
    const { rateLimited } = await checkRateLimit(VERCEL_RATE_LIMIT_ID, { request: req });
    if (rateLimited) return false;
    return true;
  } catch (error) {
    console.error('[Demo Security]', JSON.stringify({ event: 'rate_limit_error', requestId: context.requestId, error: String(error?.message || error) }));
    return process.env.VERCEL_RATE_LIMIT_FAIL_CLOSED !== 'true';
  }
}

export default async function handler(req, res) {
  securityHeaders(res);
  const context = validateChatRequest(req);
  res.setHeader('x-request-id', context.requestId);

  if (req.method !== 'POST') return res.status(405).json({ reply: 'Method not allowed.' });
  if (!context.allowed) {
    res.setHeader('Retry-After', String(context.retryAfter || 10));
    return res.status(context.status || 429).json({ reply: 'Too many requests. Please try again shortly.' });
  }
  if (!validateOrigin(req)) return res.status(403).json({ reply: 'Request origin is not authorized.' });
  if (!(await enforceVercelRateLimit(req, context))) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ reply: 'Traffic limit reached. Please try again shortly.' });
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return res.status(500).json({ reply: 'Chatbot is not configured: GEMINI_API_KEY is missing.' });

  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!validateMessage(message)) return res.status(400).json({ reply: 'Please provide a message of 1–4000 characters.' });

  try {
    const response = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: message }] }],
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('[Demo Security]', JSON.stringify({ event: 'gemini_error', status: response.status, model: MODEL, requestId: context.requestId }));
      if (response.status === 401 || response.status === 403) return res.status(502).json({ reply: 'Gemini authentication failed. Check GEMINI_API_KEY in Vercel.' });
      if (response.status === 404) return res.status(502).json({ reply: `Gemini model '${MODEL}' is unavailable.` });
      if (response.status === 429) return res.status(502).json({ reply: 'Gemini rate limit reached. Please try again shortly.' });
      return res.status(502).json({ reply: 'The chatbot could not reach Gemini right now.' });
    }
    const reply = data?.candidates?.[0]?.content?.parts?.map((part) => part?.text || '').join('').trim();
    if (!reply) return res.status(502).json({ reply: 'Gemini returned no response. Please try again.' });
    return res.status(200).json({ reply });
  } catch (error) {
    console.error('[Demo Security]', JSON.stringify({ event: 'gemini_request_failed', requestId: context.requestId, error: String(error?.message || error) }));
    return res.status(500).json({ reply: 'Connection error. Try again later.' });
  }
}
