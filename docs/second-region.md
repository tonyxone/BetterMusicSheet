# Running in a second region (us-east-1)

The serverless stack can run a second copy in us-east-1. Visitors reach
whichever region answers them faster, and a region that fails its health check
stops receiving traffic. Everything is in `infra/us-east-1.tf`, behind
`enable_us_east_1`.

## How it fits together

| Piece | us-west-1 | us-east-1 |
|---|---|---|
| `api.bettermusicsheet.com` | Latency record + health check | Latency record + health check |
| API, controller, worker | Own copy | Own copy (names end `-use1`) |
| DynamoDB tables | Global tables, one replica per region | (replica) |
| Upload lock (`control` table) | Own | Own |
| Job files | Own bucket | Own bucket |
| Cognito user pool | Only here | Uses us-west-1's |
| JWT secret | SSM | SSM copy of the live value |

Each job records the bucket and region its upload went to (`files_bucket`,
`files_region`). Any region's API can open, edit or delete any job's files.
Only the job's own region processes it and runs its controller clean-up.
Jobs from before this change live in us-west-1.

## Rolling it out

It takes two releases. A Lambda can only run an image from its own region's
ECR, and replication only copies images pushed after it is set up.

1. **Release with `enable_us_east_1 = false`** (the default). This creates the
   us-east-1 ECR repository and turns on replication. Nothing else changes,
   apart from new environment variables on the us-west-1 functions.
2. **Set `enable_us_east_1 = true` in `infra/us-east-1.tf` and release again,
   at a quiet hour.** The workflow waits for this release's images to reach
   us-east-1, then the apply:
   - adds a us-east-1 replica to each table (a few minutes; tables stay online)
   - creates the network, cluster, certificate and the stack itself
   - switches `api.*` to latency routing with health checks

   The deploy job then ships the code to both regions.

   **Expect a short DNS gap.** Changing `api.*` from a plain record to a latency
   record replaces it, so for about a minute new lookups find no record.
   Resolvers that look it up then cache that for up to 15 minutes, which is the
   zone's SOA TTL. To shrink the gap, lower the SOA record's TTL to 60 in
   Route 53 a day before, and restore it afterwards.

After step 2:
- **Confirm the alerts email.** us-east-1 has its own SNS topic, so there is a
  second subscription email to confirm (`terraform output us_east_1_alerts_topic`).
- **If the Lambda creation fails with "UnreservedConcurrentExecution below its
  minimum"**, the account's us-east-1 Lambda concurrency quota is too low for
  the 10 + 1 reserved. Raise it in Service Quotas and release again.

To turn it off, set the flag back to `false`. The us-east-1 bucket has
`prevent_destroy`, so empty it and remove that setting first.

## What still depends on us-west-1

- **Sign-in and session renewal (Cognito).** If us-west-1 is down, nobody can
  sign in. Signed-in visitors keep working until their one-hour session needs
  renewing.
- **Files uploaded in us-west-1.** They are not copied to us-east-1, so those
  sheets can't be opened during a us-west-1 outage. New uploads go to
  us-east-1 and work.
- **Legacy (v1) sheets** are in the us-west-1 legacy bucket.

## Known edge cases

DynamoDB global tables keep the last write when the same item is written in
both regions at once. Conditional writes are only checked within one region.
Each job is processed by one region, so this only matters when a visitor's
routing flips mid-job. For example, a delete sent to one region can race the
other region's worker finishing the same sheet, and the sheet may reappear.
Deleting it again fixes it.

## Cost

Approximate list prices, on top of today's bill:

- **Fixed:** 2 Route 53 HTTPS health checks (about $1–2 each per month), plus
  the Lambda calls they make (about $0.50 per month per region). Also a few
  CloudWatch alarms and log storage, and the replicated container images
  (about $0.10 per GB per month).
- **With use:** each DynamoDB write is billed in both regions, and
  table storage and point-in-time recovery are billed per replica. Replication
  traffic is about $0.02 per GB. Processing a sheet costs about the same in
  either region; jobs are split between them, not run twice.
- **No NAT gateway:** the us-east-1 worker runs in public subnets, like the
  us-west-1 one.
