'use strict';

/**
 * Live-provider test harness runner (docs/AI-LIVE-CHECKS.md).
 *
 * The only Electron-aware piece of the harness. It adapts the existing
 * AI host service (createAiService in electron/ai-host.cjs) to the pure
 * core's facade and enforces the main-side guards:
 *
 *   - CI refusal: a run is impossible when the CI / GITHUB_ACTIONS
 *     environment markers are set (the same signals the repo's build
 *     scripts treat as CI);
 *   - single flight: one run per app instance — a second attempt fails
 *     with kind 'busy' and never disturbs the active run.
 *
 * The facade invokes the service's own methods on the service instance
 * (getState / testConnection / ask / draft / refine), so key resolution,
 * destination pinning, generation checks, host validation and the
 * network call all stay inside the existing service, unchanged. This
 * module imports nothing credential-, store- or transport-related and
 * holds no key material at any point; the run's inputs are the core's
 * fixed fixtures, never caller-supplied values.
 */

const { randomUUID } = require('node:crypto');
const { AiHostError } = require('./ai-host.cjs');
const { runLiveChecks } = require('./ai-live-checks-core.cjs');

/**
 * Adapt the host service to the core facade. Each method calls through
 * to the same-named method on the service instance at call time, so the
 * service's own dispatch (and its per-provider state) is preserved —
 * the adapter adds no logic of its own.
 */
function serviceFacade(service) {
  return {
    getState: () => service.getState(),
    testConnection: (signal) => service.testConnection(signal),
    ask: (request, signal) => service.ask(request, signal),
    draft: (request, signal) => service.draft(request, signal),
    refine: (request, signal) => service.refine(request, signal),
  };
}

/**
 * Build the runner over an already-constructed AI service.
 * `options.env` exists for tests; production reads the process
 * environment at run time (a single read, used only for the CI guard).
 */
function createLiveChecksRunner(service, options = {}) {
  const facade = serviceFacade(service);
  let running = false;
  return {
    /** Whether a run is currently active (single-flight state). */
    isRunning: () => running,
    /**
     * Run the fixed check sequence once. Resolves with the core's
     * bounded report; rejects with AiHostError 'provider-failure' in a
     * CI environment and 'busy' while another run is active.
     */
    async run(signal) {
      const env = options.env ?? process.env;
      if (env && (env.CI || env.GITHUB_ACTIONS)) {
        throw new AiHostError('provider-failure', 'Live provider checks cannot run in a CI environment.');
      }
      if (running) {
        throw new AiHostError('busy', 'Live provider checks are already running.');
      }
      running = true; // Installed before the run can await anything.
      try {
        return await runLiveChecks(facade, { runTag: randomUUID(), signal });
      } finally {
        running = false;
      }
    },
  };
}

module.exports = { createLiveChecksRunner, serviceFacade };
