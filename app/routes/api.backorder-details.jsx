import {json} from "@remix-run/node";
import {authenticate} from "../shopify.server";
import {loadBackorderOrder} from "../backorder-automation-shopify.js";
import {selectBackorderNotice} from "../backorder-automation.js";

// Read-only prefilling for the existing order composer. Never queues or sends email.
export async function loader({request}) {
  const {admin, cors} = await authenticate.admin(request);
  const orderId = new URL(request.url).searchParams.get("order_id") || "";
  if (!/^gid:\/\/shopify\/Order\/\d+$/.test(orderId)) {
    return cors(json({error: "A valid order ID is required."}, {status: 400}));
  }
  try {
    const loaded = await loadBackorderOrder(admin, orderId);
    const selection = selectBackorderNotice({...loaded, config: {
      startAt: new Date(0), allowTestOrders: true, fromAddress: "orders@dieselpowerproducts.com",
    }});
    return cors(json(selection, {headers: {"Cache-Control": "no-store"}}));
  } catch (error) {
    return cors(json({error: error instanceof Error ? error.message : "Unable to read backorder details."}, {status: 500}));
  }
}
