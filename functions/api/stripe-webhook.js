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
  // Read the plan from what was actually bought. Only our own signup form sets
  // metadata.plan; Stripe Payment Links don't, so trusting it alone labelled a
  // Full Management payment-link signup as the old $599 SEO plan.
  const plan = (await planFromLineItems(session, env)) || session.metadata?.plan || "seo_management";
  const planInfo = PLANS[plan] || PLANS.seo_management;
  const planLabel = planInfo.name;
  // A discounted subscription (e.g. a partner rate) shows its real monthly rate
  // next to the list price, so the email matches what the customer is charged.
  const discounted = (session.total_details?.amount_discount || 0) > 0 && Number.isFinite(session.amount_total);
  const priceLine = discounted
    ? `${formatUsd(session.amount_total)}/mo (normally ${planInfo.price}/mo)`
    : `${planInfo.price}/mo`;
  const website = session.metadata?.website || "";
  const businessName = session.metadata?.business_name || "";

  console.log(`✅ New ${planLabel} signup (${priceLine}): ${customerName} <${customerEmail}>`);

  // Internal email to Josiah
  await sendEmail(env, {
    to: "josiahearl@gmail.com",
    subject: `🚀 New Signup: ${customerName} — ${planLabel}`,
    html: buildInternalEmail({ customerName, customerEmail, planLabel: `${planLabel} — ${priceLine}`, website, businessName }),
  });

  // Notification only. A signup does not email the customer or start onboarding:
  // existing customers (e.g. a partner rate sent as a payment link) are already
  // onboarded, and Josiah onboards new ones himself.
  console.log(`Notifications complete for ${customerEmail}`);
}

// ── Plans ───────────────────────────────────────────────────────────────
// Keep in step with the pricing section of src/pages/index.astro.

const PLANS = {
  seo_management: { name: "GEO + SEO Management", price: "$1,500" },
  full_management: { name: "Full Management SEO & AI Visibility", price: "$2,500" },
};

async function planFromLineItems(session, env) {
  if (!env.STRIPE_SECRET_KEY || !session.id) return null;
  try {
    const resp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${session.id}/line_items?expand[]=data.price.product`, {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    if (!resp.ok) return null;
    const names = ((await resp.json()).data || []).map((item) => item.price?.product?.name || item.description || "");
    if (names.some((name) => /full management/i.test(name))) return "full_management";
    if (names.some((name) => /seo management/i.test(name))) return "seo_management";
  } catch (e) {
    console.error("Line item lookup failed:", e.message);
  }
  return null;
}

function formatUsd(cents) {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
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
  <p style="color:#8b949e;font-size:12px;margin-top:16px">No email was sent to the customer and no onboarding was started.</p>
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
