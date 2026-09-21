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
  // No touch on the master: a gold item is just a unique name. The touch is typed
  // by hand on each Purchase/Sales row and is what splits the item into separate
  // stock lines, so storing a "default" here would only ever go stale.
});

// ─── items.update ─────────────────────────────────────────────────────────────

export const UpdateItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
});

// ─── items.delete ─────────────────────────────────────────────────────────────

export const DeleteItemSchema = z.object({
  id: z.string().uuid(),
});
