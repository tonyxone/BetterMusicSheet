# Apple In-App Purchase credentials are separate from Sign in with Apple.
# Load these through the existing deployment secret; never commit a .p8 key.

variable "APPLE_KEY_ID" {
  type    = string
  default = ""
}

variable "APPLE_ISSUER_ID" {
  type    = string
  default = ""
}

variable "APPLE_APP_ID" {
  type    = string
  default = "6814721766"
}

variable "APPLE_BUNDLE_ID" {
  type    = string
  default = "com.bettermusicsheet.app"
}

variable "APPLE_PRIVATE_KEY" {
  type      = string
  default   = ""
  sensitive = true
}

variable "APPLE_ENV" {
  type    = string
  default = "auto"
}

variable "APPLE_PRODUCT_MONTHLY" {
  type    = string
  default = "com.bettermusicsheet.app.premium.monthly"
}

variable "APPLE_PRODUCT_YEARLY" {
  type    = string
  default = "com.bettermusicsheet.app.premium.yearly"
}
