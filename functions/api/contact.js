// Rank Labs Contact Form Handler — Cloudflare Pages Function
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

    // Format Telegram message
    // Generate submission ID
    const subId = `SUB-${Date.now().toString(36).toUpperCase()}`;
    
    // Format Telegram message
    const typeLabel = data.type === "existing-site" ? "🔬 Free SEO Audit" : "🔨 New Site Build";
    let text = `<b>${typeLabel} Request</b>\n`;
    text += `<code>${subId}</code>\n\n`;
    text += `<b>Name:</b> ${data.name}\n`;
    text += `<b>Email:</b> ${data.email}\n`;
    
    // Build command for Josiah to use
    let cmd = `/onboard ${subId}`;
    
    if (data.type === "existing-site") {
      text += `<b>Website:</b> ${data.url || "N/A"}\n`;
    } else {
      text += `<b>Site Type:</b> ${data.siteType || "Not specified"}\n`;
      if (data.modelSites && data.modelSites.length > 0) {
        text += `<b>Model Sites:</b> ${data.modelSites.join(", ")}\n`;
      }
      if (data.pages && data.pages.length > 0) {
        text += `<b>Pages Needed:</b> ${data.pages.join(", ")}\n`;
      }
      if (data.branding) text += `<b>Branding:</b> ${data.branding.substring(0, 200)}\n`;
      if (data.timeline) text += `<b>Timeline/Budget:</b> ${data.timeline}\n`;
    }
    
    if (data.notes) text += `<b>Notes:</b> ${data.notes.substring(0, 300)}\n`;
    text += `\n<b>Submitted:</b> ${new Date(data.submittedAt).toLocaleString()}\n`;
    text += `\n<i>Reply "approve ${subId}" to start onboarding.</i>`;

    // Send to Telegram
    const tgResponse = await fetch(
      `https://api.telegram.org/bot8542811180:***/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: "5016070713",
          text: text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      }
    );

    const tgResult = await tgResponse.json();
    
    if (tgResult.ok) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } else {
      return new Response(JSON.stringify({ error: "Notify failed", detail: tgResult }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
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
