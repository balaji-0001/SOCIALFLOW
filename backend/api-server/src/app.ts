import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { getRedirectBaseUrl } from "./lib/oauth/config";

const app: Express = express();
// Replit terminates TLS at its proxy; trust it so req.secure reflects HTTPS.
app.set("trust proxy", 1);
const sessionSecret = process.env.SESSION_SECRET;

if (!sessionSecret) {
  throw new Error("SESSION_SECRET must be set for social account connections.");
}

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// The frontend and this API share an origin in every deployment (Replit's
// path router mounts both under one host; vite's dev proxy does the same
// locally), so cross-origin requests are never legitimate here — allowing
// them would only let another site's script call authenticated endpoints
// using a visitor's session cookie. Reflect only the configured origin
// (needed for the tunnel/custom-domain case where a browser extension or
// direct API testing tool sends an Origin header) and never send
// Access-Control-Allow-Credentials for anything else.
const allowedOrigin = getRedirectBaseUrl();
app.use(
  cors({
    origin: allowedOrigin ?? false,
    credentials: true,
  }),
);
// Records visits from Meta's crawlers (link previews, app review, callbacks) so "did Meta reach us, and what did we
// answer?" can be read from the logs. Logs the crawler's name, address, path and our status only; no cookies or bodies.
const META_CRAWLER = /facebookexternalhit|meta-externalagent|meta-externalfetcher|facebot|facebookcatalog/i;
app.use((req, res, next) => {
  const agent = req.get("user-agent") ?? "";
  if (META_CRAWLER.test(agent)) {
    res.on("finish", () => logger.info({ metaCrawler: agent.slice(0, 120), ip: req.ip, method: req.method, path: req.path, status: res.statusCode }, "Meta crawler request"));
  }
  next();
});

app.use(cookieParser(sessionSecret));
// A CSV import carries the file in its JSON body (up to 1 MB of text), so those two routes take a larger body.
app.use(["/api/bulk-imports", "/api/bulk-imports/preview"], express.json({ limit: "1200kb" }));
// The WordPress plugin signs the exact bytes it sends, so those routes keep the raw body next to the parsed one.
app.use("/api/wordpress-plugin", express.json({ limit: "256kb", verify: (req, _res, buf) => { (req as typeof req & { rawBody?: Buffer }).rawBody = buf; } }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
