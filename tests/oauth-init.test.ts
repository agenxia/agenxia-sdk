import test from "node:test";
import assert from "node:assert/strict";

import { buildCompleteInitContext } from "../src/oauth-init.ts";

test("complete init context preserves the OAuth callback URL", () => {
  const context = buildCompleteInitContext({
    user_id: "user-1",
    code: "authorization-code",
    state: "signed-state",
    callback_url: "https://agenxia.anteika.fr/api/oauth/callback",
  });

  assert.deepEqual(context, {
    phase: "complete",
    userId: "user-1",
    callbackUrl: "https://agenxia.anteika.fr/api/oauth/callback",
    code: "authorization-code",
    state: "signed-state",
  });
});
