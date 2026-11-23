import { opentelemetry } from "@elysiajs/opentelemetry";
import { elysiaLogger } from "@logtape/elysia";
import { getLogger } from "@logtape/logtape";
import { Elysia } from "elysia";
import { handlers } from "./base";
import { processImages } from "./controllers/seed/images";
import { db, migrate } from "./db";
import { docs } from "./docs";
import { setupLogging } from "./logtape";
import { setupOtel } from "./otel";
import { listenBroadcasts } from "./websockets";

await setupLogging();
setupOtel();
const logger = getLogger();

await migrate();

const disposeImages = await processImages();

const PATH_IGNORE = new Set(["/api/health", "/api/ready"]);
logger.info("Skipping request logging for these paths: {dropList}", {
	dropList: Array.from(PATH_IGNORE).sort(),
});

const app = new Elysia({
	allowUnsafeValidationDetails: process.env.NODE_ENV === "development",
})
	.use(opentelemetry())
	.use(
		elysiaLogger({
			format: "dev",
			skip: (ctx) => PATH_IGNORE.has(ctx.path),
		}),
	)
	.use(docs)
	.use(handlers)
	.listen(3567);

const disposeBroadcasts = await listenBroadcasts(app.server!);

process.on("SIGTERM", () => {
	app.stop().then(async () => {
		logger.info("API service state changed: {state}", {
			state: "stopping",
		});
		disposeImages();
		disposeBroadcasts();
		await db.$client.end();
		logger.info("API service state changed: {state}", {
			state: "stopped",
		});
		process.exit(0);
	});
});

logger.info("API service running at {hostname}:{port}", {
	hostname: app.server?.hostname,
	port: app.server?.port,
});
