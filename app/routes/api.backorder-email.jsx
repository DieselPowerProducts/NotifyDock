import {json} from "@remix-run/node";
import {authenticate} from "../shopify.server";
import {sendNotifyDockEvent} from "../klaviyo.server";

const VALID_EMAIL_TYPES = new Set(["backorder_notice", "will_call_ready"]);

export async function loader({request}) {
  const {cors} = await authenticate.admin(request);

  return cors(json({error: "Method not allowed."}, {status: 405}));
}

export async function action({request}) {
  const {cors, session} = await authenticate.admin(request);

  if (request.method === "OPTIONS") {
    return cors(new Response(null, {status: 204}));
  }

  let payload;

  try {
    payload = await request.json();
  } catch (_error) {
    return cors(json({error: "Invalid JSON payload."}, {status: 400}));
  }

  const emailType = payload?.email_type;
  const sku = `${payload?.sku || ""}`.trim();
  const orderNumber = `${payload?.order_number || ""}`.trim();
  const firstName = `${payload?.first_name || ""}`.trim();
  const customerEmail = `${payload?.customer_email || ""}`.trim();
  const fromAddress = `${payload?.from_address || ""}`.trim();
  const message = `${payload?.message || ""}`.trim();
  const productImageUrl = `${payload?.product_image_url || ""}`.trim();
  const productTitle = `${payload?.product_title || ""}`.trim();
  const productVariantTitle = `${payload?.product_variant_title || ""}`.trim();
  const shipDate = `${payload?.ship_date || ""}`.trim();
  const shopName = `${payload?.shop_name || ""}`.trim();
  const subject =
    `${payload?.subject || buildSubject({emailType, orderNumber})}`.trim();

  if (!VALID_EMAIL_TYPES.has(emailType)) {
    return cors(json({error: "Invalid email type."}, {status: 400}));
  }

  if (!customerEmail || !orderNumber || !subject) {
    return cors(
      json(
        {error: "Customer email, order number, and subject are required."},
        {status: 400},
      ),
    );
  }

  if (emailType === "backorder_notice" && (!sku || !shipDate)) {
    return cors(
      json(
        {error: "Backorder emails require both a SKU and ship date."},
        {status: 400},
      ),
    );
  }

  try {
    const result = await sendNotifyDockEvent({
      customerEmail,
      emailType,
      firstName,
      fromAddress,
      message,
      orderNumber,
      productImageUrl,
      productTitle,
      productVariantTitle,
      sentByEmail: session.email || "",
      shipDate,
      shop: shopName || session.shop,
      sku,
      subject,
    });

    return cors(
      json({
        ok: true,
        message:
          "Klaviyo accepted the Notify Dock event. The matching Klaviyo flow will send the email.",
        metricName: result.metricName,
      }),
    );
  } catch (error) {
    return cors(
      json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Notify Dock could not hand the email off to Klaviyo.",
        },
        {status: error?.status || 500},
      ),
    );
  }
}

function buildSubject({emailType, orderNumber}) {
  if (emailType === "will_call_ready") {
    return `Pick Up on Location Order ${orderNumber}`.trim();
  }

  return `Backorder status for order ${orderNumber}`.trim();
}
