import { createRouter } from './clients/scm/flow/src/model-router-factory.ts';
import { loadConfig } from './core/model-router/src/config.ts';

const cfg = loadConfig();
const router = createRouter({
  ...cfg,
  generateModel: 'dash_intl/glm-5.1',
  generateFallbackModel: 'dash_intl/glm-5.1',
});

const res = await router.complete('generate', {
  role: 'generate',
  system: 'You are a helpful assistant. Be warm and concise.',
  messages: [{ role: 'user', content: 'Write one sentence welcoming a patient to a mens telehealth clinic.' }],
  temperature: 0.7,
  maxTokens: 128,
});
console.log('provider=', res.provider, 'model=', res.model);
console.log('text=', JSON.stringify(res.text));
