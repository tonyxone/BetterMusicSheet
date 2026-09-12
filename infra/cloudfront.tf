# Fronts the existing hand-managed public S3 bucket that better_music_sheet_web/
# (the Next.js app, exported as static HTML via `output: "export"` - see its
# next.config.ts) is deployed to, adding HTTPS + the apex/www domain. That
# bucket already has static website hosting enabled by hand (out of scope
# here, like the other hand-created resources - see infra/README.md), so this
# points at its S3 WEBSITE endpoint rather than the REST API endpoint. That's
# what lets S3 itself resolve "folder" paths (e.g. /sheets/ -> sheets/index.html)
# without this config needing to manage an Origin Access Control / private
# bucket policy for a bucket it doesn't otherwise own.
resource "aws_cloudfront_distribution" "web" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  aliases             = [var.domain_name, "www.${var.domain_name}"]

  origin {
    origin_id   = "s3-website"
    domain_name = "${var.existing_web_bucket_name}.s3-website-${var.aws_region}.amazonaws.com"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only" # S3 website endpoints don't support HTTPS
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "s3-website"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    # The app's client-side routing uses a ?job= query param (see
    # better_music_sheet_web/app/sheets/), but the HTML served for that path
    # is identical regardless of the query string - the actual per-job data
    # comes from the browser calling the API backend, not from anything S3
    # varies by query. So query strings don't need to be part of the cache
    # key; the browser's own address bar still has them either way.
    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 3600
    max_ttl     = 86400
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.web.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}
