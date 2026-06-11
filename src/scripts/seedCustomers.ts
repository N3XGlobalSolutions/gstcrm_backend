import { db } from "@/db";
import { accounts } from "@/db/schema";
import { sql } from "drizzle-orm";

async function seedCustomers() {
  console.log("Starting customer seeding...");
  try {
    // Get next entry_no
    const result = await db.execute(sql`SELECT COALESCE(MAX(entry_no), 0) + 1 AS next_entry_no FROM accounts`);
    let nextEntryNo = Number(result[0]?.next_entry_no || 1);

    const customersToInsert = [
      {
        name: "Rahul Traders",
        type: "CUSTOMER" as const,
        customer_type: "PURCHASER" as const,
        phone: "9876543210",
        address: "123 MG Road, Bangalore",
      },
      {
        name: "Anjali Jewellers",
        type: "CUSTOMER" as const,
        customer_type: "CUSTOMER" as const,
        phone: "9876543211",
        address: "45 Commercial St, Bangalore",
      },
      {
        name: "Kishore Goldsmiths",
        type: "CUSTOMER" as const,
        customer_type: "GOLD_SMITH" as const,
        phone: "9876543212",
        address: "12 Artisan Lane, Mumbai",
      },
      {
        name: "Priya Sharma",
        type: "CUSTOMER" as const,
        customer_type: "SALES_MAN" as const,
        phone: "9876543213",
        address: "Sector 4, Noida",
      },
      {
        name: "Omkar Polishing Works",
        type: "CUSTOMER" as const,
        customer_type: "LABOUR_BILL" as const,
        phone: "9876543214",
        address: "88 Industrial Area, Surat",
      },
      {
        name: "Metro Gold Buyers",
        type: "CUSTOMER" as const,
        customer_type: "PURCHASER" as const,
        phone: "9876543215",
        address: "MG Road, Pune",
      },
      {
        name: "Lakshmi Stores",
        type: "CUSTOMER" as const,
        customer_type: "CUSTOMER" as const,
        phone: "9876543216",
        address: "T Nagar, Chennai",
      },
      {
        name: "Ramesh Kumar (Goldsmith)",
        type: "CUSTOMER" as const,
        customer_type: "GOLD_SMITH" as const,
        phone: "9876543217",
        address: "Zaveri Bazaar, Mumbai",
      }
    ];

    for (const customer of customersToInsert) {
        await db.insert(accounts).values({
            entry_no: nextEntryNo++,
            name: customer.name,
            type: customer.type,
            customer_type: customer.customer_type,
            phone: customer.phone,
            address: customer.address,
            is_system_account: false,
        });
        console.log(`✅ Seeded ${customer.name} (${customer.customer_type})`);
    }

    console.log("✅ 8 Customer records seeded successfully!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error seeding customers:", err);
    process.exit(1);
  }
}

seedCustomers();
