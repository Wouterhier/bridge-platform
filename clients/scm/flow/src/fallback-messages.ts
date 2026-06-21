import type { ScmState } from "./states.js";

export const fallbackMessages: Record<ScmState, string> = {
  NEW:
    "Welcome to SelfCareMen. I will help you book a consultation or answer any questions you have. What brings you in today?",
  ENGAGING:
    "Welcome to SelfCareMen. I am here to help you with bookings or answer questions. What can I do for you?",
  SELECTING_SERVICE:
    "Which service would you like to book? You can reply with the service name, for example TRT Initial Consultation, Free Eligibility Consultation, or RoidCare+ Initial.",
  COLLECTING:
    "To complete your booking I just need a few more details from you. Could you share those when you have a moment?",
  SHOWING_SLOTS:
    "Here are the available appointment slots. Please let me know which one suits you best.",
  AWAITING_SELECTION:
    "Please pick one of the slots I shared. Just reply with the time that works for you.",
  CREATING_CHECKOUT:
    "I am preparing your secure payment link. Your slot is held while you complete payment. One moment please.",
  AWAITING_PAYMENT:
    "Your slot is held. Please complete payment via the secure link we sent. Once payment clears, I will confirm your appointment straight away.",
  BOOKING_ACUITY:
    "I am finalising your booking in our calendar. One moment please.",
  CONFIRMED:
    "Your appointment is confirmed. If you need to reschedule or have any questions, just let us know.",
  HUMAN_TOUCH:
    "A member of our team will be in touch with you shortly.",
};

export function getFallbackMessage(state: ScmState): string {
  return fallbackMessages[state] ?? fallbackMessages.NEW;
}
