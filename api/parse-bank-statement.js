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
  
  // Locate the transaction table
  const tableStartMarker = "Post Date Value Date Narration Ref/Cheque No. Debits Credits Balance";
  const tableEndMarker = "You must advise Access Bank";
  
  let startIdx = text.indexOf(tableStartMarker);
  if (startIdx === -1) {
    startIdx = text.search(/\d{2}\/\d{2}\/\d{4}\s+\d{2}\/\d{2}\/\d{4}/);
  }
  let endIdx = text.indexOf(tableEndMarker);
  if (endIdx === -1) endIdx = text.length;
  
  if (startIdx === -1) return transactions;
  
  let tableText = text.substring(startIdx, endIdx);
  let lines = tableText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  // Skip header lines until first date
  let i = 0;
  while (i < lines.length && !/^\d{2}\/\d{2}\/\d{4}$/.test(lines[i])) {
    i++;
  }
  
  while (i < lines.length) {
    let line = lines[i];
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(line)) {
      i++;
      continue;
    }
    
    const postDate = line;
    i++;
    if (i >= lines.length) break;
    
    // Value date must be next line
    let valueDate = "";
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(lines[i])) {
      valueDate = lines[i];
      i++;
    } else {
      continue;
    }
    
    // Collect narration (multi-line until reference number or amount)
    let narrationParts = [];
    while (i < lines.length) {
      const next = lines[i];
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(next)) break;
      if (/^\d{10,}$/.test(next)) break;
      if (/^[\d,]+\.\d{2}$/.test(next)) break;
      narrationParts.push(next);
      i++;
    }
    let narration = narrationParts.join(' ').replace(/\s+/g, ' ').trim();
    
    // Skip reference numbers (two possible)
    while (i < lines.length && /^\d{6,}$/.test(lines[i]) && !/^\d{2}\/\d{2}\/\d{4}$/.test(lines[i])) {
      i++;
    }
    
    // Amount (debit or credit)
    let amount = 0;
    if (i < lines.length && /^[\d,]+\.\d{2}$/.test(lines[i])) {
      amount = parseFloat(lines[i].replace(/,/g, ''));
      i++;
    }
    
    // Optional balance
    if (i < lines.length && /^[\d,]+\.\d{2}$/.test(lines[i])) {
      i++;
    }
    
    // Determine type: credit if narration indicates incoming money
    let type = "debit";
    if (narration.includes("TRF FROM") || narration.includes("Transfer from") || narration.includes("NIP TFR FROM")) {
      type = "credit";
    }
    
    // Clean narration
    narration = narration.replace(/MOBILE TRF TO MMF\/\s*/g, '');
    narration = narration.replace(/COMMISSION\s+/g, '');
    narration = narration.replace(/VAT\s+/g, '');
    
    // Merchant & category
    let merchant = extractMerchant(narration);
    let category = guessCategory(narration, merchant);
    
    transactions.push({
      date: postDate,
      narration: narration || "Unknown",
      amount: amount,
      type: type,
      merchant: merchant,
      category: category
    });
  }
  
  return transactions;
}

function extractMerchant(narration) {
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
  return 'Other';
}
