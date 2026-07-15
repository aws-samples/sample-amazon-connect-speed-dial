# Customer Profiles — how it works, and how to create profiles for your users

This explains the `customerProfilesEnabled` capability: what it does on a call, how to create a
real profile (including one tied to a Cognito web-call user), and how it relates to the
`contextInjectionEnabled` feature (they **overlap** — see the last section).

## What happens on a call

When `customerProfilesEnabled` is on, the contact flow runs a `provide-profile-context`
`InvokeLambdaFunction` action (the `profile-lookup` Lambda) before the AI agent starts. That Lambda:

1. **Resolves the caller to a profile** via `customer-profiles:SearchProfiles`, trying three keys in order:
   1. `_phone` = the caller's phone number (voice calls with an ANI).
   2. `_account` = the `customerId` contact attribute (set by the web-call widget — see below).
   3. `_phone` = `DEMO_PROFILE_PHONE` (`+15550100123`) — a **static fallback** so the seeded demo
      profile always resolves, even on web-call / fresh-DID contacts with no real match.
2. **Bridges the profile into the Q in Connect session** by calling
   `qconnect:UpdateSessionData(namespace="Custom")` with the mapped fields.
3. The orchestration agent then reads those fields in its prompt via `{{$.Custom.<key>}}`.

**Why a Lambda and not the native "Customer profiles" flow block?** The native block writes results
into the `$.Customer.*` flow-attribute namespace, which the agent prompt does **not** read — the
agent reads the Q Connect session `Custom` namespace, writable only via `UpdateSessionData`. A
Lambda bridge is required regardless. (The native block's contact-flow-language `Type` string also
couldn't be verified from docs without a console capture — see the spec.) The Lambda does both the
lookup and the bridge in one step.

### Fields written to the session (`{{$.Custom.*}}`)

A profile carries a caller's **full** injected context — identity *and* recent activity. This is
the key idea: one profile is the single place that defines everything the agent should know about a
user.

| Session key (`{{$.Custom.<key>}}`) | Source on the profile |
|---|---|
| `customerName`  | `FirstName` + `LastName` |
| `customerId`    | `AccountNumber` |
| `accountTier`   | `Attributes.accountTier` (custom attribute) |
| `recentOrderId` | `Attributes.recentOrderId` (custom attribute) |
| `orderStatus`   | `Attributes.orderStatus` (custom attribute) |
| `openCaseCount` | `Attributes.openCaseCount` (custom attribute) |

Missing values interpolate to an empty string in the prompt (the agent simply proceeds without them).

## The seeded demo profile

At deploy time (when the flag is on), `connect-instance-stack.ts` creates **one** demo profile via
the `CreateProfile` API:

- Name **Alice Johnson**, `AccountNumber` **CUST001**, `PhoneNumber` **+15550100123**
- Custom attributes `accountTier=Premium`, `recentOrderId=ORD-12345`

This is the **only** profile that exists out of the box. **Nothing creates profiles on the fly** —
not Cognito sign-ins, and not contact records (the CTR integration is associated but no profile
object-type mapping is configured, so CTR auto-ingestion is dormant). Every web call therefore
resolves to Alice via the static fallback until you create more profiles.

## The web-call (WebRTC) `customerId` — important caveat

The web token Lambda (`lambda/widget/connect-token/index.ts`) passes a `customerId` attribute in the
widget JWT, set to the signed-in user's **Cognito `sub`** (a random UUID), which surfaces in the
flow as `$.Attributes.customerId` and is searched as the `_account` key (step 2 above).

But the seeded profile's `AccountNumber` is `CUST001`, **not** a Cognito UUID — so on a web call
that lookup misses and you fall through to the Alice fallback. To make the widget's `customerId`
resolve to a real, per-user profile, create a profile whose `AccountNumber` equals that Cognito
`sub` — exactly what the helper script does for you when you pass `--cognito-username` (next section).

## How to create a profile + injected context for a new user

Use the helper script — it reads the domain and user pool from `cdk-outputs.json`, is idempotent,
ties to a Cognito user automatically, and never needs the AWS console. (The skill offers to run this
for you post-deploy when `customerProfilesEnabled`; you can also run it directly.)

**Web-call user (recommended)** — tie the profile to a signed-in user. The widget sends that user's
Cognito `sub` as the `customerId`, which the flow searches as the `_account` key; the script
resolves the `sub` and sets it as the profile `AccountNumber` so they match:

```bash
scripts/create-customer-profile.sh <projectDir> \
  --first Jordan --last Lee \
  --cognito-username jordan \
  --tier Gold --order-id ORD-98765 --order-status Delivered --open-cases 0
```

**Voice caller** — match by phone number instead:

```bash
scripts/create-customer-profile.sh <projectDir> \
  --first Sam --last Rivera \
  --account CUST777 --phone +15557770000 \
  --tier Standard --order-id ORD-55500 --order-status Processing --open-cases 2
```

The script stores identity (name, account) plus the activity attributes (`recentOrderId`,
`orderStatus`, `openCaseCount`) and prints the exact `{{$.Custom.*}}` the agent will receive. Then
**call** — voice from the given number, or the web-call app signed in as that user — and the agent
greets them with their real context. No redeploy; profiles are data.

> Verify it resolved: `aws customer-profiles search-profiles --domain-name <projectName>-profiles
> --key-name _account --values "<account-or-sub>"`, and check the `profile-lookup` Lambda's
> CloudWatch logs for `SearchProfiles key=_account ... -> 1 match(es)`.

### Doing it by hand (what the script does)

If you'd rather not use the script: find the Cognito `sub`
(`aws cognito-idp admin-get-user --user-pool-id <UserPoolId> --username <u> --query
'UserAttributes[?Name==\`sub\`].Value' --output text`), then
`aws customer-profiles create-profile --domain-name <projectName>-profiles --account-number "<sub>"
--first-name … --last-name … --attributes accountTier=…,recentOrderId=…,orderStatus=…,openCaseCount=…`.

### Making this automatic (optional extensions, not built)

- **Seed-on-sign-up:** a Cognito post-confirmation Lambda trigger that runs the same `CreateProfile`
  with `AccountNumber = sub`, so every new web user gets a profile automatically.
- **Create-on-the-fly:** have the `profile-lookup` Lambda, on a no-match, `CreateProfile` for the
  incoming `customerId` before bridging. Requires adding `profile:CreateProfile` to the Lambda role
  (currently read-only: `profile:SearchProfiles`). This is the deferred "write path."
- **Real CTR ingestion:** configure a `CTR` profile object-type mapping so Connect auto-builds
  inferred profiles from call records (keyed by phone/email — most useful for the phone/UK-DID path).

## Relationship to pre-call context injection

`contextInjectionEnabled` and `customerProfilesEnabled` write the **same** `{{$.Custom.*}}` keys, by
design — they are two layers of the same "what the agent knows about the caller" data, with profiles
taking precedence:

| | Context injection (`provide-agent-context`) | Customer Profiles (`provide-profile-context`) |
|---|---|---|
| Role | Static **demo baseline** | Real **per-user** data |
| Source | Hardcoded values in the Lambda | Looked up live from the caller's profile |
| Keys written | `recentOrderId`, `orderStatus`, `openCaseCount` | `customerName`, `customerId`, `accountTier`, `recentOrderId`, `orderStatus`, `openCaseCount` |
| Runs | First (baseline) | **Last (overrides)** |

**Run order (when both on):** `provide-agent-context` → `provide-profile-context` → AI Agent block.
Context injection lays down a baseline; profile-lookup runs last, so **a matched profile overrides
it** with that caller's real data. With **no** profile match, profile-lookup writes nothing and the
demo baseline stands — so the agent always has *something*. The shared `{{$.Custom.*}}` prompt
snippet (identity + recent-activity sections) is appended once when **either** flag is on.

**Demo coherence:** the seeded profile and the baseline line up — Alice Johnson / `CUST001` /
Premium, `recentOrderId=ORD-12345` / `orderStatus=Shipped` — and the gateway's
`get_order_status(ORD-12345)` tool also returns `Shipped`. One consistent customer across all three
features.

**Why this design (vs. keying context off the resolved customer):** the Q Connect session is
write-only from a Lambda (`GetSession` returns no `data`), so context injection genuinely can't read
what profile-lookup resolved. Rather than route the id through a contact attribute, we let the
**profile itself carry the full context** and override the baseline — simpler, and the profile is
the natural home for per-user data anyway.

**Choosing flags:**
- **Both on** (default): real data when a profile matches, demo baseline otherwise. Recommended.
- **Profiles only:** real per-user data, but an unmatched caller gets no context (no baseline).
- **Context injection only:** everyone gets the same demo context; no profile lookup.
