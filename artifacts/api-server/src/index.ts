import { pool, runMigrations } from "@workspace/db";
import app from "./app";
import { logger } from "./lib/logger";
import { startAnalytics } from "./lib/analytics";
import { startInbox } from "./lib/inbox";
import { startReports } from "./lib/reports";
import { startAutomations } from "./lib/automations";
import { startMediaSweeper } from "./lib/media";
import { startPublisher } from "./lib/publisher";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const applied = await runMigrations(pool);
if (applied.length > 0) logger.info({ applied }, "Database migrations applied");

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startPublisher();
  startMediaSweeper();
  startAnalytics();
  startInbox();
  startReports();
  startAutomations();
});
