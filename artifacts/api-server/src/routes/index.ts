import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import connectionsRouter from "./connections";
import postsRouter from "./posts";
import mediaRouter from "./media";
import organizeRouter from "./organize";
import queuesRouter from "./queues";
import recurrencesRouter from "./recurrences";
import teamRouter from "./team";
import analyticsRouter from "./analytics";
import approvalsRouter from "./approvals";
import inboxRouter from "./inbox";
import aiRouter from "./ai";
import libraryRouter from "./library";
import reportsRouter from "./reports";
import linkPreviewRouter from "./link-preview";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(connectionsRouter);
router.use(postsRouter);
router.use(mediaRouter);
router.use(organizeRouter);
router.use(queuesRouter);
router.use(recurrencesRouter);
router.use(teamRouter);
router.use(analyticsRouter);
router.use(approvalsRouter);
router.use(inboxRouter);
router.use(aiRouter);
router.use(libraryRouter);
router.use(reportsRouter);
router.use(linkPreviewRouter);

export default router;
