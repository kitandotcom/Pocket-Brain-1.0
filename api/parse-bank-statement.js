// api/parse-bank-statement.js
import pdfParse from 'pdf-parse';

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { fileBase64, contentType } = req.body;
  if (!fileBase64 || contentType !== "application/pdf") {
    return res.status(400).json({ error: "Valid PDF file required (Base64)" });
  }

  try {
    const pdfBuffer = Buffer.from(fileBase64, "base64");
    const pdfData = await pdfParse(pdfBuffer);
    const fullText = pdfData.text;

    const result = parseAccessBankStatement(fullText);
    return res.status(200).json(result);
  } catch (error) {
    console.error("Parsing error:", error);
    return res.status(500).json({ error: "Failed to parse statement", details: error.message });
  }
}

function parseAccessBankStatement(text) {
  // ----- Account Summary -----
  const summary = { openingBalance: 0, totalDebits: 0, totalCredits: 0, closingBalance: 0 };
  const retailMatch = text.match(/165\*\*\*289.*?([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})/);
  if (retailMatch) {
    summary.openingBalance = parseFloat(retailMatch[1].replace(/,/g, ''));
    summary.totalDebits = parseFloat(retailMatch[2].replace(/,/g, ''));
    summary.totalCredits = parseFloat(retailMatch[3].replace(/,/g, ''));
    summary.closingBalance = parseFloat(retailMatch[4].replace(/,/g, ''));
  }

  // ----- Transactions -----
  const transactions = [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Look for a line that starts with a date like DD/MM/YYYY
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(line)) {
      const postDate = line;
      i++;
      if (i >= lines.length) break;
      const valueDate = lines[i];
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(valueDate)) {
        i++;
        continue;
      }
      i++;
      
      // Collect narration (may span multiple lines)
      let narrationParts = [];
      while (i < lines.length && !/^\d{2}\/\d{2}\/\d{4}$/.test(lines[i]) && !/^[\d,]+\.\d{2}$/.test(lines[i])) {
        narrationParts.push(lines[i]);
        i++;
      }
      const narration = narrationParts.join(' ').replace(/\s+/g, ' ').trim();
      
      // Next token is reference number (alphanumeric, often long)
      let refNumber = '';
      if (i < lines.length && /^[A-Z0-9]{6,}$/.test(lines[i])) {
        refNumber = lines[i];
        i++;
      }
      
      // Next is debit amount (or blank if credit)
      let debit = 0;
      let credit = 0;
      if (i < lines.length && /^[\d,]+\.\d{2}$/.test(lines[i])) {
        const amount = parseFloat(lines[i].replace(/,/g, ''));
        // Determine if debit or credit based on context (narration often contains "TRF TO" for debit, "TRF FROM" for credit)
        if (narration.includes('TRF TO') || narration.includes('Paystack') || narration.includes('COMMISSION') || narration.includes('VAT') || narration.includes('SMS Alert') || narration.includes('WEB PYMT')) {
          debit = amount;
        } else if (narration.includes('TRF FROM') || narration.includes('Transfer from') || narration.includes('NIP TFR FROM')) {
          credit = amount;
        } else {
          // Fallback: assume credit if positive and no "TO" indicator
          credit = amount;
        }
        i++;
      }
      
      // Next is balance (optional, may be missing)
      let balance = 0;
      if (i < lines.length && /^[\d,]+\.\d{2}$/.test(lines[i])) {
        balance = parseFloat(lines[i].replace(/,/g, ''));
        i++;
      }
      
      transactions.push({
        postDate,
        valueDate,
        narration,
        refNumber,
        debit,
        credit,
        balance
      });
    } else {
      i++;
    }
  }
  
  return {
    bank: "Access Bank (Nigeria)",
    summary,
    transactions,
    rawText: text.substring(0, 1000) // optional, truncate for response size
  };
}
