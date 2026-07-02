export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, url, action, personaContext, systemPrompt } = req.body;

  // ── URL fetch ──
  if (action === 'fetch' && url) {
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PageParser/1.0)' } });
      const html = await resp.text();
      const plain = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return res.status(200).json({ text: plain.slice(0, 20000) });
    } catch(e) {
      return res.status(500).json({ error: 'Could not fetch URL: ' + e.message });
    }
  }

  // ── Culture/persona generation (action === 'culture') ──
  if (action === 'culture' && text) {
    const wantsJson = text.includes('Return ONLY valid JSON') || text.includes('"cult1Title"');
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: text }],
          temperature: 0.4,
          ...(wantsJson ? { response_format: { type: 'json_object' } } : { max_tokens: 400 })
        })
      });
      const data = await response.json();
      const raw = data.choices?.[0]?.message?.content || '';
      if (wantsJson) return res.status(200).json(JSON.parse(raw));
      return res.status(200).json({ persona: raw.trim() });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── JD parse ──
  if (!text || text.trim().length < 50) {
    return res.status(400).json({ error: 'No JD text provided' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured — add GROQ_API_KEY to Vercel environment variables' });
  }

  // Use client-provided system prompt if available (universal generator sends its own)
  // Fall back to a generic EB prompt if not provided
  const personaSection = personaContext
    ? `\n\n## CANDIDATE PERSONA CONTEXT\n${personaContext}\n\nUse this to shape heroSub, Why company cards, and CTA.`
    : '';

  const finalSystemPrompt = systemPrompt
    ? systemPrompt + personaSection
    : `You are a senior employer branding specialist. Transform job descriptions into compelling, candidate-first copy. Always write for the candidate, not the company. Return ONLY valid JSON.` + personaSection;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: finalSystemPrompt },
          { role: 'user', content: `Parse this job description and return ONLY valid JSON:\n\n${text.slice(0, 12000)}` }
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || 'Groq API error');
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error('Empty response from Groq');

    const cleaned = raw.replace(/^```json\s*/, '').replace(/\s*```$/, '').trim();
    return res.status(200).json(JSON.parse(cleaned));

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
