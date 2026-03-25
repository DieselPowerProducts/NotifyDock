-- CreateTable
CREATE TABLE "NotifyDockEmailHistory" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "firstName" TEXT,
    "emailType" TEXT NOT NULL,
    "fromAddress" TEXT,
    "subject" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "sentByEmail" TEXT,
    "sku" TEXT,
    "metricName" TEXT,
    "source" TEXT NOT NULL DEFAULT 'app',
    "sourceEventId" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotifyDockEmailHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotifyDockEmailHistory_sourceEventId_key" ON "NotifyDockEmailHistory"("sourceEventId");

-- CreateIndex
CREATE INDEX "NotifyDockEmailHistory_shop_orderId_sentAt_idx" ON "NotifyDockEmailHistory"("shop", "orderId", "sentAt" DESC);

-- CreateIndex
CREATE INDEX "NotifyDockEmailHistory_shop_customerEmail_sentAt_idx" ON "NotifyDockEmailHistory"("shop", "customerEmail", "sentAt" DESC);
