import type { InitContextPayload } from "./workflow-engine.js";
export interface CompleteInitBody {
    user_id: string;
    code: string;
    state?: string;
    callback_url: string;
}
export declare function buildCompleteInitContext(body: CompleteInitBody): InitContextPayload;
//# sourceMappingURL=oauth-init.d.ts.map