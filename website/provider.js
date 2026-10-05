// The only site-local identity the microsite needs. Everything else comes
// from the shared stackql/docusaurus-config, vendored to .shared-config/ at
// build time (see package.json vendor-config).
export const providerName = 'typesafe';
export const providerTitle = 'TypeSafe';

// Optional: the scoping server variable and its environment variable
// (x-stackQL-envVar). scripts/sanitize-docs.mjs annotates the generated
// examples "required unless <env var> is set" when both are set; leave null
// for a fixed-host API.
export const scopeVariable = null;   // e.g. 'organization_id'
export const scopeEnvVar = null;     // e.g. 'TYPESAFE_ORG_ID'
