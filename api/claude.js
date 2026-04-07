// /api/claude.js - Complete working version with DeepSeek
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { messages, system } = req.body;
  if (!messages) return res.status(400).json({ error: "No messages provided" });

  // Check if request contains images/documents
  const hasFiles = messages.some(m =>
    Array.isArray(m.content) &&
    m.content.some(c => c.type === "image" || c.type === "document")
  );

  // For files (PDFs/images) - use DeepSeek first
  if (hasFiles) {
    try {
      return await deepseekFileHandler(messages, system, res);
    } catch (err) {
      console.error("DeepSeek failed:", err.message);
      // Fallback to Groq
      try {
        return await groqTextHandler(messages, system, res);
      } catch (fallbackErr) {
        return res.status(500).json({ error: "All AI providers failed" });
      }
    }
  }

  // For text-only requests - try DeepSeek then Groq
  try {
    return await deepseekTextHandler(messages, system, res);
  } catch (err) {
    console.error("DeepSeek text failed:", err.message);
    try {
      return await groqTextHandler(messages, system, res);
    } catch (groqErr) {
      return res.status(500).json({ error: "AI processing failed" });
    }
  }
}

// ========== DEEPSEEK HANDLERS ==========

async function deepseekFileHandler(messages, system, res) {
  const userMessage = messages.find(m => m.role === "user");
  if (!userMessage) throw new Error("No user message found");
  
  const content = [];
  
  // Handle different content formats
  if (Array.isArray(userMessage.content)) {
    for (const part of userMessage.content) {
      if (part.type === "text") {
        content.push({ type: "text", text: part.text });
      } else if (part.type === "image" || part.type === "document") {
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
      temperature: 0.1,
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

// ========== GROQ FALLBACK HANDLER ==========

async function groqTextHandler(messages, system, res) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        ...messages,
      ],
      max_tokens: 2048,
    }),
  });
  
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Groq API error");
  
  return res.status(200).json({
    content: [{ type: "text", text: data.choices[0].message.content }]
  });
}
