// Rank Labs — Stripe Checkout Session Creator (Cloudflare Pages Function)
export async function onRequestPost(context) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  try {
    const data = await context.request.json();

    if (!data.name || !data.email) {
      return new Response(JSON.stringify({ error: "Name and email are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const STRIPE_SECRET_KEY = context.env.STRIPE_SECRET_KEY;
    if (!STRIPE_SECRET_KEY) {
      console.error("STRIPE_SECRET_KEY not configured");
      return new Response(JSON.stringify({ error: "Payment service not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Price IDs from Cloudflare env vars (set these in CF Dashboard)
    const PRICE_IDS = {
      seo_management: context.env.STRIPE_PRICE_SEO_MANAGEMENT,
      full_management: context.env.STRIPE_PRICE_FULL_MANAGEMENT,
    };

    const plan = data.plan || "seo_management";
    const priceId = PRICE_IDS[plan];

    if (!priceId) {
      return new Response(JSON.stringify({ error: `No price configured for plan: ${plan}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const baseUrl = "https://getranklabs.com";

    // Build metadata for webhook
    const metadata = {
      plan,
      customer_name: data.name,
      customer_email: data.email,
    };
    if (data.website) metadata.website = data.website;
    if (data.business_name) metadata.business_name = data.business_name;

    // Build form body
    const params = new URLSearchParams({
      "mode": "subscription",
      "success_url": `${baseUrl}/signup-complete?plan=${plan}`,
      "cancel_url": `${baseUrl}/signup?plan=${plan}`,
      "customer_email": data.email,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      "allow_promotion_codes": "true",
    });

    for (const [key, value] of Object.entries(metadata)) {
      params.append(`metadata[${key}]`, value);
    }

    const sessionResp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const session = await sessionResp.json();

    if (session.url) {
      return new Response(JSON.stringify({ url: session.url }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.error("Stripe error:", JSON.stringify(session));
    return new Response(JSON.stringify({
      error: "Payment setup failed. Our team has been notified. Please try again.",
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    console.error("Checkout function error:", e.message);
    return new Response(JSON.stringify({ error: "Service unavailable. Please try again shortly." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// CORS preflight
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
