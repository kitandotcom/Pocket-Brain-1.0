export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { messages, system } = req.body;
  if (!messages) return res.status(400).json({ error: "No messages provided" });

  // Check if request contains images or documents
  const hasFiles = messages.some(m =>
    Array.isArray(m.content) &&
    m.content.some(c => c.type === "image" || c.type === "document")
  );

  // ── FILE UPLOADS: Use Anthropic (supports PDF + images) ──────────────
  if (hasFiles) {
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
      if (!response.ok) throw new Error(data.error?.message || "Anthropic error");
      return res.status(200).json(data);
    } catch (err) {
      // Fallback to Gemini for image parsing if Anthropic fails
      return await geminiImageFallback(messages, res);
    }
  }

  // ── TEXT REQUESTS: Try Groq first (free + fast) ───────────────────────
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
    if (!response.ok) throw new Error(data.error?.message || "Groq error");
    const text = data.choices?.[0]?.message?.content || "";
    return res.status(200).json({ content: [{ type: "text", text }] });
  } catch (groqErr) {
    console.error("Groq failed, trying Anthropic:", groqErr.message);

    // Fallback 1: Anthropic
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
      if (!response.ok) throw new Error(data.error?.message || "Anthropic error");
      return res.status(200).json(data);
    } catch (anthropicErr) {
      console.error("Anthropic failed, trying Gemini:", anthropicErr.message);

      // Fallback 2: Gemini
      try {
        return await geminiText(messages, system, res);
      } catch (geminiErr) {
        return res.status(500).json({ error: "All AI providers failed: " + geminiErr.message });
      }
    }
  }
}

// ── GEMINI TEXT ────────────────────────────────────────────────────────
async function geminiText(messages, system, res) {
  const prompt = [
    system ? `System: ${system}\n\n` : "",
    ...messages.map(m => `${m.role === "user" ? "User" : "Assistant"}: ${typeof m.content === "string" ? m.content : m.content.map(c => c.text || "").join(" ")}`)
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

// ── GEMINI IMAGE FALLBACK ──────────────────────────────────────────────
async function geminiImageFallback(messages, res) {
  try {
    // Extract image from messages
    const parts = [];
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const c of msg.content) {
          if (c.type === "image") {
            parts.push({
              inlineData: {
                mimeType: c.source.media_type,
                data: c.source.data,
              }
            });
          } else if (c.type === "text") {
            parts.push({ text: c.text });
          } else if (c.type === "document") {
            // Gemini supports PDF too
            parts.push({
              inlineData: {
                mimeType: "application/pdf",
                data: c.source.data,
              }
            });
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
    if (!response.ok) throw new Error(data.error?.message || "Gemini error");
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    return res.status(200).json({ content: [{ type: "text", text }] });
  } catch (err) {
    return res.status(500).json({ error: "File processing failed: " + err.message });
  }
}
