import { handleQueue, handleScheduled } from "./processor";

export default {
  queue(batch, env) {
    return handleQueue(batch, env);
  },
  scheduled(controller, env) {
    return handleScheduled(controller, env);
  },
} satisfies ExportedHandler<Env>;
