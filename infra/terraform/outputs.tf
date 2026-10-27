output "d1_database_id" {
  value = cloudflare_d1_database.db.id
}

output "r2_buckets" {
  value = [cloudflare_r2_bucket.raw.name, cloudflare_r2_bucket.attachments.name]
}

output "queues" {
  value = [
    cloudflare_queue.parse.queue_name,
    cloudflare_queue.events.queue_name,
    cloudflare_queue.wake.queue_name,
    cloudflare_queue.dlq.queue_name,
  ]
}
