import { type ElysiaOpenAPIConfig, openapi } from "@elysiajs/openapi";
import { comment } from "./utils";

export const docs = openapi({
	path: "/swagger",
	specPath: "/swagger/json",
	openapiVersion: "3.0.3",
	// WebSocket routes are not OpenAPI operations. Upstream `@elysiajs/openapi`
	// would otherwise emit them as a `ws` path-item member, which is not valid
	// in OpenAPI 3.0.3. The default `exclude.methods = ["options"]` is kept.
	exclude: {
		paths: ["/api/ws"],
	},
	// @scalar/types bundled with @elysiajs/openapi omits `sources` from ApiReferenceConfiguration,
	// even though Scalar's runtime and HTML configuration serialization support it.
	scalar: {
		sources: [
			{ slug: "kyoo", url: "/swagger/json" },
			{ slug: "keibi", url: "/auth/swagger/doc.json" },
			{ slug: "scanner", url: "/scanner/openapi.json" },
			{ slug: "transcoder", url: "/video/swagger/doc.json" },
		],
	} as unknown as NonNullable<ElysiaOpenAPIConfig["scalar"]>,
	documentation: {
		info: {
			title: "Kyoo",
			description: comment`
				Complete API documentation of Kyoo.
				If you need a route not present here, please make an issue over https://github.com/zoriya/kyoo
			`,
			version: "5.0.0",
			contact: { name: "github", url: "https://github.com/zoriya/kyoo" },
			license: {
				name: "GPL-3.0 license",
				url: "https://github.com/zoriya/Kyoo/blob/master/LICENSE",
			},
		},
		servers: [
			{
				url: "https://kyoo.zoriya.dev/api",
				description: "Kyoo's demo server",
			},
		],
		tags: [
			{
				name: "shows",
				description:
					"Routes to list movies, series & collections at the same time",
			},
			{ name: "movies", description: "Routes about movies" },
			{ name: "series", description: "Routes about series" },
			{ name: "collections", description: "Routes about collections" },
			{ name: "studios", description: "Routes about studios" },
			{ name: "staff", description: "Routes about staff & roles" },
			{
				name: "videos",
				description: comment`
					Used by the scanner internally to list & create videos.
					Can be used for administration or third party apps.
				`,
			},
			{
				name: "images",
				description: "Routes about images: posters, thumbnails...",
			},
			{
				name: "profiles",
				description: "Routes about user profiles, watchlist & history.",
			},
		],
		components: {
			securitySchemes: {
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
			},
		},
	},
});
