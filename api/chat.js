// api/chat.js
// Serverless proxy that forwards chat requests to Groq.
// GROQ_API_KEY lives in Vercel environment variables — never exposed to the browser.

const RATE_LIMIT = 20;           // max requests per IP…
const WINDOW_MS  = 60 * 1000;    // …per 60 seconds
const hits = new Map();          // IP -> [timestamps]

function getIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.headers['x-real-ip']
    || (req.socket && req.socket.remoteAddress)
    || 'unknown';
}

function rateCheck(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (list.length >= RATE_LIMIT) {
    return { ok: false, retry: Math.ceil((WINDOW_MS - (now - list[0])) / 1000) };
  }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 500) {
    for (const [k, v] of hits) {
      if (v.every(t => now - t > WINDOW_MS)) hits.delete(k);
    }
  }
  return { ok: true };
}

const SYSTEM_PROMPT = `You are NexaLearn's AI Tutor — a warm, patient, knowledgeable teacher.
Help the student understand the current lesson topic using clear language, short paragraphs, and concrete examples.
When asked for a quiz, give ONE multiple-choice question with options labelled A, B, C, D, and wait for their answer.
Never invent facts outside the lesson. If unsure, say so honestly.
Keep replies concise — under ~200 words unless asked for depth.`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const ip = getIP(req);
  const rl = rateCheck(ip);
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retry));
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server is missing GROQ_API_KEY' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { messages = [], context = {} } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  if (messages.length > 30) {
    return res.status(400).json({ error: 'Conversation too long' });
  }

  const ctxLine = context.topic
    ? `\n\nCurrent lesson: ${context.course || ''} — ${context.topic}.\nIntro: ${context.intro || ''}\nKey concepts: ${(context.concepts || []).join('; ')}`
    : '';

  const payload = {
    model: 'llama-3.3-70b-versatile',
    temperature: 0.6,
    max_tokens: 600,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT + ctxLine },
      ...messages.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || '').slice(0, 4000)
      }))
    ]
  };

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text().catch(() => '');
      console.error('Groq error', groqRes.status, errText);
      if (groqRes.status === 401) return res.status(502).json({ error: 'AI auth failed' });
      if (groqRes.status === 429) return res.status(429).json({ error: 'AI is busy' });
      return res.status(502).json({ error: 'AI service unavailable' });
    }

    const data = await groqRes.json();
    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) return res.status(502).json({ error: 'Empty AI response' });
    return res.status(200).json({ reply });
  } catch (err) {
    console.error('Proxy error', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
};