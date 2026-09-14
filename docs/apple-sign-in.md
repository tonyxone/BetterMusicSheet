# Sign in with Apple: setup

Everything in this repo is already written for Apple - the provider resource
(`infra/cognito-idp.tf`), the button (`better_music_sheet_web/app/sign-in-modal.tsx`)
and the code exchange (`server.py` -> `auth.exchange_authorization_code`). Apple
is dormant only because `apple_services_id` is empty. This is a
credentials-and-config job; no code changes.

It differs from Google in three ways worth knowing before you start:

- It needs a **paid Apple Developer Program membership**. A free account has no
  Services IDs and no Sign in with Apple keys.
- There is **no client secret to paste**. Cognito signs a short-lived JWT with a
  `.p8` private key, so you supply four values instead of two.
- Apple sends the user's **name only on the very first authorization** of an
  account. Get it wrong and a retest arrives nameless until you revoke the app
  from the Apple ID.

## The one URL everything hangs off

Cognito's hosted UI is where Apple sends the browser back to:

```
https://better-music-sheet.auth.us-west-1.amazoncognito.com/oauth2/idpresponse
```

(That is `terraform output cognito_hosted_ui_domain` + `/oauth2/idpresponse` -
the same endpoint Google already posts to.) Apple splits it across two fields:

| Apple field | Value |
| --- | --- |
| Domains and Subdomains | `better-music-sheet.auth.us-west-1.amazoncognito.com` |
| Return URLs | `https://better-music-sheet.auth.us-west-1.amazoncognito.com/oauth2/idpresponse` |

The domain field rejects a `https://` prefix; the return URL requires one.

## Part 1 - Apple Developer portal

Everything is under [developer.apple.com/account](https://developer.apple.com/account)
-> **Certificates, Identifiers & Profiles**.

### 1. Team ID  ->  `apple_team_id`

Account -> **Membership details**. Ten characters, e.g. `ABCDE12345`. It is also
shown in the top-right of the portal next to your team name.

### 2. App ID - the "primary" identifier

A Services ID cannot exist on its own; it must point at an App ID that has Sign
in with Apple enabled. You never deploy an iOS app, but the record has to exist.

1. **Identifiers** -> the blue **+**.
2. Select **App IDs** -> Continue -> type **App** -> Continue.
3. Description: `Better Music Sheet`.
   Bundle ID: **Explicit**, `com.bettermusicsheet.app`.
4. In the **Capabilities** list, tick **Sign In with Apple**. Leave it as
   "Enable as a primary App ID" (the default in the Edit sheet).
5. Continue -> **Register**.

### 3. Services ID  ->  `apple_services_id`

This is the value Cognito sends as its `client_id`, and it is *not* the bundle
ID from step 2. Apple treats a Services ID as the web-facing identity.

1. **Identifiers** -> **+** -> select **Services IDs** -> Continue.
2. Description: `Better Music Sheet Sign In`.
   Identifier: `com.bettermusicsheet.signin`.
3. Continue -> **Register**.
4. Now click back into the Services ID you just made, tick **Sign In with
   Apple**, and press **Configure**:
   - **Primary App ID**: `com.bettermusicsheet.app` from step 2.
   - **Domains and Subdomains**: `better-music-sheet.auth.us-west-1.amazoncognito.com`
   - **Return URLs**: `https://better-music-sheet.auth.us-west-1.amazoncognito.com/oauth2/idpresponse`
   - Next -> Done.
5. Back on the Services ID page press **Continue**, then **Save**. *This step is
   easy to miss* - closing the Configure sheet alone does not persist anything,
   and the symptom later is `invalid_client`.

Apple shows **Download** and **Verify** buttons for a domain-association file
next to the domain. Ignore both. They exist for Sign in with Apple JS running on
your own page; this flow redirects to Apple and back through Cognito, and you
could not host a file on `amazoncognito.com` anyway.

### 4. Key  ->  `apple_key_id` and `apple_private_key`

1. **Keys** -> **+**.
2. Key Name: `Better Music Sheet Sign in with Apple`.
3. Tick **Sign in with Apple** -> **Configure** -> Primary App ID
   `com.bettermusicsheet.app` -> **Save**.
4. Continue -> **Register**.
5. **Download** the `.p8`. Apple allows this exactly once - there is no second
   chance, only issuing a new key. The Key ID (ten characters, also in the
   filename `AuthKey_XXXXXXXXXX.p8`) is `apple_key_id`.

Keep the file out of the repo: `infra/**/*.tfvars` is gitignored, but `*.p8` is
not. It goes into the Secrets Manager secret below; delete the download once it
is there.

## Part 2 - Terraform

The four values live in AWS Secrets Manager, as one JSON object whose keys are
the Terraform variable names from `infra/cognito-idp.tf`:

```json
{
  "google_client_id": "...",
  "google_client_secret": "...",
  "apple_services_id": "com.bettermusicsheet.signin",
  "apple_team_id": "ABCDE12345",
  "apple_key_id": "KEY1234567",
  "apple_private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
}
```

Note the `\n` escapes in the private key. JSON cannot hold a raw newline, and
Cognito rejects a `.p8` flattened onto one line - so the key must be stored
escaped and unescaped again on the way out.

Terraform itself reads none of that: `cognito-idp.tf` takes plain input
variables, and nothing in `infra/` has a Secrets Manager data source. The
secret is loaded into `TF_VAR_*` environment variables instead, by sourcing a
helper next to it:

```bash
source infra/social-signin-env.sh
terraform -chdir=infra apply -var-file=serverless.tfvars
```

On Windows, run the PowerShell twin from a PowerShell prompt and apply from
that same window:

```powershell
.\infra\social-signin-env.ps1
terraform -chdir=infra apply -var-file=serverless.tfvars
```

cmd.exe cannot do this at all: `set` has no way to put the newlines of a PEM
key into a variable. Nor can it be `powershell -File ...` from cmd - that is a
second process, and the variables die with it. (Git Bash works too, with the
`.sh` version.)

`source`, not `./` - the exports have to land in your shell, and running it
would drop them with the subshell. It prints which variables it set (never
their values), warns if the private key arrives without its newlines or PEM
header, and names any key in the secret that is not a variable in
`cognito-idp.tf`, which is how a typo like `apple_service_id` (singular) shows
up. It reads the project's secret by default; pass an ARN, or set
`BMS_SOCIAL_SECRET_ARN`, for a different one.

The exports last only as long as that shell. A later `terraform apply` from a
fresh terminal, without sourcing first, sees empty strings - which reads to
Terraform as "this provider is disabled" and plans to **destroy** the
providers. If a plan ever offers to remove `aws_cognito_identity_provider`,
that is the cause; source the helper and re-plan rather than accepting it.

The alternative is putting the values in `infra/serverless.tfvars` (stubbed out
at the bottom of `serverless.tfvars.example`; `infra/**/*.tfvars` is
gitignored). Same result, but then the private key is on disk.

The plan should be exactly two changes - `aws_cognito_identity_provider.apple[0]`
added, and `aws_cognito_user_pool_client.web` updated so
`supported_identity_providers` gains `SignInWithApple`. Nothing else should move;
if the plan wants to touch Lambda images or the ECS service, your image tags in
the tfvars are stale (see the header of `serverless.tfvars.example`).

Confirm:

```bash
terraform -chdir=infra output cognito_social_providers
# => ["Google", "SignInWithApple"]
```

The backend needs no change: `COGNITO_DOMAIN` is already set on the API Lambda
(`infra/modules/serverless/compute.tf`) because Google needs the same hosted-UI
exchange.

## Part 3 - Smoke-test before shipping the button

You can exercise the whole round trip without deploying anything. Put the app
client id in this URL and open it in a browser:

```
https://better-music-sheet.auth.us-west-1.amazoncognito.com/oauth2/authorize?identity_provider=SignInWithApple&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fcallback%2F&response_type=code&client_id=YOUR_APP_CLIENT_ID&scope=openid+email+profile
```

(`terraform -chdir=infra output cognito_app_client_id`.) Apple's sign-in page
should appear; after authorizing, the browser lands on `localhost:3000` with
`?code=...`. That code proves Cognito and Apple agree, even with nothing running
to receive it.

Then test the real flow locally - in `better_music_sheet_web/.env.local`:

```
NEXT_PUBLIC_COGNITO_REGION=us-west-1
NEXT_PUBLIC_COGNITO_CLIENT_ID=<cognito_app_client_id>
NEXT_PUBLIC_COGNITO_DOMAIN=<cognito_hosted_ui_domain>
NEXT_PUBLIC_COGNITO_SOCIAL_PROVIDERS=Google,SignInWithApple
```

`npm run dev`, open the sign-in modal, click Sign in with Apple. `localhost:3000`
is already a registered callback URL (`infra/cognito.tf`), and `NEXT_PUBLIC_API_BASE`
should point at a backend that has the Cognito env vars, since the callback page
posts the code to `POST /api/auth/social`.

## Part 4 - Ship it

The button list is inlined at build time, so the Terraform apply alone changes
nothing on the live site.

1. GitHub -> repo **Settings** -> Secrets and variables -> **Actions** ->
   **Variables** -> set `COGNITO_SOCIAL_PROVIDERS` to:

   ```
   Google,SignInWithApple
   ```

   Exact strings, no spaces. `lib/cognito.ts` filters the list against the
   literals `Google`, `Facebook`, `SignInWithApple`, so `Apple` silently
   renders no button.
2. Re-run the release workflow. `.github/workflows/release.yml` feeds that
   variable into `NEXT_PUBLIC_COGNITO_SOCIAL_PROVIDERS`, rebuilds the static
   export, syncs it to S3 and invalidates CloudFront.
3. Load the site, open the sign-in modal, and check the black Apple button is
   next to Google.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `invalid_client` on Apple's page | Services ID / Team ID / Key ID mismatch, or the Services ID was configured but never **Saved** on the outer page. |
| Apple says the redirect URI is invalid | The Return URL is not byte-identical to the `/oauth2/idpresponse` URL, or the domain field kept a `https://` prefix. |
| Cognito: `redirect_mismatch` after Apple | The app's own `redirect_uri` is not one of `callback_urls` in `infra/cognito.tf` - most often a missing trailing slash. |
| The button does not render | `NEXT_PUBLIC_COGNITO_SOCIAL_PROVIDERS` missing, misspelled, or the build ran before the variable was set. |
| Signed in, but no name shown | Expected on any sign-in after the first. See below. |
| `400 That sign-in could not be completed (invalid_grant)` | The code was already spent - usually a reloaded callback page. Start the sign-in again. |

### Apple only sends the name once

To get a clean first-authorization again: appleid.apple.com -> Sign-In and
Security -> **Sign in with Apple** -> select the app -> **Stop using Apple ID**.
`db.save_user_identity` writes only non-null values precisely so a later
nameless sign-in does not wipe the name captured the first time.

### Private relay addresses

Users who choose "Hide My Email" arrive as
`something@privaterelay.appleid.com`, and that is what gets stored. The app
never emails users, so nothing breaks. If that ever changes, the domain has to
be registered under Services -> Sign in with Apple for Email Communication or
Apple's relay will reject the mail.

### Rotating the key later

`infra/cognito-idp.tf` sets `ignore_changes = [provider_details["private_key"]]`,
because Cognito never returns the key and every plan would otherwise show a
diff. A new `.p8` in the tfvars therefore applies nothing. Force it:

```bash
terraform -chdir=infra apply -var-file=serverless.tfvars \
  -replace='aws_cognito_identity_provider.apple[0]'
```

### Apple sign-in makes a separate account

Cognito does not link a federated sign-in to a native one by email, and this
project deliberately does not either (the reasoning is in the header comment of
`infra/cognito-idp.tf`). Someone with a password account, or a Google one, who
then clicks Sign in with Apple lands in a new, empty account - not their old
sheets. Same trade-off you already accepted for Google.
