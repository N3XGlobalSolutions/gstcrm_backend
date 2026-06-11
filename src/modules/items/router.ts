import { router, protectedProcedure } from "@/lib/trpc";
import {
  ListItemsSchema,
  CreateItemSchema,
  UpdateItemSchema,
  DeleteItemSchema,
} from "./schema";
import {
  listItems,
  createItem,
  updateItem,
  deleteItem,
} from "./service";

export const itemsRouter = router({
  list: protectedProcedure
    .input(ListItemsSchema)
    .query(async ({ input }) => listItems(input)),

  create: protectedProcedure
    .input(CreateItemSchema)
    .mutation(async ({ input }) => createItem(input)),

  update: protectedProcedure
    .input(UpdateItemSchema)
    .mutation(async ({ input }) => updateItem(input)),

  delete: protectedProcedure
    .input(DeleteItemSchema)
    .mutation(async ({ input }) => deleteItem(input)),
});
