export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { messages, system } = req.body;
  if (!messages) return res.status(400).json({ error: "No messages provided" });

  // Check if request has files (images or PDFs)
  const hasFiles = messages.some(m =>
    Array.isArray(m.content) &&
    m.content.some(c => c.type === "image" || c.type === "document")
  );

  // ── FILE UPLOADS ─────────────────────────────────────────────
  if (hasFiles) {
    // Try Anthropic first (best for files)
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 2048,
            ...(system && { system }),
            messages,
          }),
        });
        const data = await response.json();
        if (response.ok) return res.status(200).json(data);
      } catch (e) { console.error("Anthropic file error:", e.message); }
    }

    // Fallback: Gemini (also supports images + PDFs)
    if (process.env.GEMINI_API_KEY) {
      try {
        return await geminiFile(messages, res);
      } catch (e) { console.error("Gemini file error:", e.message); }
    }

    return res.status(500).json({ error: "No AI provider available for file processing. Add ANTHROPIC_API_KEY or GEMINI_API_KEY to Vercel env vars." });
  }

  // ── TEXT REQUESTS: Groq → Anthropic → Gemini ─────────────────
  // Try Groq first (free + fast)
  if (process.env.GROQ_API_KEY) {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          max_tokens: 1024,
          messages: [
            ...(system ? [{ role: "system", content: system }] : []),
            ...messages,
          ],
        }),
      });
      const data = await response.json();
      if (response.ok) {
        const text = data.choices?.[0]?.message?.content || "";
        return res.status(200).json({ content: [{ type: "text", text }] });
      }
    } catch (e) { console.error("Groq error:", e.message); }
  }

  // Fallback: Anthropic
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          ...(system && { system }),
          messages,
        }),
      });
      const data = await response.json();
      if (response.ok) return res.status(200).json(data);
    } catch (e) { console.error("Anthropic text error:", e.message); }
  }

  // Fallback: Gemini
  if (process.env.GEMINI_API_KEY) {
    try {
      return await geminiText(messages, system, res);
    } catch (e) { console.error("Gemini text error:", e.message); }
  }

  return res.status(500).json({ error: "All AI providers failed. Check your API keys in Vercel env vars." });
}

async function geminiText(messages, system, res) {
  const prompt = [
    system ? `System: ${system}\n\n` : "",
    ...messages.map(m => `${m.role === "user" ? "User" : "Assistant"}: ${typeof m.content === "string" ? m.content : (m.content.map(c => c.text || "").join(" "))}`)
  ].join("\n");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 1024 },
      }),
    }
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Gemini error");
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return res.status(200).json({ content: [{ type: "text", text }] });
}

async function geminiFile(messages, res) {
  const parts = [];
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c.type === "image") {
          parts.push({ inlineData: { mimeType: c.source.media_type, data: c.source.data } });
        } else if (c.type === "document") {
          parts.push({ inlineData: { mimeType: "application/pdf", data: c.source.data } });
        } else if (c.type === "text") {
          parts.push({ text: c.text });
        }
      }
    } else if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    }
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { maxOutputTokens: 2048 },
      }),
    }
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Gemini file error");
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
  return res.status(200).json({ content: [{ type: "text", text }] });
}
