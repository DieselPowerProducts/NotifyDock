import {useEffect, useState} from "react";
import {useApi} from "@shopify/ui-extensions-react/admin";

export const EMAIL_TYPES = [
  {label: "Backorder Notice", value: "backorder_notice"},
  {label: "Will Call Ready", value: "will_call_ready"},
];

export const FROM_OPTIONS = [
  {
    label: "orders@dieselpowerproducts.com",
    value: "orders@dieselpowerproducts.com",
  },
];

export function useComposerState(target) {
  const api = useApi(target);
  const {data} = api;
  const launchUrl = getLaunchUrl(api.intents?.launchUrl);
  const launchedOrderId = getLaunchParam(launchUrl, "orderId");
  const launchedOrderIdFromPath = getOrderIdFromAdminUrl(launchUrl);
  const launchNonce = getLaunchParam(launchUrl, "openedAt");
  const orderId =
    launchedOrderId || launchedOrderIdFromPath || data?.selected?.[0]?.id || null;
  const [loadingOrder, setLoadingOrder] = useState(true);
  const [loadingProduct, setLoadingProduct] = useState(false);
  const [error, setError] = useState("");
  const [lookupError, setLookupError] = useState("");
  const [status, setStatus] = useState(null);
  const [sending, setSending] = useState(false);
  const [shopName, setShopName] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const [firstName, setFirstName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [defaultSku, setDefaultSku] = useState("");
  const [sku, setSku] = useState("");
  const [shipDate, setShipDate] = useState("");
  const [productTitle, setProductTitle] = useState("");
  const [productVariantTitle, setProductVariantTitle] = useState("");
  const [productImageUrl, setProductImageUrl] = useState("");
  const [productImageAlt, setProductImageAlt] = useState("");
  const [emailType, setEmailType] = useState("backorder_notice");
  const [fromAddress, setFromAddress] = useState(FROM_OPTIONS[0].value);
  const [subject, setSubject] = useState(
    buildSubject({
      emailType: "backorder_notice",
      orderNumber: "",
    }),
  );
  const [subjectDirty, setSubjectDirty] = useState(false);

  useEffect(() => {
    setLoadingOrder(Boolean(orderId));
    setLoadingProduct(false);
    setError("");
    setLookupError("");
    setStatus(null);
    setShopName("");
    setOrderNumber("");
    setFirstName("");
    setCustomerEmail("");
    setDefaultSku("");
    setSku("");
    setShipDate("");
    setProductTitle("");
    setProductVariantTitle("");
    setProductImageUrl("");
    setProductImageAlt("");
    setEmailType("backorder_notice");
    setFromAddress(FROM_OPTIONS[0].value);
    setSubjectDirty(false);
  }, [launchNonce, orderId]);

  useEffect(() => {
    let cancelled = false;

    async function loadOrder() {
      if (!orderId) {
        setError("Unable to confirm the current order. Close the popup and reopen it from the order page.");
        setLoadingOrder(false);
        return;
      }

      setLoadingOrder(true);
      setError("");

      try {
        const result = await api.query(
          `query OrderEmailPanel($id: ID!) {
            shop {
              name
            }
            order(id: $id) {
              id
              name
              email
              customer {
                firstName
                lastName
                email
              }
              shippingAddress {
                firstName
                lastName
              }
              billingAddress {
                firstName
                lastName
              }
              lineItems(first: 50) {
                edges {
                  node {
                    title
                    sku
                  }
                }
              }
            }
          }`,
          {variables: {id: orderId}},
        );

        if (cancelled) {
          return;
        }

        if (result.errors?.length) {
          setError("Unable to auto-fill order details. You can still review the template below.");
          setLoadingOrder(false);
          return;
        }

        setShopName(result.data?.shop?.name || "");

        if (!result.data?.order) {
          setError("Unable to auto-fill order details. You can still review the template below.");
          setLoadingOrder(false);
          return;
        }

        const order = result.data.order;
        const lineItems = order.lineItems.edges
          .map(({node}) => ({
            title: node?.title || "",
            sku: node?.sku || "",
          }))
          .filter(({title, sku}) => title || sku);
        const uniqueSkus = Array.from(
          new Set(lineItems.map(({sku, title}) => sku || title).filter(Boolean)),
        );
        const primaryLineItem = lineItems.find(({sku}) => sku) || lineItems[0];
        const customerEmail = [order.customer?.email, order.email].find(Boolean) || "";
        const firstName = [
          order.customer?.firstName,
          order.shippingAddress?.firstName,
          order.billingAddress?.firstName,
        ].find(Boolean) || "";
        const resolvedSku = primaryLineItem?.sku || uniqueSkus[0] || "";

        setOrderNumber(order.name || "");
        setFirstName(firstName);
        setCustomerEmail(customerEmail);
        setDefaultSku(resolvedSku);
        setSku(resolvedSku);
        setProductTitle(primaryLineItem?.title || "");
        setProductVariantTitle("");
        setLoadingOrder(false);
      } catch (_loadError) {
        if (!cancelled) {
          setError("Unable to auto-fill order details. You can still review the template below.");
          setLoadingOrder(false);
        }
      }
    }

    loadOrder();

    return () => {
      cancelled = true;
    };
  }, [api, launchNonce, orderId]);

  useEffect(() => {
    if (!subjectDirty) {
      setSubject(
        buildSubject({
          emailType,
          orderNumber,
        }),
      );
    }
  }, [emailType, orderNumber, subjectDirty]);

  useEffect(() => {
    const normalizedSku = `${sku || ""}`.trim();

    if (!normalizedSku) {
      setLoadingProduct(false);
      setLookupError("");
      setProductTitle("");
      setProductVariantTitle("");
      setProductImageUrl("");
      setProductImageAlt("");
      return;
    }

    let cancelled = false;
    const timeoutId = setTimeout(async () => {
      setLoadingProduct(true);
      setLookupError("");

      try {
        const response = await fetch(
          `/api/product-by-sku?sku=${encodeURIComponent(normalizedSku)}`,
        );
        const payload = await response.json().catch(() => ({}));

        if (cancelled) {
          return;
        }

        if (!response.ok) {
          throw new Error(payload.error || "Unable to load product details for this SKU.");
        }

        setProductTitle(payload.product?.title || "");
        setProductVariantTitle(payload.product?.variantTitle || "");
        setProductImageUrl(payload.product?.imageUrl || "");
        setProductImageAlt(payload.product?.imageAlt || "");
      } catch (lookupError) {
        if (cancelled) {
          return;
        }

        setProductTitle("");
        setProductImageUrl("");
        setProductImageAlt("");
        setProductVariantTitle("");

        setLookupError(
          lookupError instanceof Error
            ? lookupError.message
            : "Unable to load product details for this SKU.",
        );
      } finally {
        if (!cancelled) {
          setLoadingProduct(false);
        }
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [sku]);

  function resetComposer() {
    setSubjectDirty(false);
    setSubject(
      buildSubject({
        emailType,
        orderNumber,
      }),
    );
    setShipDate("");
    setSku(defaultSku);
    setLookupError("");
    setStatus(null);
  }

  async function handleSend() {
    setSending(true);
    setStatus(null);

    try {
      const response = await fetch("/api/backorder-email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          customer_email: customerEmail,
          email_type: emailType,
          first_name: firstName,
          from_address: fromAddress,
          order_number: orderNumber,
          product_image_url: productImageUrl,
          product_title: productTitle,
          product_variant_title: productVariantTitle,
          ship_date: shipDate,
          shop_name: shopName,
          sku,
          subject,
        }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.error || "Notify Dock could not send this email.");
      }

      setStatus({
        tone: "success",
        message:
          payload.message ||
          "Klaviyo accepted the Notify Dock event for delivery.",
      });
    } catch (error) {
      setStatus({
        tone: "critical",
        message:
          error instanceof Error
            ? error.message
            : "Notify Dock could not send this email.",
      });
    } finally {
      setSending(false);
    }
  }

  return {
    api,
    customerEmail,
    emailType,
    error,
    firstName,
    fromAddress,
    handleSend,
    loadingOrder,
    loadingProduct,
    lookupError,
    orderNumber,
    productImageAlt,
    productImageUrl,
    productTitle,
    productVariantTitle,
    resetComposer,
    sending,
    setEmailType: (value) => {
      setEmailType(value);
      setSubjectDirty(false);
      setStatus(null);
    },
    setFromAddress,
    setShipDate: (value) => {
      setShipDate(value);
      setStatus(null);
    },
    setSku: (value) => {
      setSku(value);
      setStatus(null);
    },
    setStatus,
    setSubject: (value) => {
      setSubject(value);
      setSubjectDirty(true);
    },
    shipDate,
    sku,
    status,
    subject,
  };
}

export function canSendComposer({
  customerEmail,
  emailType,
  loadingOrder,
  loadingProduct,
  productTitle,
  shipDate,
  sku,
  subject,
}) {
  if (!customerEmail || !subject || loadingOrder || loadingProduct) {
    return false;
  }

  if (emailType === "backorder_notice") {
    return Boolean(sku && shipDate && productTitle);
  }

  return true;
}

function buildSubject({emailType, orderNumber}) {
  if (emailType === "will_call_ready") {
    return `Pick Up on Location Order ${orderNumber || "#"}`.trim();
  }

  return `Backorder status for order ${orderNumber || "#"}`.trim();
}

function getLaunchUrl(launchUrl) {
  if (!launchUrl) {
    return "";
  }

  return String(launchUrl);
}

function getLaunchParam(launchUrl, key) {
  if (!launchUrl) {
    return "";
  }

  try {
    return new URL(launchUrl).searchParams.get(key) || "";
  } catch (_error) {
    return "";
  }
}

function getOrderIdFromAdminUrl(launchUrl) {
  if (!launchUrl) {
    return "";
  }

  try {
    const pathname = new URL(launchUrl).pathname;
    const match = pathname.match(/\/orders\/(\d+)/);

    if (!match) {
      return "";
    }

    return `gid://shopify/Order/${match[1]}`;
  } catch (_error) {
    return "";
  }
}
