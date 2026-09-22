import { Router, type IRouter } from "express";
import healthRouter from "./health";
import connectionsRouter from "./connections";

const router: IRouter = Router();

router.use(healthRouter);
router.use(connectionsRouter);

export default router;
