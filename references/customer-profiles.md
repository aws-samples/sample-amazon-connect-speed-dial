# Customer Profiles — how caller identity reaches the agent, and how to create profiles

This explains the `customerProfilesEnabled` capability (default **on**): how a caller is
resolved to a Customer Profile, how the profile's data reaches the contact flow and the AI
agent, and how to create profiles for your users with `csp setup-test-users`.

## The pieces

- **Customer Profiles domain** — `amazon-connect-<projectName>-profiles`, created by the
  ConnectInstance stack (always, independent of the flag) and encrypted with the deployment's
  customer-managed storage key. Its CTR object type is set to `CTR-AutoAssociateOnly`:
  contacts auto-associate with *existing* profiles, but **no inferred profiles are ever
  created** — the domain stays empty until you create profiles yourself.
- **The `get-customer-profile` flow module** (`flows/get-customer-profile.json`, deployed as
  `<projectName>-get-customer-profile` by the ContactFlow stack) — resolves the caller using
  **native `GetCustomerProfile` blocks** and returns identity fields to the main flow.
- **The UpdateSessionContext Lambda** (`lambda/flow/update-session-context/index.py`,
  FlowLambdas stack; deployed only when `customerProfilesEnabled`) — resolves the caller's
  profile and pushes identity + latest-order data into the **Q in Connect session**, which is
  what the agent prompt actually reads (`{{$.Custom.<key>}}`).

**Why both a module and a Lambda?** They feed different consumers. The module's result lands
in flow-attribute space (`$.Modules.ResultData.*`) — usable by flow blocks for language and
contact attributes, but invisible to the agent. The agent prompt reads only the Q Connect
session's `Custom` namespace, writable solely via `qconnect:UpdateSessionData` — so a Lambda
bridge is required for the agent side.

## What happens on a call

1. **Flow module lookup — language + contact attributes.** The first thing the flow does is
   `InvokeFlowModule` with `email` = the `email` contact attribute (the web-call widget's JWT
   sets it from the signed-in Cognito user) and `phone_address` = the caller's ANI
   (`$.CustomerEndpoint.Address`). Inside the module: if the email contains `@`, a native
   `GetCustomerProfile` block searches `_email`; otherwise, if the phone contains `+`, a
   second one searches `_phone`. Three branch outcomes come back:
   - **success** — the module returns `customerNumber`, `firstName`, `lastName`, `locale`
     (from the profile's name fields and its `customerNumber`/`locale` custom attributes).
     The flow stores FirstName/LastName/CustomerNumber as contact attributes and sets the
     contact's **LanguageCode to the profile's `locale`** — a known caller gets the greeting,
     consent prompt, and voice in *their* language (the prompt-texts data table is keyed by
     language).
   - **unknown** (no match, or no usable key) or **multiple** (more than one profile
     matched) — the flow proceeds anonymously with the deployment's default language.
2. **Session bridge — agent context.** Just before the AI agent starts, the flow creates the
   Q Connect session and invokes the UpdateSessionContext Lambda (the `provide-agent-context`
   action). The Lambda resolves the profile independently, first match wins:
   **phone (ANI) → `email` attribute (`_email`) → `customerId` attribute (`_account`)** —
   the last being the widget's Cognito `sub`. On a match it writes to the session `Custom`
   namespace via `UpdateSessionData`:
   - identity: `customerName`, `customerId` (the profile's `customerNumber` attribute,
     falling back to `AccountNumber`), `accountTier`;
   - the caller's **most recent SAP order**, pre-loaded from the SAP orders DynamoDB table so
     the agent answers "my last order" without a tool call: `recentOrderId`, `orderStatus`,
     `orderTotal`, `orderCurrency`, `orderRequestedDelivery`.
   On no match the Lambda returns gracefully — every `{{$.Custom.*}}` variable interpolates
   to an empty string and the agent proceeds without caller context (the prompt then forbids
   order-tool calls until the caller is identified).
3. **The agent reads the context.** `csp render` splices
   `prompts/context-injection.snippet.md` into the orchestration prompt; it interpolates the
   session keys below and instructs the agent to greet the caller by name, treat the data as
   authoritative, and pass `customerId` as the mandatory `customer_number` on every SAP
   order-tool call (so callers only ever see their own orders).

### Fields written to the session (`{{$.Custom.*}}`)

| Session key | Source |
|---|---|
| `customerName` | profile `FirstName` + `LastName` |
| `customerId` | profile `Attributes.customerNumber` (fallback: `AccountNumber`) |
| `accountTier` | profile `Attributes.accountTier` |
| `recentOrderId`, `orderStatus`, `orderTotal`, `orderCurrency`, `orderRequestedDelivery` | the customer's latest order in the SAP orders table (queried by `customerId`) |

## How callers map to profiles

| Caller | Lookup keys tried | Profile field that must match |
|---|---|---|
| Voice call (real number) | ANI → `_phone` | `PhoneNumber` |
| Web call (signed in) | `email` attribute → `_email`, then Cognito `sub` → `_account` | `EmailAddress`, or `AccountNumber` = the `sub` |

**The Cognito `sub` caveat:** the widget's `customerId` attribute is the signed-in user's
Cognito `sub` — a random UUID. Nothing links it to a profile unless the profile's
`AccountNumber` *is* that `sub`. That is exactly what `csp setup-test-users` arranges, which
is why it is the recommended way to create web-call test users (email matching also works,
since the command stores the user's email on the profile).

## Creating a user + profile: `csp setup-test-users`

No profiles exist after deployment — create one per test user. The command reads the domain
and user pool from the deployed stacks, is idempotent (an existing profile is updated, a
pending Cognito user is re-invited), and never needs the AWS console:

```bash
csp setup-test-users csp-<name> --user jordan --first Jordan --last Lee \
  --email jordan@example.com --phone +15557770000 --customer-number 0000100042 --locale en-US
```

It creates the Cognito login (temporary password delivered **by email**, never printed) and
the matching profile in one step, with `AccountNumber` set to the user's Cognito `sub` so the
web-call `_account` lookup matches. `--locale` becomes the profile's `locale` attribute — the
language the flow switches to for this caller. Use customer number `0000100042` to tie the
user to the seeded sample orders in the SAP mock API (any other value means the order tools
and the pre-loaded "recent order" find nothing for them).

If the WebcallWidget stack is not deployed (phone-only), the Cognito step is skipped and the
profile alone is created with `AccountNumber` = the customer number — the caller is then
resolved by phone (ANI), so `--phone` must be the number they will really call from. Then
**call** — voice from that number, or the web-call app signed in as that user — and the agent
greets them with their real context. No redeploy; profiles are data.

### Doing it by hand (what the command does)

Find the Cognito `sub` (`aws cognito-idp admin-get-user --user-pool-id <UserPoolId>
--username <u> --query 'UserAttributes[?Name==\`sub\`].Value' --output text`), then
`aws customer-profiles create-profile --domain-name amazon-connect-<projectName>-profiles
--account-number "<sub>" --party-type INDIVIDUAL --first-name … --last-name … --phone-number …
--email-address … --attributes customerNumber=<n>,locale=<xx-XX>`.

## Troubleshooting

- **Verify a profile resolves:** `aws customer-profiles search-profiles --domain-name
  amazon-connect-<projectName>-profiles --key-name _account --values "<sub>"` (or `_phone` /
  `_email`). Note: the domain is encrypted with the deployment's customer-managed key, so the
  *caller's* credentials need `kms:Decrypt` on that key — an `AccessDeniedException` from the
  CLI usually means KMS, not IAM on the profile actions.
- **Agent doesn't greet by name:** check the UpdateSessionContext Lambda's CloudWatch logs
  (FlowLambdas stack; description "Resolves caller profile and pushes identity data into the
  Q Connect session"). It logs at `LOG_LEVEL=ERROR` by default — set the environment variable
  to `INFO` to see `SearchProfiles key=… -> N match(es)` per lookup key.
- **Known caller still gets the default language:** that is the *module's* lookup (email →
  phone) failing while the Lambda's (phone → email → account) may still succeed — e.g. a
  voice caller whose profile has a phone but the contact carries no `email` attribute is fine,
  but a profile found only by `_account` never switches the language (the module doesn't
  search `_account`). Make sure the profile carries the email and/or E.164 phone number.
- **`multiple` outcome (anonymous despite a profile):** more than one profile shares the
  email or phone — the native block takes its `MultipleFoundError` branch. Delete or merge
  the duplicates; `setup-test-users` updates rather than duplicates, so dupes usually come
  from manual `create-profile` runs.
- **Recent order is empty for an identified caller:** the customer number on the profile has
  no orders in the SAP mock data — use `0000100042` for the seeded sample orders.
