import { readAttribution, ATTRIBUTION_COLUMNS } from "./_shared/attribution.js";
// Rank Labs Contact Form Handler — Cloudflare Pages Function
// Submissions are delivered by email only (Resend: hello@ -> josiah@getranklabs.com).

const FROM = "Rank Labs <hello@getranklabs.com>";
const TO = "josiah@getranklabs.com";

function analyticsFormType(type) {
  if (type === "contact") return "contact";
  if (type === "existing-site") return "existing-site";
  return "new-site";
}

function analyticsPagePath(value) {
  if (typeof value !== "string" || !value.trim()) return "/contact";
  const path = value.trim().split(/[?#]/, 1)[0];
  return path.startsWith("/") ? path.slice(0, 2048) : "/contact";
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function clean(value, max = 2000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function isFreeAudit(data) {
  return clean(data.intent, 50).toLowerCase() === "free-audit";
}

export function buildEmail(data, subId) {
  const name = clean(data.name, 200);
  const email = clean(data.email, 320);
  const url = clean(data.url, 500);
  const business = clean(data.business, 200);
  const plan = clean(data.plan, 100);
  const notes = clean(data.notes, 5000);
  const intent = clean(data.intent, 50);
  const freeAudit = isFreeAudit(data);
  const submitted = new Date(data.submittedAt);
  const submittedText = Number.isNaN(submitted.getTime())
    ? new Date().toISOString()
    : submitted.toLocaleString("en-US", { timeZone: "America/New_York" }) + " ET";

  const rows = [
    ["Submission ID", subId],
    ["Request type", freeAudit ? "Free AI Visibility Audit" : "Contact"],
    ["Intent", intent || "(none)"],
    ["Plan", plan || "(none)"],
    ["Name", name],
    ["Email", email],
    ["Website", url || "N/A"],
    ...(business ? [["Business", business]] : []),
    ["Form type", clean(data.type, 50) || "contact"],
    ["Page", clean(data.page_path, 300) || "/contact"],
    ["Submitted", submittedText],
  ];

  const target = url || business || name;
  const subject = freeAudit
    ? `Approve Free AI Visibility Audit: ${target} (${subId})`
    : `New Contact: ${name}${plan ? ` [${plan}]` : ""} (${subId})`;

  const heading = freeAudit ? "Free AI Visibility Audit request — approval needed" : "New contact message";
  const approval = freeAudit
    ? `<p style="background:#3b2a00;color:#ffd479;padding:12px;border-radius:8px"><strong>Nothing runs until Josiah approves.</strong> This audit is run manually — reply to the visitor once it is approved and done.</p>`
    : "";
  const table = rows
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#9aa4b2"><strong>${escapeHtml(k)}</strong></td><td style="padding:4px 0">${escapeHtml(v)}</td></tr>`)
    .join("");
  const message = notes
    ? `<p><strong>Message:</strong></p><p style="background:#161b22;padding:12px;border-radius:8px;white-space:pre-wrap">${escapeHtml(notes)}</p>`
    : "";
  const html = `<div style="font-family:-apple-system,sans-serif;background:#0f1117;color:#e1e4e8;padding:24px;border-radius:12px"><h2 style="color:#7c3aed">${escapeHtml(heading)}</h2>${approval}<table>${table}</table>${message}</div>`;

  const text = [
    heading,
    ...(freeAudit ? ["Nothing runs until Josiah approves. This audit is run manually."] : []),
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(notes ? ["", "Message:", notes] : []),
  ].join("\n");

  return { subject, html, text, replyTo: email };
}

function json(body, status, corsHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export async function onRequestPost(context) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  let data;
  try {
    data = await context.request.json();
  } catch {
    return json({ error: "Invalid request body" }, 400, corsHeaders);
  }
  if (!data || !clean(data.name) || !clean(data.email)) {
    return json({ error: "Name and email are required" }, 400, corsHeaders);
  }

  const subId = `SUB-${Date.now().toString(36).toUpperCase()}`;

  // 1. Email — the only delivery channel. Its failure is the only 500.
  try {
    const resendKey = context.env.RESEND_API_KEY;
    if (!resendKey) throw new Error("Email not configured");
    const { subject, html, text, replyTo } = buildEmail(data, subId);
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: TO, subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
    });
    if (!resp.ok) throw new Error(`Email send failed (${resp.status})`);
  } catch (e) {
    console.error("Contact email failed:", e.message);
    return json({ error: "Unable to send your message. Please email hello@getranklabs.com" }, 500, corsHeaders);
  }

  // 2. Analytics (D1) — best-effort, never affects the response.
  try {
    if (context.env.PERFORMANCE_DB) {
      const receivedAt = new Date().toISOString();
      const submittedAt = new Date(data.submittedAt);
      const occurredAt = Number.isNaN(submittedAt.getTime()) ? receivedAt : submittedAt.toISOString();
      // First-touch attribution captured by the page (see Layout.astro).
      const _attr = readAttribution(data);
      const event = context.env.PERFORMANCE_DB.prepare(`
        INSERT INTO performance_events
          (id, customer_id, event_name, occurred_at, received_at, form_id, form_type, page_path, event_version,
          referrer_url, referrer_host, landing_page, utm_source, utm_medium, utm_campaign, gclid,
          ga_client_id, attributed_channel)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        "getranklabs",
        "generate_lead",
        occurredAt,
        receivedAt,
        "contact",
        analyticsFormType(data.type),
        analyticsPagePath(data.page_path),
        1,
        ...ATTRIBUTION_COLUMNS.map((c) => _attr[c]),
      ).run().catch((error) => {
        console.error("Performance event logging failed:", error.message);
      });
      if (typeof context.waitUntil === "function") context.waitUntil(event);
    }
  } catch (e) {
    console.error("Performance event logging failed:", e.message);
  }

  return json({ success: true, id: subId }, 200, corsHeaders);
}

// Handle CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}
