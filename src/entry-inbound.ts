import { handleEmail } from "./inbound";

export default {
  email(message, env, ctx) {
    return handleEmail(message, env, ctx);
  },
} satisfies ExportedHandler<Env>;
