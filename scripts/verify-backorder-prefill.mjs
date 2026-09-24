// Offline regression: recipient-less dummy orders must still prefill the composer.
import assert from "node:assert/strict";
import {test} from "node:test";
import {build} from "esbuild";
import {BACKORDER_PILOT_VENDOR, selectBackorderNotice} from "../app/backorder-automation.js";

const order = {
  id: "gid://shopify/Order/123", name: "#968218", createdAt: "2026-09-24T20:00:00Z",
  email: null, customer: null, tags: ["Backorder"],
  lineItems: ["Backorder", "Built to Order"].map((availability, index) => ({
    sku: `RH-${index}`, title: `Steering gear ${index}`, currentQuantity: 1, unfulfilledQuantity: 1,
    variant: {sku: `RH-${index}`, product: {vendor: BACKORDER_PILOT_VENDOR},
      availability: {value: availability}, availabilityDate: {type: "date", value: "2099-10-15"},
      buildToOrderMessage: {type: "single_line_text_field", value: "This product will ship in 2 Weeks from the manufacturer"},
    },
  })),
};

test("background selection still requires an email by default", () => {
  const selected = selectBackorderNotice({order, today: "2026-09-24", config: {startAt: new Date(0)}});
  assert.equal(selected.status, "waiting");
  assert.match(selected.reason, /customer email/);
});

test("actual prefill endpoint returns both products and messages without an order email", async () => {
  const data = {shop: {name: "Test shop", ianaTimezone: "America/Los_Angeles"},
    order: {...order, lineItems: {nodes: order.lineItems, pageInfo: {hasNextPage: false}}}};
  const bundle = await build({entryPoints: ["app/routes/api.backorder-details.jsx"], bundle: true,
    platform: "node", format: "esm", write: false, plugins: [{
      name: "mock-authenticated-shopify",
      setup(builder) {
        builder.onResolve({filter: /^(?:@remix-run\/node)$|\/shopify\.server$/}, (args) => ({path: args.path, namespace: "mock"}));
        builder.onLoad({filter: /.*/, namespace: "mock"}, (args) => ({contents: args.path.includes("@remix")
          ? "export const json = (data, init) => Response.json(data, init);"
          : `export const authenticate = {admin: async () => ({cors: (r) => r, admin: {graphql: async () => Response.json({data: ${JSON.stringify(data)}})}})};`,
        }));
      },
    }],
  });
  const {loader} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  const response = await loader({request: new Request(`https://example.com/api/backorder-details?order_id=${order.id}`)});
  assert.equal(response.status, 200);
  const selected = await response.json();
  assert.equal(selected.status, "ready");
  assert.equal(selected.payload.customerEmail, "");
  assert.equal(selected.payload.products.length, 2);
  assert.equal(selected.payload.products[0].delayDate, "2099-10-15");
  assert.equal(selected.payload.products[1].delayMessage, "This product will ship in 2 Weeks from the manufacturer");
});
