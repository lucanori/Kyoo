import { describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { handlers } from "~/base";
import { docs } from "~/docs";

const app = new Elysia().use(docs).use(handlers);

describe("openapi docs", () => {
	it("serves Scalar UI at GET /swagger with static config and four sources in order", async () => {
		const res = await app.handle(new Request("http://localhost/swagger"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");

		const html = await res.text();
		expect(html).toContain("<title>Kyoo</title>");

		const match = html.match(/data-configuration='([^']+)'/);
		expect(match).not.toBeNull();
		const decoded = match![1].replaceAll("&quot;", '"');
		const config = JSON.parse(decoded);

		expect(config.sources).toEqual([
			{ slug: "kyoo", url: "/swagger/json" },
			{ slug: "keibi", url: "/auth/swagger/doc.json" },
			{ slug: "scanner", url: "/scanner/openapi.json" },
			{ slug: "transcoder", url: "/video/swagger/doc.json" },
		]);
	});

	it("serves OpenAPI 3.0.3 spec at GET /swagger/json with expected paths, schemas, security, and hidden docs routes", async () => {
		const res = await app.handle(new Request("http://localhost/swagger/json"));
		expect(res.status).toBe(200);

		const spec = await res.json();
		expect(spec.openapi).toBe("3.0.3");
		expect(spec.info.title).toBe("Kyoo");
		expect(spec.info.version).toBe("5.0.0");
		expect(spec.servers).toEqual([
			{
				url: "https://kyoo.zoriya.dev/api",
				description: "Kyoo's demo server",
			},
		]);

		expect(spec.components?.securitySchemes).toEqual({
			bearer: {
				type: "http",
				scheme: "bearer",
				bearerFormat: "opaque",
			},
			api: {
				type: "apiKey",
				in: "header",
				name: "X-API-KEY",
			},
		});

		const paths = Object.keys(spec.paths ?? {});
		for (const expectedPath of [
			"/api/health",
			"/api/ready",
			"/api/movies",
			"/api/series",
			"/api/shows",
			"/api/videos",
		]) {
			expect(paths).toContain(expectedPath);
		}
		expect(paths).not.toContain("/swagger");
		expect(paths).not.toContain("/swagger/json");
		// `/api/ws` is a WebSocket route, not an OpenAPI operation. It must not
		// appear as a path, nor may any path item carry a `ws` member, which is
		// not a valid OpenAPI 3.0.3 operation or path-item field.
		expect(paths).not.toContain("/api/ws");
		expect(paths).not.toContain("/ws");

		const validOperationKeys = new Set([
			"get",
			"put",
			"post",
			"delete",
			"options",
			"head",
			"patch",
			"trace",
			"summary",
			"description",
			"servers",
			"parameters",
			"$ref",
		]);
		for (const path of Object.keys(spec.paths ?? {})) {
			expect(path).not.toBe("/api/ws");
			for (const key of Object.keys(
				spec.paths[path] as Record<string, unknown>,
			)) {
				expect(validOperationKeys.has(key)).toBe(true);
				expect(key).not.toBe("ws");
				// upstream excludes `options` by default; this must be preserved
				expect(key).not.toBe("options");
			}
		}

		const schemas = Object.keys(spec.components?.schemas ?? {});
		for (const expectedSchema of [
			"show",
			"movie",
			"serie",
			"collection",
			"video",
			"error",
		]) {
			expect(schemas).toContain(expectedSchema);
		}
	});
});
