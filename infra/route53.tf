# Terraform can't purchase a new domain (aws_route53domains_registered_domain
# only manages settings on a domain that's ALREADY registered - it needs
# contact/payment info and ICANN term acceptance that aren't a clean
# declarative fit). Register bettermusicsheet.com manually first:
#   Console: Route 53 -> Registered domains -> Register domain
#   or CLI:  aws route53domains register-domain ...
# Route 53 auto-creates the hosted zone as part of registration; this data
# source picks that zone up. Everything below fails to apply until the
# domain is registered - that's expected, not a bug in this config.
data "aws_route53_zone" "root" {
  name = var.domain_name
}

resource "aws_route53_record" "api" {
  zone_id = data.aws_route53_zone.root.zone_id
  name    = var.api_subdomain
  type    = "A"

  # With a second region this becomes us-west-1's half of a latency pair (see
  # us-east-1.tf). Switching routing policy replaces the record, so for a few
  # seconds during that apply new lookups of api.* find nothing; resolvers
  # that already hold the answer keep using it for its 60 second TTL.
  set_identifier  = local.us_east_1_enabled ? var.aws_region : null
  health_check_id = local.us_east_1_enabled ? aws_route53_health_check.api[var.aws_region].id : null
  dynamic "latency_routing_policy" {
    for_each = local.us_east_1_enabled ? [var.aws_region] : []
    content {
      region = latency_routing_policy.value
    }
  }

  alias {
    name    = module.serverless[0].domain_target
    zone_id = module.serverless[0].domain_zone
    # The ALB this used to point at is gone (see the migration runbook's
    # decommission step). API Gateway custom domains are not health-checkable
    # the way a load balancer is, so there is nothing to evaluate.
    evaluate_target_health = false
  }
}

# Apex + www -> the CloudFront distribution in front of the static web UI
# (see cloudfront.tf). CloudFront distributions don't support
# evaluate_target_health (they're not a health-checkable AWS resource the
# way an ALB is).
resource "aws_route53_record" "web" {
  for_each = toset(["A", "AAAA"])

  zone_id = data.aws_route53_zone.root.zone_id
  name    = var.domain_name
  type    = each.key

  alias {
    name                   = aws_cloudfront_distribution.web.domain_name
    zone_id                = aws_cloudfront_distribution.web.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "web_www" {
  for_each = toset(["A", "AAAA"])

  zone_id = data.aws_route53_zone.root.zone_id
  name    = "www.${var.domain_name}"
  type    = each.key

  alias {
    name                   = aws_cloudfront_distribution.web.domain_name
    zone_id                = aws_cloudfront_distribution.web.hosted_zone_id
    evaluate_target_health = false
  }
}
