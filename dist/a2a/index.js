// A2A Protocol — barrel export
export { A2A_ERROR_CODES } from "./types.js";
// Client
export { callAgent, discoverAgent, streamChat, sendHeartbeat, startHeartbeat, registerWithPlatform, } from "./client.js";
// Server handlers
export { createA2AHandler, createA2AStreamHandler, createAgentCardHandler, createHealthHandler, defineChatMethod, } from "./server.js";
// Middleware
export { validateAgentId, checkDepth, checkAllowedCaller, checkBodySize, validateA2ARequest, withA2AMiddleware, } from "./middleware.js";
//# sourceMappingURL=index.js.map