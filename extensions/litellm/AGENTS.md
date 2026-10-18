# LiteLLM Tests

- Keep first-request capability proof in `src/agents/agent-command-local.test.ts`.
  Give authored models different capabilities from bundled defaults in both
  merge and replace modes.
- Multipart edit tests own LiteLLM's part names and upload assembly. Assert each
  image's bytes and MIME type, not just the number of parts.
- Keep configured cache retention reaching the stream separate from TTL
  bookkeeping and unspecified retention policy. An unspecified policy does not
  mean that the transport disables caching.
