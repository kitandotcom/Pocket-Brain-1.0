// /api/claude.js - Works with Access Bank parser output
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

  // If there's a file, use our bank statement parser
  if (hasFile) {
    try {
      const userMessage = messages.find(m => m.role === "user");
      const filePart = userMessage.content.find(c => c.type === "document" || c.type === "image");
      
      if (filePart && filePart.source?.data) {
        // Call the parse-bank-statement endpoint
        const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
        const response = await fetch(`${baseUrl}/api/parse-bank-statement`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileBase64: filePart.source.data,
            fileType: filePart.source.media_type || "application/pdf"
          })
        });
        
        if (!response.ok) {
          throw new Error(`Parser returned ${response.status}`);
        }
        
        const data = await response.json();
        
        // The parser returns either { success: true, transactions: [...] } or { transactions: [...] }
        let rawTransactions = [];
        if (data.transactions && Array.isArray(data.transactions)) {
          rawTransactions = data.transactions;
        } else if (data.success && data.transactions) {
          rawTransactions = data.transactions;
        } else {
          throw new Error("Parser did not return transactions array");
        }
        
        // Transform raw parser output into the frontend's expected format
        const formattedTransactions = rawTransactions.map(tx => ({
          date: tx.postDate || tx.date || new Date().toISOString().split('T')[0],
          narration: tx.narration || "Unknown",
          amount: tx.debit > 0 ? tx.debit : (tx.credit > 0 ? tx.credit : 0),
          type: tx.debit > 0 ? "debit" : (tx.credit > 0 ? "credit" : "unknown"),
          merchant: extractMerchantFromNarration(tx.narration || ""),
          category: guessCategoryFromNarration(tx.narration || "")
        }));
        
        return res.status(200).json({
          content: [{ type: "text", text: JSON.stringify(formattedTransactions) }]
        });
      }
    } catch (err) {
      console.error("Parser error:", err);
      // Fallback to simple text extraction
      return await fallbackTextExtraction(req.body, res);
    }
  }

  // For text messages (SMS alerts, etc.), use Groq (free)
  try {
    return await groqHandler(messages, system, res);
  } catch (err) {
    console.error("Groq error:", err);
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

async function fallbackTextExtraction(reqBody, res) {
  // Simple extraction when parser fails
  const { messages } = reqBody;
  const userMessage = messages.find(m => m.role === "user");
  const text = typeof userMessage.content === 'string' ? userMessage.content : JSON.stringify(userMessage.content);
  
  const transactions = [];
  const lines = text.split('\n');
  const amountRegex = /(?:N|NGN|₦)\s*([\d,]+(?:\.\d{2})?)/i;
  
  for (const line of lines) {
    const match = line.match(amountRegex);
    if (match) {
      const amount = parseFloat(match[1].replace(/,/g, ''));
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
    content: [{ type: "text", text: JSON.stringify(transactions.length ? transactions : [{ error: "Could not parse any transaction", original: text.substring(0, 200) }]) }]
  });
}

async function regexFallback(messages, res) {
  const userMessage = messages.find(m => m.role === "user");
  const text = typeof userMessage.content === 'string' ? userMessage.content : JSON.stringify(userMessage.content);
  
  const transactions = [];
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

// Helper functions for merchant/category extraction (same as before)
function extractMerchantFromNarration(narration) {
  const patterns = [
    /\/([A-Z][A-Za-z\s]+?)(?:\s*-\s*\d+|$)/,
    /TRF (?:TO|FROM)\s+([A-Z][A-Za-z\s]+?)(?:\s+\d+|$)/,
    /Paystack\/[^\/]+\/([A-Za-z0-9]+)/,
    /for\s+([A-Z][A-Za-z\s]{3,30})/,
  ];
  for (const pattern of patterns) {
    const match = narration.match(pattern);
    if (match) return match[1].trim().substring(0, 40);
  }
  const words = narration.split(/\s+/);
  for (let w of words) {
    if (w.length > 4 && w[0] === w[0].toUpperCase() && !w.includes('/')) {
      return w.substring(0, 40);
    }
  }
  return "Unknown Merchant";
}

function guessCategoryFromNarration(narration) {
  const lower = narration.toLowerCase();
  if (lower.includes('food') || lower.includes('restaurant') || lower.includes('cafe')) return 'Food & Dining';
  if (lower.includes('bet') || lower.includes('sporty') || lower.includes('gaming')) return 'Betting & Gaming';
  if (lower.includes('transport') || lower.includes('bus') || lower.includes('logistics')) return 'Transport';
  if (lower.includes('sms') || lower.includes('fee') || lower.includes('charge') || lower.includes('commission')) return 'Bank Fees';
  if (lower.includes('paystack') || lower.includes('transfer')) return 'Transfer';
  if (lower.includes('access') && lower.includes('bank')) return 'Bank Transfer';
  if (lower.includes('roblox') || lower.includes('google')) return 'Entertainment';
  if (lower.includes('piggytech')) return 'Savings';
  return 'Other';
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
