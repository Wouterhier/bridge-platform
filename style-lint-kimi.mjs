import { generate } from './clients/scm/flow/src/generate.ts';
import { createRouter } from './clients/scm/flow/src/model-router-factory.ts';
import { loadConfig } from './core/model-router/src/config.ts';

const cfg = loadConfig();
const router = createRouter({
  ...cfg,
  generateModel: 'moon_api/kimi-k2.6',
  generateFallbackModel: 'moon_api/kimi-k2.6',
});

function lintMessage(text) {
  const issues = [];
  const trimmed = text.trim();
  const firstSentence = (trimmed.split(/[.!?\n]/)[0] ?? '');

  if (text.includes('—') || /\b--\b/.test(text)) {
    issues.push('contains em dash');
  }
  if (/^(hey|hey there)\b/i.test(trimmed)) {
    issues.push('opens with Hey/Hey there');
  }
  if (/!/.test(firstSentence)) {
    issues.push('exclamation point in opening line');
  }
  if (/;/.test(text)) {
    issues.push('contains semicolon');
  }

  return issues;
}

const testStates = [
  { state: 'NEW', collected: {} },
  { state: 'COLLECTING_NAME', collected: {} },
  { state: 'COLLECTING_PHONE', collected: { fullName: 'John Smith' } },
  { state: 'COLLECTING_EMAIL', collected: { fullName: 'John Smith', phone: '+64210000000' } },
  { state: 'SELECTING_SERVICE', collected: { fullName: 'John Smith', phone: '+64210000000', email: 'john@example.com' } },
  { state: 'SHOWING_SLOTS', collected: { fullName: 'John Smith', serviceKey: 'trt_initial' } },
  { state: 'AWAITING_SELECTION', collected: { fullName: 'John Smith', serviceKey: 'trt_initial', slotMenu: [{ iso: '2026-06-20T09:00:00+12:00' }] } },
  { state: 'CREATING_CHECKOUT', collected: { fullName: 'John Smith', serviceKey: 'trt_initial', slotIso: '2026-06-20T09:00:00+12:00' } },
  { state: 'AWAITING_PAYMENT', collected: { fullName: 'John Smith', serviceKey: 'trt_initial', slotIso: '2026-06-20T09:00:00+12:00' } },
  { state: 'CONFIRMED', collected: { fullName: 'John Smith', serviceKey: 'trt_initial', slotIso: '2026-06-20T09:00:00+12:00' } },
];

let pass = 0;
let fail = 0;

for (const { state, collected } of testStates) {
  const text = await generate(state, collected, [], undefined, undefined, { router });
  const issues = lintMessage(text);
  if (issues.length === 0) {
    pass++;
    console.log(`PASS ${state}`);
  } else {
    fail++;
    console.log(`FAIL ${state}: ${issues.join(', ')}`);
    console.log(`  text: ${text.slice(0, 200).replace(/\n/g, ' ')}`);
  }
}

console.log(`\nTotal: ${pass} pass, ${fail} fail out of ${testStates.length}`);
