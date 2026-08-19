// Same-origin by default - correct when this UI is served by the API itself
// (local dev, or a bundled deployment). When the UI is deployed separately
// from the API (e.g. this folder copied to S3/CloudFront), change this to
// the API's real URL, e.g. "https://api.bettermusicsheet.com" - nothing else
// in this folder needs to change. The API's ALLOWED_ORIGINS env var must
// then include this UI's origin (server.py handles CORS).
const API_BASE = "";
