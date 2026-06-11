import { Request } from "express";

// Extend Express Request type to include auth and user properties
declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
      };
      user?: {
        id: string;
        email: string;
        // role: string;
        // franchiseId: string | null;
      } | null;
    }
  }
}

export {};
