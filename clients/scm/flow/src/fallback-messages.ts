import type { ScmState } from "./states.js";

export const fallbackMessages: Record<ScmState, string> = {
  NEW:
    "Welcome to SelfCareMen. I will help you book a consultation. Could you please tell me your full name?",
  COLLECTING_NAME:
    "Thanks for getting in touch. To get started, could you please provide your full name?",
  COLLECTING_PHONE:
    "What is the best phone number to reach you on? Please include your country code, for example +64 21 000 0000.",
  COLLECTING_EMAIL:
    "What is your email address? We will use it to send your appointment confirmation.",
  SELECTING_SERVICE:
    "Which service would you like to book? You can reply with the service name, for example TRT Initial Consultation, Free Eligibility Consultation, or RoidCare+ Initial.",
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
};

export function getFallbackMessage(state: ScmState): string {
  return fallbackMessages[state] ?? fallbackMessages.NEW;
}
