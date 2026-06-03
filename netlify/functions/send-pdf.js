// netlify/functions/send-pdf.js
const nodemailer = require("nodemailer");

exports.handler = async (event) => {
  /* ──────────────────────────────────────────────────────────────
   * 1.  CORS + pre-flight
   * ──────────────────────────────────────────────────────────── */
  const CORS_HEADERS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type,x-api-key",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  /* ──────────────────────────────────────────────────────────────
   * 2.  Auth header
   * ──────────────────────────────────────────────────────────── */
  if (event.headers["x-api-key"] !== process.env.FUNC_API_KEY) {
    return { statusCode: 401, headers: CORS_HEADERS, body: "Unauthorized" };
  }

  /* ──────────────────────────────────────────────────────────────
   * 3.  Parse payload
   * ──────────────────────────────────────────────────────────── */
  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: "Invalid JSON payload" };
  }

  const { customer, pdfDataUri, quotePdf, uploads } = payload;
  const summaryUri = quotePdf || pdfDataUri; // front-end sends `quotePdf`
  const uploadList = Array.isArray(uploads) ? uploads : [];

  // need a customer plus at least one of: a generated study PDF, or an uploaded file
  if (!customer || (!summaryUri && uploadList.length === 0)) {
    return { statusCode: 400, headers: CORS_HEADERS, body: "Missing customer or study file" };
  }

  /* ──────────────────────────────────────────────────────────────
   * 4.  Build the attachments
   *     - the generated study-design PDF (when the form was filled out)
   *     - any files the user uploaded (existing studies / supporting docs)
   * ──────────────────────────────────────────────────────────── */
  const attachments = [];

  if (summaryUri) {
    attachments.push({
      filename: `${customer.name || "Unknown"} Study Design.pdf`,
      content:  Buffer.from(summaryUri.split(",")[1], "base64"),
    });
  }

  for (const up of uploadList) {
    if (!up || !up.content) continue;
    const raw = String(up.content);
    const b64 = raw.includes(",") ? raw.split(",")[1] : raw; // tolerate data-URI or bare base64
    attachments.push({
      filename: (up.filename || "uploaded-study").replace(/[\r\n"]/g, ""),
      content:  Buffer.from(b64, "base64"),
    });
  }

  /* ──────────────────────────────────────────────────────────────
   * 5.  Send the email via Gmail SMTP
   *     GMAIL_USER          = neurophys2@gmail.com (the sending account)
   *     GMAIL_APP_PASSWORD  = 16-char Google "app password" (NOT the login password)
   *     MAIL_TO             = comma-separated recipients (defaults to the sender)
   * ──────────────────────────────────────────────────────────── */
  const sender = process.env.GMAIL_USER || "neurophys2@gmail.com";
  const recipients = (process.env.MAIL_TO || sender)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: sender,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  try {
    await transporter.sendMail({
      from:    `Muriphys Studies <${sender}>`,
      to:      recipients,
      subject: summaryUri
        ? `New Muriphys Study Design from ${customer.name || "Unknown"}`
        : `New Muriphys Study Upload from ${customer.name || "Unknown"}`,
      text:    `Submission from ${customer.name || "Unknown"} <${customer.email || "no email"}>.\n\n${attachments.length} file(s) attached.`,
      attachments,
    });

    return {
      statusCode: 200,
      headers:    CORS_HEADERS,
      body:       JSON.stringify({ message: "Email sent" }),
    };
  } catch (err) {
    console.error("Gmail SMTP error:", err.message);
    return {
      statusCode: 500,
      headers:    CORS_HEADERS,
      body:       JSON.stringify({ error: err.message }),
    };
  }
};
