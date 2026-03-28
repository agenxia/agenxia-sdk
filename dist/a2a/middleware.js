import { A2A_ERROR_CODES } from "./types.js";
const MAX_BODY_SIZE = 1_048_576; // 1 MB default
function makeErrorResponse(id, code, message, data) {
    return Response.json({ jsonrpc: "2.0", id, error: { code, message, data } }, { status: 200 });
}
/**
 * Validate the X-Agent-ID header is present.
 */
export function validateAgentId(req) {
    return req.headers.get("x-agent-id");
}
/**
 * Check X-Max-Depth header and reject if 0 or negative.
 */
export function checkDepth(req) {
    const raw = req.headers.get("x-max-depth");
    const depth = raw ? parseInt(raw, 10) : 10;
    return { valid: depth > 0, depth };
}
/**
 * Check if the caller is allowed (whitelist).
 * allowedCallers: ["*"] means accept all, otherwise check specific IDs.
 */
export function checkAllowedCaller(callerId, allowedCallers) {
    if (allowedCallers.includes("*"))
        return true;
    return allowedCallers.includes(callerId);
}
/**
 * Validate request body size.
 */
export function checkBodySize(contentLength, maxSize = MAX_BODY_SIZE) {
    if (!contentLength)
        return true; // let it pass, will fail on parse
    return parseInt(contentLength, 10) <= maxSize;
}
/**
 * Combined A2A middleware that validates all requirements.
 * Returns null if all checks pass, or an error Response if any fail.
 */
export function validateA2ARequest(req, options = {}) {
    // Check body size
    if (!checkBodySize(req.headers.get("content-length"), options.maxBodySize)) {
        return makeErrorResponse(0, A2A_ERROR_CODES.INVALID_PARAMS, `Request body too large (max ${options.maxBodySize ?? MAX_BODY_SIZE} bytes)`);
    }
    // Check agent ID
    const callerId = validateAgentId(req);
    if (!callerId) {
        return makeErrorResponse(0, A2A_ERROR_CODES.UNAUTHORIZED, "Missing X-Agent-ID header");
    }
    // Check depth
    const { valid } = checkDepth(req);
    if (!valid) {
        return makeErrorResponse(0, A2A_ERROR_CODES.MAX_DEPTH_EXCEEDED, "Max call depth exceeded");
    }
    // Check allowed callers
    if (options.allowedCallers) {
        if (!checkAllowedCaller(callerId, options.allowedCallers)) {
            return makeErrorResponse(0, A2A_ERROR_CODES.UNAUTHORIZED, "Unauthorized agent ID", { caller: callerId });
        }
    }
    return null;
}
/**
 * Wrap an A2A handler with middleware validation.
 */
export function withA2AMiddleware(handler, options = {}) {
    return async (req) => {
        const error = validateA2ARequest(req, options);
        if (error)
            return error;
        return handler(req);
    };
}
//# sourceMappingURL=middleware.js.map