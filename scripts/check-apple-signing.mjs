import { assertRequiredSigning } from './signing-policy.mjs';
const status = assertRequiredSigning('macOS', process.env.REQUIRE_PUBLISHER_SIGNING === 'true', process.env);
console.log(status.enabled ? 'macOS Developer ID and notarization inputs are present.' : `macOS rehearsal will be ad-hoc; missing inputs: ${status.missing.join(', ')}.`);
