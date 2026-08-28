import type { InitContextPayload } from "./workflow-engine.js";

export interface CompleteInitBody {
  user_id: string;
  code: string;
  state?: string;
  callback_url: string;
}

export function buildCompleteInitContext(body: CompleteInitBody): InitContextPayload {
  return {
    phase: "complete",
    userId: body.user_id,
    callbackUrl: body.callback_url,
    code: body.code,
    state: body.state,
  };
}
