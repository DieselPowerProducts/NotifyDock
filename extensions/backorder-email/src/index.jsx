import {
  AdminBlock,
  BlockStack,
  Button,
  Text,
  reactExtension,
  useApi,
} from "@shopify/ui-extensions-react/admin";

const TARGET = "admin.order-details.block.render";
const ACTION_HANDLE = "notify-dock-action";

export default reactExtension(TARGET, () => <BlockLauncher />);

function BlockLauncher() {
  const {data, intents, navigation} = useApi(TARGET);
  const orderId =
    getOrderIdFromAdminUrl(intents?.launchUrl) || data?.selected?.[0]?.id || "";

  return (
    <AdminBlock title="Notify Dock">
      <BlockStack gap="base">
        <Text>
          Open the full composer in a popup to review and send a backorder or will-call email.
        </Text>

        <Button
          disabled={!orderId}
          onPress={() => {
            const params = new URLSearchParams({
              openedAt: String(Date.now()),
              orderId,
            });

            navigation.navigate(`extension:${ACTION_HANDLE}?${params.toString()}`);
          }}
          variant="primary"
        >
          Open composer
        </Button>
      </BlockStack>
    </AdminBlock>
  );
}

function getOrderIdFromAdminUrl(launchUrl) {
  if (!launchUrl) {
    return "";
  }

  try {
    const pathname = new URL(String(launchUrl)).pathname;
    const match = pathname.match(/\/orders\/(\d+)/);

    if (!match) {
      return "";
    }

    return `gid://shopify/Order/${match[1]}`;
  } catch (_error) {
    return "";
  }
}
