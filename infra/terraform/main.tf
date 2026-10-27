# D1, R2, and Queues only, unless you opt in to email resources.
# Do not manage Cloudflare-locked Email Routing or Email Sending DNS here.
# Routing rules are the inbound Worker's addresses list, not a second Terraform rule.

resource "cloudflare_d1_database" "db" {
  account_id = var.account_id
  name       = var.resource_prefix
}

resource "cloudflare_r2_bucket" "raw" {
  account_id = var.account_id
  name       = "${var.resource_prefix}-raw"
}

resource "cloudflare_r2_bucket" "attachments" {
  account_id = var.account_id
  name       = "${var.resource_prefix}-att"
}

resource "cloudflare_queue" "parse" {
  account_id = var.account_id
  queue_name = "${var.resource_prefix}-parse"
}

resource "cloudflare_queue" "events" {
  account_id = var.account_id
  queue_name = "${var.resource_prefix}-events"
}

resource "cloudflare_queue" "wake" {
  account_id = var.account_id
  queue_name = "${var.resource_prefix}-wake"
}

resource "cloudflare_queue" "dlq" {
  account_id = var.account_id
  queue_name = "${var.resource_prefix}-dlq"
}

resource "cloudflare_email_sending_subdomain" "mail" {
  count   = var.enable_email_sending ? 1 : 0
  zone_id = var.zone_id
  name    = var.mail_hostname
}

resource "cloudflare_email_sending_subdomain" "system" {
  count   = var.enable_email_sending ? 1 : 0
  zone_id = var.zone_id
  name    = var.system_hostname
}

resource "cloudflare_email_routing_settings" "zone" {
  count   = var.enable_routing ? 1 : 0
  zone_id = var.zone_id
}
