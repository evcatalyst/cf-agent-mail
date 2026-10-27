import { Mailbox } from "./mailbox-do";
import { handleFetch } from "./server";

export { Mailbox };

export default {
  fetch(request, env) {
    return handleFetch(request, env);
  },
} satisfies ExportedHandler<Env>;
