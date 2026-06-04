// Rank Labs — Stripe Webhook Receiver (Cloudflare Pages Function)
// Receives Stripe events, verifies signature, sends notifications.
// No k3s ingress needed — everything runs on Cloudflare's edge.

export async function onRequestPost(context) {
  const sig = context.request.headers.get("stripe-signature");
  const STRIPE_SECRET_KEY = context.env.STRIPE_SECRET_KEY;
  const WEBHOOK_SECRET = context.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !WEBHOOK_SECRET) {
    return new Response("Missing signature or secret", { status: 400 });
  }

  let event;
  try {
    const body = await context.request.text();

    // Verify Stripe signature
    event = await verifyStripeSignature(body, sig, WEBHOOK_SECRET);
    if (!event) {
      return new Response("Invalid signature", { status: 400 });
    }
  } catch (e) {
    console.error("Webhook verification error:", e.message);
    return new Response(`Webhook error: ${e.message}`, { status: 400 });
  }

  console.log(`Stripe event: ${event.type}`);

  // Handle the event
  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object, context.env);
        break;
      case "customer.subscription.updated":
        console.log(`Subscription ${event.data.object.id} updated: ${event.data.object.status}`);
        break;
      case "customer.subscription.deleted":
        console.log(`Subscription ${event.data.object.id} deleted`);
        break;
    }
  } catch (e) {
    console.error(`Handler error for ${event.type}:`, e.message);
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Signature Verification (HMAC-SHA256) ─────────────────────────────────

async function verifyStripeSignature(body, sig, webhookSecret) {
  // Parse signature header: "t=1234567890,v1=abc123..."
  const parts = {};
  for (const part of sig.split(",")) {
    const [k, v] = part.trim().split("=");
    parts[k] = v;
  }

  const timestamp = parts.t;
  const signature = parts.v1;

  if (!timestamp || !signature) {
    console.error("Missing t= or v1= in signature header");
    return null;
  }

  // Compute expected signature: HMAC-SHA256(secret, "t.body")
  const signedPayload = `${timestamp}.${body}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sigBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedPayload)
  );

  // Convert to hex
  const expected = Array.from(new Uint8Array(sigBytes))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  // Timing-safe comparison
  if (expected.length !== signature.length) return null;
  let ok = 0;
  for (let i = 0; i < expected.length; i++) {
    ok |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }

  if (ok !== 0) {
    console.error("Signature mismatch");
    return null;
  }

  // Signature verified — parse the event
  return JSON.parse(body);
}

// ── Checkout Handler ──────────────────────────────────────────────────────

async function handleCheckoutCompleted(session, env) {
  const subscriptionId = session.subscription;
  if (!subscriptionId) return; // one-time payments

  const customerName = session.metadata?.customer_name || session.customer_details?.name || "New Customer";
  const customerEmail = session.customer_details?.email || session.metadata?.customer_email || "";
  const plan = session.metadata?.plan || "seo_management";
  const planLabel = plan === "full_management" ? "Full Management ($999/mo)" : "SEO Management ($599/mo)";
  const website = session.metadata?.website || "";
  const businessName = session.metadata?.business_name || "";

  console.log(`✅ New ${planLabel} signup: ${customerName} <${customerEmail}>`);

  // 1. Telegram notification to Josiah
  await notifyTelegram(env, { customerName, customerEmail, planLabel, website, businessName });

  // 2. Internal email to Josiah
  await sendEmail(env, {
    to: "josiahearl@gmail.com",
    subject: `🚀 New Signup: ${customerName} — ${planLabel}`,
    html: buildInternalEmail({ customerName, customerEmail, planLabel, website, businessName }),
  });

  // 3. Branded confirmation to customer
  if (customerEmail) {
    await sendEmail(env, {
      to: customerEmail,
      cc: "seo-admin@getranklabs.com",
      subject: `Welcome to Rank Labs! Your ${planLabel} Plan is Active`,
      html: buildConfirmationEmail({ customerName, plan, planLabel }),
    });

    // 4. Branded onboarding to customer
    await sendEmail(env, {
      to: customerEmail,
      cc: "seo-admin@getranklabs.com",
      subject: `Your Rank Labs Onboarding — ${planLabel}`,
      html: buildOnboardingEmail({ customerName, plan, planLabel, website, businessName }),
    });
  }

  console.log(`Notifications complete for ${customerEmail}`);
}

// ── Telegram ─────────────────────────────────────────────────────────────

async function notifyTelegram(env, { customerName, customerEmail, planLabel, website, businessName }) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID || "5016070713";

  if (!token) {
    console.log("Telegram token not configured");
    return;
  }

  let text = `<b>🚀 New Signup!</b>\n\n`;
  text += `<b>Plan:</b> ${planLabel}\n`;
  text += `<b>Name:</b> ${customerName}\n`;
  text += `<b>Email:</b> ${customerEmail}\n`;
  if (website) text += `<b>Website:</b> ${website}\n`;
  if (businessName) text += `<b>Business:</b> ${businessName}\n`;
  text += `\n<i>Reply to trigger onboarding.</i>`;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    console.log("Telegram sent");
  } catch (e) {
    console.error("Telegram failed:", e.message);
  }
}

// ── Email (via Resend — free tier: 100/day) ──────────────────────────────

async function sendEmail(env, { to, cc, subject, html }) {
  const resendKey = env.RESEND_API_KEY;

  if (!resendKey) {
    console.log(`Resend not configured — skipping email to ${to}`);
    return;
  }

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Rank Labs <hello@getranklabs.com>",
        to,
        cc,
        subject,
        html,
      }),
    });

    if (resp.ok) {
      console.log(`Email sent to ${to}`);
    } else {
      const err = await resp.json().catch(() => ({}));
      console.error(`Email failed to ${to}:`, JSON.stringify(err));
    }
  } catch (e) {
    console.error(`Email error to ${to}:`, e.message);
  }
}

// ── Email Templates ──────────────────────────────────────────────────────

function buildInternalEmail({ customerName, customerEmail, planLabel, website, businessName }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,sans-serif;background:#0f1117;color:#e1e4e8;padding:20px">
<div style="max-width:500px;margin:0 auto;background:#161b22;border-radius:12px;padding:24px;border:1px solid #7c3aed33">
  <div style="background:linear-gradient(135deg,#7c3aed,#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-size:22px;font-weight:700;margin-bottom:16px">🚀 New Rank Labs Signup</div>
  <table style="width:100%;border-collapse:collapse">
    <tr><td style="padding:6px 0;color:#8b949e;font-size:13px">Plan</td><td style="padding:6px 0;font-weight:600">${planLabel}</td></tr>
    <tr><td style="padding:6px 0;color:#8b949e;font-size:13px">Name</td><td style="padding:6px 0">${customerName}</td></tr>
    <tr><td style="padding:6px 0;color:#8b949e;font-size:13px">Email</td><td style="padding:6px 0">${customerEmail}</td></tr>
    ${website ? `<tr><td style="padding:6px 0;color:#8b949e;font-size:13px">Website</td><td style="padding:6px 0">${website}</td></tr>` : ""}
    ${businessName ? `<tr><td style="padding:6px 0;color:#8b949e;font-size:13px">Business</td><td style="padding:6px 0">${businessName}</td></tr>` : ""}
  </table>
  <p style="color:#8b949e;font-size:12px;margin-top:16px">Confirmation and onboarding emails auto-sent to customer.</p>
</div></body></html>`;
}

function buildConfirmationEmail({ customerName, plan, planLabel }) {
  const steps = plan === "full_management"
    ? ["We'll review your site (or start building if you're new)","Your first weekly audit arrives within 24 hours","Content drafts start flowing next week","We'll reach out if we need anything from you"]
    : ["Your first weekly audit arrives within 24 hours","Reports land in your inbox every Monday","We'll reach out if we need anything"];

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,sans-serif;background:#0f1117;color:#e1e4e8;padding:40px">
<div style="max-width:600px;margin:0 auto">
  <div style="background:linear-gradient(135deg,#7c3aed,#3b82f6);padding:32px;border-radius:12px 12px 0 0;text-align:center">
    <h1 style="color:#fff;margin:0;font-size:24px">Welcome to Rank Labs! 🎉</h1>
  </div>
  <div style="background:#161b22;padding:32px;border-radius:0 0 12px 12px">
    <p style="font-size:16px">Hi ${customerName},</p>
    <p>Your <strong>${planLabel}</strong> plan is now active. We're thrilled to have you.</p>
    <p style="margin-top:20px"><strong>What happens next:</strong></p>
    <ul style="padding-left:20px">
      ${steps.map(s => `<li style="margin-bottom:6px">${s}</li>`).join("")}
    </ul>
    <p style="margin-top:20px">You'll receive a separate onboarding email with all the details shortly.</p>
    <p style="color:#8b949e;font-size:13px;margin-top:24px">— The Rank Labs Team</p>
  </div>
</div></body></html>`;
}

function buildOnboardingEmail({ customerName, plan, planLabel, website, businessName }) {
  const seoFeatures = [
    "Weekly SEO audits (100+ checks)","Keyword & competitor tracking","Long-tail & seasonal keyword research",
    "Backlink profile monitoring","Monthly ranking reports","Content strategy & calendar",
    "Technical SEO & schema markup","Internal link optimization","Conversion-focused recommendations",
    "3/6/12 month performance benchmarks","Core Web Vitals monitoring",
  ];
  const fullExtras = [
    "Weekly blog content (researched & written)","Full site hosting on global edge network",
    "Unlimited site edits & updates","Easy content approval workflow",
    "Google Business Profile optimization","Business listing management",
    "Service-area landing pages","Local SEO & citation strategy","Dedicated support",
  ];

  const isFull = plan === "full_management";
  const features = isFull ? [...seoFeatures, ...fullExtras] : seoFeatures;

  const extra = isFull
    ? `<p style="background:#1a2e3a;padding:12px;border-radius:8px;border-left:4px solid #7c3aed;margin-top:20px"><strong>📋 Site Build or Migration:</strong> If you're migrating an existing site or need a new build, we'll follow up separately to get your requirements and timeline.</p>`
    : `<p style="background:#1a2e3a;padding:12px;border-radius:8px;border-left:4px solid #7c3aed;margin-top:20px"><strong>🔑 Site Access:</strong> To start your weekly audits, we may need access to your website. We'll reach out if we need anything.</p>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,sans-serif;background:#0f1117;color:#e1e4e8;padding:40px">
<div style="max-width:600px;margin:0 auto">
  <div style="background:linear-gradient(135deg,#7c3aed,#3b82f6);padding:32px;border-radius:12px 12px 0 0;text-align:center">
    <h1 style="color:#fff;margin:0;font-size:24px">Let's Get Started</h1>
  </div>
  <div style="background:#161b22;padding:32px;border-radius:0 0 12px 12px">
    <p style="font-size:16px">Hi ${customerName},</p>
    <p>Here's everything you need to know about your <strong>${planLabel}</strong> plan.</p>
    <h3 style="color:#7c3aed;margin-top:24px">Your Plan Includes:</h3>
    <ul style="padding-left:20px;columns:${features.length > 10 ? "2" : "1"};column-gap:24px">
      ${features.map(f => `<li style="margin-bottom:6px;font-size:14px">${f}</li>`).join("")}
    </ul>
    ${extra}
    <p style="margin-top:24px"><strong>Your first weekly audit</strong> will arrive within 24 hours.</p>
    <p>Questions? Just reply to this email or reach us at <a href="mailto:hello@getranklabs.com" style="color:#06b6d4">hello@getranklabs.com</a>.</p>
    <p style="color:#8b949e;font-size:13px;margin-top:24px">— The Rank Labs Team</p>
  </div>
</div></body></html>`;
}

// CORS
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, stripe-signature",
      "Access-Control-Max-Age": "86400",
    },
  });
}
