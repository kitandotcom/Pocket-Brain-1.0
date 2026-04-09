// /api/ai.js
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { images, prompt, messages, system } = req.body;

  // ──────────────────────────────────────────────
  // VISION TASK (PDF / image upload)
  // Fallback: Gemini → Claude
  // ──────────────────────────────────────────────
  if (images && Array.isArray(images) && images.length > 0 && prompt) {
    // Try Gemini (free) first
    try {
      const result = await callGeminiVision(images, prompt);
      if (result) return res.status(200).json({ content: [{ type: "text", text: result }] });
    } catch (e) { console.warn("Gemini vision failed:", e.message); }

    // Try Claude (paid) as last resort
    try {
      const result = await callClaudeVision(images, prompt);
      if (result) return res.status(200).json({ content: [{ type: "text", text: result }] });
    } catch (e) { console.warn("Claude vision failed:", e.message); }

    // If all fail, return empty array
    return res.status(200).json({ content: [{ type: "text", text: "[]" }] });
  }

  // ──────────────────────────────────────────────
  // TEXT-ONLY TASKS (SMS, insights, weekly summary)
  // Fallback: DeepSeek → Groq → Gemini → Claude
  // ──────────────────────────────────────────────
  try {
    // 1. DeepSeek (cheap, good)
    const deepseekResult = await callDeepSeek(messages, system);
    if (deepseekResult) return res.status(200).json({ content: [{ type: "text", text: deepseekResult }] });
  } catch (e) { console.warn("DeepSeek failed:", e.message); }

  try {
    // 2. Groq (free, fast)
    const groqResult = await callGroq(messages, system);
    if (groqResult) return res.status(200).json({ content: [{ type: "text", text: groqResult }] });
  } catch (e) { console.warn("Groq failed:", e.message); }

  try {
    // 3. Gemini text (free, but not as fast as Groq for text)
    const geminiResult = await callGeminiText(messages, system);
    if (geminiResult) return res.status(200).json({ content: [{ type: "text", text: geminiResult }] });
  } catch (e) { console.warn("Gemini text failed:", e.message); }

  try {
    // 4. Claude (paid) – last resort
    const claudeResult = await callClaudeText(messages, system);
    if (claudeResult) return res.status(200).json({ content: [{ type: "text", text: claudeResult }] });
  } catch (e) { console.warn("Claude text failed:", e.message); }

  // Ultimate fallback: regex extraction (only for SMS)
  return await regexFallback(messages, res);
}

// ──────────────────────────────────────────────
// VISION PROVIDERS
// ──────────────────────────────────────────────
async function callGeminiVision(images, prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("No GEMINI_API_KEY");
  
  const contents = [{ text: prompt }];
  for (const base64 of images) {
    contents.push({ inlineData: { mimeType: "image/jpeg", data: base64 } });
  }
  
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: contents }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
      })
    }
  );
  if (!response.ok) throw new Error(`Gemini HTTP ${response.status}`);
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

async function callClaudeVision(images, prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("No ANTHROPIC_API_KEY");
  
  const content = [{ type: "text", text: prompt }];
  for (const base64 of images) {
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } });
  }
  
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-3-sonnet-20240229",
      max_tokens: 4096,
      messages: [{ role: "user", content }]
    })
  });
  if (!response.ok) throw new Error(`Claude HTTP ${response.status}`);
  const data = await response.json();
  return data.content?.[0]?.text || null;
}

// ──────────────────────────────────────────────
// TEXT PROVIDERS
// ──────────────────────────────────────────────
async function callDeepSeek(messages, system) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("No DEEPSEEK_API_KEY");
  
  const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        ...messages
      ],
      temperature: 0.2,
      max_tokens: 2048
    })
  });
  if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content || null;
}

async function callGroq(messages, system) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("No GROQ_API_KEY");
  
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        ...messages
      ],
      temperature: 0.2,
      max_tokens: 2048
    })
  });
  if (!response.ok) throw new Error(`Groq HTTP ${response.status}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content || null;
}

async function callGeminiText(messages, system) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("No GEMINI_API_KEY");
  
  // Convert messages to Gemini format
  const contents = [];
  if (system) {
    contents.push({ role: "user", parts: [{ text: `System: ${system}` }] });
  }
  for (const msg of messages) {
    const role = msg.role === "assistant" ? "model" : "user";
    contents.push({ role, parts: [{ text: msg.content }] });
  }
  
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents, generationConfig: { temperature: 0.2, maxOutputTokens: 2048 } })
    }
  );
  if (!response.ok) throw new Error(`Gemini HTTP ${response.status}`);
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

async function callClaudeText(messages, system) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("No ANTHROPIC_API_KEY");
  
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-3-haiku-20240307",
      max_tokens: 2048,
      system: system,
      messages: messages
    })
  });
  if (!response.ok) throw new Error(`Claude HTTP ${response.status}`);
  const data = await response.json();
  return data.content?.[0]?.text || null;
}

// ──────────────────────────────────────────────
// ULTIMATE FALLBACK: Regex for SMS alerts
// ──────────────────────────────────────────────
async function regexFallback(messages, res) {
  const userMsg = messages.find(m => m.role === "user");
  const text = typeof userMsg.content === "string" ? userMsg.content : JSON.stringify(userMsg.content);
  
  const amountMatch = text.match(/(?:N|NGN|₦)\s*([\d,]+(?:\.\d{2})?)/i);
  const merchantMatch = text.match(/(?:at|from|to|for)\s+([A-Z][A-Za-z\s]{3,30})/i);
  
  if (amountMatch) {
    const amount = parseFloat(amountMatch[1].replace(/,/g, ""));
    const merchant = merchantMatch ? merchantMatch[1].trim() : "Unknown";
    const result = [{
      name: merchant,
      amount: amount,
      category: "Other",
      date: new Date().toISOString().split("T")[0]
    }];
    return res.status(200).json({ content: [{ type: "text", text: JSON.stringify(result) }] });
  }
  return res.status(200).json({ content: [{ type: "text", text: "[]" }] });
}
