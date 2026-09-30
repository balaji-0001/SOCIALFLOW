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
app.use(cookieParser(sessionSecret));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
