// Port type conversion for Agenxia modules.
// Exposed to modules via context.convert(value, fromType, toType).
// Deterministic, never throws — returns a sensible default on failure.
const converters = {
    "text->json": (v) => {
        try {
            return JSON.parse(v);
        }
        catch {
            return { text: v };
        }
    },
    "text->array": (v) => {
        try {
            const p = JSON.parse(v);
            if (Array.isArray(p))
                return p;
        }
        catch {
            /* noop */
        }
        return String(v).split("\n").filter(Boolean);
    },
    "text->number": (v) => {
        const n = parseFloat(v);
        return isNaN(n) ? 0 : n;
    },
    "text->boolean": (v) => v === "true" || v === "1" || (typeof v === "string" && v.length > 0),
    "json->text": (v) => JSON.stringify(v, null, 2),
    "json->array": (v) => Array.isArray(v) ? v : Object.entries(v ?? {}),
    "json->number": (v) => typeof v === "number" ? v : Object.keys(v ?? {}).length,
    "json->boolean": (v) => !!v,
    "array->text": (v) => (v ?? []).join("\n"),
    "array->json": (v) => v,
    "array->number": (v) => (v ?? []).length,
    "array->boolean": (v) => (v ?? []).length > 0,
    "number->text": (v) => String(v ?? 0),
    "number->json": (v) => ({ value: v ?? 0 }),
    "number->array": (v) => [v ?? 0],
    "number->boolean": (v) => (v ?? 0) !== 0,
    "boolean->text": (v) => (v ? "true" : "false"),
    "boolean->json": (v) => ({ value: !!v }),
    "boolean->array": (v) => [!!v],
    "boolean->number": (v) => (v ? 1 : 0),
};
export function convert(value, fromType, toType) {
    if (fromType === toType)
        return value;
    if (value === null || value === undefined) {
        if (toType === "boolean")
            return false;
        if (toType === "number")
            return 0;
        return null;
    }
    // any → X: guess the real type from the JS runtime value
    let effectiveFrom = fromType;
    if (fromType === "any") {
        if (typeof value === "string")
            effectiveFrom = "text";
        else if (typeof value === "number")
            effectiveFrom = "number";
        else if (typeof value === "boolean")
            effectiveFrom = "boolean";
        else if (Array.isArray(value))
            effectiveFrom = "array";
        else
            effectiveFrom = "json";
    }
    if (effectiveFrom === toType)
        return value;
    // X → any: identity
    if (toType === "any")
        return value;
    const fn = converters[`${effectiveFrom}->${toType}`];
    if (fn)
        return fn(value);
    return value; // fallback: identity
}
//# sourceMappingURL=convert.js.map