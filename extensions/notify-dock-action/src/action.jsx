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
  ProgressIndicator,
  Section,
  Select,
  Text,
  TextField,
  reactExtension,
} from "@shopify/ui-extensions-react/admin";
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
    setEmailType,
    setFromAddress,
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
          Review the selected template with live SKU, ship date, and product data before sending it to Klaviyo.
        </Text>

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
  const resolvedShipDate = formatShipDate(shipDate) || "{{ event.ship_date }}";
  const resolvedSku = sku || "{{ event.sku }}";
  const resolvedProductTitle =
    buildProductLabel(productTitle, productVariantTitle) || "{{ event.product_title }}";

  return (
    <Section heading="Template preview">
      <BlockStack gap="base">
        <Text>
          Synthetic preview of the Klaviyo email using the same fields the event sends.
        </Text>

        <InlineStack inlineAlignment="start" gap="base">
          <Badge tone="info">SKU: {resolvedSku}</Badge>
          <Badge tone="info">Ship date: {resolvedShipDate}</Badge>
        </InlineStack>

        <Divider />

        {emailType === "will_call_ready" ? (
          <WillCallPreview
            customerEmail={customerEmail}
            firstName={firstName}
            orderNumber={orderNumber}
            productTitle={resolvedProductTitle}
            sku={resolvedSku}
          />
        ) : (
          <BackorderPreview
            customerEmail={customerEmail}
            productImageAlt={productImageAlt}
            productImageUrl={productImageUrl}
            productTitle={resolvedProductTitle}
            shipDate={resolvedShipDate}
            sku={resolvedSku}
          />
        )}
      </BlockStack>
    </Section>
  );
}

function BackorderPreview({
  customerEmail,
  productImageAlt,
  productImageUrl,
  productTitle,
  shipDate,
  sku,
}) {
  return (
    <BlockStack gap="base">
      <Heading size={3}>Backorder Notice</Heading>

      <Text>To: {customerEmail || "{{ profile.email }}"}</Text>

      {productImageUrl ? (
        <Image
          source={productImageUrl}
          accessibilityLabel={productImageAlt || productTitle}
        />
      ) : (
        <Box padding="base">
          <Text>
            The product image will appear here when the SKU matches a Shopify product image.
          </Text>
        </Box>
      )}

      <Text fontWeight="bold">{productTitle}</Text>
      <Text>SKU: {sku}</Text>

      <Divider />

      <Text>
        Based upon information from the manufacturer, the current ship date of your part(s) is:
      </Text>
      <Text fontWeight="bold">{shipDate}</Text>

      <Divider />

      <Text fontWeight="bold">Options</Text>
      <Text>
        HANG TIGHT: If you are okay to wait, you are good to go. Once we have tracking, or any
        other updates, we will forward them to this same email address.
      </Text>
      <Text>
        CHECK OPTIONS: If you would like a comparable option that is on the shelf and ready to
        ship, our sales technicians can help.
      </Text>
      <Text>
        CANCEL: If the backorder timeline is too long, we can cancel and refund the backordered
        item(s).
      </Text>
      <Text>
        QUESTIONS: Reply to this email or reach out by phone or website chat, Monday through Friday
        from 6AM to 6PM Pacific.
      </Text>
    </BlockStack>
  );
}

function WillCallPreview({customerEmail, firstName, orderNumber, productTitle, sku}) {
  return (
    <BlockStack gap="base">
      <Heading size={3}>Will Call Ready</Heading>

      <Text>To: {customerEmail || "{{ profile.email }}"}</Text>
      <Text fontWeight="bold">Pick Up on Location Order {orderNumber || "#"}</Text>
      <Text>Hello {firstName || "{{ profile.first_name|default:'there' }}"},</Text>
      <Text>
        Your order has been processed. We will contact you once your complete order is here and
        ready for pickup at Will Call.
      </Text>
      <Text>Thank you.</Text>

      <Divider />

      <Text fontWeight="bold">Reference item</Text>
      <Text>{productTitle}</Text>
      <Text>SKU: {sku}</Text>
    </BlockStack>
  );
}

function buildProductLabel(productTitle, productVariantTitle) {
  if (!productVariantTitle || productVariantTitle === "Default Title") {
    return productTitle;
  }

  return `${productTitle} - ${productVariantTitle}`.trim();
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
