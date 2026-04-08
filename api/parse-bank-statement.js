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
  // ----- Account Summary (from the retail accounts table) -----
  const summary = { openingBalance: 0, totalDebits: 0, totalCredits: 0, closingBalance: 0 };
  const retailMatch = text.match(/165\*\*\*289.*?([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})/);
  if (retailMatch) {
    summary.openingBalance = parseFloat(retailMatch[1].replace(/,/g, ''));
    summary.totalDebits = parseFloat(retailMatch[2].replace(/,/g, ''));
    summary.totalCredits = parseFloat(retailMatch[3].replace(/,/g, ''));
    summary.closingBalance = parseFloat(retailMatch[4].replace(/,/g, ''));
  }

  // ----- Transactions -----
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const transactions = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Transaction starts with a line that is exactly a date (DD/MM/YYYY)
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

      // Collect narration (may span multiple lines until we hit a long number)
      let narrationParts = [];
      while (i < lines.length && !/^\d{2}\/\d{2}\/\d{4}$/.test(lines[i]) && !/^[\d,]+\.\d{2}$/.test(lines[i])) {
        // Stop if we encounter a long numeric string (reference number)
        if (/^\d{10,}$/.test(lines[i])) break;
        narrationParts.push(lines[i]);
        i++;
      }
      const narration = narrationParts.join(' ').replace(/\s+/g, ' ').trim();

      // First reference number (long, e.g., 000014260203220757245428)
      let ref1 = '';
      if (i < lines.length && /^\d{20,}$/.test(lines[i])) {
        ref1 = lines[i];
        i++;
      }

      // Second reference number (shorter, e.g., 781373)
      let ref2 = '';
      if (i < lines.length && /^\d{6,}$/.test(lines[i]) && !/^\d{2}\/\d{2}\/\d{4}$/.test(lines[i])) {
        ref2 = lines[i];
        i++;
      }

      // Debit amount (positive number with commas and two decimals)
      let debit = 0;
      if (i < lines.length && /^[\d,]+\.\d{2}$/.test(lines[i])) {
        debit = parseFloat(lines[i].replace(/,/g, ''));
        i++;
      }

      // Balance after transaction
      let balance = 0;
      if (i < lines.length && /^[\d,]+\.\d{2}$/.test(lines[i])) {
        balance = parseFloat(lines[i].replace(/,/g, ''));
        i++;
      }

      // Determine credit amount: if narration indicates incoming money
      let credit = 0;
      if (narration.includes('TRF FROM') || narration.includes('Transfer from') || narration.includes('NIP TFR FROM')) {
        credit = debit;
        debit = 0;
      }

      transactions.push({
        postDate,
        valueDate,
        narration,
        reference1: ref1,
        reference2: ref2,
        debit,
        credit,
        balance
      });
    } else {
      i++;
    }
  }

  return {
    bank: "Access Bank Nigeria",
    summary,
    transactions,
    transactionCount: transactions.length
  };
}
