/* Type declarations for relative source imports that bypass dist bundles */
declare module "../../service/src/conversation-service.js" {
  export { ConversationService, recoverUnsentReplies, type InboundPayload } from "../../../service/src/conversation-service.js";
}

declare module "../../payment-service/src/payment-service.js" {
  export { PaymentService, WebhookError } from "../../../payment-service/src/payment-service.js";
}

declare module "../../payment-service/src/payment-processor.js" {
  export { onPaymentConfirmed } from "../../../payment-service/src/payment-processor.js";
}
