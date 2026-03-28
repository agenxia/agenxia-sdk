import { A2A_ERROR_CODES } from "./types.js";
function makeError(id, code, message, data) {
    return { jsonrpc: "2.0", id, error: { code, message, data } };
}
function makeSuccess(id, result) {
    return { jsonrpc: "2.0", id, result };
}
function extractHeaders(req) {
    return {
        callerId: req.headers.get("x-agent-id") ?? "unknown",
        depth: parseInt(req.headers.get("x-max-depth") ?? "10", 10),
        requestId: req.headers.get("x-request-id") ?? crypto.randomUUID(),
    };
}
/**
 * Create an A2A request handler for the /a2a endpoint.
 * Returns a function compatible with Web Request/Response API.
 */
export function createA2AHandler(methods) {
    return async (req) => {
        const context = extractHeaders(req);
        if (context.depth <= 0) {
            const body = await req.json();
            return Response.json(makeError(body.id ?? 0, A2A_ERROR_CODES.MAX_DEPTH_EXCEEDED, "Max call depth exceeded"));
        }
        let body;
        try {
            body = await req.json();
        }
        catch {
            return Response.json(makeError(0, A2A_ERROR_CODES.INVALID_PARAMS, "Invalid JSON body"));
        }
        if (body.jsonrpc !== "2.0" || !body.method) {
            return Response.json(makeError(body.id ?? 0, A2A_ERROR_CODES.INVALID_PARAMS, "Invalid JSON-RPC 2.0 request"));
        }
        const method = methods[body.method];
        if (!method) {
            return Response.json(makeError(body.id, A2A_ERROR_CODES.METHOD_NOT_FOUND, `Method '${body.method}' not found`));
        }
        try {
            const result = await method.handler(body.params ?? {}, context);
            return Response.json(makeSuccess(body.id, result));
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "Internal error";
            return Response.json(makeError(body.id, A2A_ERROR_CODES.INTERNAL_ERROR, message));
        }
    };
}
/**
 * Create an A2A streaming handler for the /a2a/stream endpoint.
 * Returns SSE responses.
 */
export function createA2AStreamHandler(methods) {
    return async (req) => {
        const context = extractHeaders(req);
        let body;
        try {
            body = await req.json();
        }
        catch {
            return Response.json(makeError(0, A2A_ERROR_CODES.INVALID_PARAMS, "Invalid JSON body"));
        }
        const method = methods[body.method];
        if (!method?.streamHandler) {
            return Response.json(makeError(body.id, A2A_ERROR_CODES.METHOD_NOT_FOUND, `Streaming not supported for '${body.method}'`));
        }
        const stream = new ReadableStream({
            async start(controller) {
                const encoder = new TextEncoder();
                try {
                    for await (const event of method.streamHandler(body.params ?? {}, context)) {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                    }
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : "Stream error";
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`));
                }
                finally {
                    controller.close();
                }
            },
        });
        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            },
        });
    };
}
/**
 * Create the agent-card endpoint handler.
 */
export function createAgentCardHandler(card) {
    return () => {
        return Response.json(card);
    };
}
/**
 * Create a health check endpoint handler.
 */
export function createHealthHandler(agentId, startTime) {
    return () => {
        return Response.json({
            status: "ok",
            agentId,
            uptime: Math.floor((Date.now() - startTime) / 1000),
            version: "2.0",
        });
    };
}
/**
 * Helper to define a simple chat method.
 */
export function defineChatMethod(handler, streamHandler) {
    return { handler, streamHandler };
}
//# sourceMappingURL=server.js.map