import { AppError } from "@/types/errors";
import { generateEntryNo } from "@/lib/entryNoGenerator";
import { db } from "@/db";
import type { z } from "zod";
import type {
  ListItemsSchema,
  CreateItemSchema,
  UpdateItemSchema,
  DeleteItemSchema,
} from "./schema";
import {
  findManyItems,
  findItemByNameAndType,
  findItemById,
  isItemInUse,
  insertItem,
  updateItemName,
  softDeleteItem,
} from "./queries";

// ─── listItems ───────────────────────────────────────────────────────────────

export async function listItems(input: z.infer<typeof ListItemsSchema>) {
  return findManyItems(input);
}

// ─── createItem ──────────────────────────────────────────────────────────────

export async function createItem(input: z.infer<typeof CreateItemSchema>) {
  // Uniqueness: name must be unique within the same type
  const existing = await findItemByNameAndType(input.name, input.type);
  if (existing) {
    throw new AppError(
      "CONFLICT",
      `An item named "${input.name}" of type ${input.type} already exists`,
      "name",
    );
  }

  const entry_no = await generateEntryNo(db, "items", input.type);
  return insertItem({ ...input, entry_no });
}

// ─── updateItem ──────────────────────────────────────────────────────────────

export async function updateItem(input: z.infer<typeof UpdateItemSchema>) {
  const item = await findItemById(input.id);
  if (!item) throw new AppError("NOT_FOUND", "Item not found");

  // Uniqueness check excluding self
  const conflict = await findItemByNameAndType(input.name, item.type, input.id);
  if (conflict) {
    throw new AppError(
      "CONFLICT",
      `An item named "${input.name}" of type ${item.type} already exists`,
      "name",
    );
  }

  // Ornament items keep their master touch; a gold item no longer carries one, so
  // only the name is updated here.
  return updateItemName(input.id, input.name);
}

// ─── deleteItem ──────────────────────────────────────────────────────────────

export async function deleteItem(input: z.infer<typeof DeleteItemSchema>) {
  const item = await findItemById(input.id);
  if (!item) throw new AppError("NOT_FOUND", "Item not found");

  const inUse = await isItemInUse(input.id);
  if (inUse) {
    throw new AppError(
      "BUSINESS_RULE_VIOLATION",
      "Item is in use and cannot be deleted",
    );
  }

  await softDeleteItem(input.id);
  return { success: true };
}
