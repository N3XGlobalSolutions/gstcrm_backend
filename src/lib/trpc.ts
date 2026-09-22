import { initTRPC, TRPCError } from "@trpc/server";
import { z, ZodError } from "zod";
import { formatZodError } from "@/lib/validationMessage";
import type { Context } from "./context";
import { checkPermission } from "@/lib/permissions";

export const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    console.error("❌ tRPC Error:", error);
    // A validation failure otherwise reaches the screen as the raw ZodError
    // array. Rewrite it into something the shop can act on — "PAN: Must be at
    // most 10 characters" — and keep the per-field list for any form that
    // wants to mark the boxes itself.
    const readable = formatZodError(error);
    if (!readable) return shape;
    const zodError = (error as { cause?: unknown }).cause;
    return {
      ...shape,
      message: readable,
      data: {
        ...shape.data,
        fieldErrors:
          zodError instanceof ZodError ? z.flattenError(zodError).fieldErrors : undefined,
      },
    };
  }
});

export const router = t.router;

export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required. Please log in.",
    });
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const superadminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.username.toLowerCase() !== "superadmin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only superadmin has access to this resource.",
    });
  }
  return next({ ctx });
});

export function guardedProcedure(
  module: string,
  form: string,
  action: "view" | "edit" | "delete",
) {
  return protectedProcedure.use(async ({ ctx, next }) => {
    // Only the superadmin username bypasses form/activity permission checks entirely
    if (ctx.user.username.toLowerCase() === "superadmin") {
      return next({ ctx });
    }

    const allowed = await checkPermission(
      ctx.user.id,
      module,
      form,
      action,
    );

    if (!allowed) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `You do not have permission to perform this action (${module}.${form}:${action}).`,
      });
    }

    return next({ ctx });
  });
}
