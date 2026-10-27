variable "account_id" {
  type        = string
  description = "Cloudflare account id. Do not commit a real value."
  validation {
    condition     = length(var.account_id) > 0 && !strcontains(var.account_id, "YOUR_")
    error_message = "Set account_id to your Cloudflare account id."
  }
}

variable "zone_id" {
  type        = string
  description = "Zone that will host the mail hostname. Use a zone that does not already receive mail."
  validation {
    condition     = length(var.zone_id) > 0 && !strcontains(var.zone_id, "YOUR_")
    error_message = "Set zone_id to your Cloudflare zone id."
  }
}

variable "resource_prefix" {
  type        = string
  description = "Prefix for D1, R2, and Queue names."
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,40}$", var.resource_prefix))
    error_message = "resource_prefix must be a short lowercase name."
  }
}

variable "mail_hostname" {
  type        = string
  description = "Full hostname agents send from, such as mail.example.com."
  validation {
    condition     = can(regex("^[a-z0-9.-]+$", var.mail_hostname))
    error_message = "mail_hostname must be a hostname."
  }
}

variable "system_hostname" {
  type        = string
  description = "Full hostname for template system mail, such as login.example.com."
  validation {
    condition     = can(regex("^[a-z0-9.-]+$", var.system_hostname))
    error_message = "system_hostname must be a hostname."
  }
}

variable "enable_email_sending" {
  type        = bool
  description = "Create Email Sending subdomains. Leave false until you have read the MX warning."
  default     = false
}

variable "enable_routing" {
  type        = bool
  description = "Create Email Routing settings. This can publish MX at the zone apex. Leave false until the zone is dedicated to mail."
  default     = false
}
