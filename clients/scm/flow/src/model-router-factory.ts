import { ModelRouter, loadConfig, type RouterConfig } from "@romea/model-router";
import { AnthropicProvider } from "@romea/provider-anthropic";
import { createMoonshotProvider } from "@romea/provider-moonshot";
import { createGoogleProvider } from "@romea/provider-google";
import { createStreamlakeProvider } from "@romea/provider-streamlake";

export function createRouter(cfg?: RouterConfig): ModelRouter {
  const config = cfg ?? loadConfig();
  return new ModelRouter({
    config,
    providers: {
      anth_api: new AnthropicProvider({
        apiKey: config.anthropicApiKey ?? "",
        baseUrl: config.anthropicBaseUrl,
      }),
      moon_api: createMoonshotProvider({
        apiKey: config.moonshotApiKey ?? "",
        baseUrl: config.moonshotBaseUrl,
      }),
      google: createGoogleProvider({
        apiKey: config.googleApiKey ?? "",
        baseUrl: config.googleBaseUrl,
      }),
      zai: createStreamlakeProvider({
        apiKey: config.streamlakeApiKey ?? "",
        baseUrl: config.streamlakeBaseUrl,
      }),
    },
  });
}
