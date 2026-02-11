/**
 * OpenAPI specification for the Fractal Agents Runtime — TypeScript stub (v0.0.0).
 *
 * This is a minimal spec that covers only the health and info endpoints.
 * It will grow as the TypeScript runtime gains feature parity with the
 * Python runtime.
 */

export interface OpenAPISpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
    license?: { name: string; url: string };
  };
  paths: Record<string, Record<string, PathItem>>;
}

interface PathItem {
  summary: string;
  operationId: string;
  responses: Record<string, ResponseObject>;
  tags?: string[];
}

interface ResponseObject {
  description: string;
  content?: Record<string, { schema: SchemaObject }>;
}

interface SchemaObject {
  type: string;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  items?: SchemaObject;
  enum?: string[];
  example?: unknown;
  [key: string]: unknown;
}

export const OPENAPI_SPEC: OpenAPISpec = {
  openapi: "3.1.0",
  info: {
    title: "Fractal Agents Runtime — TypeScript",
    version: "0.0.0",
    description:
      "Free, self-hostable LangGraph-compatible agent runtime. " +
      "TypeScript/Bun implementation — v0.0.0 pipeline-validation stub.",
    license: {
      name: "MIT",
      url: "https://opensource.org/licenses/MIT",
    },
  },
  paths: {
    "/health": {
      get: {
        summary: "Health check",
        operationId: "getHealth",
        tags: ["system"],
        responses: {
          "200": {
            description: "Service is healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["status"],
                  properties: {
                    status: {
                      type: "string",
                      enum: ["ok"],
                      example: "ok",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/info": {
      get: {
        summary: "Service metadata",
        operationId: "getInfo",
        tags: ["system"],
        responses: {
          "200": {
            description: "Service information",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["service", "version", "runtime"],
                  properties: {
                    service: {
                      type: "string",
                      example: "fractal-agents-runtime-ts",
                    },
                    version: { type: "string", example: "0.0.0" },
                    runtime: { type: "string", example: "bun" },
                    bun_version: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/openapi.json": {
      get: {
        summary: "OpenAPI specification",
        operationId: "getOpenApiSpec",
        tags: ["system"],
        responses: {
          "200": {
            description: "OpenAPI 3.1 specification document",
            content: {
              "application/json": {
                schema: { type: "object" },
              },
            },
          },
        },
      },
    },
  },
};
