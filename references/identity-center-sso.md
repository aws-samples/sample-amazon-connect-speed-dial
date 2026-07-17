# IAM Identity Center (SSO) Integration — full setup guide

This explains the `identityCenterEnabled` capability: how to enable it, the manual Identity
Center steps required before and after deployment, where users actually sign in, and the
error→cause troubleshooting table. It's only relevant to deployments that use SSO instead of
Connect-managed users — the README keeps a short summary and links here for the detail.

The Connect instance can optionally use **AWS IAM Identity Center** for user authentication
instead of the built-in Connect user management. When enabled, users managed in Identity Center
can SSO directly into the Connect agent workspace.

> **Important:** The identity management type is set at instance creation time and **cannot be
> changed afterward**. Choose before your first deployment. Switching later means destroying and
> recreating the entire Connect instance (losing users, claimed numbers, and configuration).

## How to Enable

The skill asks during setup ("How should agents and admins sign in?" in the operational
course) and handles the wiring; the steps below describe what happens (or how to do it
without the skill):

1. Set `identityCenterEnabled` to `true` in your order JSON (`.connect-skill-order.json`):

   ```json
   {
     "identityCenterEnabled": true
   }
   ```

   If omitted or set to `false`, the instance uses Connect's built-in identity management
   (`CONNECT_MANAGED`).

2. **Before deploying** — create the Identity Center application (catalog "Amazon Connect"
   or custom SAML 2.0 app), download its **SAML metadata XML**, and save it as
   `saml-metadata.xml` in your working directory (next to the order file).
   `render-templates.sh` carries it into the rendered project, and CDK synth **fails
   without it**. Preflight (`preflight.sh <region> <order-file>`) verifies it exists.

3. Deploy normally — the Connect instance is created with `identityManagementType: SAML`,
   and the stack **automatically creates the IAM SAML Provider and Federation Role** from
   your metadata file (no manual IAM setup needed).

4. After deployment, note the stack outputs:
   - `SamlRelayStateUrl` — set as the application's Relay state
   - `SamlProviderArn`, `SamlFederationRoleArn` — the comma pair for the Role attribute mapping
   - `IdentityManagementType` — confirms `SAML` or `CONNECT_MANAGED`

## Post-Deployment: Configure IAM Identity Center

After the Connect instance is deployed with SAML identity, complete these steps in the
AWS Console.

### Step 1: Create the Identity Center Application

1. Go to **IAM Identity Center** → **Applications** → **Add application**
2. Choose **Add from catalog** → search for **"Amazon Connect"**
3. Give it a display name (e.g., your project name)
4. **Application ACS URL**: `https://signin.aws.amazon.com/saml`
5. **Application SAML audience**: `urn:amazon:webservices`
6. Download the **SAML metadata XML** file (you'll need it for the IAM SAML Provider)
7. Save the application

### Step 2: IAM SAML Provider and Federation Role — automated

**The stack creates both automatically** from your `saml-metadata.xml` when
`identityCenterEnabled` is true: an IAM SAML Provider (from the metadata) and a Federation
Role trusted for SAML console federation with `connect:GetFederationToken` scoped to the
instance. Their ARNs are emitted as the `SamlProviderArn` and `SamlFederationRoleArn`
outputs — you only need them for the attribute mapping in Step 3. (Creating them by hand
is only necessary if you deploy the instance outside this blueprint.)

### Step 3: Configure Identity Center Attribute Mappings

> ⚠️ **These mappings are mandatory — do not skip this step.** A freshly-added catalog
> application has **no** attribute mappings by default. Without them (specifically without the
> `Role` attribute) the assertion carries no role, and clicking the app tile fails with
> **"Your request included an invalid SAML response"**. This is the #1 setup mistake, and it
> is *not* a metadata/certificate problem — the IAM SAML provider and federation role can be
> perfectly healthy and it still fails. Add all three rows below and save.

In Identity Center → your Connect application → **Actions → Edit attribute mappings**:

| Attribute | Value | Format |
|-----------|-------|--------|
| `Subject` | `${user:email}` | `emailAddress` |
| `https://aws.amazon.com/SAML/Attributes/RoleSessionName` | `${user:email}` | `unspecified` |
| `https://aws.amazon.com/SAML/Attributes/Role` | `<FederationRoleArn>,<SamlProviderArn>` | `unspecified` |

Notes:
- The `Subject` row usually **already exists** as a default mapping — edit it so its value is
  `${user:email}` and its **Format is `emailAddress`** (not `unspecified`). Add the other two.
- The left column is the literal attribute **name** — type the full
  `https://aws.amazon.com/SAML/Attributes/...` URI exactly; it is not a friendly-name dropdown.
- The `Role` value is a comma-separated pair (**FederationRoleArn first, then SamlProviderArn**)
  with **no space after the comma**. Take both ARNs verbatim from the `SamlFederationRoleArn`
  and `SamlProviderArn` stack outputs.

### Step 4: Set the Relay State

In Identity Center → your Connect application → **Application properties** → **Relay state**:

Use the `SamlRelayStateUrl` from the stack outputs:
```
https://<region>.console.aws.amazon.com/connect/federate/<instance-uuid>
```

### Step 5: Assign Users and Create Connect Users

Two separate records must exist for each person — assignment grants the app tile; the Connect
user record grants permissions once the SAML flow lands.

1. In Identity Center → your application → **Assign users and groups** (grants the app tile in
   the access portal; does **not** create the Connect-side user).
2. Create the matching Connect user. **The Login must be exactly the user's Identity Center
   email** — because both `Subject` and `RoleSessionName` are mapped to `${user:email}`, Connect
   matches the incoming assertion on the email, **not** on the Identity Center *username*. A login
   set to the username (e.g. `bent` instead of `bent@corp.com`) produces "not been onboarded".

   Either in the console (**Users → Add new users**, set **Login** = the email, assign a Security
   profile + Routing profile), or via the CLI:

   ```bash
   aws connect create-user \
     --instance-id <instance-id> \
     --region <region> \
     --username '<user-email>' \
     --identity-info FirstName=<First>,LastName=<Last> \
     --phone-config PhoneType=SOFT_PHONE,AutoAccept=false,AfterContactWorkTimeLimit=0 \
     --security-profile-ids <security-profile-id> \
     --routing-profile-id <routing-profile-id>
   ```

   > ⚠️ **CLI gotcha:** on a SAML instance, **do not put `Email=` inside `--identity-info`** —
   > `create-user` rejects it with `InvalidRequestException: Email is not required for this
   > directory type`. The email goes in `--username` only (that becomes the Login). There is no
   > password field on SAML instances — Identity Center handles authentication.

   Discover the profile IDs with `aws connect list-security-profiles` /
   `list-routing-profiles --instance-id <id> --region <region>`. The blueprint ships an `Admin`
   security profile and a `<prefix>-default-routing-profile` (the routing profile the transfer
   queue uses, so an admin user can also receive escalated calls).

### Step 6: Where users sign in, and Test

Users sign in at the **IAM Identity Center access portal**, **not** the Connect console and
**not** with a Connect password (SAML instances have no Connect passwords):

1. Open the access portal — `https://<directory-id-or-subdomain>.awsapps.com/start` (find the
   exact URL under **IAM Identity Center → Settings → "AWS access portal URL"**, in whichever
   account Identity Center lives).
2. Sign in with Identity Center credentials, then click the **Amazon Connect** app tile → the
   SAML flow redirects into the Connect agent workspace.

> These SSO logins are **staff** logins (agents/admins handling the Connect workspace and human
> transfers). They are **entirely separate** from the **web-call frontend** login
> (`frontendEnabled`), which is a **Cognito** user for the browser calling site — different
> system, different credentials, created via `scripts/create-webcall-user.sh`.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Your request included an invalid SAML response" | The Identity Center app has **no attribute mappings** (or a malformed `Role` value) — the assertion carries no role. Not a metadata/cert problem. | Add all three attribute mappings from Step 3 and save. Verify the `Role` value is `<FederationRoleArn>,<SamlProviderArn>` with no space after the comma, and `Subject` format is `emailAddress`. |
| "not been onboarded to this application" | SAML validated, but no Connect user has Login = the asserted email (or the Login was set to the IDC username instead of the email) | Create/fix the Connect user so its **Login is exactly the user's Identity Center email** (Step 5) |
| 404 after clicking the app | Relay State URL is wrong | Must be `https://<region>.console.aws.amazon.com/connect/federate/<instance-uuid>` — UUID only, not full ARN |
| Access denied on GetFederationToken | IAM policy resource mismatch | Verify the policy resource includes your instance ID and `${aws:userid}` |
| `InvalidRequestException: Email is not required for this directory type` (from `create-user`) | Passed `Email=` inside `--identity-info` on a SAML instance | Drop `Email=`; put the email in `--username` only (Step 5) |

## Cross-Account Setup

If IAM Identity Center lives in a separate account (e.g., organization management account), the
setup works unchanged. The SAML federation flow is browser-based and doesn't require cross-account
IAM trust. The SAML Provider and Federation Role are created in the Connect account; the Role
attribute mapping in Identity Center references those ARNs in the Connect account.

Practical consequence: the app config and attribute mappings must be edited **in the Identity
Center account**, and they are not visible from the Connect account's credentials —
`aws sso-admin list-applications` will return `AccessDeniedException` cross-account. That is
expected, not a misconfiguration.

## References

- [Configure SAML with IAM for Amazon Connect](https://docs.aws.amazon.com/connect/latest/adminguide/configure-saml.html)
- [AWS Knowledge Center: Connect SAML with Identity Center](https://repost.aws/knowledge-center/connect-saml-2-authentication-aws-sso)
