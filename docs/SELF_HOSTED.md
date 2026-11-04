# Self-hosted build

This fork supports only explicitly configured OpenAI-compatible APIs. Open **Providers**, fill in your API Base URL (including `/v1` when required), optional API key and model name, then save and test. Use **Load models** to query your own endpoint and **Duplicate** for another endpoint. Enable image support on the provider only when the chosen model supports it.

There is no default hosted API, no cloud fallback and no automatic model download. The former provider catalog is removed. Upgrading retains the selected local runtime as a generic OpenAI-compatible card; former hosted cards are dropped. The first upgrade clears legacy sharing and memory-extraction queues, disables automatic memory/debug recording and cloud sync, resets auxiliary model configurations, and enables screenshot redaction. Explicitly saved local memory remains local and can still enter your chosen model's context.

Research-sharing transports, managed-cloud runtime uploads, cloud sync, feedback uploads, remote favicon requests, default FreeSkillz tools, external decision models, MemCode access and remote bulletins are disabled. Old stored consent cannot re-enable the removed upload transports. Website reads and actions requested by the user still contact the relevant websites normally; an explicitly imported HTTP skill can contact its declared endpoint.

Automatic memory learning is off by default. If enabled, a queued task carries its original provider ID, endpoint and model. Switching to another provider does not reroute the task. Changing/removing that original endpoint/model drops it; legacy jobs with no owner are discarded.

Speech transcription requires an explicit endpoint under **Providers → Speech**, independently of the chat endpoint, and accepts only audio containers. Screen-video recordings are never uploaded for transcription. Image generation, CAPTCHA services and external decision-model setup are hidden in this build.

API keys remain in the browser's extension-local storage; configuration exports still contain them in plaintext. Do not share configuration exports or lossless traces containing private material.

## Build and verify

- `npm run test:privacy` checks own-API transport, migration, memory ownership, removed uploads, conversation privacy, guards and packaging boundaries.
- `npm run test:privacy:browser` loads the real Chromium extension, opens settings and the side panel, connects to a loopback mock API and checks for unexpected network requests.
- `npm run build:privacy` writes Chrome ZIP, unsigned Firefox XPI and checksums to `dist/self-hosted/`. A full `src/` checkout is required.
- `.github/workflows/self-hosted-release.yml` runs these checks on pushes to `main`, then publishes the artifacts to this repository's Releases. It can also be run manually and uses only the repository's `GITHUB_TOKEN`.

The Chromium browser smoke test covers the loaded extension. Firefox's provider and memory behavior are exercised by the same unit/integration suite; A real Firefox extension UI smoke test is not automated here. These unsigned artifacts are not submissions to browser stores. Standard Firefox release-channel installation requires Mozilla signing; this workflow has no AMO signing credentials.
