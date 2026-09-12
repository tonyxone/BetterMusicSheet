"""Record what production does today, before the serverless migration changes it.

Read-only: a DynamoDB Scan of the annotation-job table, plus an optional Cost
Explorer lookup. Nothing is written, and no job is touched. Run it once before
cutover and again afterwards; comparing the two is the only way to tell whether
the migration actually helped or merely moved the cost around.

    ANNOTATION_JOB_TABLE=... AWS_REGION=us-west-1 python tools/baseline.py --days 30

Costs need `ce:GetCostAndUsage`; without it the script still reports job stats
and says so rather than failing.
"""
import argparse
import os
import time
from collections import Counter

import boto3


def scan_jobs(table_name, since):
    """Every job row created at or after `since`.

    A Scan reads the whole table, which is fine at this size and avoids
    depending on an index that only covers some of the rows. The filter is
    applied server-side so old rows are not paid for twice.
    """
    table = boto3.resource("dynamodb").Table(table_name)
    jobs, kwargs = [], {"FilterExpression": "created_at >= :since",
                        "ExpressionAttributeValues": {":since": since}}
    while True:
        page = table.scan(**kwargs)
        jobs.extend(page["Items"])
        if "LastEvaluatedKey" not in page:
            return jobs
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def percentile(values, fraction):
    """Nearest-rank, so every reported number is a duration that really happened."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(fraction * len(ordered)))]


def duration_seconds(job):
    """End to end, from the user's upload to the terminal status.

    This deliberately includes queue wait, not just recognition: it is what the
    person staring at the status page experienced, and it is the number the
    migration's cold start will be compared against.
    """
    try:
        return int(job["updated_at"]) - int(job["created_at"])
    except (KeyError, TypeError, ValueError):
        return None


def daily_costs(days):
    """Per-day cost, because a monthly total lies about anything that did not
    run all month. The first baseline for this project read $16.64/month from a
    month in which the always-on stack ran for four days; the real rate was
    about seven times that."""
    from datetime import date, timedelta
    end = date.today()
    response = boto3.client("ce", region_name="us-east-1").get_cost_and_usage(
        TimePeriod={"Start": (end - timedelta(days=days)).isoformat(), "End": end.isoformat()},
        Granularity="DAILY", Metrics=["UnblendedCost"],
        GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}])
    out = []
    for period in response["ResultsByTime"]:
        rows = {g["Keys"][0]: float(g["Metrics"]["UnblendedCost"]["Amount"]) for g in period["Groups"]}
        out.append((period["TimePeriod"]["Start"], {k: v for k, v in rows.items() if v >= 0.005}))
    return out


def monthly_costs(months):
    from datetime import date, timedelta
    end = date.today().replace(day=1)
    start = end
    for _ in range(months):
        start = (start - timedelta(days=1)).replace(day=1)
    # Cost Explorer is a us-east-1-only endpoint regardless of where the stack runs.
    response = boto3.client("ce", region_name="us-east-1").get_cost_and_usage(
        TimePeriod={"Start": start.isoformat(), "End": end.isoformat()},
        Granularity="MONTHLY", Metrics=["UnblendedCost"],
        GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}])
    totals = Counter()
    for period in response["ResultsByTime"]:
        for group in period["Groups"]:
            totals[group["Keys"][0]] += float(group["Metrics"]["UnblendedCost"]["Amount"])
    return totals, start, end


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=30, help="window to summarise (default 30)")
    parser.add_argument("--months", type=int, default=1, help="whole months of cost to report")
    parser.add_argument("--table", default=os.environ.get("ANNOTATION_JOB_TABLE"))
    args = parser.parse_args()
    if not args.table:
        parser.error("set ANNOTATION_JOB_TABLE or pass --table")

    since = int(time.time()) - args.days * 86400
    jobs = scan_jobs(args.table, since)
    statuses = Counter(job.get("status", "unknown") for job in jobs)
    finished = statuses["done"] + statuses["failed"]
    durations = [d for d in (duration_seconds(j) for j in jobs if j.get("status") == "done") if d is not None]
    retried = [j for j in jobs if int(j.get("attempt_count", 0) or 0) > 1]

    print(f"# Pre-migration baseline ({args.days} days, table {args.table})\n")
    print(f"- Jobs created: **{len(jobs)}** ({len(jobs) / args.days:.1f}/day)")
    for status, count in sorted(statuses.items()):
        print(f"  - {status}: {count}")
    if finished:
        print(f"- Failure rate: **{statuses['failed'] / finished:.1%}** of {finished} finished jobs")
    if durations:
        print(f"- End-to-end duration (upload to done), n={len(durations)}:")
        for label, fraction in (("p50", 0.5), ("p95", 0.95)):
            print(f"  - {label}: {percentile(durations, fraction)}s")
        print(f"  - max: {max(durations)}s")
    else:
        print("- End-to-end duration: no completed jobs in this window")
    print(f"- Jobs needing more than one attempt: {len(retried)}")
    # Only v2 rows carry a lease, so a mixed window is worth flagging rather than
    # silently averaging two different pipelines together.
    v2 = sum(1 for j in jobs if int(j.get("storage_version", 0) or 0) >= 2)
    print(f"- Rows on the new storage layout: {v2} of {len(jobs)}")

    print()
    try:
        rows = daily_costs(14)
        print("## Cost per day (the last row is usually incomplete)\n")
        for day, services in rows:
            total = sum(services.values())
            top = ", ".join(f"{name.replace('Amazon ', '')} ${amount:.2f}"
                            for name, amount in sorted(services.items(), key=lambda x: -x[1])[:3])
            print(f"- {day}: **${total:.2f}** - {top or 'no charges'}")
        settled = [sum(s.values()) for _, s in rows[:-1]]
        if settled:
            average = sum(settled) / len(settled)
            print(f"\nSettled days average **${average:.2f}/day** (~${average * 30.44:.2f}/month).")
        print("\nCost Explorer lags about a day, so today reads $0.00. That is missing")
        print("data, not a saving.")
    except Exception as exc:
        print(f"## Cost\n\nUnavailable ({type(exc).__name__}: {exc}).")
        print("Needs ce:GetCostAndUsage; read it from the Billing console instead.")

    print()
    try:
        totals, start, end = monthly_costs(args.months)
        print(f"## Cost, {start} to {end} (unblended)\n")
        for service, amount in totals.most_common():
            if amount >= 0.01:
                print(f"- {service}: ${amount:.2f}")
        print(f"- **Total: ${sum(totals.values()):.2f}**")
    except Exception as exc:
        print(f"## Cost\n\nUnavailable ({type(exc).__name__}: {exc}).")
        print("Needs ce:GetCostAndUsage; read it from the Billing console instead.")

    print("\nQueue delay is not recorded per job on the old pipeline; treat the")
    print("duration percentiles above as upload-to-done, which include it.")


if __name__ == "__main__":
    main()
