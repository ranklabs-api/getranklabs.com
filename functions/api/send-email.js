// Rank Labs — Email Sender (called by webhook handler)
// POST with { to, cc, subject, html } → sends via Gmail API
export async function onRequestPost(context) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  try {
    const data = await context.request.json();
    const { to, cc, subject, html } = data;

    if (!to || !subject || !html) {
      return new Response(JSON.stringify({ error: "to, subject, and html are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const EMAIL_SECRET = context.env.EMAIL_API_SECRET;
    if (!EMAIL_SECRET) {
      console.error("EMAIL_API_SECRET not configured");
      return new Response(JSON.stringify({ error: "Email service not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate secret to prevent abuse
    const authHeader = context.request.headers.get("Authorization") || "";
    if (authHeader !== `Bearer ${EMAIL_SECRET}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Build full email with headers
    const fullEmail = [
      "From: Rank Labs <hello@getranklabs.com>",
      `To: ${to}`,
      ...(cc ? [`Cc: ${cc}`] : []),
      `Subject: ${subject}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      html,
    ].join("\r\n");

    // Send via Gmail API
    const gmailResp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${context.env.GMAIL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        raw: btoa(unescape(encodeURIComponent(fullEmail))),
      }),
    });

    if (gmailResp.ok) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const errData = await gmailResp.json().catch(() => ({}));
    console.error("Gmail API error:", JSON.stringify(errData));
    return new Response(JSON.stringify({ error: "Email send failed", detail: errData }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    console.error("Send email error:", e.message);
    return new Response(JSON.stringify({ error: "Email service error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// CORS
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}
