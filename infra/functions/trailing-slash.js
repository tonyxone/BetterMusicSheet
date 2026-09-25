// CloudFront viewer-request function for the web distribution (see
// cloudfront.tf). The static export puts each page at <path>/index.html
// (trailingSlash in next.config.ts), so a request for /sheets needs a
// redirect to /sheets/. The S3 website origin would do that redirect itself,
// but CloudFront doesn't forward the query string to S3, so S3's redirect
// dropped ?job= and the page opened with no sheet. This redirects here
// instead and keeps the query string.
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var last = uri.substring(uri.lastIndexOf("/") + 1);
  // Directory paths and anything that looks like a file pass through as-is.
  if (last === "" || last.indexOf(".") !== -1) {
    return request;
  }
  var parts = [];
  var qs = request.querystring;
  for (var key in qs) {
    var values = qs[key].multiValue ? qs[key].multiValue : [qs[key]];
    for (var i = 0; i < values.length; i++) {
      var value = values[i].value;
      // The values arrive still URL-encoded, so they're passed through unchanged.
      parts.push(value === "" ? key : key + "=" + value);
    }
  }
  return {
    statusCode: 301,
    statusDescription: "Moved Permanently",
    headers: {
      location: { value: uri + "/" + (parts.length ? "?" + parts.join("&") : "") },
    },
  };
}
