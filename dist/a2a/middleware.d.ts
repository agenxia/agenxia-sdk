interface MiddlewareOptions {
    allowedCallers?: string[];
    maxBodySize?: number;
}
/**
 * Validate the X-Agent-ID header is present.
 */
export declare function validateAgentId(req: Request): string | null;
/**
 * Check X-Max-Depth header and reject if 0 or negative.
 */
export declare function checkDepth(req: Request): {
    valid: boolean;
    depth: number;
};
/**
 * Check if the caller is allowed (whitelist).
 * allowedCallers: ["*"] means accept all, otherwise check specific IDs.
 */
export declare function checkAllowedCaller(callerId: string, allowedCallers: string[]): boolean;
/**
 * Validate request body size.
 */
export declare function checkBodySize(contentLength: string | null, maxSize?: number): boolean;
/**
 * Combined A2A middleware that validates all requirements.
 * Returns null if all checks pass, or an error Response if any fail.
 */
export declare function validateA2ARequest(req: Request, options?: MiddlewareOptions): Response | null;
/**
 * Wrap an A2A handler with middleware validation.
 */
export declare function withA2AMiddleware(handler: (req: Request) => Promise<Response>, options?: MiddlewareOptions): (req: Request) => Promise<Response>;
export {};
//# sourceMappingURL=middleware.d.ts.map