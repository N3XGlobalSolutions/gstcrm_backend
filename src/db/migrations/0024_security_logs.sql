CREATE TABLE "activity_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"username" varchar(100),
	"module" varchar(50) NOT NULL,
	"action" varchar(50) NOT NULL,
	"procedure" varchar(150),
	"record_ref" varchar(100),
	"success" boolean DEFAULT true NOT NULL,
	"error" text,
	"ip" varchar(45),
	"device_id" uuid,
	"browser" varchar(100),
	"os" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"actor_username" varchar(100),
	"action" varchar(60) NOT NULL,
	"target_type" varchar(40) NOT NULL,
	"target_id" varchar(100),
	"target_label" varchar(200),
	"changes" jsonb,
	"reason" text,
	"ip" varchar(45),
	"user_agent" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"username" varchar(100) NOT NULL,
	"event" varchar(30) NOT NULL,
	"reason" text,
	"method" varchar(20),
	"ip" varchar(45),
	"city" varchar(100),
	"region" varchar(100),
	"country" varchar(100),
	"browser" varchar(100),
	"os" varchar(100),
	"device_type" varchar(20),
	"device_id" uuid,
	"new_device" boolean DEFAULT false NOT NULL,
	"user_agent" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"browser" varchar(100),
	"os" varchar(100),
	"device_type" varchar(20),
	"label" varchar(100),
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_ip" varchar(45),
	"last_location" varchar(150),
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid
);
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_device_id_user_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."user_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_history" ADD CONSTRAINT "login_history_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_history" ADD CONSTRAINT "login_history_device_id_user_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."user_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_revoked_by_app_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_logs_created_at_idx" ON "activity_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "activity_logs_user_id_idx" ON "activity_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "activity_logs_module_idx" ON "activity_logs" USING btree ("module");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "login_history_created_at_idx" ON "login_history" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "login_history_user_id_idx" ON "login_history" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "login_history_ip_idx" ON "login_history" USING btree ("ip");--> statement-breakpoint
CREATE UNIQUE INDEX "user_devices_user_token_uq" ON "user_devices" USING btree ("user_id","token_hash");--> statement-breakpoint
CREATE INDEX "user_devices_user_id_idx" ON "user_devices" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_device_id_user_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."user_devices"("id") ON DELETE set null ON UPDATE no action;