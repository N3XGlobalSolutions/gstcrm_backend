import { z } from "zod";

// ─── items.list ───────────────────────────────────────────────────────────────

export const ListItemsSchema = z.object({
  type: z.enum(["GOLD", "ORNAMENT", "MONEY"]).optional(),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
});

// ─── items.create ─────────────────────────────────────────────────────────────

export const CreateItemSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(["GOLD", "ORNAMENT"]), // MONEY is system-only
  unit: z.enum(["GRAM", "PIECE"]),    // RUPEE is system-only
  // Touch 0 is allowed — an item may carry no default touch, with the real touch
  // typed per bill row. Only a negative touch is invalid.
  touch: z.number().nonnegative().max(100).optional(),
});

// ─── items.update ─────────────────────────────────────────────────────────────

export const UpdateItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  touch: z.number().nonnegative().max(100).optional().nullable(),
});

// ─── items.delete ─────────────────────────────────────────────────────────────

export const DeleteItemSchema = z.object({
  id: z.string().uuid(),
});
