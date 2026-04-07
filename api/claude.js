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

  // ── FILE UPLOADS: Try DeepSeek FIRST (cheapest + supports PDF/images) ──
  if (hasFiles) {
    try {
      return await deepseekFileHandler(messages, system, res);
    } catch (deepseekErr) {
      console.error("DeepSeek failed, trying Anthropic:", deepseekErr.message);
      // Fallback to Anthropic
      try {
        return await anthropicFileHandler(messages, system, res);
      } catch (anthropicErr) {
        // Final fallback to Gemini
        return await geminiImageFallback(messages, res);
      }
    }
  }

  // ── TEXT REQUESTS: Try Groq → DeepSeek → Anthropic → Gemini ──
  
  // Try Groq first (fastest for text)
  try {
    return await groqTextHandler(messages, system, res);
  } catch (groqErr) {
    console.error("Groq failed, trying DeepSeek:", groqErr.message);
    
    // Try DeepSeek second (cheap & good for text)
    try {
      return await deepseekTextHandler(messages, system, res);
    } catch (deepseekErr) {
      console.error("DeepSeek failed, trying Anthropic:", deepseekErr.message);
      
      // Try Anthropic third
      try {
        return await anthropicTextHandler(messages, system, res);
      } catch (anthropicErr) {
        console.error("Anthropic failed, trying Gemini:", anthropicErr.message);
        
        // Final fallback to Gemini
        return await geminiText(messages, system, res);
      }
    }
  }
}

// ========== DEEPSEEK HANDLERS ==========

async function deepseekFileHandler(messages, system, res) {
  // Convert your message format to DeepSeek's vision format
  const userMessage = messages.find(m => m.role === "user");
  if (!userMessage) throw new Error("No user message found");
  
  const content = [];
  
  // Handle both array and string content
  if (Array.isArray(userMessage.content)) {
    for (const part of userMessage.content) {
      if (part.type === "text") {
        content.push({ type: "text", text: part.text });
      } else if (part.type === "image" || part.type === "document") {
        // DeepSeek accepts base64 images/PDFs via image_url
        content.push({
          type: "image_url",
          image_url: {
            url: `data:${part.source.media_type};base64,${part.source.data}`
          }
        });
      }
    }
  } else if (typeof userMessage.content === "string") {
    content.push({ type: "text", text: userMessage.content });
  }
  
  const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content }
      ],
      max_tokens: 4096,
      temperature: 0.1, // Lower = more consistent extraction
    }),
  });
  
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "DeepSeek API error");
  
  return res.status(200).json({
    content: [{ type: "text", text: data.choices[0].message.content }]
  });
}

async function deepseekTextHandler(messages, system, res) {
  const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        ...messages,
      ],
      max_tokens: 2048,
      temperature: 0.7,
    }),
  });
  
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "DeepSeek API error");
  
  return res.status(200).json({
    content: [{ type: "text", text: data.choices[0].message.content }]
  });
}

// ========== GROQ HANDLER ==========

async function groqTextHandler(messages, system, res) {
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
  
  return res.status(200).json({
    content: [{ type: "text", text: data.choices[0].message.content }]
  });
}

// ========== ANTHROPIC HANDLERS ==========

async function anthropicFileHandler(messages, system, res) {
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
}

async function anthropicTextHandler(messages, system, res) {
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
}

// ========== GEMINI HANDLERS (Fallbacks) ==========

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

async function geminiImageFallback(messages, res) {
  try {
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
