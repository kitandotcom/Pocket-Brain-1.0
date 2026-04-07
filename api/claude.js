export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { messages, system } = req.body;
  if (!messages) return res.status(400).json({ error: "No messages provided" });

  // Check for PDF files or images
  const hasFile = messages.some(m =>
    Array.isArray(m.content) && 
    m.content.some(c => c.type === "document" || c.type === "image")
  );

  // If there's a file (PDF or image), use our free parser
  if (hasFile) {
    try {
      const userMessage = messages.find(m => m.role === "user");
      const filePart = userMessage.content.find(c => c.type === "document" || c.type === "image");
      
      if (filePart && filePart.source?.data) {
        // Call our bank statement parser
        const response = await fetch(`${process.env.VERCEL_URL || 'http://localhost:3000'}/api/parse-bank-statement`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileBase64: filePart.source.data,
            fileType: filePart.source.media_type
          })
        });
        
        const data = await response.json();
        if (data.success && data.transactions) {
          return res.status(200).json({
            content: [{ type: "text", text: JSON.stringify(data.transactions) }]
          });
        } else {
          // If parser fails, try fallback
          return await fallbackTextExtraction(filePart.source.data, filePart.source.media_type, res);
        }
      }
    } catch (err) {
      console.error("Parser error:", err);
      return res.status(500).json({ error: "Failed to parse file: " + err.message });
    }
  }

  // For text messages (SMS alerts, etc.), use Groq (free)
  try {
    return await groqHandler(messages, system, res);
  } catch (err) {
    console.error("Groq error:", err);
    // Final fallback - simple regex parsing
    return await regexFallback(messages, res);
  }
}

async function groqHandler(messages, system, res) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return await regexFallback(messages, res);
  }
  
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
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
  
  if (!response.ok) {
    throw new Error("Groq API error");
  }
  
  const data = await response.json();
  return res.status(200).json({
    content: [{ type: "text", text: data.choices[0].message.content }]
  });
}

async function fallbackTextExtraction(base64Data, mimeType, res) {
  // Simple text extraction for when AI fails
  const buffer = Buffer.from(base64Data, 'base64');
  const text = buffer.toString('utf-8');
  
  // Try to find transaction-like patterns
  const transactions = [];
  const lines = text.split('\n');
  
  for (const line of lines) {
    const amountMatch = line.match(/(?:N|NGN|₦)\s*([\d,]+(?:\.\d{2})?)/i);
    if (amountMatch) {
      const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
      if (amount > 0 && amount < 10000000) {
        transactions.push({
          date: new Date().toISOString().split('T')[0],
          narration: line.substring(0, 100),
          amount: amount,
          type: 'debit',
          merchant: extractSimpleMerchant(line),
          category: 'Other'
        });
      }
    }
  }
  
  return res.status(200).json({
    content: [{ type: "text", text: JSON.stringify(transactions) }]
  });
}

async function regexFallback(messages, res) {
  // Last resort - extract using regex patterns
  const userMessage = messages.find(m => m.role === "user");
  const text = typeof userMessage.content === 'string' ? userMessage.content : JSON.stringify(userMessage.content);
  
  const transactions = [];
  
  // Pattern for Nigerian debit alerts
  const patterns = [
    /(?:debit|spent|paid)\s+(?:N|NGN|₦)\s*([\d,]+(?:\.\d{2})?)\s+(?:at|to|for)\s+([A-Z][A-Za-z\s]+)/i,
    /(?:N|NGN|₦)\s*([\d,]+(?:\.\d{2})?)\s+(?:debited|deducted)\s+(?:for|from)\s+([A-Z][A-Za-z\s]+)/i,
    /alert:\s*(?:N|NGN|₦)\s*([\d,]+(?:\.\d{2})?)\s+(?:at|from)\s+([A-Z][A-Za-z\s]+)/i,
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      transactions.push({
        date: new Date().toISOString().split('T')[0],
        narration: match[2]?.trim() || "Transaction",
        amount: parseFloat(match[1].replace(/,/g, '')),
        type: 'debit',
        merchant: match[2]?.trim() || "Unknown",
        category: 'Other'
      });
    }
  }
  
  if (transactions.length === 0) {
    return res.status(200).json({
      content: [{ type: "text", text: JSON.stringify([{ error: "Could not parse", original: text.substring(0, 200) }]) }]
    });
  }
  
  return res.status(200).json({
    content: [{ type: "text", text: JSON.stringify(transactions) }]
  });
}

function extractSimpleMerchant(text) {
  const patterns = [
    /(?:at|from|to)\s+([A-Z][A-Za-z\s]{3,30})/i,
    /for\s+([A-Z][A-Za-z\s]{3,30})/i,
    /-\s+([A-Z][A-Za-z\s]{3,20})/i,
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  
  const words = text.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    if (words[i].length > 5 && words[i][0] === words[i][0].toUpperCase()) {
      return words[i];
    }
  }
  
  return "Unknown Merchant";
}
