const EMERGENCY_PATTERNS = [
  /\b(chest pain|can't breathe|cannot breathe|difficulty breathing|short of breath|breathlessness|suicide|suicidal|self[- ]?harm|overdose|heart attack|stroke symptoms|severe bleeding|unconscious|fainting|severe allergic reaction|anaphylaxis|severe pain)\b/i,
  /\bthoughts of (harming myself|ending my life|killing myself)\b/i,
  /\b(hurt(ing)? myself|harm myself)\b/i,
  /\bend it all\b/i,
  /\bend my life\b/i,
  /\bdon't want to be here\b/i,
  /\bdon't want to live\b/i,
  /\bno reason to live\b/i,
  /\bwant to die\b/i,
  /\bwant to end (it|my life)\b/i,
  /\bkill myself\b/i,
  /\bcan't go on\b/i,
  /\bcan't cope\b/i,
  /\bhopeless\b/i,
  /\bworthless\b/i,
];

// Steroids, SARMs, PEDs and related anabolic compounds.
const PED_PATTERNS = [
  /\b(steroids?|anabolic steroids?|sarms?|selective androgen receptor modulators?|peds?|performance enhancing drugs?)\b/i,
  /\b(trenbolone|tren|anavar|dianabol|dbol|deca|nandrolone|sustanon|testosterone enanthate|testosterone cypionate|testosterone propionate)\b/i,
  /\b(human growth hormone|hgh|clenbuterol|clen|winstrol|stanozolol|anadrol|oxymetholone|turinabol|boldenone|equipoise|masteron|primobolan)\b/i,
];

export interface EscalationResult {
  escalate: boolean;
  reason?: string;
}

export function shouldEscalate(
  message: string | undefined,
  serviceKey?: string,
): EscalationResult {
  if (!message || message.trim() === '') {
    return { escalate: false };
  }
  const lower = message.toLowerCase();

  for (const pattern of EMERGENCY_PATTERNS) {
    if (pattern.test(lower)) {
      return { escalate: true, reason: "medical_emergency" };
    }
  }

  for (const pattern of PED_PATTERNS) {
    if (pattern.test(lower)) {
      if (serviceKey && serviceKey.startsWith("roidcare_")) {
        // Expected topic for RoidCare — do not escalate.
        continue;
      }
      return { escalate: true, reason: "ped_mention" };
    }
  }

  return { escalate: false };
}
