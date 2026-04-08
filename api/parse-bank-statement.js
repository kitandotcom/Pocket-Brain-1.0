// /api/parse-bank-statement.js
import pdfParse from 'pdf-parse';

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { fileBase64, fileType } = req.body;
  if (!fileBase64) return res.status(400).json({ error: "No file provided" });

  try {
    // Extract text from PDF using pdf-parse
    const pdfText = await extractTextFromPDF(fileBase64);
    
    // Detect which bank this statement is from
    const bankType = detectBankType(pdfText);
    
    // Parse based on bank type
    const transactions = parseNigerianBankStatement(pdfText, bankType);
    
    return res.status(200).json({ 
      success: true, 
      transactions: transactions,
      count: transactions.length,
      bank: bankType
    });
    
  } catch (error) {
    console.error("Parse error:", error);
    return res.status(500).json({ error: error.message });
  }
}

// ============================================================
// PDF TEXT EXTRACTION (NOW REAL)
// ============================================================
async function extractTextFromPDF(base64Data) {
  const buffer = Buffer.from(base64Data, 'base64');
  const data = await pdfParse(buffer);
  return data.text;
}

// ============================================================
// BANK DETECTION
// ============================================================
function detectBankType(text) {
  const textLower = text.toLowerCase();
  
  if (textLower.includes('access bank') || textLower.includes('accessbank')) return 'ACCESS';
  if (textLower.includes('gtbank') || textLower.includes('guaranty trust')) return 'GTBANK';
  if (textLower.includes('first bank') || textLower.includes('firstbank')) return 'FIRSTBANK';
  if (textLower.includes('uba') || textLower.includes('united bank for africa')) return 'UBA';
  if (textLower.includes('zenith') || textLower.includes('zenith bank')) return 'ZENITH';
  if (textLower.includes('kuda') || textLower.includes('kudabank')) return 'KUDA';
  if (textLower.includes('opal') || textLower.includes('opay')) return 'OPAY';
  if (textLower.includes('sterling') || textLower.includes('sterling bank')) return 'STERLING';
  if (textLower.includes('wema') || textLower.includes('wema bank')) return 'WEMA';
  if (textLower.includes('stanbic') || textLower.includes('stanbic ibtc')) return 'STANBIC';
  if (textLower.includes('providus')) return 'PROVIDUS';
  if (textLower.includes('fidelity')) return 'FIDELITY';
  if (textLower.includes('union bank')) return 'UNION';
  
  return 'UNKNOWN';
}

// ============================================================
// MAIN PARSER - COMBINES ALL STRATEGIES
// ============================================================
function parseNigerianBankStatement(text, bankType) {
  let transactions = [];
  
  // Try specific bank parsers first
  const specificParsers = {
    'ACCESS': parseAccessBankFormat,
    'GTBANK': parseGTBankFormat,
    'FIRSTBANK': parseFirstBankFormat,
    'UBA': parseUBAFormat,
    'ZENITH': parseZenithFormat,
    'KUDA': parseKudaFormat,
  };
  
  if (specificParsers[bankType]) {
    transactions = specificParsers[bankType](text);
  }
  
  // If specific parser found nothing, try generic strategies
  if (transactions.length === 0) {
    const genericStrategies = [
      parseStandardTableFormat,
      parseCSVFormat,
      parseLineByLine,
      parseWithRegexPatterns
    ];
    
    for (const strategy of genericStrategies) {
      const result = strategy(text);
      if (result && result.length > 0) {
        transactions = result;
        break;
      }
    }
  }
  
  // Remove duplicates
  transactions = removeDuplicates(transactions);
  
  // Enrich with categories and merchants
  transactions = enrichTransactions(transactions);
  
  return transactions;
}

// ============================================================
// BANK-SPECIFIC PARSERS
// ============================================================

// Access Bank
function parseAccessBankFormat(text) {
  const transactions = [];
  const lines = text.split('\n');
  let inTransactionTable = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.includes('Post Date') && line.includes('Value Date')) {
      inTransactionTable = true;
      continue;
    }
    
    if (!inTransactionTable) continue;
    
    if (line.match(/^\d{2}\/\d{2}\/\d{4}/)) {
      const parts = line.trim().split(/\s{2,}/);
      
      if (parts.length >= 5) {
        let narration = parts[2] || '';
        let debit = parts[3] !== '-' ? parseAmount(parts[3]) : 0;
        let credit = parts[4] !== '-' ? parseAmount(parts[4]) : 0;
        
        if (debit > 0 || credit > 0) {
          transactions.push({
            date: formatDate(parts[0]),
            narration: cleanNarration(narration),
            amount: debit > 0 ? debit : credit,
            type: debit > 0 ? 'debit' : 'credit'
          });
        }
      }
    }
    
    if (line.includes('You must advise')) break;
  }
  
  return transactions;
}

// GTBank
function parseGTBankFormat(text) {
  const transactions = [];
  const lines = text.split('\n');
  
  for (const line of lines) {
    const match = line.match(/(\d{2}\/\d{2}\/\d{4})\s+[\d:]+\s+(.+?)\s+(?:N|NGN|₦)\s*([\d,]+\.\d{2})/i);
    if (match) {
      transactions.push({
        date: formatDate(match[1]),
        narration: cleanNarration(match[2]),
        amount: parseAmount(match[3]),
        type: 'debit'
      });
    }
  }
  
  return transactions;
}

// First Bank
function parseFirstBankFormat(text) {
  const transactions = [];
  const lines = text.split('\n');
  
  for (const line of lines) {
    const match = line.match(/(\d{1,2}-[A-Za-z]{3}-\d{4})\s*[|\|]\s*(.+?)\s*[|\|]\s*([\d,]+\.\d{2})\s*[|\|]?\s*(Dr|Cr)?/i);
    if (match) {
      transactions.push({
        date: formatDate(match[1]),
        narration: cleanNarration(match[2]),
        amount: parseAmount(match[3]),
        type: match[4] === 'Dr' ? 'debit' : 'credit'
      });
    }
  }
  
  return transactions;
}

// UBA
function parseUBAFormat(text) {
  const transactions = [];
  const lines = text.split('\n');
  
  for (const line of lines) {
    const match = line.match(/(\d{2}\/\d{2}\/\d{4})\s+(Debit|Credit)\s+([\d,]+\.\d{2})\s+(.+)/i);
    if (match) {
      transactions.push({
        date: formatDate(match[1]),
        narration: cleanNarration(match[4]),
        amount: parseAmount(match[3]),
        type: match[2].toLowerCase()
      });
    }
  }
  
  return transactions;
}

// Zenith Bank
function parseZenithFormat(text) {
  const transactions = [];
  const lines = text.split('\n');
  
  for (const line of lines) {
    const match = line.match(/(\d{2}\/\d{2}\/\d{4})\s+([\d,]+\.\d{2})\s+(.+)/i);
    if (match && !match[3].toLowerCase().includes('balance')) {
      transactions.push({
        date: formatDate(match[1]),
        narration: cleanNarration(match[3]),
        amount: parseAmount(match[2]),
        type: 'debit'
      });
    }
  }
  
  return transactions;
}

// Kuda Bank
function parseKudaFormat(text) {
  const transactions = [];
  const lines = text.split('\n');
  
  for (const line of lines) {
    const match = line.match(/(?:spent|received)\s+(?:N|NGN|₦)\s*([\d,]+\.\d{2})\s+(?:at|from)\s+(.+?)\s+on\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i);
    if (match) {
      transactions.push({
        date: formatDate(match[3]),
        narration: cleanNarration(match[2]),
        amount: parseAmount(match[1]),
        type: line.toLowerCase().includes('spent') ? 'debit' : 'credit'
      });
    }
  }
  
  return transactions;
}

// ============================================================
// GENERIC PARSERS
// ============================================================

// Standard table format
function parseStandardTableFormat(text) {
  const transactions = [];
  const lines = text.split('\n');
  
  const patterns = [
    /(\d{2}[\/\-]\d{2}[\/\-]\d{2,4})\s+([A-Za-z0-9\s\.,\-]+?)\s+([\d,]+\.\d{2})?\s+([\d,]+\.\d{2})?\s+([\d,]+\.\d{2})/i,
    /(\d{2}[\/\-]\d{2}[\/\-]\d{2,4})\s+[-–]\s+(.+?)\s+[-–]\s+([\d,]+\.\d{2})/i,
    /(\d{2}[\/\-]\d{2}[\/\-]\d{2,4})\s+(.+?)\s+(?:NGN|N|₦)\s+([\d,]+\.\d{2})/i,
  ];
  
  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        const transaction = {
          date: formatDate(match[1]),
          narration: cleanNarration(match[2]),
          amount: parseAmount(match[3] || match[4] || match[2]),
          type: determineType(line, match)
        };
        
        if (transaction.amount > 0) {
          transactions.push(transaction);
        }
        break;
      }
    }
  }
  
  return transactions;
}

// CSV format
function parseCSVFormat(text) {
  const transactions = [];
  const lines = text.split('\n');
  
  for (const line of lines) {
    if (line.includes(',') && (line.includes('Debit') || line.includes('Credit') || line.includes('Amount'))) {
      const parts = line.split(',');
      if (parts.length >= 3) {
        let date = '', narration = '', amount = 0, type = 'debit';
        
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i].trim();
          if (part.match(/\d{2}[\/\-]\d{2}[\/\-]\d{2,4}/)) date = part;
          if (part.match(/[\d,]+\.\d{2}/)) amount = parseAmount(part);
          if (part.toLowerCase() === 'debit') type = 'debit';
          if (part.toLowerCase() === 'credit') type = 'credit';
          if (part.length > 5 && !part.match(/[\d,]/) && !part.match(/debit|credit/i)) narration = part;
        }
        
        if (amount > 0 && date) {
          transactions.push({
            date: formatDate(date),
            narration: cleanNarration(narration),
            amount: amount,
            type: type
          });
        }
      }
    }
  }
  
  return transactions;
}

// Line by line fallback
function parseLineByLine(text) {
  const transactions = [];
  const lines = text.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    const amountMatch = line.match(/(?:N|NGN|₦)\s*([\d,]+(?:\.\d{2})?)/i);
    if (!amountMatch) continue;
    
    const amount = parseAmount(amountMatch[1]);
    if (amount === 0) continue;
    
    let date = new Date().toISOString().split('T')[0];
    const dateMatch = line.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
    if (dateMatch) date = formatDate(dateMatch[1]);
    
    let narration = '';
    const textBeforeAmount = line.substring(0, line.indexOf(amountMatch[0]));
    const words = textBeforeAmount.split(/\s+/);
    
    for (let j = words.length - 1; j >= 0; j--) {
      if (words[j] && (words[j][0] === words[j][0].toUpperCase() || words[j].length > 3)) {
        narration = words.slice(Math.max(0, j-3), j+1).join(' ');
        break;
      }
    }
    
    if (!narration) narration = "Transaction";
    
    let type = 'debit';
    if (line.toLowerCase().includes('credit') || line.toLowerCase().includes('received')) {
      type = 'credit';
    }
    
    transactions.push({
      date: date,
      narration: cleanNarration(narration),
      amount: amount,
      type: type
    });
  }
  
  return transactions;
}

// Regex patterns catch-all
function parseWithRegexPatterns(text) {
  const transactions = [];
  
  const patterns = [
    /(?:N|NGN|₦)\s*([\d,]+\.\d{2})\s+(?:at|to|from|for)\s+([A-Z][A-Za-z\s]+?)(?:\s+on|\s+$|\s+\d)/i,
    /([A-Z][A-Za-z\s]{5,30}?)\s+(?:of|was)\s+(?:N|NGN|₦)\s*([\d,]+\.\d{2})/i,
    /(?:POS|MOBILE|TRF|TRANSFER|DEBIT|CREDIT)[:\s]+(.+?)\s+(?:N|NGN|₦)\s*([\d,]+\.\d{2})/i,
  ];
  
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const amount = parseAmount(match[1] || match[2]);
      const narration = cleanNarration(match[2] || match[1]);
      
      if (amount > 0 && narration.length > 2) {
        transactions.push({
          date: new Date().toISOString().split('T')[0],
          narration: narration,
          amount: amount,
          type: 'debit'
        });
      }
    }
  }
  
  return transactions;
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function cleanNarration(text) {
  if (!text) return '';
  
  let cleaned = text
    .replace(/\d{10,}/g, '')
    .replace(/[A-Z0-9]{8,}/g, '')
    .replace(/\/MMF\/|\/Food\/|\/Pay\/|\/Meds\/|\/Transportation\//gi, ' → ')
    .replace(/\s+/g, ' ')
    .trim();
  
  cleaned = cleaned.split(' ').map(word => 
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ');
  
  return cleaned.substring(0, 100);
}

function parseAmount(amountStr) {
  if (!amountStr) return 0;
  const cleaned = String(amountStr).replace(/[^0-9.-]/g, '');
  const amount = parseFloat(cleaned);
  return isNaN(amount) ? 0 : amount;
}

function formatDate(dateStr) {
  if (!dateStr) return new Date().toISOString().split('T')[0];
  
  let cleaned = dateStr.toString().trim();
  cleaned = cleaned.split(' ')[0];
  cleaned = cleaned.replace(/-/g, '/');
  
  const parts = cleaned.split('/');
  
  if (parts.length === 3) {
    if (parts[0].length === 4) {
      return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
    }
    let year = parts[2];
    if (year.length === 2) year = '20' + year;
    return `${year}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
  }
  
  const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const monthMatch = cleaned.match(/([A-Za-z]{3})/i);
  if (monthMatch) {
    const month = monthNames.indexOf(monthMatch[1].toLowerCase()) + 1;
    const dayMatch = cleaned.match(/(\d{1,2})/);
    const yearMatch = cleaned.match(/(20\d{2})/);
    if (dayMatch && yearMatch && month) {
      return `${yearMatch[1]}-${month.toString().padStart(2, '0')}-${dayMatch[1].padStart(2, '0')}`;
    }
  }
  
  return new Date().toISOString().split('T')[0];
}

function determineType(line, match) {
  const lineLower = line.toLowerCase();
  const text = match[0].toLowerCase();
  
  if (lineLower.includes('credit') || text.includes('credit') || lineLower.includes('received')) {
    return 'credit';
  }
  if (lineLower.includes('debit') || text.includes('debit') || lineLower.includes('spent') || lineLower.includes('paid')) {
    return 'debit';
  }
  return 'debit';
}

function removeDuplicates(transactions) {
  const seen = new Set();
  return transactions.filter(t => {
    const key = `${t.date}-${t.narration}-${t.amount}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function enrichTransactions(transactions) {
  return transactions.map(t => ({
    ...t,
    merchant: extractMerchant(t.narration),
    category: inferCategory(t.narration)
  }));
}

function extractMerchant(narration) {
  const merchants = [
    'CHICKEN REPUBLIC', 'UBER', 'BOLT', 'DSTV', 'GOTV', 'NETFLIX', 'SPOTIFY',
    'AMAZON', 'JUMIA', 'KONGA', 'SHOPRITE', 'ACCESS BANK', 'GTBANK', 'FIRST BANK',
    'UBA', 'ZENITH', 'KUDA', 'OPAY', 'SPORTYBET', 'PIGGYTECH', 'GOOGLE', 'ROBLOX'
  ];
  
  const upperNarration = narration.toUpperCase();
  
  for (const merchant of merchants) {
    if (upperNarration.includes(merchant)) {
      return merchant;
    }
  }
  
  const patterns = [/(?:TO|FROM|AT)\s+([A-Z\s]{3,30})/i, /([A-Z][A-Z\s]{5,25}?)(?:\s+-\s+|\s+$)/i];
  for (const pattern of patterns) {
    const match = narration.match(pattern);
    if (match) return match[1].trim();
  }
  
  const words = narration.split(' ');
  if (words.length > 0) {
    return words.slice(0, Math.min(3, words.length)).join(' ');
  }
  
  return 'Unknown Merchant';
}

function inferCategory(narration) {
  const lower = narration.toLowerCase();
  
  const categories = {
    'Food': /food|chicken|restaurant|kfc|burger|pizza|cafe|eatery|meal|dinner|lunch|chicken republic/i,
    'Transport': /transport|uber|bolt|taxi|bus|train|fuel|petrol|diesel|filling station/i,
    'Entertainment': /sportybet|bet|game|roblox|netflix|spotify|cinema|movie|dstv|gotv|showmax/i,
    'Utilities': /google|subscription|internet|wifi|data|airtime|electricity|water|bill|mtn|glo|airtel/i,
    'Shopping': /shop|store|mall|market|amazon|jumia|konga|supermarket|retail|boutique/i,
    'Savings': /piggytech|savings|invest|piggyvest|cowrywise|interest|dividend/i,
    'Transfer': /transfer|trf|send|receive|payment|pay|nibss|nip/i,
    'Health': /meds|health|hospital|clinic|pharmacy|drug|doctor|medical|wellness/i,
    'Education': /school|tuition|education|university|college|book|course|training/i,
    'Salary': /salary|wage|income|earning|commission/i
  };
  
  for (const [category, pattern] of Object.entries(categories)) {
    if (pattern.test(lower)) {
      return category;
    }
  }
  
  return 'Other';
}
