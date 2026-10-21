# OAuth App Verification Checklist

This document is a reusable checklist for preparing Anavyst's provider integrations for review. Keep account identifiers, OAuth client IDs, email addresses, screenshots, tokens, and other environment-specific details in private operational records—not in this public repository.

## Google OAuth verification

Before submitting or changing the Google OAuth consent screen, verify the following in Google Cloud Console:

- [ ] App name, homepage, privacy policy, terms of service, authorized domains, and support contact match the current production site.
- [ ] Every configured redirect URI exactly matches the callback URL used by the deployed app.
- [ ] Requested scopes are limited to the minimum required by integrations enabled in the target environment.
- [ ] The privacy policy accurately describes Google user data access, use, storage, deletion, and sharing, including the Google API Services User Data Policy and Limited Use requirements where applicable.
- [ ] The app's consent and disconnect/delete flows work end to end.
- [ ] The app's publishing status and test-user restrictions are understood before inviting real customers.
- [ ] The demo recording shows a real, complete flow and does not expose passwords, tokens, private customer data, or sample metrics presented as live data.
- [ ] Submit the app for verification only after the relevant console settings and user-facing disclosures have been checked.

**Scope changes require review.** Before enabling an additional Google integration, inspect the scopes it requests and confirm whether the API requires additional verification, restricted-scope review, or a security assessment. Do not enable an integration in production solely by adding it to an environment allowlist; verify credentials, API access, permissions, and the full connection flow first.

## Meta app review

In the Meta developer console, verify:

- [ ] App name, category, privacy policy, terms, and data-deletion instructions are current.
- [ ] Redirect URIs exactly match the deployed callback URL.
- [ ] Requested permissions are limited to those required by enabled Meta Ads and Instagram features.
- [ ] App Review evidence demonstrates the real connect, data-access, disconnect, and deletion flows.
- [ ] Business verification and access-level requirements have been checked for the requested permissions.
- [ ] The test account meets any account-type and asset-linking requirements for the feature being demonstrated.

## Other advertising and analytics integrations

For each provider:

- [ ] Confirm the current API access and review requirements directly in the provider's developer console/documentation.
- [ ] Request only the scopes needed for implemented functionality.
- [ ] Validate OAuth state/nonce handling, callback URL, token refresh, disconnect, and deletion flows.
- [ ] Keep provider credentials and account-specific setup notes in a private secrets manager or restricted operational document.
- [ ] Enable the integration in production only after a safe end-to-end test.

## Production launch review

- [ ] Confirm the production app URL and redirect URIs are consistent.
- [ ] Confirm environment variables are configured in the deployment platform and are not committed to source control.
- [ ] Verify that production customer data is never replaced by demo/sample data without a clear user-facing label.
- [ ] Test authorization and tenant isolation for agencies with multiple clients.
- [ ] Verify data deletion and provider deauthorization callbacks.
- [ ] Recheck this document whenever provider scopes or production integrations change.

Do not store personal email addresses, OAuth client identifiers, production account/property IDs, test-user lists, private screenshots, or internal account-review notes in this public checklist.
