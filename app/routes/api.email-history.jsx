import {json} from "@remix-run/node";
import {
  backfillEmailHistoryFromKlaviyo,
  listEmailHistory,
  serializeEmailHistory,
} from "../email-history.server";
import {authenticate} from "../shopify.server";

export async function loader({request}) {
  const {cors, session} = await authenticate.admin(request);
  const url = new URL(request.url);
  const orderId = `${url.searchParams.get("orderId") || ""}`.trim();
  const orderNumber = `${url.searchParams.get("orderNumber") || ""}`.trim();
  const customerEmail = `${url.searchParams.get("customerEmail") || ""}`.trim();

  if (!orderId) {
    return cors(json({error: "orderId is required."}, {status: 400}));
  }

  try {
    let warning = "";
    let historyResult = await listEmailHistory({
      orderId,
      shop: session.shop,
    });

    if (!historyResult.history.length && customerEmail && orderNumber) {
      try {
        await backfillEmailHistoryFromKlaviyo({
          customerEmail,
          orderId,
          orderNumber,
          shop: session.shop,
        });
        historyResult = await listEmailHistory({
          orderId,
          shop: session.shop,
        });
      } catch (_error) {
        warning =
          "Older Klaviyo activity could not be imported right now. New sends will still appear here.";
      }
    }

    return cors(
      json({
        hasMore: historyResult.hasMore,
        history: historyResult.history.map(serializeEmailHistory),
        warning,
      }),
    );
  } catch (error) {
    return cors(
      json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Notify Dock could not load email history.",
        },
        {status: error?.status || 500},
      ),
    );
  }
}

export async function action({request}) {
  const {cors} = await authenticate.admin(request);

  return cors(json({error: "Method not allowed."}, {status: 405}));
}
