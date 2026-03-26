import {
  AdminAction,
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  DateField,
  Divider,
  Heading,
  Image,
  InlineStack,
  Link,
  ProgressIndicator,
  Section,
  Select,
  Text,
  TextField,
  reactExtension,
} from "@shopify/ui-extensions-react/admin";
import {useEffect, useState} from "react";
import {
  canSendComposer,
  EMAIL_TYPES,
  FROM_OPTIONS,
  useComposerState,
} from "./composer.jsx";

const TARGET = "admin.order-details.action.render";

export default reactExtension(TARGET, () => <ActionComposer />);

function ActionComposer() {
  const {
    api,
    customerEmail,
    emailType,
    error,
    firstName,
    fromAddress,
    handleSend,
    history,
    historyExpanded,
    historyLoading,
    historyNotice,
    launchMode,
    loadingOrder,
    loadingProduct,
    lookupError,
    orderNumber,
    productImageAlt,
    productImageUrl,
    productTitle,
    productVariantTitle,
    resetComposer,
    selectedHistoryId,
    sending,
    setEmailType,
    setFromAddress,
    setHistoryExpanded,
    setShipDate,
    setSku,
    setStatus,
    setSubject,
    shipDate,
    sku,
    status,
    subject,
  } = useComposerState(TARGET);

  const canSend = canSendComposer({
    customerEmail,
    emailType,
    loadingOrder,
    loadingProduct,
    productTitle,
    shipDate,
    sku,
    subject,
  });
  const selectedHistoryEntry =
    history.find((entry) => entry.id === selectedHistoryId) || null;

  if (launchMode === "history_email") {
    return (
      <AdminAction
        loading={historyLoading || loadingOrder}
        secondaryAction={<Button onPress={api.close}>Close</Button>}
        title="Email"
      >
        <BlockStack gap="base">
          {historyNotice ? <Text>{historyNotice}</Text> : null}

          {!historyLoading && !loadingOrder && selectedHistoryEntry ? (
            <EmailPreviewContent entry={selectedHistoryEntry} />
          ) : null}

          {!historyLoading && !loadingOrder && !selectedHistoryEntry && !historyNotice ? (
            <Text>This email could not be loaded.</Text>
          ) : null}
        </BlockStack>
      </AdminAction>
    );
  }

  return (
    <AdminAction
      title="Notify Dock"
      primaryAction={
        <Button
          disabled={!canSend || sending}
          onPress={handleSend}
          variant="primary"
        >
          {sending ? "Sending..." : "Send email"}
        </Button>
      }
      secondaryAction={<Button onPress={api.close}>Close</Button>}
    >
      <BlockStack gap="base">
        <Text>
          Review the selected template with ship date, SKU, product data, and order history before
          sending it to Klaviyo.
        </Text>

        {history.length ? (
          <BlockStack gap="base">
            <InlineStack inlineAlignment="start">
              <Button
                onPress={() => {
                  setHistoryExpanded(!historyExpanded);
                }}
                variant="secondary"
              >
                {historyExpanded
                  ? `Hide history (${history.length})`
                  : `View history (${history.length})`}
              </Button>
            </InlineStack>

            {historyExpanded ? (
              <EmailHistoryList
                history={history}
                selectedHistoryId={selectedHistoryId}
              />
            ) : null}
          </BlockStack>
        ) : null}

        {historyLoading ? <Text>Loading email history...</Text> : null}

        {historyNotice ? <Text>{historyNotice}</Text> : null}

        {!loadingOrder && !historyLoading && !history.length && !historyNotice ? (
          <Text>No email history yet for this order.</Text>
        ) : null}

        {loadingOrder ? (
          <ProgressIndicator size="small" accessibilityLabel="Loading order details" />
        ) : null}

        {error ? <Banner tone="critical">{error}</Banner> : null}

        {status ? <Banner tone={status.tone}>{status.message}</Banner> : null}

        <InlineStack inlineAlignment="space-between">
          <Box inlineSize="48%">
            <Select
              label="Email type"
              options={EMAIL_TYPES}
              value={emailType}
              onChange={setEmailType}
            />
          </Box>

          <Box inlineSize="48%">
            <TextField
              label="Subject"
              value={subject}
              onChange={setSubject}
            />
          </Box>
        </InlineStack>

        <InlineStack inlineAlignment="space-between">
          <Box inlineSize="48%">
            <TextField
              disabled
              label="To"
              value={customerEmail}
            />
          </Box>

          <Box inlineSize="48%">
            <Select
              label="From"
              options={FROM_OPTIONS}
              value={fromAddress}
              onChange={setFromAddress}
            />
          </Box>
        </InlineStack>

        <InlineStack inlineAlignment="space-between">
          <Box inlineSize="48%">
            <DateField
              disabled={!showsShipDate(emailType)}
              label="Ship date"
              value={shipDate}
              onChange={setShipDate}
            />
          </Box>

          <Box inlineSize="48%">
            <TextField
              label="SKU"
              value={sku}
              onChange={setSku}
            />
          </Box>
        </InlineStack>

        {loadingProduct ? (
          <ProgressIndicator size="small" accessibilityLabel="Loading product preview" />
        ) : null}

        {lookupError ? <Banner tone="warning">{lookupError}</Banner> : null}

        <TemplatePreview
          customerEmail={customerEmail}
          emailType={emailType}
          firstName={firstName}
          orderNumber={orderNumber}
          productImageAlt={productImageAlt}
          productImageUrl={productImageUrl}
          productTitle={productTitle}
          productVariantTitle={productVariantTitle}
          shipDate={shipDate}
          sku={sku}
        />

        <InlineStack inlineAlignment="start" gap="base">
          <Button onPress={resetComposer} variant="secondary">
            Reset defaults
          </Button>

          <Button
            onPress={() => {
              setStatus(null);
            }}
            variant="tertiary"
          >
            Clear notice
          </Button>
        </InlineStack>
      </BlockStack>
    </AdminAction>
  );
}

function EmailHistoryList({history, selectedHistoryId}) {
  return (
    <BlockStack gap="small">
      {history.map((entry, index) => (
        <BlockStack key={entry.id} gap="small">
          <EmailHistoryItem
            entry={entry}
            isSelected={entry.id === selectedHistoryId}
          />
          {index < history.length - 1 ? <CenteredSeparator /> : null}
        </BlockStack>
      ))}
    </BlockStack>
  );
}

function EmailHistoryItem({entry, isSelected}) {
  const [expanded, setExpanded] = useState(isSelected);

  useEffect(() => {
    if (isSelected) {
      setExpanded(true);
    }
  }, [isSelected]);

  return (
    <BlockStack gap="small">
      <InlineStack inlineAlignment="start">
        <Badge>{buildHistorySummary(entry)}</Badge>
      </InlineStack>

      <InlineStack inlineAlignment="start">
        <Link
          onPress={() => {
            setExpanded(!expanded);
          }}
        >
          {expanded ? "Hide email" : "View email"}
        </Link>
      </InlineStack>

      {expanded ? <EmailPreviewContent entry={entry} /> : null}
    </BlockStack>
  );
}

function TemplatePreview({
  customerEmail,
  emailType,
  firstName,
  orderNumber,
  productImageAlt,
  productImageUrl,
  productTitle,
  productVariantTitle,
  shipDate,
  sku,
}) {
  const resolvedSku = sku || "{{ event.sku }}";
  const resolvedShipDate = formatShipDate(shipDate) || "{{ event.ship_date }}";
  const resolvedProductTitle =
    buildProductLabel(productTitle, productVariantTitle) || "{{ event.product_title }}";
  const previewParagraphs = buildTemplateParagraphs({
    emailType,
    firstName,
    orderNumber,
    productTitle: resolvedProductTitle,
    shipDate: resolvedShipDate,
    sku: resolvedSku,
  });

  return (
    <Section heading="Template preview">
      <BlockStack gap="base">
        <Text>
          Synthetic preview of the Klaviyo email using the same fields this action sends.
        </Text>

        <InlineStack inlineAlignment="start" gap="base">
          <Badge tone="info">{labelEmailType(emailType)}</Badge>
          <Badge tone="info">SKU: {resolvedSku}</Badge>
          {showsShipDate(emailType) ? (
            <Badge tone="info">Ship date: {resolvedShipDate}</Badge>
          ) : null}
        </InlineStack>

        <Divider />

        {productImageUrl ? (
          <Image
            source={productImageUrl}
            accessibilityLabel={productImageAlt || resolvedProductTitle}
          />
        ) : (
          <Box padding="base">
            <Text>
              The product image will appear here when the SKU matches a Shopify product image.
            </Text>
          </Box>
        )}

        <Heading size={3}>{resolvedProductTitle}</Heading>
        <Text>To: {customerEmail || "{{ profile.email }}"}</Text>

        {previewParagraphs.map((paragraph, index) => (
          <Text key={`preview-paragraph-${index}`}>{paragraph}</Text>
        ))}
      </BlockStack>
    </Section>
  );
}

function EmailPreviewContent({entry}) {
  const paragraphs = buildEmailPreviewParagraphs(entry.message);

  return (
    <BlockStack gap="small">
      <Text fontWeight="bold">{entry.subject}</Text>

      {paragraphs.length ? (
        <BlockStack gap="small">
          {paragraphs.map((paragraph, index) => (
            <Text key={`${entry.id}-paragraph-${index}`}>{paragraph}</Text>
          ))}
        </BlockStack>
      ) : (
        <Text>No email body saved for this email.</Text>
      )}
    </BlockStack>
  );
}

function labelEmailType(emailType) {
  if (emailType === "will_call_in_progress") {
    return "Will Call - In Progress";
  }

  if (emailType === "will_call_ready") {
    return "Will Call Ready";
  }

  if (emailType === "shipping_delay") {
    return "Shipping Delay";
  }

  return "Backorder Notice";
}

function buildHistorySummary(entry) {
  return `${labelEmailType(entry.emailType)} Sent | ${formatHistoryTimestamp(entry.sentAt)} - To: ${entry.customerEmail}`;
}

function formatHistoryTimestamp(sentAt) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(sentAt));
  } catch (_error) {
    return sentAt;
  }
}

function formatShipDate(value) {
  if (!value) {
    return "";
  }

  const [year, month, day] = value.split("-").map(Number);

  if (!year || !month || !day) {
    return value;
  }

  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function buildProductLabel(productTitle, productVariantTitle) {
  if (!productVariantTitle || productVariantTitle === "Default Title") {
    return productTitle;
  }

  return `${productTitle} - ${productVariantTitle}`.trim();
}

function buildTemplateParagraphs({
  emailType,
  firstName,
  orderNumber,
  productTitle,
  shipDate,
  sku,
}) {
  if (emailType === "will_call_ready") {
    return [
      `Pick Up on Location Order ${orderNumber || "#"}`,
      `Hello ${firstName || "{{ profile.first_name|default:'there' }}"},`,
      "Your order has been processed. We will contact you once your complete order is here and ready for pickup at Will Call.",
      `Reference item: ${productTitle} (${sku})`,
      "Thank you.",
    ];
  }

  if (emailType === "will_call_in_progress") {
    return [
      `Hello ${firstName || "{{ profile.first_name|default:'there' }}"},`,
      "Your order has been processed. We will contact you once your complete order is here and ready for pickup at Will Call.",
      `Reference item: ${productTitle} (${sku})`,
      "Thank you.",
    ];
  }

  if (emailType === "shipping_delay") {
    return [
      "Thanks so much for shopping with Diesel Power Products, we really do appreciate it.",
      `The below product is currently on backorder: ${productTitle} (${sku}).`,
      `Based upon information from the manufacturer, the current ship date is: ${shipDate}.`,
      "HANG TIGHT: If you are okay to wait, you are good to go. Once we have tracking, or any other updates, we will forward them to this same email address.",
      "CHECK OPTIONS: If you would like a comparable option that is on the shelf and ready to ship, our sales technicians can help.",
      "CANCEL: If the backorder timeline is too long, we can cancel and refund the backordered item(s).",
      "QUESTIONS: Reply to this email or reach out by phone or website chat, Monday through Friday from 6AM to 6PM Pacific.",
    ];
  }

  return [
    `Product: ${productTitle} (${sku})`,
    `Based upon information from the manufacturer, the current ship date of your part(s) is: ${shipDate}.`,
    "HANG TIGHT: If you are okay to wait, you are good to go. Once we have tracking, or any other updates, we will forward them to this same email address.",
    "CHECK OPTIONS: If you would like a comparable option that is on the shelf and ready to ship, our sales technicians can help.",
    "CANCEL: If the backorder timeline is too long, we can cancel and refund the backordered item(s).",
    "QUESTIONS: Reply to this email or reach out by phone or website chat, Monday through Friday from 6AM to 6PM Pacific.",
  ];
}

function showsShipDate(emailType) {
  return emailType === "backorder_notice" || emailType === "shipping_delay";
}

function CenteredSeparator() {
  return (
    <InlineStack inlineAlignment="center">
      <Text>-</Text>
    </InlineStack>
  );
}

function formatEmailPreview(message) {
  return `${message || ""}`
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/center>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .trim();
}

function buildEmailPreviewParagraphs(message) {
  return formatEmailPreview(message)
    .split(/\n\s*\n/)
    .map((paragraph) =>
      paragraph
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" "),
    )
    .filter(Boolean);
}
