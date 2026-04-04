export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { reference } = req.body;
  if (!reference) return res.status(400).json({ error: "No reference provided" });

  try {
    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: {
        "Authorization": `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      },
    });

    const data = await response.json();

    if (!data.status || data.data?.status !== "success") {
      return res.status(400).json({ success: false, message: "Payment not successful" });
    }

    return res.status(200).json({
      success: true,
      email: data.data.customer.email,
      amount: data.data.amount / 100, // Paystack returns in kobo
      reference: data.data.reference,
    });
  } catch (err) {
    return res.status(500).json({ error: "Verification error: " + err.message });
  }
}
