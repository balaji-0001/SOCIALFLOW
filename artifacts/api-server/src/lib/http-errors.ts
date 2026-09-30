import type { Response } from "express";

export function jsonError(res: Response, status: number, error: string, message: string): void {
  res.status(status).json({ error, message });
}
