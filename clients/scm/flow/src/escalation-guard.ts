const EMERGENCY_PATTERNS = [
  /\b(chest pain|can't breathe|cannot breathe|difficulty breathing|short of breath|breathlessness|suicide|suicidal|self[- ]?harm|overdose|heart attack|stroke symptoms|severe bleeding|unconscious|fainting|severe allergic reaction|anaphylaxis|severe pain|thoughts of (harming myself|ending my life|killing myself)|hurt(ing)? myself|harm myself|end it all|end my life|don't want to (be here|live|go on)|no reason to live|want to die|want to end (it|my life)|kill myself|can't go on|can't cope|hopeless|worthless)\b/i,
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
