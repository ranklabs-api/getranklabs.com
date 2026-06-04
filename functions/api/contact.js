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

    // Format Telegram message based on type
    const subId = `SUB-${Date.now().toString(36).toUpperCase()}`;
    
    let typeLabel, text;
    if (data.type === "contact") {
      typeLabel = "💬 New Message";
      text = `<b>${typeLabel}</b>\n<code>${subId}</code>\n\n`;
      text += `<b>Name:</b> ${data.name}\n`;
      text += `<b>Email:</b> ${data.email}\n`;
      if (data.url) text += `<b>Website:</b> ${data.url}\n`;
      if (data.notes) text += `<b>Message:</b> ${data.notes.substring(0, 500)}\n`;
    } else if (data.type === "existing-site") {
      typeLabel = "🔬 Free SEO Audit";
      text = `<b>${typeLabel} Request</b>\n<code>${subId}</code>\n\n`;
      text += `<b>Name:</b> ${data.name}\n`;
      text += `<b>Email:</b> ${data.email}\n`;
      text += `<b>Website:</b> ${data.url || "N/A"}\n`;
      if (data.notes) text += `<b>Notes:</b> ${data.notes.substring(0, 300)}\n`;
    } else {
      typeLabel = "🔨 New Site Build";
      text = `<b>${typeLabel} Request</b>\n<code>${subId}</code>\n\n`;
      text += `<b>Name:</b> ${data.name}\n`;
      text += `<b>Email:</b> ${data.email}\n`;
      if (data.siteType) text += `<b>Site Type:</b> ${data.siteType}\n`;
      if (data.modelSites && data.modelSites.length > 0) {
        text += `<b>Model Sites:</b> ${data.modelSites.join(", ")}\n`;
      }
      if (data.pages && data.pages.length > 0) {
        text += `<b>Pages Needed:</b> ${data.pages.join(", ")}\n`;
      }
      if (data.branding) text += `<b>Branding:</b> ${data.branding.substring(0, 200)}\n`;
      if (data.timeline) text += `<b>Timeline/Budget:</b> ${data.timeline}\n`;
      if (data.notes) text += `<b>Notes:</b> ${data.notes.substring(0, 300)}\n`;
    }
    
    text += `\n<b>Submitted:</b> ${new Date(data.submittedAt).toLocaleString()}`;
    if (data.type !== "contact") {
      text += `\n\n<i>Reply "approve ${subId}" to start onboarding.</i>`;
    }

    // Send to Telegram (token from Cloudflare secret)
    const TELEGRAM_TOKEN = context.env.TELEGRAM_BOT_TOKEN;
    const CHAT_ID = context.env.TELEGRAM_CHAT_ID || "5016070713";
    
    const tgResponse = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      }
    );

    const tgResult = await tgResponse.json();
    
    if (tgResult.ok) {
      // Also send email notification via Resend
      const resendKey = context.env.RESEND_API_KEY;
      if (resendKey) {
        try {
          let subject, htmlBody;
          if (data.type === "contact") {
            subject = `💬 New Contact: ${data.name}`;
            htmlBody = `<div style="font-family:-apple-system,sans-serif;background:#0f1117;color:#e1e4e8;padding:24px;border-radius:12px"><h2 style="color:#7c3aed">💬 New Message</h2><p><strong>Name:</strong> ${data.name}</p><p><strong>Email:</strong> ${data.email}</p>${data.url ? `<p><strong>Website:</strong> ${data.url}</p>` : ''}${data.notes ? `<p><strong>Message:</strong></p><p style="background:#161b22;padding:12px;border-radius:8px">${data.notes}</p>` : ''}</div>`;
          } else {
            subject = `🔬 Free Audit Request: ${data.name}`;
            htmlBody = `<div style="font-family:-apple-system,sans-serif;background:#0f1117;color:#e1e4e8;padding:24px;border-radius:12px"><h2 style="color:#7c3aed">🔬 Free SEO Audit Request</h2><p><strong>Name:</strong> ${data.name}</p><p><strong>Email:</strong> ${data.email}</p><p><strong>Website:</strong> ${data.url || 'N/A'}</p>${data.notes ? `<p><strong>Notes:</strong> ${data.notes}</p>` : ''}</div>`;
          }
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from: "Rank Labs <hello@getranklabs.com>", to: "josiah@getranklabs.com", subject, html: htmlBody }),
          });
        } catch (e) {
          console.error("Contact email failed:", e.message);
        }
      }

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
