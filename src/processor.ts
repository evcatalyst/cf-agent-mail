import {
  handleParseJob,
  handleProviderEvent,
  handleWake,
  runRetention,
  type ParseJob,
} from "./pipeline";

export async function handleQueue(
  batch: MessageBatch,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      const queue = batch.queue;
      if (queue.includes("parse"))
        await handleParseJob(env, message.body as ParseJob);
      else if (queue.includes("events"))
        await handleProviderEvent(env, message.body as Record<string, unknown>);
      else if (queue.includes("wake"))
        await handleWake(env, message.body as Parameters<typeof handleWake>[1]);
      message.ack();
    } catch (error) {
      console.log(
        JSON.stringify({
          event: "queue_retry",
          queue: batch.queue,
          error: error instanceof Error ? error.message : "error",
        }),
      );
      message.retry();
    }
  }
}

export async function handleScheduled(
  _controller: ScheduledController,
  env: Env,
): Promise<void> {
  await runRetention(env, new Date());
}
