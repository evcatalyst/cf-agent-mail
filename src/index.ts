import { handleEmail } from "./inbound";
import { Mailbox } from "./mailbox-do";
import { handleQueue, handleScheduled } from "./processor";
import { handleFetch } from "./server";

export { Mailbox };

export default {
  fetch(request, env) {
    return handleFetch(request, env);
  },
  email(message, env, ctx) {
    return handleEmail(message, env, ctx);
  },
  queue(batch, env) {
    return handleQueue(batch, env);
  },
  scheduled(controller, env) {
    return handleScheduled(controller, env);
  },
} satisfies ExportedHandler<Env>;
