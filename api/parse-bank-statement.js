// api/parse-bank-statement.js
import pdfParse from 'pdf-parse';

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { fileBase64, fileType } = req.body;
  if (!fileBase64) {
    return res.status(400).json({ error: "No file provided" });
  }

  try {
    const pdfBuffer = Buffer.from(fileBase64, "base64");
    const pdfData = await pdfParse(pdfBuffer);
    const fullText = pdfData.text;

    if (!fullText || fullText.trim().length === 0) {
      return res.status(400).json({ success: false, error: "No text extracted from PDF" });
    }

    const transactions = parseAccessBankTransactions(fullText);
    return res.status(200).json({ success: true, transactions });
  } catch (error) {
    console.error("Parsing error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

function parseAccessBankTransactions(text) {
  const transactions = [];
  
  // Pattern to match each transaction line
  // Format: date1 date2 narration... ref1 ref2 amount balance
  // We'll capture: date1, date2, narration (everything between dates and the first long number), amount, balance
  const transactionPattern = /(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+([A-Za-z0-9\s\/*#\-&]+?)\s+(\d{15,})\s+(\d{6,})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})/g;
  
  let match;
  while ((match = transactionPattern.exec(text)) !== null) {
    const postDate = match[1];
    const valueDate = match[2];
    let narration = match[3].trim();
    const refLong = match[4];
    const refShort = match[5];
    let amount = parseFloat(match[6].replace(/,/g, ''));
    const balance = parseFloat(match[7].replace(/,/g, ''));
    
    // Clean narration
    narration = narration.replace(/\s+/g, ' ').trim();
    narration = narration.replace(/MOBILE TRF TO MMF\/\s*/g, '');
    narration = narration.replace(/COMMISSION\s+/g, '');
    narration = narration.replace(/VAT\s+/g, '');
    
    // Determine debit or credit
    let type = "debit";
    if (narration.includes("TRF FROM") || narration.includes("Transfer from") || narration.includes("NIP TFR FROM")) {
      type = "credit";
    }
    
    // Special cases
    if (narration.includes("FGN STAMP DUTY")) {
      type = "debit";
    }
    if (narration.includes("SMS Alert Fee")) {
      type = "debit";
    }
    
    // Extract merchant
    let merchant = extractMerchant(narration);
    let category = guessCategory(narration, merchant);
    
    transactions.push({
      date: postDate,
      narration: narration,
      amount: amount,
      type: type,
      merchant: merchant,
      category: category
    });
  }
  
  // Fallback: if regex didn't work, try a simpler pattern that catches transactions with line breaks
  if (transactions.length === 0) {
    // Simpler pattern: date, date, then capture up to a number with commas
    const simplePattern = /(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+([\s\S]*?)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})/g;
    let simpleMatch;
    while ((simpleMatch = simplePattern.exec(text)) !== null) {
      let narration = simpleMatch[3].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      let amount = parseFloat(simpleMatch[4].replace(/,/g, ''));
      let balance = parseFloat(simpleMatch[5].replace(/,/g, ''));
      
      // Remove reference numbers from narration if they appear
      narration = narration.replace(/\d{10,}/g, '').trim();
      
      let type = "debit";
      if (narration.includes("TRF FROM") || narration.includes("Transfer from") || narration.includes("NIP TFR FROM")) {
        type = "credit";
      }
      
      let merchant = extractMerchant(narration);
      let category = guessCategory(narration, merchant);
      
      transactions.push({
        date: simpleMatch[1],
        narration: narration,
        amount: amount,
        type: type,
        merchant: merchant,
        category: category
      });
    }
  }
  
  return transactions;
}

function extractMerchant(narration) {
  const patterns = [
    /\/([A-Z][A-Za-z\s]+?)(?:\s*-\s*\d+|$)/,
    /TRF (?:TO|FROM)\s+([A-Z][A-Za-z\s]+?)(?:\s+\d+|$)/,
    /Paystack\/[^\/]+\/([A-Za-z0-9]+)/,
    /for\s+([A-Z][A-Za-z\s]{3,30})/,
    /-\s+([A-Z][A-Za-z\s]{3,30})/,
  ];
  for (const pattern of patterns) {
    const match = narration.match(pattern);
    if (match) return match[1].trim().substring(0, 40);
  }
  const words = narration.split(/\s+/);
  for (let w of words) {
    if (w.length > 4 && w[0] === w[0].toUpperCase() && !w.includes('/') && !w.includes('*') && !w.includes('#')) {
      return w.substring(0, 40);
    }
  }
  return "Unknown Merchant";
}

function guessCategory(narration, merchant) {
  const lower = (narration + ' ' + merchant).toLowerCase();
  if (lower.includes('food') || lower.includes('restaurant') || lower.includes('cafe')) return 'Food & Dining';
  if (lower.includes('bet') || lower.includes('sporty') || lower.includes('gaming')) return 'Betting & Gaming';
  if (lower.includes('transport') || lower.includes('bus') || lower.includes('logistics')) return 'Transport';
  if (lower.includes('sms') || lower.includes('fee') || lower.includes('charge') || lower.includes('commission')) return 'Bank Fees';
  if (lower.includes('paystack') || lower.includes('transfer')) return 'Transfer';
  if (lower.includes('access') && lower.includes('bank')) return 'Bank Transfer';
  if (lower.includes('roblox') || lower.includes('google')) return 'Entertainment';
  if (lower.includes('piggytech')) return 'Savings';
  if (lower.includes('stamp duty')) return 'Tax';
  return 'Other';
}
