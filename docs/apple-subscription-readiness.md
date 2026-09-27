# Apple subscription readiness — 26 September 2026

## Latest setup update

The account holder reports manual items 1–4 complete: banking/agreement, EU trader declaration, the In-App Purchase key, and AWS billing secret configuration. These account-side completions are user-reported. The release and drift workflows now forward all eight uppercase Apple billing variables and mask private-key lines. Deployment and sandbox/device verification remain to be confirmed.

## Completed

- iOS bundle: `com.bettermusicsheet.app`; App Store app ID: `6814721766`.
- StoreKit products: `com.bettermusicsheet.app.premium.monthly` and `com.bettermusicsheet.app.premium.yearly`.
- Purchases require sign-in and carry the account UUID as Apple's appAccountToken. Server delivery must succeed before the transaction is finished or Premium is enabled.
- Launch, foreground, sign-in and Restore retry unfinished transactions. Offline entitlement snapshots are tied to their owner and expire at the server's period end.
- Paywall uses Apple's per-product introductory eligibility and displays Privacy/EULA links and renewal disclosures.
- Backend rejects transaction ownership mismatches, handles Apple's signedPayload JSON envelope, re-queries Apple's server for authoritative status, handles grace periods and tries sandbox only after production returns 404.
- Terraform and deployment secret loaders now pass the Apple billing variables to the API Lambda. The privacy page has been updated locally.
- App Store Connect: both products at level 1; seven-day free trials in all 175 regions with no end date; production and sandbox notification URLs saved; description includes renewal and legal disclosures.

## Remaining blockers

1. Restore the original lowercase `apple_key_id` and `apple_private_key` in the `better_music_sheet_singin_provider` AWS secret. The 26 September release log confirms the uppercase billing credentials are present, but these two separate Sign in with Apple fields are absent. Recover them from a secret version before the billing edits, preserving all current fields. Do not substitute the new In-App Purchase key. Cognito rejected the attempted update because the sign-in details were incomplete.
2. Re-run GitHub Actions → Release on `master` with Deploy enabled once the sign-in secret is complete. The previous run (`36296492578`) failed in Terraform, skipped backend and website deployment, and may have applied some independent infrastructure changes. The loader now checks credential completeness before exporting values so this error cannot cause another partial apply.
3. Test on a real device using Apple's sandbox: monthly/yearly purchase, eligible and ineligible trial display, renewal, cancellation, expiry, refund, Restore, different app accounts, offline delivery and delivery retry. Verify notifications and website entitlement. No real purchase test has been completed.
4. Capture authentic iPhone/iPad app screenshots and a paywall screenshot for each subscription's review information. Upload the signed build, select it for version 1.0, attach both subscriptions, finish privacy/version/review metadata and submit the app and subscriptions together. No review has been submitted. Review Streamlined Purchasing because purchases must be bound to an app account.

## Validation and artifacts

216 runnable Swift tests passed; the existing everyInstrumentShipsWithTheApp test requires resources absent from SwiftPM and was excluded. 214 backend tests and 5 deployment-secret preflight tests passed. Website Next type generation and TypeScript checking passed. Signed iOS Release archive and App Store IPA export succeeded. The final archive is `/Users/tonyxone/Desktop/workspace/bms-subscription-release/BetterMusicSheet.xcarchive`; the exported IPA is retained in `/Users/tonyxone/Desktop/workspace/bms-subscription-release/ipa`. Subscription fixes are merged; the production release remains blocked by the missing sign-in secret fields.

Source references: https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-in-app-purchase and https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/overview-for-configuring-in-app-purchases
