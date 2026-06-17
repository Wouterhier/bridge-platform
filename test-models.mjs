import { createRouter } from './clients/scm/flow/src/model-router-factory.js';
import { loadConfig } from './core/model-router/src/config.js';

const cfg = loadConfig();

async function testModel(model) {
  const router = createRouter({
    ...cfg,
    generateModel: model,
    generateFallbackModel: model,
  });

  try {
    const res = await router.complete('generate', {
      role: 'generate',
      system: 'You are a helpful assistant. Be warm and concise.',
      messages: [{ role: 'user', content: 'Write one sentence welcoming a patient to a mens telehealth clinic.' }],
      temperature: 0.7,
      maxTokens: 128,
    });
    console.log(`OK  ${model}`);
    console.log(`  provider=${res.provider} model=${res.model}`);
    console.log(`  raw=${JSON.stringify(res.text)}`);
    console.log(`  trimmed=${JSON.stringify(res.text.trim())}`);
    console.log(`  length=${res.text.trim().length}`);
    return { ok: true, text: res.text.trim(), provider: res.provider, model: res.model };
  } catch (err) {
    console.log(`FAIL ${model}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

const candidates = ['moon_api/kimi-k2.6', 'dash_intl/glm-5.1'];
for (const m of candidates) {
  await testModel(m);
}
