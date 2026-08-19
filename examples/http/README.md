# HTTP Contract Examples

[`settleflow.http`](settleflow.http) is a source-controlled REST Client collection for every implemented public business route. It uses placeholders and synthetic values only; it contains no usable API key, signing secret, provider data, or environment credential.

## Use

1. Start the local infrastructure, migrations, API, and worker using the [local development guide](../../docs/operations/local-development.md).
2. Obtain a one-time synthetic merchant API key through the repository's internal development/demo provisioning boundary. There is intentionally no public onboarding or API-key management endpoint.
3. Copy `settleflow.http` to an ignored local file or provide editor-local variables. Replace `merchantApiKey` only outside source control.
4. Run requests in order and let named-response variables capture Payment, Refund, Webhook endpoint, Settlement, and Reconciliation IDs.
5. For a development Webhook URL, run an endpoint you control on an origin explicitly present in `WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS`. Never add broad/private-network allowances.

The collection is illustrative and does not replace the committed [OpenAPI](../../docs/api/openapi.json), exact [event/Webhook contract](../../docs/events/README.md), or automated contract/integration tests. A `409` from an intentionally concurrent idempotency request is documented behavior; changing a key/body to force success is not a recovery procedure.

Do not save response bodies containing one-time Webhook secrets, authorization headers, idempotency values, amounts/references from anything other than synthetic fixtures, or raw Reconciliation data in public logs/artifacts.
