// netlify/functions/send-pdf.js
const nodemailer = require("nodemailer");

// Storefront origins allowed to call this from a browser (CORS is defense-in-depth,
// not auth — a non-browser client can still reach the endpoint).
const ALLOWED_ORIGINS = [
  "https://muriphys.com",
  "https://www.muriphys.com",
  "https://d07dan-c1.myshopify.com",
];

// Attachment limits. The frontend also caps these, but never trust the client.
const ALLOWED_EXT = ["pdf", "doc", "docx", "png", "jpg", "jpeg"];
const CONTENT_TYPES = {
  pdf:  "application/pdf",
  doc:  "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png:  "image/png",
  jpg:  "image/jpeg",
  jpeg: "image/jpeg",
};
const MAX_FILES       = 6;                  // study PDF + uploads combined
const MAX_FILE_BYTES  = 5 * 1024 * 1024;    // per attachment
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;    // all attachments combined
const MAX_BODY_BYTES  = 9 * 1024 * 1024;    // raw request body (Lambda also caps ~6MB)

const extOf = (name) => (String(name).split(".").pop() || "").toLowerCase();
const clip  = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");

exports.handler = async (event) => {
  /* 1.  CORS + pre-flight (locked to the storefront origins) */
  const origin = event.headers.origin || event.headers.Origin || "";
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  const CORS_HEADERS = {
    "Access-Control-Allow-Origin":  allowOrigin,
    "Vary":                         "Origin",
    "Access-Control-Allow-Headers": "Content-Type,x-api-key",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
  };
  const fail = (code, msg) => ({ statusCode: code, headers: CORS_HEADERS, body: JSON.stringify({ error: msg }) });

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  if (event.httpMethod !== "POST")    return fail(405, "Method not allowed");

  /* 2.  Auth header. NOTE: this key ships in the public theme, so it is only a speed-bump. */
  if (event.headers["x-api-key"] !== process.env.FUNC_API_KEY) {
    return fail(401, "Unauthorized");
  }

  /* 3.  Body-size guard + parse */
  if (event.body && event.body.length > MAX_BODY_BYTES) return fail(413, "Payload too large");
  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return fail(400, "Invalid JSON payload");
  }

  const { customer, pdfDataUri, quotePdf, uploads } = payload;
  const summaryUri = quotePdf || pdfDataUri;
  const uploadList = Array.isArray(uploads) ? uploads : [];

  if (!customer || typeof customer !== "object" || Array.isArray(customer)) {
    return fail(400, "Missing or invalid customer");
  }
  if (!summaryUri && uploadList.length === 0) return fail(400, "Missing study file");
  if (uploadList.length + (summaryUri ? 1 : 0) > MAX_FILES) {
    return fail(400, `Too many files (max ${MAX_FILES})`);
  }

  const name  = clip(customer.name, 200)  || "Unknown";
  const email = clip(customer.email, 200) || "no email";

  /* 4.  Build attachments with type + size enforcement */
  const attachments = [];
  let totalBytes = 0;

  const addAttachment = (filename, b64, contentType) => {
    let buf;
    try {
      buf = Buffer.from(b64 || "", "base64");
    } catch {
      return "Could not decode an attachment";
    }
    if (buf.length === 0)              return "An attachment was empty";
    if (buf.length > MAX_FILE_BYTES)   return "An attachment is too large";
    totalBytes += buf.length;
    if (totalBytes > MAX_TOTAL_BYTES)  return "Attachments are too large";
    attachments.push({ filename, content: buf, contentType });
    return null;
  };

  if (summaryUri) {
    const err = addAttachment(`${name} Study Design.pdf`, String(summaryUri).split(",").pop(), "application/pdf");
    if (err) return fail(400, err);
  }

  for (const up of uploadList) {
    if (!up || !up.content) continue;
    const cleanName = clip(up.filename, 200).replace(/[\r\n"\\/]/g, "") || "uploaded-study";
    const ext = extOf(cleanName);
    if (!ALLOWED_EXT.includes(ext)) {
      return fail(400, `File type not allowed (allowed: ${ALLOWED_EXT.join(", ")})`);
    }
    const raw = String(up.content);
    const b64 = raw.includes(",") ? raw.split(",").pop() : raw;
    const err = addAttachment(cleanName, b64, CONTENT_TYPES[ext]);
    if (err) return fail(400, err);
  }

  if (attachments.length === 0) return fail(400, "No valid files to send");

  /* 5.  Send via Gmail SMTP */
  const sender = process.env.GMAIL_USER || "neurophys2@gmail.com";
  const recipients = (process.env.MAIL_TO || sender).split(",").map((s) => s.trim()).filter(Boolean);

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: sender, pass: process.env.GMAIL_APP_PASSWORD },
  });

  try {
    await transporter.sendMail({
      from:    `Muriphys Studies <${sender}>`,
      to:      recipients,
      subject: summaryUri
        ? `New Muriphys Study Design from ${name}`
        : `New Muriphys Study Upload from ${name}`,
      text:    `Submission from ${name} <${email}>.\n\n${attachments.length} file(s) attached.\n\n` +
               `Note: this form is public; attachments are uploaded by an unauthenticated visitor — treat them as untrusted.`,
      attachments,
    });
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ message: "Email sent" }) };
  } catch (err) {
    console.error("Gmail SMTP error:", err.message); // detail stays server-side only
    return fail(502, "Failed to send email");
  }
};
