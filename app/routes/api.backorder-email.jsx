import {json} from "@remix-run/node";
import {authenticate} from "../shopify.server";

const VALID_EMAIL_TYPES = new Set(["backorder_notice", "will_call_ready"]);

export async function loader() {
  return json({error: "Method not allowed."}, {status: 405});
}

export async function action({request}) {
  await authenticate.admin(request);

  const payload = await request.json();
  const emailType = payload?.email_type;
  const sku = `${payload?.sku || ""}`.trim();
  const orderNumber = `${payload?.order_number || ""}`.trim();
  const firstName = `${payload?.first_name || ""}`.trim();
  const customerEmail = `${payload?.customer_email || ""}`.trim();
  const etaDate = `${payload?.eta_date || ""}`.trim();
  const message = `${payload?.message || ""}`.trim();
  const subject =
    `${payload?.subject || buildSubject({emailType, orderNumber})}`.trim();

  if (!VALID_EMAIL_TYPES.has(emailType)) {
    return json({error: "Invalid email type."}, {status: 400});
  }

  if (!customerEmail || !orderNumber || !sku) {
    return json(
      {error: "Customer email, order number, and SKU are required."},
      {status: 400},
    );
  }

  if (emailType === "backorder_notice" && !etaDate) {
    return json({error: "ETA date is required for backorder notices."}, {status: 400});
  }

  return json({
    ok: true,
    message:
      "Email request received by the Shopify app backend. Delivery provider is not configured yet.",
    preview: {
      customerEmail,
      emailType,
      etaDate,
      firstName,
      message,
      orderNumber,
      sku,
      subject,
    },
  });
}

function buildSubject({emailType, orderNumber}) {
  if (emailType === "will_call_ready") {
    return `Pick Up on Location Order ${orderNumber}`.trim();
  }

  return `Backorder status for order ${orderNumber}`.trim();
}
