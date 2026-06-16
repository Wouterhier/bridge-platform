import { generate } from './clients/scm/flow/src/generate.js';
import { createRouter } from './clients/scm/flow/src/model-router-factory.js';
import { loadConfig } from './core/model-router/src/config.js';

const cfg = loadConfig();
const router = createRouter({
  ...cfg,
  generateModel: 'dash_intl/glm-5.1',
  generateFallbackModel: 'dash_intl/glm-5.1',
});

const samples = [
  {
    name: 'slot offer',
    state: 'SHOWING_SLOTS',
    collected: { fullName: 'John Smith', serviceKey: 'trt_initial' },
  },
  {
    name: 'payment nudge',
    state: 'AWAITING_PAYMENT',
    collected: { fullName: 'John Smith', serviceKey: 'trt_initial', slotIso: '2026-06-20T09:00:00+12:00' },
  },
  {
    name: 'confirmation',
    state: 'CONFIRMED',
    collected: { fullName: 'John Smith', serviceKey: 'trt_initial', slotIso: '2026-06-20T09:00:00+12:00' },
  },
];

for (const s of samples) {
  console.log(`\n=== ${s.name.toUpperCase()} (${s.state}) ===`);
  const text = await generate(s.state, s.collected, [], undefined, undefined, { router });
  console.log(text);
}
